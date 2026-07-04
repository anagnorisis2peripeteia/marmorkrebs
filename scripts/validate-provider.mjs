#!/usr/bin/env node
// Live provider validation — fires the REAL mutation tool through
// runMutationAnalysis against a fixtures/<tool> micro-project.
//
// Written after the 2026-07-03 audit: the gomu lane shipped broken for three
// weeks because its unit tests fed the parser hand-written fixtures shaped like
// the parser's own interface — a closed loop that cannot detect a wrong CLI flag
// or a report written to disk instead of stdout. Only invoking the real binary
// can. A lane may not leave quarantine (runner.ts QUARANTINED_TOOLS) until its
// spec here passes.
//
// Usage:
//   node scripts/validate-provider.mjs <tool>    validate one lane (exit 3 if binary absent)
//   node scripts/validate-provider.mjs --all     validate every lane whose binary is present
//
// Each spec asserts the failure modes that actually bit us:
//   - a multi-file diff runs end to end (score, no error)
//   - survivors ARE reported for a changed-but-untested file
//   - survivors are NOT reported for an untested UNCHANGED neighbour
//   - no tool artifacts are left in the target directory
//   - with the binary hidden from PATH, the run ERRORS (fail-closed proof)

import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// pathToFileURL: a bare absolute path is not a valid ESM specifier on Windows
// (ERR_UNSUPPORTED_ESM_URL_SCHEME — caught by this job's first windows run).
const { runMutationAnalysis } = await import(pathToFileURL(join(ROOT, "dist/runner.js")).href);

// Tool binaries often live outside a lean shell's PATH; make the validator (and the
// runs it spawns) see the standard per-user install dirs.
const EXTRA_BIN_DIRS = [
  `${process.env.HOME}/.cargo/bin`,
  `${process.env.HOME}/go/bin`,
  "/opt/homebrew/bin",
];
process.env.PATH = `${EXTRA_BIN_DIRS.join(":")}:${process.env.PATH}`;

const SPECS = {
  gomu: {
    binary: "gomu",
    fixture: "fixtures/gomu",
    changedFiles: ["a.go", "b.go", "pkg/c.go"],
    minMutants: 8,
    survivorsIn: ["b.go"], // changed, untested -> must be flagged
    noSurvivorsIn: ["pkg/d.go"], // unchanged, untested neighbour -> must be filtered out
    forbiddenArtifacts: [".gomu_history.json", "mutation-report.json"],
  },
  "go-mutesting": {
    binary: "go-mutesting", // avito-tech fork; zimmski upstream finds 0 mutants on Go modules
    fixture: "fixtures/gomu",
    changedFiles: ["a.go", "b.go"],
    minMutants: 2,
    survivorsIn: ["b.go"],
    noSurvivorsIn: ["pkg/d.go"],
    forbiddenArtifacts: ["mutation-report.json"],
  },
  "cargo-mutants": {
    binary: "cargo-mutants",
    fixture: "fixtures/cargo-mutants",
    changedFiles: ["src/lib.rs", "src/untested.rs"],
    minMutants: 8,
    survivorsIn: ["src/untested.rs"],
    noSurvivorsIn: ["src/other.rs"], // unchanged neighbour excluded via --file scoping
    forbiddenArtifacts: ["mutants.out"],
  },
  mutmut: {
    binary: "mutmut",
    fixture: "fixtures/mutmut",
    changedFiles: ["calclib/tested.py", "calclib/untested.py"],
    minMutants: 2,
    survivorsIn: ["calclib/untested.py"], // reported as no-tests -> no_coverage survivor
    noSurvivorsIn: ["calclib/neighbor.py"],
    forbiddenArtifacts: ["mutants"],
  },
  stryker: {
    binary: "stryker", // global @stryker-mutator/core (the lane auto-installs when missing, but the validator requires it present to run)
    fixture: "fixtures/stryker",
    changedFiles: ["lib/tested.js", "lib/untested.js"],
    config: { testCommand: "node test.js" },
    minMutants: 2,
    survivorsIn: ["lib/untested.js"],
    noSurvivorsIn: ["lib/neighbor.js"],
    // The stryker lane deliberately KEEPS reports/ + .stryker-tmp (git-excluded via
    // info/exclude; runLocally reads reports/mutation/mutation.json as a fallback).
    // Its hygiene contract is git-invisibility, not absence — only the throwaway
    // config must be cleaned up.
    forbiddenArtifacts: [".marmorkrebs-stryker.json"],
  },
  "stryker-net": {
    binary: "dotnet-stryker", // dotnet tool install -g dotnet-stryker (Windows CI job; local run needs the dotnet SDK)
    fixture: "fixtures/stryker-net",
    changedFiles: ["Lib/Calc.cs"],
    minMutants: 2,
    survivorsIn: ["Calc.cs"], // Sub() is untested
    noSurvivorsIn: [],
    forbiddenArtifacts: [".marmorkrebs-stryker", "StrykerOutput"],
  },
};

function binaryPath(name) {
  const r = spawnSync("bash", ["-lc", `command -v '${name}'`], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

function fail(tool, msg, result) {
  console.error(`[validate:${tool}] FAIL: ${msg}`);
  if (result) console.error(JSON.stringify(result, null, 2));
  process.exitCode = 1;
}

function validate(tool, spec) {
  const bin = binaryPath(spec.binary);
  if (!bin) return "absent";

  const work = mkdtempSync(join(tmpdir(), `marmorkrebs-validate-${tool}-`));
  const target = join(work, "fixture");
  cpSync(join(ROOT, spec.fixture), target, { recursive: true });

  try {
    // 1) Positive run against the real tool.
    const result = runMutationAnalysis(target, spec.changedFiles, { tool, ...(spec.config ?? {}) });
    if (result.error) return fail(tool, `real run errored: ${result.error}`, result);
    if (result.totalMutants < spec.minMutants) {
      return fail(tool, `expected >=${spec.minMutants} mutants, got ${result.totalMutants}`, result);
    }
    for (const f of spec.survivorsIn) {
      if (!result.survivingMutants.some((m) => m.file.endsWith(f))) {
        return fail(tool, `expected survivors in changed untested file ${f}`, result);
      }
    }
    for (const f of spec.noSurvivorsIn) {
      if (result.survivingMutants.some((m) => m.file.endsWith(f))) {
        return fail(tool, `unchanged neighbour ${f} leaked into survivors`, result);
      }
    }

    // 2) Target directory left clean.
    for (const artifact of spec.forbiddenArtifacts) {
      if (existsSync(join(target, artifact))) {
        return fail(tool, `tool artifact left behind: ${artifact}`);
      }
    }

    // 3) Fail-closed: hide the binary; the run must ERROR, never pass.
    const origPath = process.env.PATH;
    let hidden;
    try {
      process.env.PATH = "/usr/bin:/bin";
      hidden = runMutationAnalysis(target, spec.changedFiles, { tool, ...(spec.config ?? {}) });
    } finally {
      process.env.PATH = origPath;
    }
    if (!hidden.error) {
      return fail(tool, "run with binary hidden did not error (fail-open!)", hidden);
    }

    console.error(
      `[validate:${tool}] PASS — ${result.totalMutants} mutants, ` +
        `${result.killed} killed, ${result.survived} survived, score ${result.score}; ` +
        `fail-closed proof OK`,
    );
    return "pass";
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const arg = process.argv[2];
if (!arg) {
  console.error("usage: validate-provider.mjs <tool>|--all");
  process.exit(2);
}

if (arg === "--all") {
  let ran = 0;
  for (const [tool, spec] of Object.entries(SPECS)) {
    const outcome = validate(tool, spec);
    if (outcome === "absent") console.error(`[validate:${tool}] SKIP — ${spec.binary} not installed`);
    else ran++;
  }
  if (!ran) console.error("[validate] no provider binaries installed; nothing validated");
} else {
  const spec = SPECS[arg];
  if (!spec) {
    console.error(`no validation spec for '${arg}' — add one to SPECS (and a fixtures/${arg} project)`);
    process.exit(2);
  }
  const outcome = validate(arg, spec);
  if (outcome === "absent") {
    console.error(`[validate:${arg}] binary '${spec.binary}' not installed`);
    process.exit(3);
  }
}
