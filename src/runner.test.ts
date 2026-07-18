import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finalizeStrykerNetGroups, findMutationReport, findStrykerNetTestProject, reconcileResult, runMutationAnalysis } from "./runner.js";
import { EMPTY_RESULT, type MutationConfig, type MutationResult } from "./types.js";

function result(overrides: Partial<MutationResult>): MutationResult {
  return { ...EMPTY_RESULT, tool: "gomu", error: null, ...overrides };
}

describe("findMutationReport (Node report locator — replaces the shell find|cat)", () => {
  it("finds a mutation-report.json under a reports/ subtree", () => {
    const root = mkdtempSync(join(tmpdir(), "mk-report-"));
    try {
      mkdirSync(join(root, "reports"), { recursive: true });
      writeFileSync(join(root, "reports", "mutation-report.json"), "{}");
      const found = findMutationReport(root);
      assert.ok(found && found.replace(/\\/g, "/").endsWith("reports/mutation-report.json"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns null when there is no report (fail-closed: parser then errors on empty)", () => {
    const root = mkdtempSync(join(tmpdir(), "mk-report-"));
    try {
      mkdirSync(join(root, "logs"), { recursive: true });
      writeFileSync(join(root, "logs", "other.json"), "{}");
      assert.equal(findMutationReport(root), null); // not under reports/, not the report name
      assert.equal(findMutationReport(join(root, "does-not-exist")), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

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

  it("#25: an allowed empty run still passes a threshold — reconcile normalizes the now-0 empty score", () => {
    // Post-#25, a parser scores a proved-nothing run 0 (a perfect score must imply a detected
    // mutant). An explicitly-allowed empty run must still PASS as it did before #25, so that 0
    // must never reach the CLI's `--threshold` check (score < threshold → exit 2). reconcileResult
    // normalizes an allowed empty run to the canonical passing empty result.
    const allowed = reconcileResult(
      result({ totalMutants: 0, score: 0 }), // the parser's honest empty score, post-#25
      OK_EXEC,
      { tool: "gomu", allowEmpty: true } as MutationConfig,
    );
    assert.equal(allowed.error, null);
    assert.equal(allowed.score, 1, "an allowed empty run must not read as a threshold failure");
    assert.equal(allowed.totalMutants, 0);
  });

  it("does NOT normalize a corrupt totalMutants=0 report that carries scored mutants (no erasing survivors)", () => {
    // cargo-mutants/cxx read totalMutants from the report, so a corrupt report can claim total 0
    // while carrying real scored mutants / survivors. The allow-empty normalization must not scrub
    // that into a perfect pass — it fails closed as corrupt evidence. Each scored dimension is
    // exercised INDEPENDENTLY (with empty survivingMutants) so that no single count can be dropped
    // from the corrupt-detection sum without a test noticing, plus the survivors-only direction.
    const surv = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        file: `a${i}.rs`,
        line: i + 1,
        mutator: "m",
        description: "x->y",
        status: "survived" as const,
      }));
    const corruptCases: Array<Partial<MutationResult>> = [
      { killed: 2 }, // killed without a matching total
      { survived: 3 }, // survived count with no array entries
      { timeout: 1 },
      { noCoverage: 4 },
      { survived: 2, survivingMutants: surv(2) }, // count + array survivors
      { survivingMutants: surv(1) }, // survivor in the array, all counts 0
    ];
    for (const c of corruptCases) {
      const r = reconcileResult(result({ totalMutants: 0, score: 0, ...c }), OK_EXEC, {
        tool: "cargo-mutants",
        allowEmpty: true,
      } as MutationConfig);
      assert.notEqual(r.error, null, `corrupt total=0 with ${JSON.stringify(c)} must fail closed`);
      assert.match(r.error ?? "", /corrupt counts/);
    }
    // a genuinely all-zero allowed run is still the canonical empty PASS (not caught by the guard)
    const genuinelyEmpty = reconcileResult(result({ totalMutants: 0, score: 0 }), OK_EXEC, {
      tool: "cargo-mutants",
      allowEmpty: true,
    } as MutationConfig);
    assert.equal(genuinelyEmpty.error, null);
    assert.equal(genuinelyEmpty.score, 1);
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

describe("finalizeStrykerNetGroups (grouped merge, fail-closed)", () => {
  const merged = (o: Partial<MutationResult>): MutationResult => ({
    ...EMPTY_RESULT,
    tool: "stryker-net",
    survivingMutants: [],
    error: null,
    ...o,
  });

  it("#25 regression: an all-empty allowed grouped run PASSES (score 1), not the merge recompute of 0", () => {
    // Every group was an allowed-empty run (each reconciled to EMPTY_RESULT, contributing 0 counts),
    // so merged.totalMutants === 0. Recomputing mutationScore(0,0,0,0) would yield 0 (post-#25) and
    // fail --threshold — the exact allow-empty regression on the ONE lane whose merged result is not
    // the reconciled result. Must present the canonical empty PASS instead.
    const r = finalizeStrykerNetGroups(merged({ totalMutants: 0 }), []);
    assert.equal(r.error, null);
    assert.equal(r.score, 1, "an allowed all-empty grouped run must not read as a threshold failure");
    assert.equal(r.totalMutants, 0);
    assert.equal(r.tool, "stryker-net");
  });

  it("recomputes the merged score from pooled counts when mutants were scored", () => {
    const r = finalizeStrykerNetGroups(merged({ totalMutants: 4, killed: 2, timeout: 1, survived: 1 }), []);
    assert.equal(r.error, null);
    assert.equal(r.score, 0.75); // (2 killed + 1 timeout) / 4
  });

  it("a real survivor across groups is NOT masked by the empty normalization", () => {
    const r = finalizeStrykerNetGroups(merged({ totalMutants: 2, killed: 1, survived: 1 }), []);
    assert.equal(r.error, null);
    assert.equal(r.score, 0.5);
  });

  it("any group failure fails the whole run closed with score 0", () => {
    const r = finalizeStrykerNetGroups(merged({ totalMutants: 0 }), ["Lib: compile error"]);
    assert.equal(r.score, 0);
    assert.match(r.error ?? "", /failed in one or more project scopes/);
    assert.match(r.error ?? "", /compile error/);
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

  const testCsproj = (ref: string) =>
    '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup>' +
    '<PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.0.0" />' +
    `<ProjectReference Include="${ref}" />` +
    "</ItemGroup></Project>";

  it("#28: prefers the co-located unit-test project over a distant integration project that also references the source", () => {
    // The Stryker.NET self-mutation repro: two test projects reference Core.csproj — a sibling
    // unit-test project (unit-covers the file) and a distant integration project (does not). The
    // integration tree sorts BEFORE src/ in the walk, so the old first-hit logic picked it →
    // totalMutants: 0. Ranking must pick the unit-test project.
    const repo = mkdtempSync(join(tmpdir(), "mk-sn-"));
    try {
      mkdirSync(join(repo, "src", "Core"), { recursive: true });
      mkdirSync(join(repo, "src", "Core.UnitTest"), { recursive: true });
      mkdirSync(join(repo, "integrationtest", "Validation"), { recursive: true });
      writeFileSync(join(repo, "src", "Core", "Core.csproj"), "<Project Sdk=\"Microsoft.NET.Sdk\"/>");
      writeFileSync(join(repo, "src", "Core.UnitTest", "Core.UnitTest.csproj"), testCsproj("..\\Core\\Core.csproj"));
      writeFileSync(join(repo, "integrationtest", "Validation", "Validation.csproj"), testCsproj("..\\..\\src\\Core\\Core.csproj"));
      const found = findStrykerNetTestProject(repo, join(repo, "src", "Core"));
      assert.equal(found, "../Core.UnitTest/Core.UnitTest.csproj");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("#28: prefers a name-matching <Source>.Tests project even when a generic test project is walked first", () => {
    // `AAAHarness` sorts (and is walked) BEFORE `App.Tests`, so the pre-#28 first-hit logic would
    // return it. Name match must override walk order and pick `App.Tests`. Walk order diverging from
    // the correct answer is what makes this test actually exercise the ranking (not the fallback).
    const repo = mkdtempSync(join(tmpdir(), "mk-sn-"));
    try {
      mkdirSync(join(repo, "App"), { recursive: true });
      mkdirSync(join(repo, "AAAHarness"), { recursive: true });
      mkdirSync(join(repo, "App.Tests"), { recursive: true });
      writeFileSync(join(repo, "App", "App.csproj"), "<Project Sdk=\"Microsoft.NET.Sdk\"/>");
      writeFileSync(join(repo, "AAAHarness", "AAAHarness.csproj"), testCsproj("..\\App\\App.csproj"));
      writeFileSync(join(repo, "App.Tests", "App.Tests.csproj"), testCsproj("..\\App\\App.csproj"));
      const found = findStrykerNetTestProject(repo, join(repo, "App"));
      assert.equal(found, "../App.Tests/App.Tests.csproj");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("#28: within the same name rank, the closer test project wins (proximity tiebreak)", () => {
    // Two plain (non-name-matching, non-integration) test projects both reference App: the nearer
    // one must win purely on proximity.
    const repo = mkdtempSync(join(tmpdir(), "mk-sn-"));
    try {
      mkdirSync(join(repo, "src", "App"), { recursive: true });
      mkdirSync(join(repo, "src", "Near"), { recursive: true });
      mkdirSync(join(repo, "extras", "deep", "Far"), { recursive: true });
      writeFileSync(join(repo, "src", "App", "App.csproj"), "<Project Sdk=\"Microsoft.NET.Sdk\"/>");
      writeFileSync(join(repo, "src", "Near", "Near.csproj"), testCsproj("..\\App\\App.csproj"));
      writeFileSync(join(repo, "extras", "deep", "Far", "Far.csproj"), testCsproj("..\\..\\..\\src\\App\\App.csproj"));
      const found = findStrykerNetTestProject(repo, join(repo, "src", "App"));
      assert.equal(found, "../Near/Near.csproj");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("#28: an integration-named source's own unit tests are picked (no 'integration' substring penalty)", () => {
    // A source product named `<Something>.Integration` has legitimate unit tests
    // `<Something>.Integration.Tests`. A substring "integration" penalty on the candidate path would
    // wrongly demote those real unit tests and let a generic `Harness` win → 0 killed → false gate
    // failure. Ranking on name/proximity only, the name-matching unit tests (rank 2) win over the
    // walked-first generic (rank 1) regardless of the "integration" in the shared product name.
    const repo = mkdtempSync(join(tmpdir(), "mk-sn-"));
    try {
      mkdirSync(join(repo, "Payments.Integration"), { recursive: true });
      mkdirSync(join(repo, "Harness"), { recursive: true });
      mkdirSync(join(repo, "Payments.Integration.Tests"), { recursive: true });
      writeFileSync(join(repo, "Payments.Integration", "Payments.Integration.csproj"), "<Project Sdk=\"Microsoft.NET.Sdk\"/>");
      writeFileSync(join(repo, "Harness", "Harness.csproj"), testCsproj("..\\Payments.Integration\\Payments.Integration.csproj"));
      writeFileSync(
        join(repo, "Payments.Integration.Tests", "Payments.Integration.Tests.csproj"),
        testCsproj("..\\Payments.Integration\\Payments.Integration.csproj"),
      );
      const found = findStrykerNetTestProject(repo, join(repo, "Payments.Integration"));
      assert.equal(found, "../Payments.Integration.Tests/Payments.Integration.Tests.csproj");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("#28: a sibling product's test project does NOT name-match the source (suffix must be a whole test token)", () => {
    // `App.Extras.Tests` (a different product's tests) is walked BEFORE `App.Tests` and starts with
    // "App", but its remainder "extras.tests" is not a whole test token, so it must stay rank 1 and
    // lose to the exact `App.Tests`. Without the whole-token check it would tie at rank 2 and win by
    // walk order.
    const repo = mkdtempSync(join(tmpdir(), "mk-sn-"));
    try {
      mkdirSync(join(repo, "App"), { recursive: true });
      mkdirSync(join(repo, "App.Extras.Tests"), { recursive: true });
      mkdirSync(join(repo, "App.Tests"), { recursive: true });
      writeFileSync(join(repo, "App", "App.csproj"), "<Project Sdk=\"Microsoft.NET.Sdk\"/>");
      writeFileSync(join(repo, "App.Extras.Tests", "App.Extras.Tests.csproj"), testCsproj("..\\App\\App.csproj"));
      writeFileSync(join(repo, "App.Tests", "App.Tests.csproj"), testCsproj("..\\App\\App.csproj"));
      const found = findStrykerNetTestProject(repo, join(repo, "App"));
      assert.equal(found, "../App.Tests/App.Tests.csproj");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("#28: a numeric-suffixed sibling product (Foo2.Tests vs source Foo) does NOT name-match", () => {
    // Only separators are stripped from the suffix, not digits: `Foo2.Tests` -> remainder `2tests`
    // (not a token) -> rank 1, so it must lose to the real `Foo.Tests` (rank 2) EVEN though the
    // sibling sits closer. Stripping all non-letters would make `2.tests` -> `tests` -> rank 2 and
    // the nearer sibling would wrongly win.
    const repo = mkdtempSync(join(tmpdir(), "mk-sn-"));
    try {
      mkdirSync(join(repo, "Foo"), { recursive: true });
      mkdirSync(join(repo, "Foo2.Tests"), { recursive: true });
      mkdirSync(join(repo, "far", "Foo.Tests"), { recursive: true });
      writeFileSync(join(repo, "Foo", "Foo.csproj"), "<Project Sdk=\"Microsoft.NET.Sdk\"/>");
      writeFileSync(join(repo, "Foo2.Tests", "Foo2.Tests.csproj"), testCsproj("..\\Foo\\Foo.csproj"));
      writeFileSync(join(repo, "far", "Foo.Tests", "Foo.Tests.csproj"), testCsproj("..\\..\\Foo\\Foo.csproj"));
      const found = findStrykerNetTestProject(repo, join(repo, "Foo"));
      assert.equal(found, "../far/Foo.Tests/Foo.Tests.csproj");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("#28: the tests-first `<Source>.Tests.Unit` layout name-matches (not just `<Source>.UnitTest`)", () => {
    // The common .NET `tests/Foo.Tests.Unit` + `tests/Foo.Tests.Integration` layout: `Foo.Tests.Unit`
    // strips to `testsunit` (a token) → rank 2, `Foo.Tests.Integration` → `testsintegration` (not a
    // token) → rank 1. The integration project is walked FIRST, so nameRank — not walk order — must
    // pick the unit project.
    const repo = mkdtempSync(join(tmpdir(), "mk-sn-"));
    try {
      mkdirSync(join(repo, "src", "Foo"), { recursive: true });
      mkdirSync(join(repo, "tests", "Foo.Tests.Unit"), { recursive: true });
      mkdirSync(join(repo, "tests", "Foo.Tests.Integration"), { recursive: true });
      writeFileSync(join(repo, "src", "Foo", "Foo.csproj"), "<Project Sdk=\"Microsoft.NET.Sdk\"/>");
      writeFileSync(join(repo, "tests", "Foo.Tests.Unit", "Foo.Tests.Unit.csproj"), testCsproj("..\\..\\src\\Foo\\Foo.csproj"));
      writeFileSync(join(repo, "tests", "Foo.Tests.Integration", "Foo.Tests.Integration.csproj"), testCsproj("..\\..\\src\\Foo\\Foo.csproj"));
      const found = findStrykerNetTestProject(repo, join(repo, "src", "Foo"));
      assert.equal(found, "../../tests/Foo.Tests.Unit/Foo.Tests.Unit.csproj");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
