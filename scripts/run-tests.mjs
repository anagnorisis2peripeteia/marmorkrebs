#!/usr/bin/env node
// Portable test entry: `node --test <glob>` needs node >= 21 for built-in globs and
// behaves differently again on Windows shells (quotes pass through literally) — the
// CI matrix was silently red on every node-20 cell because of exactly that. Walk
// dist/ ourselves and hand node an explicit file list; identical behavior on every
// node version and OS.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.name.endsWith(".test.js")) out.push(p);
  }
  return out;
}

const files = walk(join(ROOT, "dist"));
if (!files.length) {
  console.error("run-tests: no dist/**/*.test.js files found — did the build run?");
  process.exit(1);
}
const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
