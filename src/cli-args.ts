// CLI argument parsing, extracted from cli.ts so it is unit-testable without
// executing main(). Invalid input throws UsageError; the cli.ts entry catches it
// and prints usage + exits 2 (tests assert the throw instead of dying).
import { resolve } from "node:path";
import type { CrabboxLeaseOptions, MutationTool } from "./types.js";

export class UsageError extends Error {}

export const TOOLS: ReadonlySet<string> = new Set([
  "stryker",
  "stryker-net",
  "stryker-cxx",
  "mull",
  "go-mutesting",
  "gomu",
  "cargo-mutants",
  "mutmut",
]);

export function splitCommaList(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }
  const items = value.split(",").map((item) => item.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

export function parseCliArgs(argv: string[]): {
  dir?: string;
  repo?: string;
  pr?: number;
  base?: string;
  since?: string;
  tool: MutationTool;
  changedFiles?: string[];
  testCommand?: string;
  buildCommand?: string;
  checkCommand?: string;
  buildSystem?: string;
  buildDir?: string;
  buildTarget?: string;
  artifactPath?: string;
  artifactBackend?: string;
  artifactFallback?: string;
  xcodeWorkspace?: string;
  xcodeProject?: string;
  xcodeScheme?: string;
  xcodeConfiguration?: string;
  xcodeSdk?: string;
  xcodeDestination?: string;
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
  allowEmpty?: boolean;
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
  coverageAnalysis?: string;
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
  workerLabel?: string;
  distributionManifest?: string;
  env?: string[];
  envInherit?: string[];
  envBlock?: string[];
  includeMetal?: boolean;
  mutators?: string;
  mutationLevel?: string;
  ignoreMutations?: string;
  parityProfile?: "summary" | "review" | "strict";
  mode?: string;
  executionMode?: string;
  executionBackend?: string;
  equivalentSuppression?: string;
  plugins?: string[];
  pluginDirs?: string[];
  reporters?: string[];
  dashboardExport?: string;
  dashboardUploadUrl?: string;
  dashboardVersion?: string;
  dashboardRetentionDays?: number;
  dashboardUploadRetries?: number;
  dashboardUploadRetryDelayMs?: number;
  dashboardProject?: string;
  dashboardBranch?: string;
  dashboardCommit?: string;
  dashboardBuildUrl?: string;
  dashboardAuthTokenEnv?: string;
  dashboardAuthHeader?: string;
  strykerCxxBinary?: string;
  mullBinary?: string;
  leaseId?: string;
  skipSync?: boolean;
  remoteDir?: string;
  crabbox?: CrabboxLeaseOptions;
} {
  const BOOLEAN_FLAGS = new Set([
    "allow-empty",
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
    throw new UsageError(`Error: --tool must be one of: ${[...TOOLS].join(", ")}`);
  }

  const result: ReturnType<typeof parseCliArgs> = {
    tool: args.tool as MutationTool,
  };

  if (args.dir) result.dir = resolve(args.dir);
  if (args.repo) result.repo = args.repo;
  if (args.pr) result.pr = parseInt(args.pr, 10);
  if (args.base) result.base = args.base;
  if (args.since) result.since = args.since;
  const changedFiles = splitCommaList(args["changed-files"]);
  if (changedFiles) result.changedFiles = changedFiles;
  if (args["test-command"]) result.testCommand = args["test-command"];
  if (args["build-command"]) result.buildCommand = args["build-command"];
  if (args["check-command"]) result.checkCommand = args["check-command"];
  if (args["build-system"]) result.buildSystem = args["build-system"];
  if (args["build-dir"]) result.buildDir = args["build-dir"];
  if (args["build-target"]) result.buildTarget = args["build-target"];
  if (args["artifact-path"]) result.artifactPath = args["artifact-path"];
  if (args["artifact-backend"]) result.artifactBackend = args["artifact-backend"];
  if (args["artifact-fallback"]) result.artifactFallback = args["artifact-fallback"];
  if (args["xcode-workspace"]) result.xcodeWorkspace = args["xcode-workspace"];
  if (args["xcode-project"]) result.xcodeProject = args["xcode-project"];
  if (args["xcode-scheme"]) result.xcodeScheme = args["xcode-scheme"];
  if (args["xcode-configuration"]) result.xcodeConfiguration = args["xcode-configuration"];
  if (args["xcode-sdk"]) result.xcodeSdk = args["xcode-sdk"];
  if (args["xcode-destination"]) result.xcodeDestination = args["xcode-destination"];
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
  if (args["coverage-analysis"]) result.coverageAnalysis = args["coverage-analysis"];
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
  if (args["worker-label"]) result.workerLabel = args["worker-label"];
  if (args["distribution-manifest"]) result.distributionManifest = args["distribution-manifest"];
  const env = splitCommaList(args.env);
  if (env) result.env = env;
  const envInherit = splitCommaList(args["env-inherit"]);
  if (envInherit) result.envInherit = envInherit;
  const envBlock = splitCommaList(args["env-block"]);
  if (envBlock) result.envBlock = envBlock;
  if (args["max-mutants"]) result.maxMutants = parseInt(args["max-mutants"], 10);
  if ("include-metal" in args) result.includeMetal = true;
  if (args.mutators) result.mutators = args.mutators;
  if (args["mutation-level"]) result.mutationLevel = args["mutation-level"];
  if (args["ignore-mutations"]) result.ignoreMutations = args["ignore-mutations"];
  if (args["parity-profile"]) {
    const profile = args["parity-profile"];
    if (!["summary", "review", "strict"].includes(profile)) {
      throw new UsageError("Error: --parity-profile must be one of: summary, review, strict");
    }
    result.parityProfile = profile as "summary" | "review" | "strict";
  }
  if (args.mode) result.mode = args.mode;
  if (args["execution-mode"]) result.executionMode = args["execution-mode"];
  if (args["execution-backend"]) result.executionBackend = args["execution-backend"];
  if (args["equivalent-suppression"]) {
    result.equivalentSuppression = args["equivalent-suppression"];
  }
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
  if (args["dashboard-upload-retries"]) {
    result.dashboardUploadRetries = parseInt(args["dashboard-upload-retries"], 10);
  }
  if (args["dashboard-upload-retry-delay-ms"]) {
    result.dashboardUploadRetryDelayMs = parseInt(args["dashboard-upload-retry-delay-ms"], 10);
  }
  if (args["dashboard-project"]) result.dashboardProject = args["dashboard-project"];
  if (args["dashboard-branch"]) result.dashboardBranch = args["dashboard-branch"];
  if (args["dashboard-commit"]) result.dashboardCommit = args["dashboard-commit"];
  if (args["dashboard-build-url"]) result.dashboardBuildUrl = args["dashboard-build-url"];
  if (args["dashboard-auth-token-env"]) {
    result.dashboardAuthTokenEnv = args["dashboard-auth-token-env"];
  }
  if (args["dashboard-auth-header"]) result.dashboardAuthHeader = args["dashboard-auth-header"];
  if (args["stryker-cxx-bin"]) {
    result.strykerCxxBinary = args["stryker-cxx-bin"];
  } else if (process.env.STRYKER_CXX_BIN) {
    result.strykerCxxBinary = process.env.STRYKER_CXX_BIN;
  }
  if (args["mull-bin"]) {
    result.mullBinary = args["mull-bin"];
  } else if (process.env.MULL_CXX_BIN) {
    result.mullBinary = process.env.MULL_CXX_BIN;
  }

  if (args["lease-id"]) result.leaseId = args["lease-id"];
  if ("skip-sync" in args) result.skipSync = true;
  if ("allow-empty" in args) result.allowEmpty = true;
  if (args["remote-dir"]) result.remoteDir = args["remote-dir"];
  if (args.provider) {
    result.crabbox = { provider: args.provider };
    if (args.image) result.crabbox.image = args.image;
    if (args.cpus) result.crabbox.cpus = parseInt(args.cpus, 10);
    if (args.memory) result.crabbox.memory = parseInt(args.memory, 10);
  }

  return result;
}
