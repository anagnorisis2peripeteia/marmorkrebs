import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildGoMutestingCommand, parseGoMutesting } from "./go-mutesting.js";

// Sample captured from a REAL avito-tech/go-mutesting run on fixtures/gomu (2026-07-03).
const REAL_OUTPUT = `PASS "/var/folders/rn/T/go-mutesting-3770869741/a.go.0" with checksum d41d8cd98f00b204e9800998ecf8427e
--- a.go
+++ mutated
 package marmorkrebsfixture

-func Sub(a, b int) int { return a - b }
+func Sub(a, b int) int { return a + b }

FAIL "/var/folders/rn/T/go-mutesting-3770869741/b.go.0" with checksum 71205d42213afa31a0739e6942bddd93
------------------------------------------------------------------------------------------------------------------------------------------------------
The mutation score is 0.500000 (1 passed, 1 failed, 0 duplicated, 0 skipped, total is 2)
`;

describe("parseGoMutesting (avito fork format)", () => {
  it("parses PASS/FAIL quoted-tmp-path lines and maps back to changed files", () => {
    const r = parseGoMutesting(REAL_OUTPUT, ["a.go", "b.go"]);
    assert.equal(r.error, null);
    assert.equal(r.killed, 1);
    assert.equal(r.survived, 1);
    assert.equal(r.totalMutants, 2);
    assert.equal(r.score, 0.5);
    assert.equal(r.survivingMutants.length, 1);
    assert.equal(r.survivingMutants[0].file, "b.go");
  });

  it("maps tmp copies to nested changed paths", () => {
    const out = `FAIL "/tmp/go-mutesting-1/c.go.2" with checksum abc\nThe mutation score is 0.000000 (0 passed, 1 failed, 0 duplicated, 0 skipped, total is 1)`;
    const r = parseGoMutesting(out, ["pkg/c.go"]);
    assert.equal(r.survivingMutants[0].file, "pkg/c.go");
  });

  it("errors on output with no result lines (fail closed)", () => {
    const r = parseGoMutesting("go-mutesting: some crash\n", ["a.go"]);
    assert.notEqual(r.error, null);
  });
});

describe("buildGoMutestingCommand", () => {
  it("quotes file args and strips line ranges", () => {
    const cmd = buildGoMutestingCommand(["a.go:1-10", "pkg/my file.go"], "/repo");
    assert.ok(cmd.includes("'a.go'"));
    assert.ok(cmd.includes("'pkg/my file.go'"));
    assert.ok(!cmd.includes("1-10"));
  });
});
