import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getChangedFilesFromGit, getChangedLineRangesFromGit } from "./git-changed-files.js";

function git(dir: string, args: string[]): void {
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "marmorkrebs-git-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@test"]);
  git(dir, ["config", "user.name", "test"]);
  writeFileSync(join(dir, "kept.ts"), "export const kept = 1;\n");
  writeFileSync(join(dir, "doomed.ts"), "export const doomed = 1;\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "base"]);
  return dir;
}

test("derives branch commits, working tree edits, and untracked files vs base", () => {
  const dir = makeRepo();
  try {
    git(dir, ["checkout", "-qb", "feature"]);
    writeFileSync(join(dir, "committed.ts"), "export const a = 1;\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", "feature change"]);
    writeFileSync(join(dir, "kept.ts"), "export const kept = 2;\n"); // unstaged edit
    writeFileSync(join(dir, "untracked.ts"), "export const u = 1;\n"); // never added

    assert.deepEqual(getChangedFilesFromGit(dir, "main"), [
      "committed.ts",
      "kept.ts",
      "untracked.ts",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("excludes deleted files and reports nothing on a clean branch", () => {
  const dir = makeRepo();
  try {
    assert.deepEqual(getChangedFilesFromGit(dir, "main"), []);

    git(dir, ["checkout", "-qb", "feature"]);
    unlinkSync(join(dir, "doomed.ts"));
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", "delete doomed"]);

    assert.deepEqual(getChangedFilesFromGit(dir, "main"), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getChangedLineRangesFromGit derives hunk ranges, untracked whole-file entries, and skips deletions", () => {
    const dir = mkdtempSync(join(tmpdir(), "marmorkrebs-ranges-"));
    try {
      const g = (...args: string[]) =>
        execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
      g("init", "-q", "-b", "main");
      g("config", "user.email", "t@t");
      g("config", "user.name", "t");
      writeFileSync(join(dir, "kept.ts"), Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n") + "\n");
      writeFileSync(join(dir, "doomed.ts"), "gone\n");
      g("add", "-A");
      g("commit", "-qm", "base");
      g("checkout", "-qb", "feature");
      // edit lines 3 and 5 (adjacent hunks with -U0 merge to 3-5? no: separate), plus append 21-22
      const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
      lines[2] = "edited3";
      lines[4] = "edited5";
      lines.push("new21", "new22");
      writeFileSync(join(dir, "kept.ts"), lines.join("\n") + "\n");
      rmSync(join(dir, "doomed.ts"));
      writeFileSync(join(dir, "fresh.ts"), "brand new\n");
      g("add", "kept.ts", "doomed.ts");
      g("commit", "-qm", "changes");

      const entries = getChangedLineRangesFromGit(dir, "main");
      assert.ok(entries.includes("fresh.ts"), "untracked file is a whole-file entry");
      assert.ok(entries.includes("kept.ts:3-3"), `expected kept.ts:3-3 in ${entries}`);
      assert.ok(entries.includes("kept.ts:5-5"), `expected kept.ts:5-5 in ${entries}`);
      assert.ok(entries.some((e) => /^kept\.ts:21-22$/.test(e)), `expected kept.ts:21-22 in ${entries}`);
      assert.ok(!entries.some((e) => e.startsWith("doomed.ts")), "deleted file excluded");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
});
