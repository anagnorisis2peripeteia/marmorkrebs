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

// Captured from a REAL mutmut 3.6.0 `results --all true` run against
// agent-skills/plugins/issue-loop/scripts/issue_loop.py (2026-07-13 gate repro).
const HYPHENATED_PATH_OUTPUT =
  "    plugins.issue-loop.scripts.issue_loop.x_utcnow__mutmut_1: survived\n";

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

  it("accepts hyphenated module paths and maps them back to changed files", () => {
    const r = parseMutmut(HYPHENATED_PATH_OUTPUT, ["plugins/issue-loop/scripts/issue_loop.py"]);
    assert.equal(r.error, null);
    assert.equal(r.totalMutants, 1);
    assert.equal(r.survived, 1);
    assert.equal(r.survivingMutants[0].file, "plugins/issue-loop/scripts/issue_loop.py");
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
  it("rebuilds source_paths in a temporary scoped setup.cfg for changed py files", () => {
    const cmd = buildMutmutCommand(["calclib/tested.py:3-6"], "/repo");
    assert.ok(cmd.startsWith("cd '/repo' && rm -rf mutants && "));
    assert.ok(cmd.includes("python3 - <<'PY'"));
    assert.ok(cmd.includes("parser['mutmut']['source_paths']"));
    assert.ok(cmd.includes("source_paths'] ="));
    assert.ok(cmd.includes("mutmut results --all true"));
    assert.ok(cmd.includes("mutmut run 1>&2"));
    assert.ok(cmd.includes("cp setup.cfg"));
    assert.ok(cmd.includes("mv \"$backup\" setup.cfg"));
    assert.ok(cmd.includes("rm -f setup.cfg"));
  });

  it("dedupes source files and keeps each file only once in the scoped config", () => {
    const cmd = buildMutmutCommand(
      ["plugins/issue-loop/scripts/issue_loop.py:1", "plugins/issue-loop/scripts/issue_loop.py:10", "other.py"],
      "/repo",
    );
    assert.ok(cmd.includes("json.loads"));
    assert.ok(cmd.includes("for p in paths"));
  });
});
