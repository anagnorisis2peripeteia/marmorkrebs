import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconcileResult, runMutationAnalysis } from "./runner.js";
import { EMPTY_RESULT, type MutationConfig, type MutationResult } from "./types.js";

function result(overrides: Partial<MutationResult>): MutationResult {
  return { ...EMPTY_RESULT, tool: "gomu", error: null, ...overrides };
}

const OK_EXEC = { exitCode: 0, signal: null, spawnError: null, stderr: "" };

describe("reconcileResult (fail-closed net)", () => {
  it("passes through an existing parse error untouched", () => {
    const r = reconcileResult(
      result({ error: "Failed to parse" }),
      OK_EXEC,
      { tool: "gomu" } as MutationConfig,
    );
    assert.equal(r.error, "Failed to parse");
  });

  it("errors on spawn failure", () => {
    const r = reconcileResult(
      result({ totalMutants: 5, killed: 5, score: 1 }),
      { ...OK_EXEC, spawnError: "ENOENT" },
      { tool: "gomu" } as MutationConfig,
    );
    assert.match(r.error ?? "", /failed to spawn/);
  });

  it("errors on kill signal (timeout)", () => {
    const r = reconcileResult(
      result({ totalMutants: 5, killed: 5, score: 1 }),
      { ...OK_EXEC, signal: "SIGTERM" },
      { tool: "gomu" } as MutationConfig,
    );
    assert.match(r.error ?? "", /SIGTERM/);
  });

  it("errors on zero mutants with non-zero exit — the missing-binary case", () => {
    const r = reconcileResult(
      result({ totalMutants: 0, score: 1 }),
      { ...OK_EXEC, exitCode: 127, stderr: "bash: gomu: command not found" },
      { tool: "gomu" } as MutationConfig,
    );
    assert.match(r.error ?? "", /exited 127/);
    assert.match(r.error ?? "", /command not found/);
  });

  it("errors on zero mutants even at exit 0, unless allowEmpty", () => {
    const strict = reconcileResult(result({ totalMutants: 0, score: 1 }), OK_EXEC, {
      tool: "gomu",
    } as MutationConfig);
    assert.match(strict.error ?? "", /0 mutants/);

    const allowed = reconcileResult(result({ totalMutants: 0, score: 1 }), OK_EXEC, {
      tool: "gomu",
      allowEmpty: true,
    } as MutationConfig);
    assert.equal(allowed.error, null);
  });

  it("allowEmpty does NOT mask a real tool failure", () => {
    const r = reconcileResult(
      result({ totalMutants: 0, score: 1 }),
      { ...OK_EXEC, exitCode: 127 },
      { tool: "gomu", allowEmpty: true } as MutationConfig,
    );
    assert.notEqual(r.error, null);
  });

  it("trusts a parsed result with mutants despite non-zero exit (tool's own gate)", () => {
    const r = reconcileResult(
      result({ totalMutants: 10, killed: 6, survived: 4, score: 0.6 }),
      { ...OK_EXEC, exitCode: 1 },
      { tool: "stryker" } as MutationConfig,
    );
    assert.equal(r.error, null);
    assert.equal(r.score, 0.6);
  });
});

describe("missing binary is an error, not a pass (integration)", () => {
  it("gomu absent from PATH -> result.error set", () => {
    const dir = mkdtempSync(join(tmpdir(), "marmorkrebs-nobin-"));
    writeFileSync(join(dir, "go.mod"), "module nobintest\n\ngo 1.21\n");
    writeFileSync(join(dir, "x.go"), "package nobintest\n\nfunc F(a int) int { return a + 1 }\n");
    const origPath = process.env.PATH;
    try {
      process.env.PATH = "/usr/bin:/bin"; // bash lives here; gomu does not
      const r = runMutationAnalysis(dir, ["x.go"], { tool: "gomu" } as MutationConfig);
      assert.notEqual(r.error, null, "missing binary must not score as a pass");
      assert.notEqual(r.score, 1);
    } finally {
      process.env.PATH = origPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("stryker-cxx exit-2 keeps its report (integration)", () => {
  it("below-threshold runner exit with a valid report parses instead of erroring", () => {
    const dir = mkdtempSync(join(tmpdir(), "marmorkrebs-exit2-"));
    // Stub honoring the stryker-cxx shim contract: write the v1 report to the
    // --report path, exit 2 (= below threshold-break WITH a valid report).
    const stub = join(dir, "stub-stryker-cxx");
    writeFileSync(
      stub,
      `#!/bin/bash
report=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--report" ]; then report="$a"; fi
  prev="$a"
done
cat > "$report" <<'JSON'
{"schemaVersion":"stryker-cxx.report.v1","tool":"stryker-cxx","targetFiles":["src/a.cpp"],"totalMutants":5,"killed":2,"survived":3,"buildErrors":0,"checkErrors":0,"noCoverage":0,"timeouts":0,"ignored":0,"score":0.4,"thresholds":{"high":0.9,"low":0.7,"break":0.5,"status":"failed"},"dryRun":{"status":"PASSED"}}
JSON
exit 2
`,
      { mode: 0o755 },
    );
    try {
      const r = runMutationAnalysis(dir, ["src/a.cpp"], {
        tool: "stryker-cxx",
        buildCommand: "true",
        testCommand: "true",
        strykerCxxBinary: stub,
      } as MutationConfig);
      assert.equal(r.error, null, "exit 2 with a valid report must parse, not mask");
      assert.equal(r.totalMutants, 5);
      assert.equal(r.thresholds?.status, "failed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
