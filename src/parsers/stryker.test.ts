import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildStrykerCommand, parseStryker } from "./stryker.js";

describe("parseStryker", () => {
  it("parses Stryker JSON report", () => {
    const report = {
      files: {
        "src/config.ts": {
          mutants: [
            {
              status: "Killed",
              mutatorName: "ConditionalExpression",
              location: { start: { line: 10 } },
            },
            {
              status: "Survived",
              mutatorName: "ArithmeticOperator",
              replacement: "changed + to -",
              location: { start: { line: 25 } },
            },
            {
              status: "NoCoverage",
              mutatorName: "BlockStatement",
              location: { start: { line: 42 } },
            },
          ],
        },
        "src/runner.ts": {
          mutants: [
            {
              status: "Killed",
              mutatorName: "BooleanLiteral",
              location: { start: { line: 5 } },
            },
            {
              status: "Timeout",
              mutatorName: "StringLiteral",
              location: { start: { line: 8 } },
            },
          ],
        },
      },
    };

    const result = parseStryker(JSON.stringify(report));

    assert.equal(result.tool, "stryker");
    assert.equal(result.killed, 2);
    assert.equal(result.survived, 1);
    assert.equal(result.timeout, 1);
    assert.equal(result.noCoverage, 1);
    assert.equal(result.totalMutants, 5);
    assert.equal(result.score, 0.5); // 2 / (2 + 1 + 1)
    assert.equal(result.survivingMutants.length, 2);
    assert.equal(result.survivingMutants[0].file, "src/config.ts");
    assert.equal(result.survivingMutants[0].status, "survived");
    assert.equal(result.survivingMutants[1].status, "no_coverage");
    assert.equal(result.error, null);
  });

  it("returns error for non-JSON output", () => {
    const result = parseStryker("not json at all");
    assert.notEqual(result.error, null);
    assert.equal(result.tool, "stryker");
  });

  it("handles empty files object", () => {
    const result = parseStryker(JSON.stringify({ files: {} }));
    assert.equal(result.killed, 0);
    assert.equal(result.survived, 0);
    assert.equal(result.score, 1);
  });

  it("builds commands that emit the JSON report file to stdout", () => {
    const command = buildStrykerCommand(["src/config.ts"], "/repo");
    assert.match(command, /stryker run --mutate/);
    assert.match(command, /1>&2/);
    assert.match(command, /cat reports\/mutation\/mutation\.json/);
  });

  it("builds command-runner commands that emit the JSON report file to stdout", () => {
    const command = buildStrykerCommand(["src/config.ts"], "/repo", "npm test -- config");
    assert.match(command, /stryker run \.marmorkrebs-stryker\.json/);
    assert.match(command, /1>&2/);
    assert.match(command, /cat reports\/mutation\/mutation\.json/);
  });
});
