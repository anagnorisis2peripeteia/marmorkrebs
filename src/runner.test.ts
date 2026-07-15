import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findStrykerNetTestProject, reconcileResult, runMutationAnalysis } from "./runner.js";
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

  it("surfaces the tool's stderr when a parse error accompanies a crashed tool", () => {
    const r = reconcileResult(
      result({ error: "Failed to parse Stryker.NET output: No JSON output from Stryker.NET" }),
      {
        ...OK_EXEC,
        exitCode: 134,
        stderr: "Stryker.Abstractions.Exceptions.CompilationException: Internal error due to compile error.",
      },
      { tool: "stryker-net" } as MutationConfig,
    );
    assert.match(r.error ?? "", /No JSON output/); // parse symptom kept
    assert.match(r.error ?? "", /CompilationException/); // real cause surfaced, not swallowed
    assert.match(r.error ?? "", /exited 134/);
  });

  it("surfaces spawn errors when a parse failure has no stderr output", () => {
    const r = reconcileResult(
      result({ error: "Failed to parse Stryker.NET output: No JSON output from Stryker.NET" }),
      {
        ...OK_EXEC,
        exitCode: 127,
        spawnError: "sh: 1: bash: not found",
      },
      { tool: "stryker-net" } as MutationConfig,
    );
    assert.match(r.error ?? "", /No JSON output/);
    assert.match(r.error ?? "", /bash: not found/);
  });

  it("appends the exit code even when a failed run has empty stderr (silent death still carries its code)", () => {
    const r = reconcileResult(
      result({ error: "Failed to parse" }),
      { ...OK_EXEC, exitCode: 1, stderr: "   " },
      { tool: "gomu" } as MutationConfig,
    );
    assert.match(r.error ?? "", /Failed to parse/);
    assert.match(r.error ?? "", /tool exited 1/);
    assert.doesNotMatch(r.error ?? "", /tool stderr/); // no empty stderr tail block
  });

  it("truncates a very long tool stderr to the tail", () => {
    const long = "X".repeat(5000) + "REAL_CAUSE_AT_END";
    const r = reconcileResult(
      result({ error: "parse fail" }),
      { ...OK_EXEC, exitCode: 1, stderr: long },
      { tool: "gomu" } as MutationConfig,
    );
    assert.match(r.error ?? "", /REAL_CAUSE_AT_END/); // tail (with the real cause) kept
    assert.ok((r.error ?? "").length < long.length); // and truncated, not the whole dump
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

  it("errors when mutants exist but NONE were scored (vacuous run, any lane)", () => {
    // gomu all-notViable / cargo-mutants all-unviable / stryker all-Ignored shapes:
    // totalMutants > 0 so the empty-run check passes, but nothing was scored.
    const r = reconcileResult(
      result({ totalMutants: 7, ignored: 7, score: 1 }),
      OK_EXEC,
      { tool: "gomu" } as MutationConfig,
    );
    assert.match(r.error ?? "", /NONE were scored/);

    const withAllowEmpty = reconcileResult(
      result({ totalMutants: 7, ignored: 7, score: 1 }),
      OK_EXEC,
      { tool: "gomu", allowEmpty: true } as MutationConfig,
    );
    assert.notEqual(withAllowEmpty.error, null, "allowEmpty covers empty DIFFS, not vacuous runs");
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

  let repoDir: string;

  function makeFake(mode: string) {
    dir = mkdtempSync(join(tmpdir(), "marmorkrebs-fakecrab-runner-"));
    repoDir = mkdtempSync(join(tmpdir(), "marmorkrebs-fakecrab-repo-"));
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
    rmSync(repoDir, { recursive: true, force: true });
  }

  function callLog(): string[] {
    return readFileSync(calls, "utf8").split("\n").filter(Boolean);
  }

  it("runInCrabbox full lifecycle: parses report; stop+cleanup always run", () => {
    makeFake("ok");
    try {
      const r = runMutationAnalysis(repoDir, ["a.go"], {
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
      const r = runMutationAnalysis(repoDir, ["a.go"], {
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
      const r = runMutationAnalysis(repoDir, ["a.go"], {
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
      const r = runMutationAnalysis(repoDir, ["a.go"], {
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
  "stryker-net crabbox project grouping (issue #17)",
  { skip: process.platform === "win32" ? "fake crabbox needs POSIX exec" : false },
  () => {
    // Field-for-field subset of the Stryker.NET mutation-report.json schema already
    // validated against the real tool in parsers/stryker-net.test.ts + the stryker-net
    // provider validator; this suite exercises grouping/merging, not parser fidelity.
    // Both grouped runs return it, so the merged result and survivor re-anchoring are
    // what distinguish the groups.
    const CANNED_STRYKER_NET_REPORT = JSON.stringify({
      files: {
        "Calc.cs": {
          mutants: [
            { status: "Killed", mutatorName: "ArithmeticOperator", location: { start: { line: 3 } } },
            { status: "Survived", mutatorName: "EqualityOperator", location: { start: { line: 7 } } },
            { status: "Timeout", mutatorName: "StringLiteral", location: { start: { line: 9 } } },
            { status: "NoCoverage", mutatorName: "BlockStatement", location: { start: { line: 11 } } },
            { status: "Ignored", mutatorName: "EqualityOperator", location: { start: { line: 13 } } },
          ],
        },
      },
    });

    // Same real-gomu-0.2.1 shape as the sibling crabbox suite's canned report; used to
    // prove non-stryker-net tools stay on the generic single-command path.
    const CANNED_GROUPING_GOMU_REPORT = JSON.stringify({
      statistics: { killed: 1, survived: 0, timedOut: 0, errors: 0, notViable: 0, mutationScore: 100 },
      results: [
        { mutant: { id: "x", filePath: "a.go", line: 3, type: "t", original: "+", mutated: "-" }, status: "KILLED" },
      ],
      duration: 1_000_000,
    });

    let dir: string;
    let repoDir: string;
    let calls: string;

    function makeFake(mode: string) {
      dir = mkdtempSync(join(tmpdir(), "marmorkrebs-fakecrab-groups-"));
      repoDir = mkdtempSync(join(tmpdir(), "marmorkrebs-fakecrab-groups-repo-"));
      calls = join(dir, "calls.log");
      writeFileSync(calls, "");
      const bin = join(dir, "crabbox");
      writeFileSync(
        bin,
        `#!/bin/bash
echo "$@" >> "${calls}"
case "${mode}:$1" in
  *:run) echo "lease=fake-lease-9"; exit 0 ;;
  ok:ssh) printf '%s' '${CANNED_STRYKER_NET_REPORT}'; exit 0 ;;
  gomu:ssh) printf '%s' '${CANNED_GROUPING_GOMU_REPORT}'; exit 0 ;;
  dead:ssh) echo "container gone" >&2; exit 127 ;;
  *) exit 0 ;;
esac
`,
        { mode: 0o755 },
      );
      process.env.CRABBOX_BIN = bin;

      // Two source projects plus a sibling test project referencing only App:
      // App gets --test-project, Lib must not.
      mkdirSync(join(repoDir, "App"));
      mkdirSync(join(repoDir, "App.Tests"));
      mkdirSync(join(repoDir, "Lib"));
      writeFileSync(join(repoDir, "App", "App.csproj"), "<Project />\n");
      writeFileSync(join(repoDir, "App", "Calc.cs"), "class C {}\n");
      writeFileSync(
        join(repoDir, "App.Tests", "App.Tests.csproj"),
        '<Project><ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk" />' +
          '<ProjectReference Include="../App/App.csproj" /></ItemGroup></Project>\n',
      );
      writeFileSync(join(repoDir, "Lib", "Lib.csproj"), "<Project />\n");
      writeFileSync(join(repoDir, "Lib", "Util.cs"), "class U {}\n");
    }

    function cleanupFake() {
      delete process.env.CRABBOX_BIN;
      rmSync(dir, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
    }

    function sshCommands(): string[] {
      return readFileSync(calls, "utf8")
        .split("\n")
        .filter((line) => line.startsWith("ssh "));
    }

    it("runs one grouped exec per project with remote workdirs, test-project discovery, and merged survivors", () => {
      makeFake("ok");
      try {
        const r = runMutationAnalysis(repoDir, ["App/Calc.cs", "Lib/Util.cs"], {
          tool: "stryker-net",
          leaseId: "fake-lease-9",
          skipSync: true,
        } as MutationConfig);
        assert.equal(r.error, null);

        const cmds = sshCommands();
        assert.equal(cmds.length, 2, "one crabbox exec per project group");
        const appCmd = cmds.find((c) => c.includes("cd '/tmp/mutation-target/App'"));
        const libCmd = cmds.find((c) => c.includes("cd '/tmp/mutation-target/Lib'"));
        assert.ok(appCmd, "App group must run in the translated remote project dir");
        assert.ok(libCmd, "Lib group must run in the translated remote project dir");
        assert.match(appCmd ?? "", /--mutate '\*\*\/Calc\.cs'/);
        assert.match(appCmd ?? "", /--test-project '\.\.\/App\.Tests\/App\.Tests\.csproj'/);
        assert.ok(!(libCmd ?? "").includes("--test-project"), "Lib has no referencing test project");

        // Both canned reports: 1 each of killed/survived/timeout/noCoverage/ignored,
        // so every merge accumulator is distinguishable from its mutated inverse.
        assert.equal(r.totalMutants, 10);
        assert.equal(r.killed, 2);
        assert.equal(r.survived, 2);
        assert.equal(r.timeout, 2);
        assert.equal(r.noCoverage, 2);
        assert.equal(r.ignored, 2);
        assert.equal(r.score, 0.5); // (killed+timeout) / (killed+timeout+survived+noCoverage)
        assert.ok(r.elapsedMs >= 0 && r.elapsedMs < 5 * 60 * 1000, "elapsedMs must be wall time");
        assert.deepEqual(
          r.survivingMutants.map((m) => m.file).sort(),
          ["App/Calc.cs", "App/Calc.cs", "Lib/Calc.cs", "Lib/Calc.cs"],
          "survivor + no-coverage paths must be re-anchored to the repo root per group",
        );
      } finally {
        cleanupFake();
      }
    });

    it("groups on the fresh-lease crabbox lane too, and non-stryker-net tools keep the generic path", () => {
      makeFake("ok");
      try {
        // Fresh lease (runInCrabbox): stryker-net must still group per project.
        const r = runMutationAnalysis(repoDir, ["App/Calc.cs", "Lib/Util.cs"], {
          tool: "stryker-net",
          crabbox: { provider: "tart" },
        } as MutationConfig);
        assert.equal(r.error, null);
        const cmds = sshCommands();
        assert.equal(cmds.length, 2, "one exec per project on the fresh-lease lane");
        assert.ok(cmds.every((c) => c.includes("dotnet stryker")));
      } finally {
        cleanupFake();
      }

      makeFake("gomu");
      try {
        // gomu on both crabbox lanes must keep the generic single-command path:
        // routing it through the stryker-net grouping would still "work" against the
        // canned report, so assert on the actual command shape.
        const lease = runMutationAnalysis(repoDir, ["a.go"], {
          tool: "gomu",
          leaseId: "fake-lease-9",
          skipSync: true,
        } as MutationConfig);
        assert.equal(lease.error, null);
        const fresh = runMutationAnalysis(repoDir, ["a.go"], {
          tool: "gomu",
          crabbox: { provider: "tart" },
        } as MutationConfig);
        assert.equal(fresh.error, null);
        const cmds = sshCommands();
        assert.equal(cmds.length, 2);
        assert.ok(
          cmds.every((c) => !c.includes("dotnet stryker")),
          "gomu must never route through the stryker-net grouped path",
        );
      } finally {
        cleanupFake();
      }
    });

    it("a project at the repo root runs in the remote root with unprefixed survivors", () => {
      makeFake("ok");
      try {
        writeFileSync(join(repoDir, "Root.csproj"), "<Project />\n");
        writeFileSync(join(repoDir, "Calc.cs"), "class R {}\n");
        const r = runMutationAnalysis(repoDir, ["Calc.cs"], {
          tool: "stryker-net",
          leaseId: "fake-lease-9",
          skipSync: true,
        } as MutationConfig);
        assert.equal(r.error, null);
        const cmds = sshCommands();
        assert.equal(cmds.length, 1);
        assert.ok(
          cmds[0].includes("cd '/tmp/mutation-target' &&"),
          "repo-root project must run in the remote root, not a subdir or trailing slash",
        );
        assert.deepEqual(
          r.survivingMutants.map((m) => m.file).sort(),
          ["Calc.cs", "Calc.cs"],
          "repo-root survivors must keep unprefixed paths",
        );
      } finally {
        cleanupFake();
      }
    });

    it("a failed project scope fails the whole run closed with score 0", () => {
      makeFake("dead");
      try {
        const r = runMutationAnalysis(repoDir, ["App/Calc.cs", "Lib/Util.cs"], {
          tool: "stryker-net",
          leaseId: "fake-lease-9",
          skipSync: true,
        } as MutationConfig);
        assert.match(r.error ?? "", /failed in one or more project scopes/);
        assert.match(r.error ?? "", /App: /, "failure must name the App scope");
        assert.match(r.error ?? "", /Lib: /, "failure must name the Lib scope");
        assert.equal(r.score, 0);
        assert.ok(r.elapsedMs >= 0 && r.elapsedMs < 5 * 60 * 1000, "elapsedMs must be wall time");
      } finally {
        cleanupFake();
      }
    });
  },
);

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

describe("per-repo lock", () => {
  it("refuses to run while a live pid holds the lock", () => {
    const dir = mkdtempSync(join(tmpdir(), "marmorkrebs-lock-"));
    writeFileSync(join(dir, "x.go"), "package x\n");
    writeFileSync(
      join(dir, ".marmorkrebs.lock"),
      JSON.stringify({ pid: process.pid, started: new Date().toISOString() }),
    );
    try {
      const r = runMutationAnalysis(dir, ["x.go"], { tool: "gomu" } as MutationConfig);
      assert.match(r.error ?? "", /another marmorkrebs run/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("steals a dead-pid lock and always releases afterwards", () => {
    const dir = mkdtempSync(join(tmpdir(), "marmorkrebs-lock2-"));
    writeFileSync(join(dir, "go.mod"), "module locktest\n\ngo 1.21\n");
    writeFileSync(join(dir, "x.go"), "package locktest\n\nfunc F(a int) int { return a + 1 }\n");
    writeFileSync(
      join(dir, ".marmorkrebs.lock"),
      JSON.stringify({ pid: 2147483646, started: new Date().toISOString() }),
    );
    const origPath = process.env.PATH;
    try {
      process.env.PATH = "/usr/bin:/bin"; // gomu hidden: run fails, but NOT on the lock
      const r = runMutationAnalysis(dir, ["x.go"], { tool: "gomu" } as MutationConfig);
      assert.doesNotMatch(r.error ?? "", /another marmorkrebs run/);
      assert.ok(!existsSync(join(dir, ".marmorkrebs.lock")), "lock must be released in finally");
    } finally {
      process.env.PATH = origPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("findStrykerNetTestProject (issue #14: multi-project repos)", () => {
  it("finds the sibling test csproj that references the source project", () => {
    const repo = mkdtempSync(join(tmpdir(), "mk-sn-"));
    try {
      mkdirSync(join(repo, "App"), { recursive: true });
      mkdirSync(join(repo, "AppTests"), { recursive: true });
      writeFileSync(join(repo, "App", "App.csproj"), "<Project Sdk=\"Microsoft.NET.Sdk\"/>");
      writeFileSync(
        join(repo, "AppTests", "AppTests.csproj"),
        '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup>' +
          '<PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.0.0" />' +
          // backslash separators are DELIBERATE: real csproj content is Windows-style,
          // and this asserts the discovery normalizes them on every platform
          '<ProjectReference Include="..\\App\\App.csproj" />' +
          "</ItemGroup></Project>",
      );
      const found = findStrykerNetTestProject(repo, join(repo, "App"));
      assert.equal(found, "../AppTests/AppTests.csproj");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("returns undefined when no test project references the source project", () => {
    const repo = mkdtempSync(join(tmpdir(), "mk-sn-"));
    try {
      mkdirSync(join(repo, "App"), { recursive: true });
      writeFileSync(join(repo, "App", "App.csproj"), "<Project Sdk=\"Microsoft.NET.Sdk\"/>");
      const found = findStrykerNetTestProject(repo, join(repo, "App"));
      assert.equal(found, undefined);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
