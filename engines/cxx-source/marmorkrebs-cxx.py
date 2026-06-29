#!/usr/bin/env python3
"""marmorkrebs-cxx: a source-level C++/ObjC++ mutation tester.

marmorkrebs' built-in C++/ObjC++ source-mutation engine (the JS arm uses
Stryker). Stryker mutates JS source and re-runs its test runner; this mutates
C++/ObjC++ source and re-runs a targeted test command. mull (LLVM-bitcode
mutation) is not used because it needs a self-contained test binary to toggle
mutants in; this engine instead recompiles per mutant, which fits projects
built as one library and driven by an external test runner.

What it does, per the marmorkrebs contract:
  1. Restrict to the PR's changed host-logic lines (git diff vs --diff-base),
     or explicit --lines. .metal kernels are NOT mutated (no C++ AST there;
     they are covered by the numeric tests) unless --include-metal.
  2. Apply one source mutation at a time (Stryker-style operators).
  3. Rebuild (--build-cmd, which must produce the artifacts the tests load)
     and run the targeted tests (--test-cmd).
  4. Classify: KILLED (tests failed -> good, the tests catch this break),
     SURVIVED (tests passed -> a coverage gap), BUILD_ERROR (skipped, the
     mutant did not compile).
  5. Report a mutation score and every survivor as file:line: original -> mutant.

A SURVIVED mutant is a hole in the test suite: the code could be broken that
way and every test still passes -- the same class of gap that lets an
untested dispatch branch ship a bug.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass, field, asdict

# Stryker-equivalent operators, token-level. Each entry maps a matched operator
# to its mutation. Applied to non-comment, non-string C++ source spans only.
MUTATORS: dict[str, list[tuple[str, str]]] = {
    "ConditionalBoundary": [("<=", "<"), (">=", ">"), ("<", "<="), (">", ">=")],
    "EqualityOperator": [("==", "!="), ("!=", "==")],
    "LogicalOperator": [("&&", "||"), ("||", "&&")],
    "BooleanLiteral": [("true", "false"), ("false", "true")],
    "ArithmeticOperator": [("+", "-"), ("-", "+"), ("*", "/")],
}
# Operators are matched as whole tokens with these boundaries so we never split
# `<=` into `<`, mangle `->`/`+=`/`<<`, or touch `<T>` template brackets etc.
# Bare `<`/`>` require surrounding spaces so we mutate spaced comparisons
# (`M <= 16`, `a < b`) and not unspaced template brackets (`reduction<long>`),
# which would only ever waste a full rebuild as a BUILD_ERROR.
_TOKEN = {
    "<=": r"<=", ">=": r">=", "==": r"==", "!=": r"!=", "&&": r"&&", "||": r"\|\|",
    "<": r"(?<= )<(?= )", ">": r"(?<= )>(?= )",
    "true": r"\btrue\b", "false": r"\bfalse\b",
    "+": r"(?<![+])\+(?![+=])", "-": r"(?<![-])-(?![->=])", "*": r"(?<![*/])\*(?![*/=])",
}
# Default to decision-logic mutators; arithmetic is noisy/expensive on dispatch
# code (pointer math, deref) so it is opt-in via --mutators.
DEFAULT_MUTATORS = ["ConditionalBoundary", "EqualityOperator",
                    "LogicalOperator", "BooleanLiteral"]


@dataclass
class Mutant:
    mutator: str
    file: str
    line: int
    col: int
    original: str
    mutated: str
    id: str = ""
    status: str = "PENDING"  # KILLED | SURVIVED | BUILD_ERROR | PENDING
    detail: str = ""


@dataclass
class Report:
    target_files: list[str]
    total: int = 0
    killed: int = 0
    survived: int = 0
    build_error: int = 0
    mutants: list[dict] = field(default_factory=list)

    @property
    def score(self) -> float:
        scored = self.killed + self.survived
        return self.killed / scored if scored else 1.0

    @property
    def score_percent(self) -> float:
        return 100.0 * self.score


def _strip_noncode(line: str) -> str:
    """Blank out // comments and "string"/'c' literals so we never mutate them."""
    out = re.sub(r"//.*$", "", line)
    out = re.sub(r'"(\\.|[^"\\])*"', lambda m: " " * len(m.group(0)), out)
    out = re.sub(r"'(\\.|[^'\\])*'", lambda m: " " * len(m.group(0)), out)
    return out


def parse_lines(spec: str) -> set[int]:
    """Parse '409-545,1493-1540' into a set of line numbers."""
    out: set[int] = set()
    for part in spec.split(","):
        part = part.strip()
        if "-" in part:
            a, b = part.split("-")
            out.update(range(int(a), int(b) + 1))
        elif part:
            out.add(int(part))
    return out


def changed_lines(repo: str, diff_base: str, path: str) -> set[int]:
    """Line numbers added/changed in `path` vs diff_base (the new-file side)."""
    out = subprocess.run(
        ["git", "-C", repo, "diff", "--unified=0", diff_base, "--", path],
        capture_output=True, text=True).stdout
    lines, cur = set(), 0
    for ln in out.splitlines():
        m = re.match(r"@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@", ln)
        if m:
            cur = int(m.group(1))
            continue
        if ln.startswith("+") and not ln.startswith("+++"):
            lines.add(cur)
            cur += 1
        elif not ln.startswith("-"):
            cur += 1
    return lines


def discover(repo: str, path: str, only: set[int] | None,
             enabled: list[str]) -> list[Mutant]:
    full = os.path.join(repo, path)
    with open(full) as f:
        src = f.readlines()
    muts: list[Mutant] = []
    for i, raw in enumerate(src, start=1):
        if only is not None and i not in only:
            continue
        code = _strip_noncode(raw)
        for mutator in enabled:
            for orig, new in MUTATORS[mutator]:
                for m in re.finditer(_TOKEN[orig], code):
                    mut = Mutant(mutator, path, i, m.start(), orig, new)
                    mut.id = stable_id(mut)
                    muts.append(mut)
    return muts


def stable_id(mut: Mutant) -> str:
    raw = f"{mut.file}:{mut.line}:{mut.col}:{mut.mutator}:{mut.original}:{mut.mutated}"
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:12]
    return f"{mut.file}:{mut.line}:{mut.col}:{mut.mutator}:{digest}"


def apply_mutant(repo: str, mut: Mutant) -> str:
    full = os.path.join(repo, mut.file)
    with open(full) as f:
        src = f.readlines()
    original = src[mut.line - 1]
    span = len(mut.original)
    src[mut.line - 1] = original[:mut.col] + mut.mutated + original[mut.col + span:]
    with open(full, "w") as f:
        f.writelines(src)
    return original


def restore(repo: str, path: str, line: int, original: str) -> None:
    full = os.path.join(repo, path)
    with open(full) as f:
        src = f.readlines()
    src[line - 1] = original
    with open(full, "w") as f:
        f.writelines(src)


def run(cmd: str, repo: str, log: str) -> int:
    with open(log, "w") as f:
        return subprocess.run(cmd, cwd=repo, shell=True, stdout=f,
                              stderr=subprocess.STDOUT).returncode


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo-dir", required=True)
    ap.add_argument("--files", required=True,
                    help="comma-separated paths to mutate (relative to repo)")
    ap.add_argument("--diff-base", default=None,
                    help="git ref; restrict to lines changed vs this ref")
    ap.add_argument("--lines", default=None,
                    help="further restrict to these ranges, e.g. 409-545,1493-1540")
    ap.add_argument("--build-cmd", required=True,
                    help="build command; must produce the artifacts the tests load")
    ap.add_argument("--test-cmd", required=True,
                    help="targeted tests; non-zero exit == mutant KILLED")
    ap.add_argument("--report", required=True)
    ap.add_argument("--max-mutants", type=int, default=0, help="0 == no cap")
    ap.add_argument("--include-metal", action="store_true")
    ap.add_argument("--mutators", default=",".join(DEFAULT_MUTATORS),
                    help=f"comma-separated; available: {','.join(MUTATORS)}")
    ap.add_argument(
        "--output-format",
        default="legacy",
        choices=["legacy", "stryker-cxx"],
        help=(
            "legacy keeps current embedded report schema; "
            "stryker-cxx emits mutation-testing-compatible wrapper"
        ),
    )
    args = ap.parse_args()

    enabled = [m.strip() for m in args.mutators.split(",") if m.strip()]
    bad = [m for m in enabled if m not in MUTATORS]
    if bad:
        ap.error(f"unknown mutators: {bad}")
    repo = os.path.abspath(args.repo_dir)
    files = [p.strip() for p in args.files.split(",") if p.strip()]
    rep = Report(target_files=files)
    pending: list[Mutant] = []
    for path in files:
        if path.endswith(".metal") and not args.include_metal:
            print(f"[skip] {path}: .metal is not C++-mutable (numeric tests cover it)")
            continue
        only = changed_lines(repo, args.diff_base, path) if args.diff_base else None
        if args.lines:
            lf = parse_lines(args.lines)
            only = lf if only is None else (only & lf)
        if only is not None:
            print(f"[scope] {path}: {len(only)} lines")
        pending += discover(repo, path, only, enabled)
    if args.max_mutants:
        pending = pending[:args.max_mutants]
    rep.total = len(pending)
    print(f"[marmorkrebs-cxx] {rep.total} mutants across {len(files)} file(s)\n")

    logdir = os.path.join(repo, "agent_space", "marmorkrebs")
    os.makedirs(logdir, exist_ok=True)
    try:
        for idx, mut in enumerate(pending, 1):
            tag = f"{mut.file.split('/')[-1]}:{mut.line} {mut.original}->{mut.mutated} [{mut.mutator}]"
            print(f"[{idx}/{rep.total}] {tag} ... ", end="", flush=True)
            original = apply_mutant(repo, mut)
            t0 = time.time()
            b = run(args.build_cmd, repo, f"{logdir}/build_{idx}.log")
            if b != 0:
                mut.status, mut.detail = "BUILD_ERROR", "did not compile"
                rep.build_error += 1
            else:
                t = run(args.test_cmd, repo, f"{logdir}/test_{idx}.log")
                if t != 0:
                    mut.status = "KILLED"
                    rep.killed += 1
                else:
                    mut.status, mut.detail = "SURVIVED", "all targeted tests passed"
                    rep.survived += 1
            restore(repo, mut.file, mut.line, original)
            rep.mutants.append(asdict(mut))
            print(f"{mut.status} ({time.time()-t0:.0f}s)")
            _write_report(
                args.report,
                rep,
                repo=repo,
                base=args.diff_base,
                output_mode=args.output_format,
            )
    finally:
        for path in files:
            subprocess.run(["git", "-C", repo, "checkout", "--", path])
    _write_report(
        args.report,
        rep,
        repo=repo,
        base=args.diff_base,
        output_mode=args.output_format,
    )
    print(f"\n[marmorkrebs-cxx] score {rep.score_percent:.1f}%  "
          f"killed={rep.killed} survived={rep.survived} build_error={rep.build_error}")
    for m in rep.mutants:
        if m["status"] == "SURVIVED":
            print(f"  SURVIVOR {m['file']}:{m['line']} {m['original']}->{m['mutated']} ({m['mutator']})")
    # Gate semantics: any survivor is a failure (a real test-coverage hole).
    return 1 if rep.survived else 0


def _write_report(
    path: str,
    rep: Report,
    repo: str | None = None,
    base: str | None = None,
    output_mode: str = "legacy",
) -> None:
    with open(path, "w") as f:
        if output_mode == "stryker-cxx":
            json.dump(_report_dict(rep, repo=repo, base=base), f, indent=2)
        else:
            json.dump(_legacy_report(rep), f, indent=2)


def _legacy_report(rep: Report) -> dict:
    return {
        "target_files": rep.target_files,
        "total": rep.total,
        "killed": rep.killed,
        "survived": rep.survived,
        "build_error": rep.build_error,
        "mutants": rep.mutants,
        "score": rep.score_percent,
    }


def _report_dict(rep: Report, repo: str | None = None,
                 base: str | None = None) -> dict:
    """Return a standalone stryker-cxx report while preserving legacy fields."""
    mutants = rep.mutants
    return {
        "schemaVersion": "stryker-cxx.report.v1",
        "tool": "stryker-cxx",
        "repo": repo,
        "base": base,
        "targetFiles": rep.target_files,
        "totalMutants": rep.total,
        "killed": rep.killed,
        "survived": rep.survived,
        "buildErrors": rep.build_error,
        "timeouts": 0,
        "score": rep.score,
        "mutants": mutants,
        # Legacy Marmorkrebs embedded-engine fields. Keep these until
        # Marmorkrebs requires only stryker-cxx.report.v1.
        "target_files": rep.target_files,
        "total": rep.total,
        "build_error": rep.build_error,
        "scorePercent": rep.score_percent,
        "mutationTestingElements": _mutation_testing_elements(rep, repo),
    }


def _mutation_testing_elements(rep: Report, repo: str | None) -> dict:
    """Best-effort Stryker mutation-testing-elements report projection."""
    files: dict[str, dict] = {}
    for file in rep.target_files:
        source = ""
        if repo:
            try:
                with open(os.path.join(repo, file)) as f:
                    source = f.read()
            except OSError:
                source = ""
        files[file] = {"source": source, "mutants": []}

    for idx, mut in enumerate(rep.mutants):
        file = mut["file"]
        files.setdefault(file, {"source": "", "mutants": []})
        files[file]["mutants"].append({
            "id": mut.get("id") or str(idx),
            "mutatorName": mut["mutator"],
            "replacement": mut["mutated"],
            "status": _mte_status(mut["status"]),
            "statusReason": mut.get("detail", ""),
            "location": {
                "start": {"line": mut["line"], "column": mut["col"]},
                "end": {"line": mut["line"], "column": mut["col"] + len(mut["original"])},
            },
        })
    return {
        "schemaVersion": "2.0",
        "files": files,
        "testFiles": {},
    }


def _mte_status(status: str) -> str:
    return {
        "KILLED": "Killed",
        "SURVIVED": "Survived",
        "BUILD_ERROR": "NoCoverage",
        "PENDING": "Pending",
    }.get(status, "RuntimeError")


if __name__ == "__main__":
    sys.exit(main())
