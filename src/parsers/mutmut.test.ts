import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildMutmutCommand, parseMutmut } from "./mutmut.js";

// Captured from a REAL mutmut 3.6.0 `results --all true` run (2026-07-03 probe).
const REAL_OUTPUT = `    calclib.tested.x_add__mutmut_1: killed
    calclib.untested.x_sub__mutmut_1: no tests
    calclib.neighbor.x_mul__mutmut_1: no tests
    calclib.flaky.x_f__mutmut_1: suspicious
    calclib.slow.x_g__mutmut_1: timeout
`;

describe("parseMutmut (mutmut 3 results lines)", () => {
  it("maps module paths to files and scopes to changed files", () => {
    const r = parseMutmut(REAL_OUTPUT, ["calclib/tested.py", "calclib/untested.py"]);
    assert.equal(r.error, null);
    assert.equal(r.killed, 1);
    assert.equal(r.noCoverage, 1);
    assert.equal(r.totalMutants, 2, "neighbor/flaky/slow modules must be filtered out");
    assert.equal(r.survivingMutants.length, 1);
    assert.equal(r.survivingMutants[0].file, "calclib/untested.py");
    assert.equal(r.survivingMutants[0].status, "no_coverage");
    assert.equal(r.score, 0.5);
  });

  it("treats suspicious as survived (fail closed) when in scope", () => {
    const r = parseMutmut(REAL_OUTPUT, ["calclib/flaky.py"]);
    assert.equal(r.survived, 1);
    assert.equal(r.survivingMutants[0].status, "survived");
  });

  it("errors when no result lines match the changed files", () => {
    const r = parseMutmut(REAL_OUTPUT, ["other/module.py"]);
    assert.notEqual(r.error, null);
  });

  it("errors on garbage output (fail closed)", () => {
    const r = parseMutmut("FileNotFoundError: Could not figure out where the code to mutate is", ["x.py"]);
    assert.notEqual(r.error, null);
  });
});

describe("buildMutmutCommand", () => {
  it("scrubs the mutants dir around the run and propagates the run exit code", () => {
    const cmd = buildMutmutCommand(["calclib/tested.py"], "/repo");
    assert.ok(cmd.startsWith("cd '/repo' && rm -rf mutants && "));
    assert.ok(cmd.includes("mutmut run 1>&2"));
    assert.ok(cmd.includes("mutmut results --all true"));
    assert.ok(cmd.endsWith("rm -rf mutants; exit $code"));
  });
});
