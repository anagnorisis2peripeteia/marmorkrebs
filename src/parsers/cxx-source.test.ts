import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildCxxSourceCommand, parseCxxSource } from "./cxx-source.js";

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

    const result = parseCxxSource(JSON.stringify(report), "stryker-cxx");

    assert.equal(result.tool, "stryker-cxx");
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

  it("builds stryker-cxx as the external C++ mutation command", () => {
    const command = buildCxxSourceCommand(["src/foo.cpp"], "/repo", {
      tool: "stryker-cxx",
      buildCommand: "ninja -C build target",
      testCommand: "./target_test",
      base: "origin/main",
      maxMutants: 5,
      timeoutMs: 9000,
    });

    assert.ok(command.includes("'stryker-cxx' run"));
    assert.ok(command.includes("--repo '/repo'"));
    assert.ok(command.includes("--files 'src/foo.cpp'"));
    assert.ok(command.includes("--output-format stryker-cxx"));
    assert.ok(command.includes("--timeout 9"));
  });

  it("parses standalone stryker-cxx report v1", () => {
    const report = {
      schemaVersion: "stryker-cxx.report.v1",
      tool: "stryker-cxx",
      targetFiles: ["aten/src/Reduce.mm"],
      totalMutants: 2,
      killed: 1,
      survived: 1,
      buildErrors: 0,
      timeouts: 0,
      ignored: 1,
      score: 0.5,
      mutants: [
        {
          id: "aten/src/Reduce.mm:42:12:ConditionalBoundary:abc123",
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
          id: "aten/src/Reduce.mm:130:20:LogicalOperator:def456",
          mutator: "LogicalOperator",
          file: "aten/src/Reduce.mm",
          line: 130,
          col: 20,
          original: "&&",
          mutated: "||",
          status: "SURVIVED",
          detail: "all targeted tests passed",
        },
        {
          id: "aten/src/Reduce.mm:140:20:EqualityOperator:ignored",
          mutator: "EqualityOperator",
          file: "aten/src/Reduce.mm",
          line: 140,
          col: 20,
          original: "==",
          mutated: "!=",
          status: "IGNORED",
          detail: "equivalent generated comparison",
          ignoreReason: "equivalent generated comparison",
        },
      ],
      mutationTestingElements: {
        schemaVersion: "2.0",
        files: {},
        testFiles: {},
      },
    };

    const result = parseCxxSource(JSON.stringify(report), "stryker-cxx");

    assert.equal(result.tool, "stryker-cxx");
    assert.equal(result.killed, 1);
    assert.equal(result.survived, 1);
    assert.equal(result.timeout, 0);
    assert.equal(result.noCoverage, 0);
    assert.equal(result.ignored, 1);
    assert.equal(result.totalMutants, 2);
    assert.equal(result.score, 0.5);
    assert.equal(result.survivingMutants.length, 1);
    assert.equal(result.survivingMutants[0].file, "aten/src/Reduce.mm");
    assert.equal(result.survivingMutants[0].line, 130);
    assert.equal(result.survivingMutants[0].mutator, "LogicalOperator");
    assert.equal(result.survivingMutants[0].description, "&&->||");
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
    assert.equal(result.ignored, 0);
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
    assert.equal(result.ignored, 0);
    assert.equal(result.score, 1);
  });

  it("parses ignored stryker-cxx mutants from status when count is absent", () => {
    const report = {
      schemaVersion: "stryker-cxx.report.v1",
      totalMutants: 1,
      killed: 0,
      survived: 0,
      buildErrors: 0,
      timeouts: 0,
      score: 1,
      mutants: [
        {
          mutator: "EqualityOperator",
          file: "x.cpp",
          line: 3,
          col: 4,
          original: "==",
          mutated: "!=",
          status: "IGNORED",
          detail: "equivalent",
        },
      ],
    };

    const result = parseCxxSource(JSON.stringify(report), "stryker-cxx");
    assert.equal(result.totalMutants, 1);
    assert.equal(result.ignored, 1);
    assert.equal(result.score, 1);
    assert.equal(result.survivingMutants.length, 0);
  });
});
