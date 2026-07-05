import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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
    // Stub replaying a CAPTURED REAL report: stryker-cxx 0.1.0 live probe,
    // 2026-07-04 (2 mutants, all survived, shim exited 2 = below threshold-break).
    // Per-mutant arrays truncated; every top-level scalar + thresholds/dryRun verbatim.
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
{"schemaVersion":"stryker-cxx.report.v1","tool":"stryker-cxx","toolVersion":"0.1.0","repo":"/tmp/claude-501/-Users-cameronbeeley/d8722002-1b5d-4612-aca0-694829551895/scratchpad/cxx-probe","base":null,"startedAt":"2026-07-04T14:17:06.071332Z","completedAt":"2026-07-04T14:17:06.133829Z","threshold":1.0,"thresholds":{"high":1.0,"low":1.0,"break":1.0,"status":"failed"},"timeoutSeconds":6,"totalMutants":2,"killed":0,"survived":2,"buildErrors":0,"checkErrors":0,"noCoverage":0,"timeouts":0,"ignored":0,"score":0.0,"dryRun":{"status":"PASSED","artifacts":{"buildLog":"/tmp/claude-501/-Users-cameronbeeley/d8722002-1b5d-4612-aca0-694829551895/scratchpad/cxx-probe/agent_space/stryker-cxx/dry_run_build.log","checkLog":"/tmp/claude-501/-Users-cameronbeeley/d8722002-1b5d-4612-aca0-694829551895/scratchpad/cxx-probe/agent_space/stryker-cxx/dry_run_check.log","testLog":"/tmp/claude-501/-Users-cameronbeeley/d8722002-1b5d-4612-aca0-694829551895/scratchpad/cxx-probe/agent_space/stryker-cxx/dry_run_test.log"},"build":{"exitCode":0,"durationMs":4,"log":"/tmp/claude-501/-Users-cameronbeeley/d8722002-1b5d-4612-aca0-694829551895/scratchpad/cxx-probe/agent_space/stryker-cxx/dry_run_build.log","provider":"builtin"},"test":{"exitCode":0,"durationMs":3,"log":"/tmp/claude-501/-Users-cameronbeeley/d8722002-1b5d-4612-aca0-694829551895/scratchpad/cxx-probe/agent_space/stryker-cxx/dry_run_test.log","provider":"builtin"}},"scorePercent":0.0,"build_error":0,"check_error":0,"no_coverage":0,"total":2,"ignored_count":0}
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
      assert.equal(r.totalMutants, 2);
      assert.equal(r.thresholds?.status, "failed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe(
  "crabbox execution paths (fake crabbox binary)",
  { skip: process.platform === "win32" ? "fake crabbox needs POSIX exec" : false },
  () => {
  // Field-for-field subset of a real gomu 0.2.1 mutation-report.json (captured in the
  // 2026-07-03 live probe on fixtures/gomu; a.go arithmetic mutant, killed).
  const CANNED_GOMU_REPORT = JSON.stringify({
    statistics: { killed: 1, survived: 0, timedOut: 0, errors: 0, notViable: 0, mutationScore: 100 },
    results: [
      { mutant: { id: "x", filePath: "a.go", line: 3, type: "t", original: "+", mutated: "-" }, status: "KILLED" },
    ],
    duration: 1_000_000,
  });

  let dir: string;
  let calls: string;

  function makeFake(mode: string) {
    dir = mkdtempSync(join(tmpdir(), "marmorkrebs-fakecrab-runner-"));
    calls = join(dir, "calls.log");
    writeFileSync(calls, "");
    const bin = join(dir, "crabbox");
    writeFileSync(
      bin,
      `#!/bin/bash
echo "$1" >> "${calls}"
case "${mode}:$1" in
  *:run)   echo "lease=fake-lease-9"; exit 0 ;;
  ok:ssh)  printf '%s' '${CANNED_GOMU_REPORT}'; printf '\\n\\x1e\\n'; exit 0 ;;
  dead:ssh) exit 127 ;;
  syncfail:cache) echo "rsync down" >&2; exit 12 ;;
  *:cache) exit 0 ;;
  *) exit 0 ;;
esac
`,
      { mode: 0o755 },
    );
    process.env.CRABBOX_BIN = bin;
  }

  function cleanupFake() {
    delete process.env.CRABBOX_BIN;
    rmSync(dir, { recursive: true, force: true });
  }

  function callLog(): string[] {
    return readFileSync(calls, "utf8").split("\n").filter(Boolean);
  }

  it("runInCrabbox full lifecycle: parses report; stop+cleanup always run", () => {
    makeFake("ok");
    try {
      const r = runMutationAnalysis("/repo", ["a.go"], {
        tool: "gomu",
        crabbox: { provider: "tart" },
      } as MutationConfig);
      assert.equal(r.error, null);
      assert.equal(r.totalMutants, 1);
      assert.deepEqual(callLog(), ["run", "cache", "ssh", "stop", "cleanup"]);
    } finally {
      cleanupFake();
    }
  });

  it("runInCrabbox exec failure fails closed AND still stops/cleans the lease", () => {
    makeFake("dead");
    try {
      const r = runMutationAnalysis("/repo", ["a.go"], {
        tool: "gomu",
        crabbox: { provider: "tart" },
      } as MutationConfig);
      assert.notEqual(r.error, null, "dead remote must not pass");
      const log = callLog();
      assert.ok(log.includes("stop") && log.includes("cleanup"), "lease must not leak");
    } finally {
      cleanupFake();
    }
  });

  it("runOnExistingLease with skipSync never syncs", () => {
    makeFake("ok");
    try {
      const r = runMutationAnalysis("/repo", ["a.go"], {
        tool: "gomu",
        leaseId: "fake-lease-9",
        skipSync: true,
      } as MutationConfig);
      assert.equal(r.error, null);
      assert.ok(!callLog().includes("cache"));
    } finally {
      cleanupFake();
    }
  });

  it("runOnExistingLease sync failure is an error and skips exec", () => {
    makeFake("syncfail");
    try {
      const r = runMutationAnalysis("/repo", ["a.go"], {
        tool: "gomu",
        leaseId: "fake-lease-9",
      } as MutationConfig);
      assert.match(r.error ?? "", /crabbox sync failed/);
      assert.ok(!callLog().includes("ssh"), "must not exec after failed sync");
    } finally {
      cleanupFake();
    }
  });
});

describe(
  "stryker stale-report guard",
  { skip: process.platform === "win32" ? "PATH-hiding probe is POSIX-shaped" : false },
  () => {
    it("a failed run must not resurrect a PRE-EXISTING report as a pass", () => {
      const dir = mkdtempSync(join(tmpdir(), "marmorkrebs-stale-"));
      const reportDir = join(dir, "reports", "mutation");
      mkdirSync(reportDir, { recursive: true });
      const staleReport = JSON.stringify({
        files: {
          "lib/a.js": {
            mutants: [
              { status: "Killed", mutatorName: "t", location: { start: { line: 1 } } },
              { status: "Survived", mutatorName: "t", location: { start: { line: 2 } } },
            ],
          },
        },
      });
      writeFileSync(join(reportDir, "mutation.json"), staleReport);
      const past = new Date(Date.now() - 3_600_000);
      utimesSync(join(reportDir, "mutation.json"), past, past);
      const origPath = process.env.PATH;
      try {
        process.env.PATH = "/usr/bin:/bin"; // stryker AND npm hidden -> the run must fail
        const r = runMutationAnalysis(dir, ["lib/a.js"], {
          tool: "stryker",
          testCommand: "node test.js",
        } as MutationConfig);
        assert.notEqual(r.error, null, "stale report must never score a failed run");
        assert.equal(r.totalMutants, 0);
      } finally {
        process.env.PATH = origPath;
        rmSync(dir, { recursive: true, force: true });
      }
    });
  },
);

describe("fixtures are test data, not mutation targets", () => {
  it("a fixtures-only diff errors without --allow-empty, passes vacuously with it", () => {
    const files = ["fixtures/stryker/lib/tested.js", "fixtures/gomu/a.go"];
    const strict = runMutationAnalysis("/repo", files, { tool: "stryker" } as MutationConfig);
    assert.match(strict.error ?? "", /no mutatable sources/);

    const allowed = runMutationAnalysis("/repo", files, {
      tool: "stryker",
      allowEmpty: true,
    } as MutationConfig);
    assert.equal(allowed.error, null);
    assert.equal(allowed.totalMutants, 0);
  });
});

describe("quarantine registry", () => {
  it("mull refuses to run until validated against a real binary", () => {
    const r = runMutationAnalysis("/nonexistent", ["x.cpp"], { tool: "mull" } as MutationConfig);
    assert.match(r.error ?? "", /quarantined/);
  });
});
