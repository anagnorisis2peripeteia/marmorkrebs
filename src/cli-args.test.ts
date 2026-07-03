import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseCliArgs, UsageError } from "./cli-args.js";

const argv = (...rest: string[]) => ["node", "cli.js", ...rest];

describe("parseCliArgs", () => {
  it("rejects a missing or unknown tool with UsageError (not process.exit)", () => {
    assert.throws(() => parseCliArgs(argv()), UsageError);
    assert.throws(() => parseCliArgs(argv("--tool", "nonsense")), UsageError);
  });

  it("parses tool, dir, and comma-separated changed files", () => {
    const o = parseCliArgs(argv("--tool", "gomu", "--dir", "/repo", "--changed-files", "a.go, b.go,"));
    assert.equal(o.tool, "gomu");
    assert.equal(o.dir, "/repo");
    assert.deepEqual(o.changedFiles, ["a.go", "b.go"]);
  });

  it("parses boolean flags without swallowing the next arg", () => {
    const o = parseCliArgs(argv("--tool", "gomu", "--allow-empty", "--dir", "/repo"));
    assert.equal(o.allowEmpty, true);
    assert.equal(o.dir, "/repo");
  });

  it("defaults allow-empty to undefined (fail-closed posture)", () => {
    const o = parseCliArgs(argv("--tool", "gomu"));
    assert.equal(o.allowEmpty, undefined);
  });

  it("parses numeric threshold and timeout", () => {
    const o = parseCliArgs(argv("--tool", "stryker", "--threshold", "0.7", "--timeout", "60000"));
    assert.equal(o.threshold, 0.7);
    assert.equal(o.timeout, 60000);
  });

  it("rejects a bad parity profile", () => {
    assert.throws(
      () => parseCliArgs(argv("--tool", "stryker-cxx", "--parity-profile", "bogus")),
      UsageError,
    );
  });
});
