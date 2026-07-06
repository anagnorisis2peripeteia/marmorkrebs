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
            {
              status: "Ignored",
              mutatorName: "EqualityOperator",
              location: { start: { line: 45 } },
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
    assert.equal(result.ignored, 1);
    assert.equal(result.totalMutants, 6);
    assert.equal(result.score, 0.6); // timeout counts as detected (uniform formula) // 2 / (2 + 1 + 1)
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

describe("buildStrykerCommand scoping and mutator policy", () => {
  it("passes ranged mutate entries through untouched (StrykerJS native)", () => {
    const cmd = buildStrykerCommand(["src/a.ts:12-40"], "/repo", "npm test");
    assert.ok(cmd.includes('"mutate":["src/a.ts:12-40"]'));
  });

  it("adds mutator.excludedMutations only when provided", () => {
    const withEx = buildStrykerCommand(["src/a.ts"], "/repo", "npm test", ["StringLiteral"]);
    assert.ok(withEx.includes('"mutator":{"excludedMutations":["StringLiteral"]}'));
    const without = buildStrykerCommand(["src/a.ts"], "/repo", "npm test");
    assert.ok(!without.includes("excludedMutations"));
  });
});

describe("stale-report scrub ordering (fail-open regression)", () => {
  it("cd + scrub precede the ensure step in BOTH branches", () => {
    // The trailing `cat` runs on every exit path; if the prior report is not
    // scrubbed before anything can fail, a failed run emits stale-report +
    // non-zero exit and reconcileResult trusts it as a threshold verdict.
    for (const cmd of [
      buildStrykerCommand(["src/a.ts"], "/repo", "npm test"),
      buildStrykerCommand(["src/a.ts"], "/repo"),
    ]) {
      assert.ok(
        cmd.startsWith("cd '/repo' && rm -f reports/mutation/mutation.json && "),
        `scrub must be first: ${cmd.slice(0, 80)}`,
      );
    }
  });
});

describe("git-exclude guard freshness", () => {
  it("guards on the newest exclude entry so upgrades append missing lines", () => {
    const cmd = buildStrykerCommand(["src/a.ts"], "/repo", "npm test");
    assert.ok(cmd.includes("grep -qxF '.marmorkrebs.lock'"), "must probe the newest entry, not reports/");
  });
});
