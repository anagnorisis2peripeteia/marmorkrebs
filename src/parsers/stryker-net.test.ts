import { describe, it } from "node:test";
import assert from "node:assert/strict";
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
    assert.equal(result.score, 1);
  });
});

describe("mutate glob anchoring and vacuous-ignore guard", () => {
  it("anchors repo-relative patterns with **/ and strips line ranges", () => {
    const cmd = buildStrykerNetCommand(["Lib/Calc.cs:5-9", "Other.cs"], "/repo");
    assert.ok(cmd.includes("--mutate '**/Lib/Calc.cs'"));
    assert.ok(cmd.includes("--mutate '**/Other.cs'"));
    assert.ok(!cmd.includes("5-9"));
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
