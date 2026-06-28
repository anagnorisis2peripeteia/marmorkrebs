# cxx-mutant standalone tool spec

## Purpose

`cxx-mutant` is a standalone source-level mutation tester for C, C++, Objective-C++, and optionally Metal shader sources.

It should graduate the current Marmorkrebs embedded `cxx-source` engine into an independent tool with a stable CLI, reports, configuration, and release story. Marmorkrebs should then treat it like other mutation tools: an external engine with a parser/adapter, not a private implementation detail.

The tool is intended for PR-sized mutation gates where the caller supplies the build and test commands. It recompiles per mutant, which makes it suitable for projects that do not expose a single self-contained test binary and where LLVM-bitcode mutation tools are awkward to integrate.

## Non-goals

`cxx-mutant` is not trying to replace full compiler-integrated mutation systems on day one.

Initial non-goals:

- No requirement for whole-program LLVM instrumentation.
- No automatic test selection beyond changed-line and file scoping.
- No claim that all survivors are non-equivalent.
- No mutation of macros, generated files, vendored code, or shader files unless explicitly enabled.
- No hidden dependency on Marmorkrebs.

## Current embedded engine baseline

The current Marmorkrebs engine already provides the seed implementation:

- Discovers changed lines via `git diff --unified=0 <base>`.
- Restricts to caller-provided files and optional line ranges.
- Generates token-level mutants while skipping comments and string/character literals.
- Applies one source mutation at a time.
- Runs caller-supplied build and test commands.
- Classifies mutants as `KILLED`, `SURVIVED`, or `BUILD_ERROR`.
- Emits JSON with target files, totals, score, and per-mutant records.
- Supports `--max-mutants`, `--include-metal`, and `--mutators`.

That behavior should remain available as the first standalone implementation.

## CLI contract

The first release should expose a small stable command surface.

### `run`

Run mutation testing and emit a report.

```bash
cxx-mutant run \
  --repo . \
  --files src/foo.cpp,src/bar.mm \
  --base origin/main \
  --build-command "ninja -C build target" \
  --test-command "./build/bin/target_test" \
  --report mutation.json
```

Required options:

- `--repo <path>`: repository root.
- `--files <paths>`: comma-separated repo-relative source paths.
- `--build-command <cmd>`: command that rebuilds the mutated artifact.
- `--test-command <cmd>`: command whose non-zero exit kills a mutant.

Scoping options:

- `--base <ref>`: restrict to changed lines versus a git ref.
- `--lines <ranges>`: further restrict to line ranges such as `10-20,40`.
- `--include <glob>`: include source paths matching a glob.
- `--exclude <glob>`: exclude source paths matching a glob.

Mutation options:

- `--mutators <names>`: comma-separated mutator list.
- `--max-mutants <n>`: cap generated mutants.
- `--include-metal`: include `.metal` files in token-level mode.
- `--mode token|clang`: choose mutation implementation, default `token` initially.

Execution options:

- `--timeout <seconds>`: per-mutant timeout.
- `--jobs <n>`: parallel mutant workers, introduced after isolated worktrees exist.
- `--worktree-mode inplace|git-worktree|copy`: default `inplace` for compatibility, safer modes later.
- `--resume <report>`: skip completed mutants from a prior report.

Report options:

- `--report <path>`: JSON report path.
- `--format json|markdown|html|sarif`: output format for stdout or generated report.
- `--quiet`: write only report output to stdout.

### `list-mutants`

Discover mutants without running build/test commands.

```bash
cxx-mutant list-mutants \
  --repo . \
  --files src/foo.cpp \
  --base origin/main \
  --format json
```

This supports fast review of mutation scope and stable mutant IDs before a long run.

### `run-mutant`

Run one mutant by stable ID.

```bash
cxx-mutant run-mutant \
  --repo . \
  --id src/foo.cpp:42:17:EqualityOperator:sha256... \
  --build-command "ninja -C build target" \
  --test-command "./build/bin/target_test"
```

This is useful for reproducing a survivor locally.

## Exit codes

Exit codes must be stable and CI-friendly.

- `0`: mutation run completed and met the configured threshold.
- `1`: infrastructure or usage error.
- `2`: run completed but did not meet threshold, including surviving mutants.
- `3`: no mutants generated, when `--fail-on-empty` is enabled.

Marmorkrebs can map these into its existing gate semantics.

## Report schema

The JSON report should be stable and versioned.

```json
{
  "schemaVersion": "cxx-mutant.report.v1",
  "tool": "cxx-mutant",
  "repo": "/path/to/repo",
  "base": "origin/main",
  "startedAt": "2026-06-28T12:00:00Z",
  "completedAt": "2026-06-28T12:05:00Z",
  "score": 0.83,
  "threshold": 0.8,
  "totalMutants": 6,
  "killed": 5,
  "survived": 1,
  "buildErrors": 0,
  "timeouts": 0,
  "mutants": [
    {
      "id": "src/foo.cpp:42:17:EqualityOperator:abc123",
      "file": "src/foo.cpp",
      "line": 42,
      "column": 17,
      "mutator": "EqualityOperator",
      "original": "==",
      "mutated": "!=",
      "status": "SURVIVED",
      "durationMs": 1200,
      "buildLog": "agent_space/cxx-mutant/build_1.log",
      "testLog": "agent_space/cxx-mutant/test_1.log",
      "detail": "all targeted tests passed"
    }
  ]
}
```

Required compatibility notes:

- Scores should be `0.0` to `1.0` in standalone reports.
- The Marmorkrebs adapter can normalize older embedded reports that use percentages.
- `totalMutants: 0` should be explicit so callers can distinguish vacuous proof from strong evidence.
- Build errors should not silently improve the score; they should be counted separately.

## Mutator set

Initial mutators should match the embedded engine:

- `ConditionalBoundary`: `<` `<=' `>` `>=` boundary changes.
- `EqualityOperator`: `==` and `!=` swaps.
- `LogicalOperator`: `&&` and `||` swaps.
- `BooleanLiteral`: `true` and `false` swaps.
- `ArithmeticOperator`: `+` `-` `*` `/` swaps, opt-in by default.

Near-term additions:

- `UnaryOperator`: remove or add `!` where syntactically safe.
- `ReturnValue`: mutate simple boolean/integer return constants.
- `AssignmentOperator`: selected `+=`, `-=`, `*=`, `/=` changes.
- `BitwiseOperator`: `&`, `|`, `^` swaps where AST context proves they are operators.
- `CallRemoval`: replace selected side-effect-free predicate/helper calls only when configured.

Default mutators should bias toward branch and dispatch logic, not broad arithmetic. Arithmetic creates too many equivalent or noisy mutants in pointer/indexing code.

## Source analysis modes

### Token mode

Token mode is the compatibility path. It should remain simple, fast, and dependency-light.

Requirements:

- Skip comments, string literals, and character literals.
- Avoid template brackets and common C++ punctuation traps.
- Avoid includes and preprocessor lines by default.
- Keep deterministic mutant ordering.
- Support `.cpp`, `.cc`, `.cxx`, `.c`, `.mm`, `.m`, `.h`, `.hpp`, `.hh`, `.hxx`, and optional `.metal`.

### Clang-aware mode

Clang-aware mode is the path toward Stryker/gomu-level trustworthiness.

Requirements:

- Use compile commands from `compile_commands.json` when available.
- Mutate AST-confirmed expressions rather than raw token matches.
- Preserve formatting enough that diagnostics remain useful.
- Avoid macro expansions unless explicitly enabled.
- Record AST node kind in the mutant record.

Implementation options:

- Python `libclang` bindings for continuity with the current engine.
- A small C++/LLVM binary if Python bindings become too brittle.
- Tree-sitter as an intermediate parser for lighter-weight structural filtering, but not as the final semantic authority.

## Workspace safety

The embedded engine currently mutates files in place and restores them, then uses `git checkout -- <path>` as a final cleanup. A standalone tool needs safer modes.

Required phases:

1. Keep `inplace` mode for compatibility.
2. Add `git-worktree` mode to run each mutant or shard in an isolated worktree.
3. Add resume support so interrupted runs do not require starting over.
4. Avoid destructive cleanup of files not owned by the run.

Safety rules:

- Refuse to run in `inplace` mode on a dirty target file unless `--allow-dirty` is set.
- Never reset unrelated files.
- Write all logs under a configurable artifact directory.
- Emit enough cleanup metadata to recover after interruption.

## Configuration file

Support `cxx-mutant.yml` at the repo root.

```yaml
schemaVersion: cxx-mutant.config.v1
base: origin/main
files:
  include:
    - "aten/src/**/*.mm"
    - "aten/src/**/*.cpp"
  exclude:
    - "**/generated/**"
mutators:
  enabled:
    - ConditionalBoundary
    - EqualityOperator
    - LogicalOperator
    - BooleanLiteral
execution:
  buildCommand: "ninja -C build target"
  testCommand: "python test/run_test.py test_mps --keep-going"
  timeoutSeconds: 300
  maxMutants: 50
  worktreeMode: inplace
report:
  threshold: 0.6
  failOnEmpty: false
  artifactDir: agent_space/cxx-mutant
```

CLI flags should override config values.

## Reports for humans

The JSON report is the canonical machine contract. The tool should also generate human reports.

Markdown report should include:

- Summary table.
- Score and threshold.
- Changed files targeted.
- Survivor list with file/line/mutator/before/after.
- Build errors and timeout list.
- Exact build/test commands.
- Reproduction command for each survivor.

HTML can come later and should be generated from the same report schema.

SARIF can come later for GitHub code-scanning integration.

## Marmorkrebs integration

Marmorkrebs should remain the language-agnostic orchestrator. `cxx-mutant` should become the C/C++ provider.

Adapter plan:

1. Add a Marmorkrebs config option or discovery path for external `cxx-mutant`.
2. If installed, run `cxx-mutant run` and parse `cxx-mutant.report.v1`.
3. If not installed, fall back to the bundled embedded engine for compatibility.
4. Preserve current Marmorkrebs CLI flags: `--max-mutants`, `--include-metal`, and `--mutators`.
5. Eventually remove the bundled fallback once the standalone tool is stable and packaged.

Marmorkrebs result mapping:

- `totalMutants` -> `MutationResult.totalMutants`
- `killed` -> `MutationResult.killed`
- `survived` -> `MutationResult.survived`
- `buildErrors` -> `MutationResult.noCoverage`
- `timeouts` -> `MutationResult.timeout`
- `score` -> `MutationResult.score`
- surviving mutants -> `MutationResult.survivingMutants`

## First repository layout

```text
cxx-mutant/
  README.md
  LICENSE
  pyproject.toml
  src/cxx_mutant/
    __init__.py
    cli.py
    config.py
    discover.py
    mutate.py
    runner.py
    report.py
    token_mode.py
    clang_mode.py
  tests/
    fixtures/
    test_discover.py
    test_mutate_restore.py
    test_report_schema.py
    test_cli.py
  docs/
    config.md
    reports.md
    marmorkrebs.md
    mutators.md
  examples/
    minimal/
    cmake/
    pytorch-mps/
```

Python is the lowest-friction first packaging route because the current engine is Python and the tool will often be invoked from heterogeneous repos. A later Rust or C++ rewrite is only justified if parallelism, parsing, or packaging becomes painful.

## Milestones

### M0: extraction without behavior change

- Move the embedded Python engine into a standalone repo.
- Keep token-level mutation behavior equivalent.
- Add CLI tests for report generation and exit codes.
- Add docs for local PR-gate use.
- Update Marmorkrebs to call the external tool when present.

### M1: product-quality CLI

- Add `list-mutants` and `run-mutant`.
- Add stable mutant IDs.
- Add config file support.
- Add markdown report generation.
- Add dirty-tree checks and safer artifact handling.

### M2: safer execution

- Add timeout handling.
- Add resume from report.
- Add isolated worktree mode.
- Add sharding groundwork.

### M3: clang-aware mutation

- Add `--mode clang` behind an explicit flag.
- Read `compile_commands.json`.
- Generate AST-confirmed mutants for core operators.
- Compare token-mode and clang-mode output on known fixtures.

### M4: CI and ecosystem parity

- Publish installable package.
- Add GitHub Actions examples.
- Add SARIF or annotation output.
- Add threshold policy docs.
- Add equivalent-mutant annotation flow.

## Acceptance criteria for independence

The standalone tool is ready to be treated as independent when:

- It can run outside Marmorkrebs with only documented CLI/config inputs.
- It has tests for discovery, mutation application, restoration, report schema, and exit codes.
- Marmorkrebs can use it as an external provider.
- A real C++/ObjC++ repo can run it from a clean checkout and get a deterministic JSON report.
- A survivor can be reproduced with a single `run-mutant` command.
- An interrupted run leaves the target repo recoverable and reports what happened.

## Open decisions

- Repository name: `cxx-mutant`, `marmorkrebs-cxx`, or `claw-mutant-cxx`.
- Initial license.
- Whether Metal support remains token-only or gets its own shader-aware mode.
- Whether thresholding belongs in `cxx-mutant`, Marmorkrebs, or both.
- Whether clang-aware mode should be Python/libclang or a compiled helper binary.
