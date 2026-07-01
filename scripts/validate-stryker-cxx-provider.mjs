#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function run(command, args, options = {}) {
  console.log(`[run] ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    ...options,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function capture(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: "utf8",
    shell: process.platform === "win32",
    ...options,
  });
}

function canRun(command) {
  if (command.includes("/") || command.includes("\\") || command.includes(" ")) {
    return true;
  }
  const probe = process.platform === "win32"
    ? spawnSync("where", [command], { stdio: "ignore", shell: true })
    : spawnSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" });
  return probe.status === 0;
}

run("npm", ["run", "check"]);
run("npm", ["run", "lint"]);
run("npm", ["run", "build"]);
run("npm", ["test"]);

const strykerCxx = process.env.STRYKER_CXX_BIN || "stryker-cxx";
if (!canRun(strykerCxx)) {
  console.log("[skip] stryker-cxx provider smoke: STRYKER_CXX_BIN/stryker-cxx not available");
  process.exit(0);
}

const repo = mkdtempSync(join(tmpdir(), "marmorkrebs-stryker-cxx-"));
const workerTmp = mkdtempSync(join(tmpdir(), "marmorkrebs-stryker-cxx-workers-"));
const distributionManifest = join(repo, "distribution.json");
writeFileSync(join(repo, "sample.cpp"), "int main() { return 1 == 1 ? 0 : 1; }\n");
writeFileSync(join(repo, "noop.mjs"), "process.exit(0);\n");

const nodeCommand = `"${process.execPath}" noop.mjs`;
const result = capture("node", [
  "dist/cli.js",
  "--dir",
  repo,
  "--tool",
  "stryker-cxx",
  "--changed-files",
  "sample.cpp:1",
  "--build-command",
  nodeCommand,
  "--test-command",
  nodeCommand,
  "--execution-mode",
  "source-overlay",
  "--dry-run-only",
  "--max-mutants",
  "1",
  "--worktree-mode",
  "copy",
  "--retain-worktrees-for",
  "SURVIVED,TIMEOUT",
  "--retained-worktree-ttl-hours",
  "24",
  "--worker-tmp-dir",
  workerTmp,
  "--worker-label",
  "marmorkrebs-provider-smoke",
  "--distribution-manifest",
  distributionManifest,
  "--env-inherit",
  "PATH",
  "--env-block",
  "GITHUB_TOKEN",
  "--stryker-cxx-bin",
  strykerCxx,
]);

if (result.status !== 0) {
  process.stderr.write(result.stderr || "");
  process.stdout.write(result.stdout || "");
  process.exit(result.status ?? 1);
}

const payload = JSON.parse(result.stdout);
if (payload.tool !== "stryker-cxx") {
  throw new Error(`expected tool=stryker-cxx, got ${payload.tool}`);
}
if (payload.totalMutants < 1) {
  throw new Error(`expected at least one stryker-cxx mutant, got ${payload.totalMutants}`);
}
if (payload.error) {
  throw new Error(`stryker-cxx provider smoke returned error: ${payload.error}`);
}
if (payload.provider?.executionMode !== "source-overlay") {
  throw new Error(`expected forwarded executionMode=source-overlay, got ${payload.provider?.executionMode}`);
}

const manifestPayload = JSON.parse(readFileSync(distributionManifest, "utf8"));
if (manifestPayload.schemaVersion !== "stryker-cxx.distribution.v1") {
  throw new Error(`expected distribution manifest schema, got ${manifestPayload.schemaVersion}`);
}
if (manifestPayload.worker?.label !== "marmorkrebs-provider-smoke") {
  throw new Error(`expected worker label in distribution manifest, got ${manifestPayload.worker?.label}`);
}
if (manifestPayload.shard?.selectedMutants !== payload.totalMutants) {
  throw new Error(
    `expected distribution selectedMutants=${payload.totalMutants}, got ${manifestPayload.shard?.selectedMutants}`,
  );
}

console.log("[marmorkrebs] stryker-cxx provider validation completed");
