#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getChangedFilesFromGit, getChangedLineRangesFromGit } from "./git-changed-files.js";
import { runMutationAnalysis } from "./runner.js";
import type { CrabboxLeaseOptions, MutationConfig, MutationTool } from "./types.js";
import { parseCliArgs, TOOLS, UsageError } from "./cli-args.js";



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
  --tool <tool>             Mutation tool: stryker | stryker-net | stryker-cxx | mull | go-mutesting | gomu | cargo-mutants | mutmut
  --changed-files <files>   Comma-separated list of changed files
  --base <ref>              Derive changed files from the local git diff vs <ref>
                            (branch commits since merge-base + staged/unstaged +
                            untracked) — for locally staged PRs, nothing pushed
  --since <ref>             Stryker-style alias for --base in local C++ flows
  --test-command <cmd>      Custom test command (default: tool-specific)
  --build-command <cmd>     Build command run between mutants (required for stryker-cxx)
  --check-command <cmd>     stryker-cxx only: compile/type-check command run before tests
  --build-system <name>     stryker-cxx only: cmake | ctest | ninja | make | meson | bazel | xcodebuild
  --build-dir <path>        stryker-cxx only: adapter build directory
  --build-target <target>   stryker-cxx only: adapter build target
  --artifact-path <path>    stryker-cxx only: original artifact to swap/restore
  --artifact-backend <mode> stryker-cxx only: source-overlay | compiled-executable | compiled-library | compiled-object
  --artifact-fallback <mode>
                            stryker-cxx only: none | source-overlay
  --xcode-workspace <path>  stryker-cxx only: xcodebuild workspace
  --xcode-project <path>    stryker-cxx only: xcodebuild project
  --xcode-scheme <name>     stryker-cxx only: xcodebuild scheme
  --xcode-configuration <c> stryker-cxx only: xcodebuild configuration
  --xcode-sdk <sdk>         stryker-cxx only: xcodebuild SDK
  --xcode-destination <d>   stryker-cxx only: xcodebuild destination
  --check-system <name>     stryker-cxx only: clang | clang++ | clang-tidy | cppcheck
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
  --allow-empty             Let a zero-mutant result pass (default: a 0-mutant run is an error)
  --report-file <path>      Also write the MutationResult JSON to <path> (written before
                            exit-code evaluation, so gate evidence exists even for failures)
  --threshold-high <0-1>    stryker-cxx only: healthy score band
  --threshold-low <0-1>     stryker-cxx only: warning score band
  --threshold-break <0-1>   stryker-cxx only: failing score band
  --timeout-factor <n>      stryker-cxx only: dry-run timeout multiplier
  --timeout-constant-ms <n> stryker-cxx only: dry-run timeout constant
  --skip-initial-test       stryker-cxx only: skip unmutated build/test validation
  --dry-run-only            stryker-cxx only: validate unmutated build/test and stop
  --skip-tests              stryker-cxx only: run build/check phases without tests
  --coverage-file <path>    stryker-cxx only: llvm-cov JSON, simple JSON, or LCOV coverage file
  --coverage-analysis <m>   stryker-cxx only: off | all | perTest | perTestInIsolation
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
  --worker-label <label>    stryker-cxx only: label retained worker/worktree artifacts
  --distribution-manifest <path>
                            stryker-cxx only: write shard/work distribution manifest
  --env <KEY=VALUE,...>     stryker-cxx only: explicit env injected into build/check/test
  --env-inherit <KEY,...>   stryker-cxx only: inherited env allowlist for build/check/test
  --env-block <KEY,...>     stryker-cxx only: inherited env denylist for build/check/test
  --max-mutants <n>         stryker-cxx only: cap mutants after discovery
  --include-metal           stryker-cxx only: mutate .metal files instead of skipping them
  --mutators <names>        stryker-cxx only: comma-separated mutator names
  --mutation-level <level>  stryker-cxx only: Basic | Standard | Advanced | Complete
  --ignore-mutations <names>
                            stryker-cxx only: comma-separated mutators to mark ignored
  --parity-profile <p>      stryker-cxx only: summary | review | strict
  --mode <mode>             stryker-cxx only: token | clang | clang-ast
  --execution-mode <mode>   stryker-cxx only: source-overlay | mutant-switch
  --execution-backend <m>   stryker-cxx only: auto | source-overlay | mutant-switch | compiled-artifact | llvm-switch
  --equivalent-suppression <mode>
                            stryker-cxx only: off | conservative | aggressive
  --plugin <path>           stryker-cxx only: plugin manifest path, repeatable via comma
  --plugin-dir <path>       stryker-cxx only: directory containing stryker-cxx-plugin.json
  --reporter <name>         stryker-cxx only: requested reporter, repeatable via comma
  --dashboard-export <path> stryker-cxx only: write dashboard JSON export
  --dashboard-upload-url <url>
                            stryker-cxx only: POST dashboard JSON to explicit URL
  --dashboard-version <v>   stryker-cxx only: dashboard payload version metadata
  --dashboard-retention-days <n>
                            stryker-cxx only: dashboard retention policy metadata
  --dashboard-upload-retries <n>
                            stryker-cxx only: dashboard upload retry count
  --dashboard-upload-retry-delay-ms <n>
                            stryker-cxx only: dashboard upload retry delay
  --dashboard-project <id>  stryker-cxx only: dashboard project/repository id
  --dashboard-branch <name> stryker-cxx only: dashboard branch name
  --dashboard-commit <sha>  stryker-cxx only: dashboard commit sha
  --dashboard-build-url <u> stryker-cxx only: dashboard CI/build URL
  --dashboard-auth-token-env <KEY>
                            stryker-cxx only: env var used for upload bearer auth
  --dashboard-auth-header <name>
                            stryker-cxx only: upload auth header name
  --mull-bin <path>         Optional mull executable (default: mull)
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
  let opts: ReturnType<typeof parseCliArgs>;
  try {
    opts = parseCliArgs(process.argv);
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(e.message);
      usage();
    }
    throw e;
  }

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

  const diffBase = opts.base ?? opts.since;
  if (!changedFiles && diffBase) {
    try {
      changedFiles = opts.scopeLines
        ? getChangedLineRangesFromGit(repoDir, diffBase)
        : getChangedFilesFromGit(repoDir, diffBase);
      console.error(
        `[marmorkrebs] ${changedFiles.length} changed files from local diff vs ${diffBase}`,
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
    artifactPath: opts.artifactPath,
    artifactBackend: opts.artifactBackend,
    artifactFallback: opts.artifactFallback,
    xcodeWorkspace: opts.xcodeWorkspace,
    xcodeProject: opts.xcodeProject,
    xcodeScheme: opts.xcodeScheme,
    xcodeConfiguration: opts.xcodeConfiguration,
    xcodeSdk: opts.xcodeSdk,
    xcodeDestination: opts.xcodeDestination,
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
    since: opts.since,
    timeoutMs: opts.timeout,
    threshold: opts.threshold,
    allowEmpty: opts.allowEmpty,
    excludeMutations: opts.excludeMutations,
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
    baselineMaxAgeDays: opts.baselineMaxAgeDays,
    baselineBranch: opts.baselineBranch,
    writeBaseline: opts.writeBaseline,
    clearBaseline: opts.clearBaseline,
    batchMutants: opts.batchMutants,
    batchSize: opts.batchSize,
    worktreeMode: opts.worktreeMode,
    retainWorktrees: opts.retainWorktrees,
    retainWorktreesFor: opts.retainWorktreesFor,
    retainedWorktreeTtlHours: opts.retainedWorktreeTtlHours,
    workerTmpDir: opts.workerTmpDir,
    workerLabel: opts.workerLabel,
    distributionManifest: opts.distributionManifest,
    env: opts.env,
    envInherit: opts.envInherit,
    envBlock: opts.envBlock,
    maxMutants: opts.maxMutants,
    includeMetal: opts.includeMetal,
    mutators: opts.mutators,
    mutationLevel: opts.mutationLevel,
    ignoreMutations: opts.ignoreMutations,
    parityProfile: opts.parityProfile,
    mode: opts.mode,
    executionMode: opts.executionMode,
    executionBackend: opts.executionBackend,
    equivalentSuppression: opts.equivalentSuppression,
    plugins: opts.plugins,
    pluginDirs: opts.pluginDirs,
    reporters: opts.reporters,
    dashboardExport: opts.dashboardExport,
    dashboardUploadUrl: opts.dashboardUploadUrl,
    dashboardVersion: opts.dashboardVersion,
    dashboardRetentionDays: opts.dashboardRetentionDays,
    dashboardUploadRetries: opts.dashboardUploadRetries,
    dashboardUploadRetryDelayMs: opts.dashboardUploadRetryDelayMs,
    dashboardProject: opts.dashboardProject,
    dashboardBranch: opts.dashboardBranch,
    dashboardCommit: opts.dashboardCommit,
    dashboardBuildUrl: opts.dashboardBuildUrl,
    dashboardAuthTokenEnv: opts.dashboardAuthTokenEnv,
    dashboardAuthHeader: opts.dashboardAuthHeader,
    strykerCxxBinary: opts.strykerCxxBinary,
    mullBinary: opts.mullBinary,
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

  if (opts.reportFile) {
    // Written BEFORE the error/threshold exits: the artifact must exist precisely
    // when the gate fails, or the evidence trail only covers the happy path.
    writeFileSync(opts.reportFile, JSON.stringify(result, null, 2) + "\n");
    console.error(`[marmorkrebs] report written to ${opts.reportFile}`);
  }

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
