import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseStrykerNet } from "./stryker-net.js";

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
    assert.equal(result.totalMutants, 5);
    assert.equal(result.score, 0.5); // 2 / (2 + 1 + 1)
    assert.equal(result.survivingMutants.length, 2);
    assert.equal(result.survivingMutants[0].file, "src/OpenClaw.Shared/Capabilities/BrowserProxyCapability.cs");
    assert.equal(result.survivingMutants[0].status, "survived");
    assert.equal(result.survivingMutants[1].status, "no_coverage");
    assert.equal(result.error, null);
  });

  it("returns error for non-JSON output (e.g. MSBuild failure)", () => {
    const result = parseStrykerNet("error MSB1009: Project file does not exist.");
    assert.notEqual(result.error, null);
    assert.equal(result.tool, "stryker-net");
  });

  it("handles empty files object", () => {
    const result = parseStrykerNet(JSON.stringify({ files: {} }));
    assert.equal(result.killed, 0);
    assert.equal(result.survived, 0);
    assert.equal(result.score, 1);
  });
});
