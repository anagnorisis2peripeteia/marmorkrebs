import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseGoMutesting } from "./go-mutesting.js";

describe("parseGoMutesting", () => {
  it("parses mixed PASS/FAIL/SKIP output", () => {
    const output = [
      "PASS: internal/cli/status.go:55: replaced == with != in statusCommand",
      "FAIL: internal/cli/config.go:42: removed call to applyDefaults",
      "FAIL: internal/cli/config.go:80: replaced > with >=",
      "SKIP: internal/cli/config.go:120: timed out",
      "PASS: internal/cli/status.go:232: replaced true with false",
      "The mutation score is 0.50",
    ].join("\n");

    const result = parseGoMutesting(output);

    assert.equal(result.tool, "go-mutesting");
    assert.equal(result.killed, 2);
    assert.equal(result.survived, 2);
    assert.equal(result.timeout, 1);
    assert.equal(result.totalMutants, 5);
    assert.equal(result.score, 0.5);
    assert.equal(result.survivingMutants.length, 2);
    assert.equal(result.survivingMutants[0].file, "internal/cli/config.go");
    assert.equal(result.survivingMutants[0].line, 42);
    assert.equal(result.survivingMutants[0].status, "survived");
    assert.equal(result.error, null);
  });

  it("returns score 1 for empty output", () => {
    const result = parseGoMutesting("");
    assert.equal(result.killed, 0);
    assert.equal(result.survived, 0);
    assert.equal(result.score, 1);
    assert.equal(result.survivingMutants.length, 0);
  });

  it("returns perfect score when all pass", () => {
    const output = [
      "PASS: foo.go:1: replaced == with !=",
      "PASS: foo.go:5: removed call to bar",
      "The mutation score is 1.00",
    ].join("\n");

    const result = parseGoMutesting(output);
    assert.equal(result.killed, 2);
    assert.equal(result.survived, 0);
    assert.equal(result.score, 1);
    assert.equal(result.survivingMutants.length, 0);
  });

  it("computes score from counts when no score line present", () => {
    const output = [
      "PASS: foo.go:1: a",
      "FAIL: foo.go:2: b",
      "PASS: foo.go:3: c",
      "PASS: foo.go:4: d",
    ].join("\n");

    const result = parseGoMutesting(output);
    assert.equal(result.killed, 3);
    assert.equal(result.survived, 1);
    assert.equal(result.score, 0.75);
  });
});
