import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildGomuCommand, parseGomu } from "./gomu.js";

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
    assert.equal(result.score, 0.75); // timeout counts as detected
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
    // A proved-nothing (all-zero) parse scores 0, not a vacuous 1 (#25) — a perfect score must
    // imply at least one DETECTED mutant. The deliberate allow-empty PASS is enforced at the
    // reconcile layer (reconcileResult normalizes an allowed empty run to the canonical pass),
    // not by the parser scoring an empty run as perfect.
    assert.equal(result.score, 0);
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

describe("parseGomu multi-report stream", () => {
  it("merges RS-separated per-file reports", () => {
    const r1 = {
      statistics: { killed: 2, survived: 1, timedOut: 0, errors: 0, notViable: 0, mutationScore: 66.7 },
      results: [
        {
          mutant: { id: "a", filePath: "a.go", line: 3, type: "arithmetic_binary", original: "+", mutated: "-" },
          status: "SURVIVED",
        },
      ],
      duration: 1_000_000_000,
    };
    const r2 = {
      statistics: { killed: 3, survived: 0, timedOut: 1, errors: 0, notViable: 1, mutationScore: 75 },
      results: [
        {
          mutant: { id: "b", filePath: "b.go", line: 9, type: "conditional", original: "<", mutated: "<=" },
          status: "TIMED_OUT",
        },
      ],
      duration: 2_000_000_000,
    };
    const stream = JSON.stringify(r1) + "\n\u001e\n" + JSON.stringify(r2) + "\n\u001e\n";
    const result = parseGomu(stream);
    assert.equal(result.error, null);
    assert.equal(result.killed, 5);
    assert.equal(result.survived, 1);
    assert.equal(result.timeout, 1);
    assert.equal(result.totalMutants, 8);
    assert.equal(result.score, 0.86); // (5+1)/7 — timeout detected
    assert.equal(result.survivingMutants.length, 2);
    assert.equal(result.survivingMutants[0].file, "a.go");
    assert.equal(result.survivingMutants[1].file, "b.go");
    assert.equal(result.elapsedMs, 3000);
  });
});

describe("buildGomuCommand", () => {
  it("runs gomu once per unique package dir with a single positional each", () => {
    const cmd = buildGomuCommand(["a.go", "pkg/b.go", "pkg/c.go"], "/repo");
    assert.equal(cmd.match(/gomu run /g)?.length, 2);
    assert.ok(cmd.includes("'.' 1>&2"));
    assert.ok(cmd.includes("'pkg' 1>&2"));
    assert.ok(!cmd.includes("'a.go'"), "must pass package dirs, not files");
    assert.ok(cmd.startsWith("cd '/repo' && "));
  });

  it("scrubs gomu incremental history around every run", () => {
    const cmd = buildGomuCommand(["a.go", "pkg/b.go"], "/repo");
    assert.equal(cmd.match(/rm -f \.gomu_history\.json/g)?.length, 3);
    assert.ok(cmd.includes("--incremental=false"));
  });

  it("collects the report file per run and emits an RS-separated stream", () => {
    const cmd = buildGomuCommand(["a.go", "pkg/b.go"], "/repo");
    assert.ok(cmd.includes('mv -f mutation-report.json "$RPT/r0.json"'));
    assert.ok(cmd.includes('mv -f mutation-report.json "$RPT/r1.json"'));
    assert.ok(cmd.includes("printf '\\n\\036\\n'"));
    assert.ok(cmd.includes('rm -rf "$RPT"'));
    assert.ok(!cmd.includes("2>&1"), "stdout must stay pure JSON stream");
  });

  it("strips focus line-range suffixes when deriving dirs", () => {
    const cmd = buildGomuCommand(["pkg/a.go:12-40"], "/repo");
    assert.ok(cmd.includes("'pkg' 1>&2"));
    assert.ok(!cmd.includes("12-40"));
  });
});

describe("parseGomu changed-file scoping", () => {
  it("filters package-wide results down to changed files and recomputes stats", () => {
    const report = {
      statistics: { killed: 4, survived: 2, timedOut: 0, errors: 0, notViable: 0, mutationScore: 66.7 },
      results: [
        { mutant: { id: "1", filePath: "/abs/repo/pkg/changed.go", line: 3, type: "t", original: "+", mutated: "-" }, status: "KILLED" },
        { mutant: { id: "2", filePath: "/abs/repo/pkg/changed.go", line: 9, type: "t", original: "<", mutated: "<=" }, status: "SURVIVED" },
        { mutant: { id: "3", filePath: "/abs/repo/pkg/other.go", line: 5, type: "t", original: "+", mutated: "-" }, status: "SURVIVED" },
        { mutant: { id: "4", filePath: "/abs/repo/pkg/other.go", line: 7, type: "t", original: "-", mutated: "+" }, status: "KILLED" },
      ],
      duration: 1_000_000_000,
    };
    const result = parseGomu(JSON.stringify(report), ["pkg/changed.go"]);
    assert.equal(result.error, null);
    assert.equal(result.killed, 1);
    assert.equal(result.survived, 1);
    assert.equal(result.totalMutants, 2);
    assert.equal(result.survivingMutants.length, 1);
    assert.equal(result.survivingMutants[0].file, "/abs/repo/pkg/changed.go");
    assert.equal(result.score, 0.5);
  });

  it("strips line ranges from the changed-file filter", () => {
    const report = {
      statistics: { killed: 1, survived: 0, timedOut: 0, errors: 0, notViable: 0, mutationScore: 100 },
      results: [
        { mutant: { id: "1", filePath: "/abs/repo/a.go", line: 3, type: "t", original: "+", mutated: "-" }, status: "KILLED" },
      ],
      duration: 0,
    };
    const result = parseGomu(JSON.stringify(report), ["a.go:1-20"]);
    assert.equal(result.killed, 1);
    assert.equal(result.totalMutants, 1);
  });
});

describe("parseGomu line-range scoping", () => {
  const report = {
    statistics: { killed: 2, survived: 2, timedOut: 0, errors: 0, notViable: 0, mutationScore: 50 },
    results: [
      { mutant: { id: "1", filePath: "/r/a.go", line: 3, type: "t", original: "+", mutated: "-" }, status: "SURVIVED" },
      { mutant: { id: "2", filePath: "/r/a.go", line: 9, type: "t", original: "<", mutated: "<=" }, status: "SURVIVED" },
      { mutant: { id: "3", filePath: "/r/a.go", line: 3, type: "t", original: "+", mutated: "*" }, status: "KILLED" },
      { mutant: { id: "4", filePath: "/r/a.go", line: 9, type: "t", original: "<", mutated: ">" }, status: "KILLED" },
    ],
    duration: 0,
  };

  it("scores only mutants inside the entry's line range", () => {
    const r = parseGomu(JSON.stringify(report), ["a.go:1-5"]);
    assert.equal(r.totalMutants, 2, "only line-3 mutants in scope");
    assert.equal(r.survived, 1);
    assert.equal(r.survivingMutants.length, 1);
    assert.equal(r.survivingMutants[0].line, 3);
  });

  it("whole-file entry keeps every line in scope", () => {
    const r = parseGomu(JSON.stringify(report), ["a.go"]);
    assert.equal(r.totalMutants, 4);
  });
});
