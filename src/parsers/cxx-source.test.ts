import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseCxxSource } from "./cxx-source.js";

describe("parseCxxSource", () => {
  it("parses the engine JSON report", () => {
    const report = {
      target_files: ["aten/src/Reduce.mm"],
      total: 3,
      killed: 2,
      survived: 1,
      build_error: 0,
      mutants: [
        {
          mutator: "ConditionalBoundary",
          file: "aten/src/Reduce.mm",
          line: 42,
          col: 12,
          original: "<=",
          mutated: "<",
          status: "KILLED",
          detail: "",
        },
        {
          mutator: "EqualityOperator",
          file: "aten/src/Reduce.mm",
          line: 88,
          col: 7,
          original: "==",
          mutated: "!=",
          status: "KILLED",
          detail: "",
        },
        {
          mutator: "LogicalOperator",
          file: "aten/src/Reduce.mm",
          line: 130,
          col: 20,
          original: "&&",
          mutated: "||",
          status: "SURVIVED",
          detail: "all targeted tests passed",
        },
      ],
      score: 66.66666666666667,
    };

    const result = parseCxxSource(JSON.stringify(report));

    assert.equal(result.tool, "cxx-source");
    assert.equal(result.killed, 2);
    assert.equal(result.survived, 1);
    assert.equal(result.timeout, 0);
    assert.equal(result.noCoverage, 0);
    assert.equal(result.totalMutants, 3);
    assert.equal(result.score, 0.67); // 66.67% -> 0.67
    assert.equal(result.survivingMutants.length, 1);
    assert.equal(result.survivingMutants[0].file, "aten/src/Reduce.mm");
    assert.equal(result.survivingMutants[0].line, 130);
    assert.equal(result.survivingMutants[0].mutator, "LogicalOperator");
    assert.equal(result.survivingMutants[0].description, "&&->||");
    assert.equal(result.survivingMutants[0].status, "survived");
    assert.equal(result.error, null);
  });

  it("maps build_error mutants to noCoverage", () => {
    const report = {
      target_files: ["x.cpp"],
      total: 2,
      killed: 1,
      survived: 0,
      build_error: 1,
      mutants: [
        {
          mutator: "BooleanLiteral",
          file: "x.cpp",
          line: 3,
          col: 0,
          original: "true",
          mutated: "false",
          status: "KILLED",
          detail: "",
        },
        {
          mutator: "ConditionalBoundary",
          file: "x.cpp",
          line: 9,
          col: 4,
          original: "<",
          mutated: "<=",
          status: "BUILD_ERROR",
          detail: "did not compile",
        },
      ],
      score: 100.0,
    };

    const result = parseCxxSource(JSON.stringify(report));
    assert.equal(result.killed, 1);
    assert.equal(result.survived, 0);
    assert.equal(result.noCoverage, 1);
    assert.equal(result.totalMutants, 2);
    assert.equal(result.score, 1); // 100% -> 1.0
    assert.equal(result.survivingMutants.length, 0);
    assert.equal(result.error, null);
  });

  it("returns error for non-JSON output", () => {
    const result = parseCxxSource("not json at all");
    assert.notEqual(result.error, null);
    assert.equal(result.tool, "cxx-source");
  });

  it("defaults score to 1 when nothing was scored", () => {
    const report = {
      target_files: [],
      total: 0,
      killed: 0,
      survived: 0,
      build_error: 0,
      mutants: [],
      score: 100.0,
    };
    const result = parseCxxSource(JSON.stringify(report));
    assert.equal(result.killed, 0);
    assert.equal(result.survived, 0);
    assert.equal(result.score, 1);
  });
});
