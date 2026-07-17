import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildStrykerNetCommand, parseStrykerNet } from "./stryker-net.js";

describe("parseStrykerNet", () => {
  it("parses Stryker.NET mutation-report.json", () => {
    const report = {
      files: {
        "src/OpenClaw.Shared/Capabilities/BrowserProxyCapability.cs": {
          mutants: [
            { status: "Killed", mutatorName: "ArithmeticOperator", location: { start: { line: 10 } } },
            {
              status: "Survived",
              mutatorName: "EqualityOperator",
              replacement: "changed == to !=",
              location: { start: { line: 25 } },
            },
            { status: "NoCoverage", mutatorName: "BlockStatement", location: { start: { line: 42 } } },
            { status: "Ignored", mutatorName: "EqualityOperator", location: { start: { line: 45 } } },
          ],
        },
        "src/OpenClaw.Shared/SettingsData.cs": {
          mutants: [
            { status: "Killed", mutatorName: "BooleanLiteral", location: { start: { line: 5 } } },
            { status: "Timeout", mutatorName: "StringLiteral", location: { start: { line: 8 } } },
          ],
        },
      },
    };

    const result = parseStrykerNet(JSON.stringify(report));

    assert.equal(result.tool, "stryker-net");
    assert.equal(result.killed, 2);
    assert.equal(result.survived, 1);
    assert.equal(result.timeout, 1);
    assert.equal(result.noCoverage, 1);
    assert.equal(result.ignored, 1);
    assert.equal(result.totalMutants, 6);
    assert.equal(result.score, 0.6); // timeout counts as detected (uniform formula) // 2 / (2 + 1 + 1)
    assert.equal(result.survivingMutants.length, 2);
    assert.equal(result.survivingMutants[0].file, "src/OpenClaw.Shared/Capabilities/BrowserProxyCapability.cs");
    assert.equal(result.survivingMutants[0].status, "survived");
    assert.equal(result.survivingMutants[1].status, "no_coverage");
    assert.equal(result.error, null);
  });

  it("returns error for non-JSON output (e.g. MSBuild failure)", () => {
    const result = parseStrykerNet("error MSB1009: Project file does not exist.");
    assert.notEqual(result.error, null);
    assert.equal(result.score, 0);
    assert.equal(result.tool, "stryker-net");
  });

  it("handles empty files object", () => {
    const result = parseStrykerNet(JSON.stringify({ files: {} }));
    assert.equal(result.killed, 0);
    assert.equal(result.survived, 0);
    // Empty parse scores 0, not a vacuous 1 (#25); the allow-empty PASS is enforced by
    // reconcileResult, not by the parser scoring nothing as perfect.
    assert.equal(result.score, 0);
  });
});

describe("mutate glob anchoring and vacuous-ignore guard", () => {
  it("anchors repo-relative patterns with **/ and strips line ranges", () => {
    const cmd = buildStrykerNetCommand(["Lib/Calc.cs:5-9", "Other.cs"], "/repo");
    assert.ok(cmd.includes("--mutate '**/Lib/Calc.cs'"));
    assert.ok(cmd.includes("--mutate '**/Other.cs'"));
    assert.ok(!cmd.includes("5-9"));
  });

  it("passes --test-project when a sibling test csproj was discovered (issue #14)", () => {
    const workDir = join(tmpdir(), "repo", "Lib");
    const testProject = ["..", "Lib.Tests", "Lib.Tests.csproj"].join("/");
    const cmd = buildStrykerNetCommand(["Calc.cs"], workDir, testProject);
    assert.ok(cmd.includes("--test-project '../Lib.Tests/Lib.Tests.csproj'"));
  });

  it("omits --test-project for single-project repos", () => {
    const cmd = buildStrykerNetCommand(["Calc.cs"], join(tmpdir(), "repo"));
    assert.ok(!cmd.includes("--test-project"));
  });

  it("errors when every mutant is Ignored (filter matched nothing)", () => {
    // Shape captured from the providers-windows CI run 2026-07-04: dotnet-stryker
    // 4.x, both mutants Ignored because the mutate glob resolved against the
    // project dir, not the repo root.
    const report = {
      files: {
        "Calc.cs": {
          mutants: [
            { status: "Ignored", mutatorName: "Arithmetic", location: { start: { line: 5 } } },
            { status: "Ignored", mutatorName: "Arithmetic", location: { start: { line: 7 } } },
          ],
        },
      },
    };
    const r = parseStrykerNet(JSON.stringify(report));
    assert.notEqual(r.error, null);
    assert.match(r.error ?? "", /Ignored/);
  });
});

describe("equivalent-mutant classification (#31)", () => {
  // A report WITH source (mutation-testing-elements carries it) so the classifier can inspect
  // the mutated span. Line 3 is a bare, result-discarded logger call — a StringLiteral survivor
  // there is logging-only (message not asserted).
  const loggerSource =
    "public void DoThing()\n{\n    _logger.LogInformation(\"starting thing\");\n    Compute();\n}";
  const reportWith = (mutants: unknown[], source = loggerSource) =>
    JSON.stringify({ files: { "src/Thing.cs": { source, mutants } } });

  const loggerSurvivor = {
    status: "Survived",
    mutatorName: "StringLiteral",
    location: { start: { line: 3 }, end: { line: 3 } },
  };
  const killed = { status: "Killed", mutatorName: "ArithmeticOperator", location: { start: { line: 4 } } };

  it("annotates (default) a logging-only survivor without changing the score", () => {
    const r = parseStrykerNet(reportWith([killed, loggerSurvivor]));
    assert.equal(r.survived, 1, "still counted in annotate mode — no silent score inflation");
    assert.equal(r.score, 0.5); // 1 killed / (1 killed + 1 survived)
    assert.equal(r.likelyEquivalent, undefined, "nothing suppressed in annotate mode");
    assert.match(r.survivingMutants[0].likelyEquivalent ?? "", /^logging-only:/);
  });

  it("suppress mode removes the logging-only survivor from the score", () => {
    const r = parseStrykerNet(reportWith([killed, loggerSurvivor]), { classifyEquivalent: "suppress" });
    assert.equal(r.survived, 0);
    assert.equal(r.score, 1); // survivor no longer counts against the threshold
    assert.equal(r.likelyEquivalent, 1);
    assert.equal(r.likelyEquivalentMutants?.length, 1);
    assert.match(r.likelyEquivalentMutants?.[0].likelyEquivalent ?? "", /logging-only/);
    assert.equal(r.survivingMutants.length, 0);
    assert.equal(r.totalMutants, 2, "suppressed mutant still counts in the total, like ignored");
  });

  it("off mode disables classification entirely", () => {
    const r = parseStrykerNet(reportWith([killed, loggerSurvivor]), { classifyEquivalent: "off" });
    assert.equal(r.survived, 1);
    assert.equal(r.score, 0.5);
    assert.equal(r.survivingMutants[0].likelyEquivalent, undefined);
  });

  it("honours an in-source `// marmorkrebs-ok` directive even in the default annotate mode", () => {
    const src = "void M()\n{\n    x = compute(); // marmorkrebs-ok: known equivalent\n}";
    const manualSurvivor = {
      status: "Survived",
      mutatorName: "ArithmeticOperator",
      location: { start: { line: 3 }, end: { line: 3 } },
    };
    const r = parseStrykerNet(reportWith([killed, manualSurvivor], src));
    assert.equal(r.survived, 0, "a human directive is authoritative in any mode except off");
    assert.equal(r.likelyEquivalent, 1);
    assert.match(r.likelyEquivalentMutants?.[0].likelyEquivalent ?? "", /manual-suppression/);
  });

  it("leaves a genuine (non-equivalent) survivor counted under suppress", () => {
    const realSurvivor = {
      status: "Survived",
      mutatorName: "EqualityOperator",
      location: { start: { line: 4 }, end: { line: 4 } }, // Compute(); — not a logger call
    };
    const r = parseStrykerNet(reportWith([killed, realSurvivor]), { classifyEquivalent: "suppress" });
    assert.equal(r.survived, 1);
    assert.equal(r.likelyEquivalent, undefined);
    assert.equal(r.survivingMutants[0].likelyEquivalent, undefined);
  });

  it("does not fail open: an all-equivalent-suppressed run trips the vacuous guard, not a 1.0 pass", () => {
    const r = parseStrykerNet(reportWith([loggerSurvivor]), { classifyEquivalent: "suppress" });
    assert.notEqual(r.error, null);
    assert.match(r.error ?? "", /nothing was scored/);
  });
});

describe("stryker-net exit-code and cleanup chain", () => {
  it("preserves the runner exit code and removes output dirs after cat", () => {
    const cmd = buildStrykerNetCommand(["Lib/Calc.cs"], "/repo");
    assert.ok(
      cmd.startsWith("cd '/repo' && rm -rf .marmorkrebs-stryker StrykerOutput && "),
      "prior-run reports must be scrubbed BEFORE the run (stale-report fail-open class)",
    );
    assert.ok(cmd.includes("; code=$?; "));
    assert.ok(cmd.includes("rm -rf .marmorkrebs-stryker StrykerOutput; exit $code"));
    assert.ok(!cmd.includes(">/dev/null 2>&1"), "progress goes to stderr, not the void");
  });
});
