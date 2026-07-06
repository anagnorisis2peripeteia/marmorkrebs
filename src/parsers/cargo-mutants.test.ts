import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildCargoMutantsCommand, parseCargoMutants } from "./cargo-mutants.js";

// Miniaturized from a REAL cargo-mutants v27.1.0 outcomes.json (2026-07-03 probe).
const REAL_REPORT = {
  cargo_mutants_version: "27.1.0",
  caught: 5,
  missed: 2,
  timeout: 1,
  unviable: 1,
  total_mutants: 9,
  success: 0,
  outcomes: [
    { scenario: "Baseline", summary: "Success" },
    {
      scenario: { Mutant: { name: "src/lib.rs:4:5: replace add -> i32 with 0", file: "src/lib.rs", span: { start: { line: 4 } }, genre: "FnValue", replacement: "0" } },
      summary: "CaughtMutant",
    },
    {
      scenario: { Mutant: { name: "src/untested.rs:2:7: replace - with + in sub", file: "src/untested.rs", span: { start: { line: 2 } }, genre: "BinaryOperator", replacement: "+" } },
      summary: "MissedMutant",
    },
    {
      scenario: { Mutant: { name: "src/untested.rs:2:5: replace sub -> i32 with 1", file: "src/untested.rs", span: { start: { line: 2 } }, genre: "FnValue", replacement: "1" } },
      summary: "MissedMutant",
    },
    {
      scenario: { Mutant: { name: "src/slow.rs:9:1: replace loop_body", file: "src/slow.rs", span: { start: { line: 9 } }, genre: "FnValue", replacement: "()" } },
      summary: "Timeout",
    },
  ],
};

describe("parseCargoMutants (outcomes.json)", () => {
  it("reads top-level counts and lists missed/timeout mutants with file:line", () => {
    const r = parseCargoMutants(JSON.stringify(REAL_REPORT));
    assert.equal(r.error, null);
    assert.equal(r.killed, 5);
    assert.equal(r.survived, 2);
    assert.equal(r.timeout, 1);
    assert.equal(r.totalMutants, 9);
    assert.equal(r.score, 0.75); // (killed+timeout)/(killed+timeout+survived)
    assert.equal(r.survivingMutants.length, 3);
    assert.equal(r.survivingMutants[0].file, "src/untested.rs");
    assert.equal(r.survivingMutants[0].line, 2);
    assert.equal(r.survivingMutants[2].status, "timeout");
  });

  it("errors on non-JSON output (fail closed)", () => {
    const r = parseCargoMutants("error: no such command");
    assert.notEqual(r.error, null);
  });
});

describe("buildCargoMutantsCommand", () => {
  it("scopes with --file per changed file and cats the temp outcomes.json", () => {
    const cmd = buildCargoMutantsCommand(["src/a.rs", "src/b.rs:3-9"], "/repo");
    assert.ok(cmd.includes("--file 'src/a.rs'"));
    assert.ok(cmd.includes("--file 'src/b.rs'"));
    assert.ok(!cmd.includes("3-9"));
    assert.ok(cmd.includes('--output "$RPT"'));
    assert.ok(cmd.includes('cat "$RPT/mutants.out/outcomes.json"'));
    assert.ok(cmd.includes("exit $code"), "must propagate the tool exit code");
  });
});

describe("parseCargoMutants line-range scoping", () => {
  it("recomputes counts from outcomes when entries carry ranges", () => {
    const r = parseCargoMutants(JSON.stringify(REAL_REPORT), ["src/untested.rs:1-2"]);
    assert.equal(r.totalMutants, 2, "two untested.rs mutants on line 2");
    assert.equal(r.survived, 2);
    assert.equal(r.killed, 0);
    assert.ok(r.survivingMutants.every((m) => m.file === "src/untested.rs"));
  });

  it("without ranges keeps the report's own counts", () => {
    const r = parseCargoMutants(JSON.stringify(REAL_REPORT), ["src/untested.rs", "src/lib.rs", "src/slow.rs"]);
    assert.equal(r.totalMutants, 9);
  });
});
