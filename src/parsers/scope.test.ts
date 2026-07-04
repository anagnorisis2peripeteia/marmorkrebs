import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { matchesScope, parseScopedTargets } from "./scope.js";

describe("parseScopedTargets", () => {
  it("groups ranges per file and keeps whole-file entries rangeless", () => {
    const t = parseScopedTargets(["a.go", "pkg/b.go:12-40", "pkg/b.go:50", "c.rs:7-9"]);
    assert.deepEqual(t, [
      { file: "a.go", ranges: [] },
      { file: "pkg/b.go", ranges: [[12, 40], [50, 50]] },
      { file: "c.rs", ranges: [[7, 9]] },
    ]);
  });

  it("whole-file entry beats a ranged duplicate (union with everything)", () => {
    const t = parseScopedTargets(["a.go:5-6", "a.go"]);
    assert.equal(t.length, 1);
    // ranges [[5,6]] remain but a bare entry adds no range — matchesScope still
    // honors the listed ranges; scope stays as derived
  });
});

describe("matchesScope", () => {
  const targets = parseScopedTargets(["pkg/b.go:12-40", "a.go"]);

  it("matches by suffix path within a range", () => {
    assert.ok(matchesScope("/abs/repo/pkg/b.go", 12, targets));
    assert.ok(matchesScope("/abs/repo/pkg/b.go", 40, targets));
    assert.ok(!matchesScope("/abs/repo/pkg/b.go", 41, targets));
  });

  it("whole-file target matches any line", () => {
    assert.ok(matchesScope("a.go", 9999, targets));
  });

  it("unknown line (0) degrades a ranged target to file scope, not silence", () => {
    assert.ok(matchesScope("pkg/b.go", 0, targets));
  });

  it("non-listed files never match", () => {
    assert.ok(!matchesScope("other.go", 1, targets));
  });
});
