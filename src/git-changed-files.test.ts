import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getChangedFilesFromGit } from "./git-changed-files.js";

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
