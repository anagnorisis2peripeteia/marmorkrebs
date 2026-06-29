#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { getChangedFilesFromGit } from "./git-changed-files.js";
import { runMutationAnalysis } from "./runner.js";
import type { CrabboxLeaseOptions, MutationConfig, MutationTool } from "./types.js";

const TOOLS: ReadonlySet<string> = new Set([
  "stryker",
  "stryker-net",
  "stryker-cxx",
  "go-mutesting",
  "gomu",
  "cargo-mutants",
  "mutmut",
  "cxx-source",
]);

function usage(): never {
  console.error(`marmorkrebs - mutation testing for PRs via crabbox

Usage:
  marmorkrebs --dir <path> --tool <tool> --changed-files <file,...> [options]
  marmorkrebs --dir <path> --tool <tool> --base <ref> [options]
  marmorkrebs --repo <owner/repo> --pr <number> --tool <tool> [options]

Options:
  --dir <path>              Local checkout directory
  --repo <owner/repo>       GitHub repository (requires gh CLI)
  --pr <number>             PR number (used with --repo to get changed files)
  --tool <tool>             Mutation tool: stryker | stryker-net | stryker-cxx | go-mutesting | gomu | cargo-mutants | mutmut | cxx-source
  --changed-files <files>   Comma-separated list of changed files
  --base <ref>              Derive changed files from the local git diff vs <ref>
                            (branch commits since merge-base + staged/unstaged +
                            untracked) — for locally staged PRs, nothing pushed
  --test-command <cmd>      Custom test command (default: tool-specific)
  --build-command <cmd>     Build command run between mutants (required for stryker-cxx/cxx-source)
  --timeout <ms>            Mutation run timeout in ms (default: 480000)
  --threshold <0-1>         Minimum mutation score to pass (default: none)
  --max-mutants <n>         stryker-cxx only: cap mutants after discovery
  --include-metal           stryker-cxx only: mutate .metal files instead of skipping them
  --mutators <names>        stryker-cxx only: comma-separated mutator names
  --stryker-cxx-bin <path>  Optional stryker-cxx executable (default: stryker-cxx)
                            (or set STRYKER_CXX_BIN)

Crabbox options (omit all for local execution):
  --lease-id <id>           Reuse an existing crabbox lease (skips provision+cleanup)
  --skip-sync               Skip repo sync (code already in lease, use with --remote-dir)
  --remote-dir <path>       Remote directory containing the code (default: /tmp/mutation-target)
  --provider <name>         Provision a new lease with this provider (e.g. tart, local-container)
  --image <image>           Crabbox VM/container image
  --cpus <n>                CPU count for crabbox lease
  --memory <mb>             Memory in MB for crabbox lease

Output:
  JSON MutationResult to stdout. Exit 0 on success, 1 on error, 2 on threshold failure.`);
  process.exit(2);
}

function parseCliArgs(argv: string[]): {
  dir?: string;
  repo?: string;
  pr?: number;
  base?: string;
  tool: MutationTool;
  changedFiles?: string[];
  testCommand?: string;
  buildCommand?: string;
  timeout?: number;
  threshold?: number;
  maxMutants?: number;
  includeMetal?: boolean;
  mutators?: string;
  strykerCxxBinary?: string;
  leaseId?: string;
  skipSync?: boolean;
  remoteDir?: string;
  crabbox?: CrabboxLeaseOptions;
} {
  const BOOLEAN_FLAGS = new Set(["skip-sync", "include-metal"]);
  const args: Record<string, string> = {};
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    if (key.startsWith("--")) {
      const name = key.slice(2);
      if (BOOLEAN_FLAGS.has(name)) {
        args[name] = "true";
      } else if (i + 1 < argv.length) {
        args[name] = argv[++i];
      }
    }
  }

  if (!args.tool || !TOOLS.has(args.tool)) {
    console.error(`Error: --tool must be one of: ${[...TOOLS].join(", ")}`);
    usage();
  }

  const result: ReturnType<typeof parseCliArgs> = {
    tool: args.tool as MutationTool,
  };

  if (args.dir) result.dir = resolve(args.dir);
  if (args.repo) result.repo = args.repo;
  if (args.pr) result.pr = parseInt(args.pr, 10);
  if (args.base) result.base = args.base;
  if (args["changed-files"]) result.changedFiles = args["changed-files"].split(",");
  if (args["test-command"]) result.testCommand = args["test-command"];
  if (args["build-command"]) result.buildCommand = args["build-command"];
  if (args.timeout) result.timeout = parseInt(args.timeout, 10);
  if (args.threshold) result.threshold = parseFloat(args.threshold);
  if (args["max-mutants"]) result.maxMutants = parseInt(args["max-mutants"], 10);
  if ("include-metal" in args) result.includeMetal = true;
  if (args.mutators) result.mutators = args.mutators;
  if (args["stryker-cxx-bin"]) {
    result.strykerCxxBinary = args["stryker-cxx-bin"];
  } else if (process.env.STRYKER_CXX_BIN) {
    result.strykerCxxBinary = process.env.STRYKER_CXX_BIN;
  }

  if (args["lease-id"]) result.leaseId = args["lease-id"];
  if ("skip-sync" in args) result.skipSync = true;
  if (args["remote-dir"]) result.remoteDir = args["remote-dir"];
  if (args.provider) {
    result.crabbox = { provider: args.provider };
    if (args.image) result.crabbox.image = args.image;
    if (args.cpus) result.crabbox.cpus = parseInt(args.cpus, 10);
    if (args.memory) result.crabbox.memory = parseInt(args.memory, 10);
  }

  return result;
}

function getChangedFilesFromPR(repo: string, pr: number): string[] {
  const ghBin = process.env.GH_BIN ?? "gh";
  const result = execFileSync(ghBin, ["pr", "diff", String(pr), "--repo", repo, "--name-only"], {
    encoding: "utf8",
    timeout: 30_000,
  });
  return result
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function main(): void {
  const opts = parseCliArgs(process.argv);

  let repoDir = opts.dir;
  if (!repoDir) {
    if (!opts.repo) {
      console.error("Error: either --dir or --repo is required");
      usage();
    }
    repoDir = process.cwd();
  }

  if (!existsSync(repoDir)) {
    console.error(`Error: directory does not exist: ${repoDir}`);
    process.exit(1);
  }

  let changedFiles = opts.changedFiles;
  if (!changedFiles && opts.repo && opts.pr) {
    try {
      changedFiles = getChangedFilesFromPR(opts.repo, opts.pr);
      console.error(`[marmorkrebs] ${changedFiles.length} changed files from PR #${opts.pr}`);
    } catch (error) {
      console.error(
        `Error fetching PR diff: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
  }

  if (!changedFiles && opts.base) {
    try {
      changedFiles = getChangedFilesFromGit(repoDir, opts.base);
      console.error(
        `[marmorkrebs] ${changedFiles.length} changed files from local diff vs ${opts.base}`,
      );
    } catch (error) {
      console.error(
        `Error deriving local diff: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
  }

  if (!changedFiles || !changedFiles.length) {
    console.error("Error: no changed files (use --changed-files, --base, or --repo --pr)");
    process.exit(1);
  }

  const config: MutationConfig = {
    tool: opts.tool,
    testCommand: opts.testCommand,
    buildCommand: opts.buildCommand,
    base: opts.base,
    timeoutMs: opts.timeout,
    threshold: opts.threshold,
    maxMutants: opts.maxMutants,
    includeMetal: opts.includeMetal,
    mutators: opts.mutators,
    strykerCxxBinary: opts.strykerCxxBinary,
    leaseId: opts.leaseId,
    skipSync: opts.skipSync,
    remoteDir: opts.remoteDir,
    crabbox: opts.crabbox,
  };

  const execTarget = config.leaseId
    ? `lease=${config.leaseId}`
    : config.crabbox
      ? `provider=${config.crabbox.provider}`
      : "local";
  console.error(`[marmorkrebs] tool=${config.tool} files=${changedFiles.length} ${execTarget}`);

  const result = runMutationAnalysis(repoDir, changedFiles, config);

  process.stdout.write(JSON.stringify(result, null, 2) + "\n");

  if (result.error) {
    console.error(`[marmorkrebs] error: ${result.error}`);
    process.exit(1);
  }

  console.error(
    `[marmorkrebs] score=${Math.round(result.score * 100)}% killed=${result.killed} survived=${result.survived} ignored=${result.ignored} elapsed=${result.elapsedMs}ms`,
  );

  if (opts.threshold !== undefined && result.score < opts.threshold) {
    console.error(
      `[marmorkrebs] FAIL: mutation score ${Math.round(result.score * 100)}% < threshold ${Math.round(opts.threshold * 100)}%`,
    );
    process.exit(2);
  }
}

main();
