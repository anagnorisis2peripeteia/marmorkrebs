import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseGomu } from "./gomu.js";

describe("parseGomu", () => {
  it("parses gomu JSON report", () => {
    const report = {
      statistics: {
        killed: 5,
        survived: 2,
        timedOut: 1,
        errors: 0,
        notViable: 1,
        mutationScore: 62.5,
      },
      results: [
        {
          mutant: {
            id: "m1",
            filePath: "internal/config.go",
            line: 42,
            column: 10,
            type: "ConditionalBoundary",
            original: "<",
            mutated: "<=",
            description: "changed < to <=",
          },
          status: "KILLED",
        },
        {
          mutant: {
            id: "m2",
            filePath: "internal/config.go",
            line: 55,
            column: 5,
            type: "ArithmeticOperator",
            original: "+",
            mutated: "-",
            description: "changed + to -",
          },
          status: "SURVIVED",
        },
        {
          mutant: {
            id: "m3",
            filePath: "internal/runner.go",
            line: 100,
            column: 8,
            type: "ReturnValue",
            original: "nil",
            mutated: "fmt.Errorf(\"mutated\")",
          },
          status: "TIMED_OUT",
        },
      ],
      duration: 5_500_000_000,
    };

    const result = parseGomu(JSON.stringify(report));

    assert.equal(result.tool, "gomu");
    assert.equal(result.killed, 5);
    assert.equal(result.survived, 2);
    assert.equal(result.timeout, 1);
    assert.equal(result.totalMutants, 9);
    assert.equal(result.score, 0.63);
    assert.equal(result.survivingMutants.length, 2);
    assert.equal(result.survivingMutants[0].file, "internal/config.go");
    assert.equal(result.survivingMutants[0].status, "survived");
    assert.equal(result.survivingMutants[1].status, "timeout");
    assert.equal(result.elapsedMs, 5500);
    assert.equal(result.error, null);
  });

  it("returns error for non-JSON output", () => {
    const result = parseGomu("not json at all");
    assert.notEqual(result.error, null);
    assert.equal(result.tool, "gomu");
    assert.equal(result.score, 0);
  });

  it("handles all-killed report", () => {
    const report = {
      statistics: {
        killed: 10,
        survived: 0,
        timedOut: 0,
        errors: 0,
        notViable: 0,
        mutationScore: 100,
      },
      results: [],
      duration: 1_000_000_000,
    };
    const result = parseGomu(JSON.stringify(report));
    assert.equal(result.killed, 10);
    assert.equal(result.survived, 0);
    assert.equal(result.score, 1);
    assert.equal(result.survivingMutants.length, 0);
  });

  it("handles empty results", () => {
    const report = {
      statistics: {
        killed: 0,
        survived: 0,
        timedOut: 0,
        errors: 0,
        notViable: 0,
        mutationScore: 0,
      },
      results: [],
    };
    const result = parseGomu(JSON.stringify(report));
    assert.equal(result.score, 1);
    assert.equal(result.totalMutants, 0);
  });

  it("uses original->mutated as fallback description", () => {
    const report = {
      statistics: { killed: 0, survived: 1, timedOut: 0, errors: 0, notViable: 0, mutationScore: 0 },
      results: [
        {
          mutant: {
            id: "m1",
            filePath: "foo.go",
            line: 1,
            type: "BooleanLiteral",
            original: "true",
            mutated: "false",
          },
          status: "SURVIVED",
        },
      ],
    };
    const result = parseGomu(JSON.stringify(report));
    assert.equal(result.survivingMutants[0].description, "true -> false");
  });
});
