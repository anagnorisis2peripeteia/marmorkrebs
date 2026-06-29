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
  --tool <tool>             Mutation tool: stryker | stryker-net | stryker-cxx | go-mutesting | gomu | cargo-mutants | mutmut
  --changed-files <files>   Comma-separated list of changed files
  --base <ref>              Derive changed files from the local git diff vs <ref>
                            (branch commits since merge-base + staged/unstaged +
                            untracked) — for locally staged PRs, nothing pushed
  --test-command <cmd>      Custom test command (default: tool-specific)
  --build-command <cmd>     Build command run between mutants (required for stryker-cxx)
  --check-command <cmd>     stryker-cxx only: compile/type-check command run before tests
  --build-system <name>     stryker-cxx only: cmake | ctest | ninja | make | meson | bazel
  --build-dir <path>        stryker-cxx only: adapter build directory
  --build-target <target>   stryker-cxx only: adapter build target
  --check-system <name>     stryker-cxx only: clang-tidy | cppcheck
  --check-args <args>       stryker-cxx only: adapter checker arguments
  --test-target <target>    stryker-cxx only: adapter test target
  --test-filter <pattern>   stryker-cxx only: adapter test filter
  --test-framework <name>   stryker-cxx only: gtest | catch2 | doctest | xctest
  --test-binary <path>      stryker-cxx only: framework test binary override/disambiguation
  --xctest-bundle <path>    stryker-cxx only: XCTest bundle path
  --xctest-destination <d>  stryker-cxx only: xcodebuild destination
  --xctest-only-testing <t> stryker-cxx only: XCTest only-testing target(s), commaable
  --xctest-skip-testing <t> stryker-cxx only: XCTest skip-testing target(s), commaable
  --timeout <ms>            Mutation run timeout in ms (default: 480000)
  --threshold <0-1>         Minimum mutation score to pass (default: none)
  --threshold-high <0-1>    stryker-cxx only: healthy score band
  --threshold-low <0-1>     stryker-cxx only: warning score band
  --threshold-break <0-1>   stryker-cxx only: failing score band
  --timeout-factor <n>      stryker-cxx only: dry-run timeout multiplier
  --timeout-constant-ms <n> stryker-cxx only: dry-run timeout constant
  --skip-initial-test       stryker-cxx only: skip unmutated build/test validation
  --dry-run-only            stryker-cxx only: validate unmutated build/test and stop
  --skip-tests              stryker-cxx only: run build/check phases without tests
  --coverage-file <path>    stryker-cxx only: llvm-cov JSON, simple JSON, or LCOV coverage file
  --coverage-provider <id>  stryker-cxx only: label for supplied coverage data
  --coverage-test-command-template <cmd>
                            stryker-cxx only: per-mutant test command template using coverage coveredTests
  --coverage-helper-command-template <cmd>
                            stryker-cxx only: command template that writes per-test coverage
  --coverage-helper-tests <tests>
                            stryker-cxx only: comma-separated tests passed to the coverage helper
  --incremental             stryker-cxx only: reuse compatible results from baseline cache
  --baseline-file <path>    stryker-cxx only: baseline cache path
  --baseline-max-age-days <n>
                            stryker-cxx only: only reuse recent baseline entries
  --baseline-branch <name>  stryker-cxx only: only reuse entries for this branch name
  --write-baseline <path>   stryker-cxx only: write/update baseline cache after run
  --clear-baseline          stryker-cxx only: delete selected baseline cache before run
  --batch-mutants           stryker-cxx only: batch compatible mutants in isolated worktrees
  --batch-size <n>          stryker-cxx only: maximum compatible mutants per batch
  --worktree-mode <mode>    stryker-cxx only: inplace | copy | git-worktree
  --retain-worktrees        stryker-cxx only: keep generated copy/git worktrees for debugging
  --retain-worktrees-for <statuses>
                            stryker-cxx only: retain copy/git worktrees for selected statuses
  --retained-worktree-ttl-hours <n>
                            stryker-cxx only: remove old retained worktrees under worker tmp
  --worker-tmp-dir <path>   stryker-cxx only: parent directory for worker worktrees
  --env <KEY=VALUE,...>     stryker-cxx only: explicit env injected into build/check/test
  --env-inherit <KEY,...>   stryker-cxx only: inherited env allowlist for build/check/test
  --env-block <KEY,...>     stryker-cxx only: inherited env denylist for build/check/test
  --max-mutants <n>         stryker-cxx only: cap mutants after discovery
  --include-metal           stryker-cxx only: mutate .metal files instead of skipping them
  --mutators <names>        stryker-cxx only: comma-separated mutator names
  --mode <mode>             stryker-cxx only: token | clang | clang-ast
  --plugin <path>           stryker-cxx only: plugin manifest path, repeatable via comma
  --plugin-dir <path>       stryker-cxx only: directory containing stryker-cxx-plugin.json
  --reporter <name>         stryker-cxx only: requested reporter, repeatable via comma
  --dashboard-export <path> stryker-cxx only: write dashboard JSON export
  --dashboard-upload-url <url>
                            stryker-cxx only: POST dashboard JSON to explicit URL
  --dashboard-version <v>   stryker-cxx only: dashboard payload version metadata
  --dashboard-retention-days <n>
                            stryker-cxx only: dashboard retention policy metadata
  --dashboard-auth-token-env <KEY>
                            stryker-cxx only: env var used for upload bearer auth
  --dashboard-auth-header <name>
                            stryker-cxx only: upload auth header name
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

function splitCommaList(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }
  const items = value.split(",").map((item) => item.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
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
  checkCommand?: string;
  buildSystem?: string;
  buildDir?: string;
  buildTarget?: string;
  checkSystem?: string;
  checkArgs?: string;
  testTarget?: string;
  testFilter?: string;
  testFramework?: string;
  testBinary?: string;
  xctestBundle?: string;
  xctestDestination?: string;
  xctestOnlyTesting?: string[];
  xctestSkipTesting?: string[];
  timeout?: number;
  threshold?: number;
  thresholdHigh?: number;
  thresholdLow?: number;
  thresholdBreak?: number;
  maxMutants?: number;
  timeoutFactor?: number;
  timeoutConstantMs?: number;
  skipInitialTest?: boolean;
  dryRunOnly?: boolean;
  skipTests?: boolean;
  coverageFile?: string;
  coverageProvider?: string;
  coverageTestCommandTemplate?: string;
  coverageHelperCommandTemplate?: string;
  coverageHelperTests?: string[];
  incremental?: boolean;
  baselineFile?: string;
  baselineMaxAgeDays?: number;
  baselineBranch?: string;
  writeBaseline?: string;
  clearBaseline?: boolean;
  batchMutants?: boolean;
  batchSize?: number;
  worktreeMode?: string;
  retainWorktrees?: boolean;
  retainWorktreesFor?: string[];
  retainedWorktreeTtlHours?: number;
  workerTmpDir?: string;
  env?: string[];
  envInherit?: string[];
  envBlock?: string[];
  includeMetal?: boolean;
  mutators?: string;
  mode?: string;
  plugins?: string[];
  pluginDirs?: string[];
  reporters?: string[];
  dashboardExport?: string;
  dashboardUploadUrl?: string;
  dashboardVersion?: string;
  dashboardRetentionDays?: number;
  dashboardAuthTokenEnv?: string;
  dashboardAuthHeader?: string;
  strykerCxxBinary?: string;
  leaseId?: string;
  skipSync?: boolean;
  remoteDir?: string;
  crabbox?: CrabboxLeaseOptions;
} {
  const BOOLEAN_FLAGS = new Set([
    "skip-sync",
    "include-metal",
    "skip-initial-test",
    "dry-run-only",
    "skip-tests",
    "incremental",
    "clear-baseline",
    "batch-mutants",
    "retain-worktrees",
  ]);
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
  const changedFiles = splitCommaList(args["changed-files"]);
  if (changedFiles) result.changedFiles = changedFiles;
  if (args["test-command"]) result.testCommand = args["test-command"];
  if (args["build-command"]) result.buildCommand = args["build-command"];
  if (args["check-command"]) result.checkCommand = args["check-command"];
  if (args["build-system"]) result.buildSystem = args["build-system"];
  if (args["build-dir"]) result.buildDir = args["build-dir"];
  if (args["build-target"]) result.buildTarget = args["build-target"];
  if (args["check-system"]) result.checkSystem = args["check-system"];
  if (args["check-args"]) result.checkArgs = args["check-args"];
  if (args["test-target"]) result.testTarget = args["test-target"];
  if (args["test-filter"]) result.testFilter = args["test-filter"];
  if (args["test-framework"]) result.testFramework = args["test-framework"];
  if (args["test-binary"]) result.testBinary = args["test-binary"];
  if (args["xctest-bundle"]) result.xctestBundle = args["xctest-bundle"];
  if (args["xctest-destination"]) result.xctestDestination = args["xctest-destination"];
  const xctestOnlyTesting = splitCommaList(args["xctest-only-testing"]);
  if (xctestOnlyTesting) result.xctestOnlyTesting = xctestOnlyTesting;
  const xctestSkipTesting = splitCommaList(args["xctest-skip-testing"]);
  if (xctestSkipTesting) result.xctestSkipTesting = xctestSkipTesting;
  if (args.timeout !== undefined) result.timeout = parseInt(args.timeout, 10);
  if (args.threshold !== undefined) result.threshold = parseFloat(args.threshold);
  if (args["threshold-high"] !== undefined) {
    result.thresholdHigh = parseFloat(args["threshold-high"]);
  }
  if (args["threshold-low"] !== undefined) {
    result.thresholdLow = parseFloat(args["threshold-low"]);
  }
  if (args["threshold-break"] !== undefined) {
    result.thresholdBreak = parseFloat(args["threshold-break"]);
  }
  if (args["timeout-factor"] !== undefined) {
    result.timeoutFactor = parseFloat(args["timeout-factor"]);
  }
  if (args["timeout-constant-ms"] !== undefined) {
    result.timeoutConstantMs = parseInt(args["timeout-constant-ms"], 10);
  }
  if ("skip-initial-test" in args) result.skipInitialTest = true;
  if ("dry-run-only" in args) result.dryRunOnly = true;
  if ("skip-tests" in args) result.skipTests = true;
  if (args["coverage-file"]) result.coverageFile = args["coverage-file"];
  if (args["coverage-provider"]) result.coverageProvider = args["coverage-provider"];
  if (args["coverage-test-command-template"]) {
    result.coverageTestCommandTemplate = args["coverage-test-command-template"];
  }
  if (args["coverage-helper-command-template"]) {
    result.coverageHelperCommandTemplate = args["coverage-helper-command-template"];
  }
  const coverageHelperTests = splitCommaList(args["coverage-helper-tests"]);
  if (coverageHelperTests) result.coverageHelperTests = coverageHelperTests;
  if ("incremental" in args) result.incremental = true;
  if (args["baseline-file"]) result.baselineFile = args["baseline-file"];
  if (args["baseline-max-age-days"]) result.baselineMaxAgeDays = parseInt(args["baseline-max-age-days"], 10);
  if (args["baseline-branch"]) result.baselineBranch = args["baseline-branch"];
  if (args["write-baseline"]) result.writeBaseline = args["write-baseline"];
  if ("clear-baseline" in args) result.clearBaseline = true;
  if ("batch-mutants" in args) result.batchMutants = true;
  if (args["batch-size"]) result.batchSize = parseInt(args["batch-size"], 10);
  if (args["worktree-mode"]) result.worktreeMode = args["worktree-mode"];
  if ("retain-worktrees" in args) result.retainWorktrees = true;
  const retainWorktreesFor = splitCommaList(args["retain-worktrees-for"]);
  if (retainWorktreesFor) result.retainWorktreesFor = retainWorktreesFor;
  if (args["retained-worktree-ttl-hours"]) {
    result.retainedWorktreeTtlHours = parseFloat(args["retained-worktree-ttl-hours"]);
  }
  if (args["worker-tmp-dir"]) result.workerTmpDir = args["worker-tmp-dir"];
  const env = splitCommaList(args.env);
  if (env) result.env = env;
  const envInherit = splitCommaList(args["env-inherit"]);
  if (envInherit) result.envInherit = envInherit;
  const envBlock = splitCommaList(args["env-block"]);
  if (envBlock) result.envBlock = envBlock;
  if (args["max-mutants"]) result.maxMutants = parseInt(args["max-mutants"], 10);
  if ("include-metal" in args) result.includeMetal = true;
  if (args.mutators) result.mutators = args.mutators;
  if (args.mode) result.mode = args.mode;
  const plugins = splitCommaList(args.plugin);
  if (plugins) result.plugins = plugins;
  const pluginDirs = splitCommaList(args["plugin-dir"]);
  if (pluginDirs) result.pluginDirs = pluginDirs;
  const reporters = splitCommaList(args.reporter);
  if (reporters) result.reporters = reporters;
  if (args["dashboard-export"]) result.dashboardExport = args["dashboard-export"];
  if (args["dashboard-upload-url"]) result.dashboardUploadUrl = args["dashboard-upload-url"];
  if (args["dashboard-version"]) result.dashboardVersion = args["dashboard-version"];
  if (args["dashboard-retention-days"]) {
    result.dashboardRetentionDays = parseInt(args["dashboard-retention-days"], 10);
  }
  if (args["dashboard-auth-token-env"]) {
    result.dashboardAuthTokenEnv = args["dashboard-auth-token-env"];
  }
  if (args["dashboard-auth-header"]) result.dashboardAuthHeader = args["dashboard-auth-header"];
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
    checkCommand: opts.checkCommand,
    buildSystem: opts.buildSystem,
    buildDir: opts.buildDir,
    buildTarget: opts.buildTarget,
    checkSystem: opts.checkSystem,
    checkArgs: opts.checkArgs,
    testTarget: opts.testTarget,
    testFilter: opts.testFilter,
    testFramework: opts.testFramework,
    testBinary: opts.testBinary,
    xctestBundle: opts.xctestBundle,
    xctestDestination: opts.xctestDestination,
    xctestOnlyTesting: opts.xctestOnlyTesting,
    xctestSkipTesting: opts.xctestSkipTesting,
    base: opts.base,
    timeoutMs: opts.timeout,
    threshold: opts.threshold,
    thresholdHigh: opts.thresholdHigh,
    thresholdLow: opts.thresholdLow,
    thresholdBreak: opts.thresholdBreak,
    timeoutFactor: opts.timeoutFactor,
    timeoutConstantMs: opts.timeoutConstantMs,
    skipInitialTest: opts.skipInitialTest,
    dryRunOnly: opts.dryRunOnly,
    skipTests: opts.skipTests,
    coverageFile: opts.coverageFile,
    coverageProvider: opts.coverageProvider,
    coverageTestCommandTemplate: opts.coverageTestCommandTemplate,
    coverageHelperCommandTemplate: opts.coverageHelperCommandTemplate,
    coverageHelperTests: opts.coverageHelperTests,
    incremental: opts.incremental,
    baselineFile: opts.baselineFile,
    writeBaseline: opts.writeBaseline,
    clearBaseline: opts.clearBaseline,
    batchMutants: opts.batchMutants,
    batchSize: opts.batchSize,
    maxMutants: opts.maxMutants,
    includeMetal: opts.includeMetal,
    mutators: opts.mutators,
    mode: opts.mode,
    plugins: opts.plugins,
    pluginDirs: opts.pluginDirs,
    reporters: opts.reporters,
    dashboardExport: opts.dashboardExport,
    dashboardUploadUrl: opts.dashboardUploadUrl,
    dashboardVersion: opts.dashboardVersion,
    dashboardRetentionDays: opts.dashboardRetentionDays,
    dashboardAuthTokenEnv: opts.dashboardAuthTokenEnv,
    dashboardAuthHeader: opts.dashboardAuthHeader,
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

  const breakThreshold = opts.thresholdBreak ?? opts.threshold;
  if (
    (breakThreshold !== undefined && result.score < breakThreshold) ||
    result.thresholds?.status === "failed"
  ) {
    const threshold = breakThreshold ?? result.thresholds?.break ?? 0;
    console.error(
      `[marmorkrebs] FAIL: mutation score ${Math.round(result.score * 100)}% < threshold ${Math.round(threshold * 100)}%`,
    );
    process.exit(2);
  }
}

main();
