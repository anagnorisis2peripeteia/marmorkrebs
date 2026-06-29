import { fileURLToPath } from "node:url";
import {
  EMPTY_RESULT,
  type MutationConfig,
  type MutationResult,
  type MutationTool,
  type SurvivingMutant,
} from "../types.js";

/**
 * Marmorkrebs' C++/ObjC++ source mutation parser and command builder.
 * The supported CLI provider is the external stryker-cxx tool.
 * This module keeps a historical parser path to normalize legacy cxx-source
 * reports into Marmorkrebs result shape.
 */

interface CxxMutant {
  id?: string;
  mutator: string;
  file: string;
  line: number;
  col: number;
  original: string;
  mutated: string;
  status: string;
  detail: string;
}

interface CxxReport {
  schemaVersion?: string;
  tool?: string;
  target_files?: string[];
  targetFiles?: string[];
  total?: number;
  totalMutants?: number;
  killed: number;
  survived: number;
  build_error?: number;
  buildErrors?: number;
  check_error?: number;
  checkErrors?: number;
  no_coverage?: number;
  noCoverage?: number;
  timeouts?: number;
  ignored?: number;
  mutants: CxxMutant[];
  score: number;
  scorePercent?: number;
  thresholds?: {
    high: number;
    low: number;
    break: number;
    status: "failed" | "low" | "acceptable" | "high";
  };
  dryRun?: {
    status: string;
    failureReason?: string;
  };
  execution?: {
    resourceIsolation?: Record<string, unknown>;
  };
}

function enginePath(): string {
  return fileURLToPath(new URL("../../engines/cxx-source/marmorkrebs-cxx.py", import.meta.url));
}

export function buildCxxSourceCommand(
  sourceFiles: string[],
  workDir: string,
  config: MutationConfig,
): string {
  if (config.tool === "stryker-cxx" || config.strykerCxxBinary) {
    return buildExternalCxxSourceCommand(sourceFiles, workDir, config);
  }

  if (!config.buildCommand || !config.testCommand) {
    throw new Error("cxx-source requires --build-command and --test-command");
  }

  const engine = enginePath();
  const files = sourceFiles.join(",");

  const parts = [
    "python3",
    `'${shellEscape(engine)}'`,
    "--repo-dir",
    `'${shellEscape(workDir)}'`,
    "--files",
    `'${shellEscape(files)}'`,
  ];
  if (config.base) {
    parts.push("--diff-base", `'${shellEscape(config.base)}'`);
  }
  parts.push("--build-cmd", `'${shellEscape(config.buildCommand)}'`);
  parts.push("--test-cmd", `'${shellEscape(config.testCommand)}'`);
  if (config.maxMutants !== undefined) {
    parts.push("--max-mutants", String(config.maxMutants));
  }
  if (config.includeMetal) {
    parts.push("--include-metal");
  }
  if (config.mutators) {
    parts.push("--mutators", `'${shellEscape(config.mutators)}'`);
  }
  if (config.mode) {
    parts.push("--mode", `'${shellEscape(config.mode)}'`);
  }
  // The engine's own progress goes to stdout; redirect it to stderr and emit
  // only the JSON report (written to a temp file) on stdout.
  return `report="$(mktemp)" && ${parts.join(" ")} --report "$report" 1>&2; cat "$report"`;
}

function buildExternalCxxSourceCommand(
  sourceFiles: string[],
  workDir: string,
  config: MutationConfig,
): string {
  if (!config.buildCommand && !config.buildSystem) {
    throw new Error("stryker-cxx requires --build-command or --build-system");
  }
  if (!config.testCommand && !config.skipTests && !config.buildSystem) {
    throw new Error(
      "stryker-cxx requires --test-command unless --skip-tests or --build-system is set",
    );
  }

  const files = sourceFiles.join(",");
  const timeoutSeconds =
    config.timeoutMs !== undefined
      ? Math.max(1, Math.ceil(config.timeoutMs / 1000))
      : undefined;
  const buildCommand = config.buildCommand;
  const testCommand = config.testCommand;

  const parts = [
    `'${shellEscape(config.strykerCxxBinary ?? "stryker-cxx")}'`,
    "run",
    "--repo",
    `'${shellEscape(workDir)}'`,
    "--files",
    `'${shellEscape(files)}'`,
    "--format",
    "json",
  ];
  if (buildCommand) {
    parts.push("--build-command", `'${shellEscape(buildCommand)}'`);
  }
  if (config.checkCommand) {
    parts.push("--check-command", `'${shellEscape(config.checkCommand)}'`);
  }
  if (config.buildSystem) {
    parts.push("--build-system", `'${shellEscape(config.buildSystem)}'`);
  }
  if (config.buildDir) {
    parts.push("--build-dir", `'${shellEscape(config.buildDir)}'`);
  }
  if (config.buildTarget) {
    parts.push("--build-target", `'${shellEscape(config.buildTarget)}'`);
  }
  if (config.checkSystem) {
    parts.push("--check-system", `'${shellEscape(config.checkSystem)}'`);
  }
  if (config.checkArgs) {
    parts.push("--check-args", `'${shellEscape(config.checkArgs)}'`);
  }
  if (config.testTarget) {
    parts.push("--test-target", `'${shellEscape(config.testTarget)}'`);
  }
  if (config.testFilter) {
    parts.push("--test-filter", `'${shellEscape(config.testFilter)}'`);
  }
  if (config.testFramework) {
    parts.push("--test-framework", `'${shellEscape(config.testFramework)}'`);
  }
  if (config.testBinary) {
    parts.push("--test-binary", `'${shellEscape(config.testBinary)}'`);
  }
  if (config.xctestBundle) {
    parts.push("--xctest-bundle", `'${shellEscape(config.xctestBundle)}'`);
  }
  if (config.xctestDestination) {
    parts.push("--xctest-destination", `'${shellEscape(config.xctestDestination)}'`);
  }
  for (const item of config.xctestOnlyTesting ?? []) {
    parts.push("--xctest-only-testing", `'${shellEscape(item)}'`);
  }
  for (const item of config.xctestSkipTesting ?? []) {
    parts.push("--xctest-skip-testing", `'${shellEscape(item)}'`);
  }
  if (testCommand) {
    parts.push("--test-command", `'${shellEscape(testCommand)}'`);
  }
  if (config.mode) {
    parts.push("--mode", `'${shellEscape(config.mode)}'`);
  }
  if (config.base) {
    parts.push("--base", `'${shellEscape(config.base)}'`);
  }
  if (config.maxMutants !== undefined) {
    parts.push("--max-mutants", String(config.maxMutants));
  }
  if (config.includeMetal) {
    parts.push("--include-metal");
  }
  if (config.mutators) {
    parts.push("--mutators", `'${shellEscape(config.mutators)}'`);
  }
  for (const plugin of config.plugins ?? []) {
    parts.push("--plugin", `'${shellEscape(plugin)}'`);
  }
  for (const pluginDir of config.pluginDirs ?? []) {
    parts.push("--plugin-dir", `'${shellEscape(pluginDir)}'`);
  }
  for (const reporter of config.reporters ?? []) {
    parts.push("--reporter", `'${shellEscape(reporter)}'`);
  }
  if (config.dashboardExport) {
    parts.push("--dashboard-export", `'${shellEscape(config.dashboardExport)}'`);
  }
  if (config.dashboardUploadUrl) {
    parts.push("--dashboard-upload-url", `'${shellEscape(config.dashboardUploadUrl)}'`);
  }
  if (config.dashboardVersion) {
    parts.push("--dashboard-version", `'${shellEscape(config.dashboardVersion)}'`);
  }
  if (config.dashboardRetentionDays !== undefined) {
    parts.push("--dashboard-retention-days", String(config.dashboardRetentionDays));
  }
  if (config.dashboardAuthTokenEnv) {
    parts.push(
      "--dashboard-auth-token-env",
      `'${shellEscape(config.dashboardAuthTokenEnv)}'`,
    );
  }
  if (config.dashboardAuthHeader) {
    parts.push("--dashboard-auth-header", `'${shellEscape(config.dashboardAuthHeader)}'`);
  }
  if (timeoutSeconds !== undefined) {
    parts.push("--timeout", String(timeoutSeconds));
  }
  if (config.timeoutFactor !== undefined) {
    parts.push("--timeout-factor", String(config.timeoutFactor));
  }
  if (config.timeoutConstantMs !== undefined) {
    parts.push("--timeout-constant-ms", String(config.timeoutConstantMs));
  }
  if (config.thresholdHigh !== undefined) {
    parts.push("--threshold-high", String(config.thresholdHigh));
  }
  if (config.thresholdLow !== undefined) {
    parts.push("--threshold-low", String(config.thresholdLow));
  }
  const breakThreshold = config.thresholdBreak ?? config.threshold;
  if (breakThreshold !== undefined) {
    parts.push("--threshold-break", String(breakThreshold));
  }
  if (config.dryRunOnly) {
    parts.push("--dry-run-only");
  }
  if (config.skipTests) {
    parts.push("--skip-tests");
  }
  if (config.coverageFile) {
    parts.push("--coverage-file", `'${shellEscape(config.coverageFile)}'`);
  }
  if (config.coverageProvider) {
    parts.push("--coverage-provider", `'${shellEscape(config.coverageProvider)}'`);
  }
  if (config.coverageTestCommandTemplate) {
    parts.push(
      "--coverage-test-command-template",
      `'${shellEscape(config.coverageTestCommandTemplate)}'`,
    );
  }
  if (config.coverageHelperCommandTemplate) {
    parts.push(
      "--coverage-helper-command-template",
      `'${shellEscape(config.coverageHelperCommandTemplate)}'`,
    );
  }
  for (const item of config.coverageHelperTests ?? []) {
    parts.push("--coverage-helper-tests", `'${shellEscape(item)}'`);
  }
  if (config.incremental) {
    parts.push("--incremental");
  }
  if (config.baselineFile) {
    parts.push("--baseline-file", `'${shellEscape(config.baselineFile)}'`);
  }
  if (config.baselineMaxAgeDays !== undefined) {
    parts.push("--baseline-max-age-days", String(config.baselineMaxAgeDays));
  }
  if (config.baselineBranch) {
    parts.push("--baseline-branch", `'${shellEscape(config.baselineBranch)}'`);
  }
  if (config.writeBaseline) {
    parts.push("--write-baseline", `'${shellEscape(config.writeBaseline)}'`);
  }
  if (config.clearBaseline) {
    parts.push("--clear-baseline");
  }
  if (config.batchMutants) {
    parts.push("--batch-mutants");
  }
  if (config.batchSize !== undefined) {
    parts.push("--batch-size", String(config.batchSize));
  }
  if (config.worktreeMode) {
    parts.push("--worktree-mode", `'${shellEscape(config.worktreeMode)}'`);
  }
  if (config.retainWorktrees) {
    parts.push("--retain-worktrees");
  }
  if (config.retainWorktreesFor?.length) {
    parts.push(
      "--retain-worktrees-for",
      `'${shellEscape(config.retainWorktreesFor.join(","))}'`,
    );
  }
  if (config.retainedWorktreeTtlHours !== undefined) {
    parts.push("--retained-worktree-ttl-hours", String(config.retainedWorktreeTtlHours));
  }
  if (config.workerTmpDir) {
    parts.push("--worker-tmp-dir", `'${shellEscape(config.workerTmpDir)}'`);
  }
  for (const item of config.env ?? []) {
    parts.push("--env", `'${shellEscape(item)}'`);
  }
  for (const item of config.envInherit ?? []) {
    parts.push("--env-inherit", `'${shellEscape(item)}'`);
  }
  for (const item of config.envBlock ?? []) {
    parts.push("--env-block", `'${shellEscape(item)}'`);
  }
  parts.push("--output-format", "stryker-cxx");

  return `report="$(mktemp)" && ${parts.join(" ")} --report "$report" 1>&2; cat "$report"`;
}

export function parseCxxSource(output: string, tool: MutationTool = "stryker-cxx"): MutationResult {
  let report: CxxReport;
  try {
    report = JSON.parse(output) as CxxReport;
  } catch (error) {
    return {
      ...EMPTY_RESULT,
      tool,
      error:
        `Failed to parse ${tool} output: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const killed = report.killed ?? 0;
  const survived = report.survived ?? 0;
  const buildError = report.buildErrors ?? report.build_error ?? 0;
  const checkError = report.checkErrors ?? report.check_error ?? 0;
  const timeout = report.timeouts ?? 0;
  const noCoverage = report.noCoverage ?? report.no_coverage ?? 0;
  const ignored =
    report.ignored ?? (report.mutants ?? []).filter((m) => m.status === "IGNORED").length;

  const scored = killed + survived;
  let score: number;
  if (typeof report.score === "number") {
    // stryker-cxx.report.v1 reports a 0-1 fraction; the legacy embedded
    // Marmorkrebs engine reported a 0-100 percentage.
    score =
      report.schemaVersion === "stryker-cxx.report.v1"
        ? report.score
        : report.score / 100;
  } else if (scored > 0) {
    score = killed / scored;
  } else {
    score = 1;
  }
  score = Math.min(1, Math.max(0, Math.round(score * 100) / 100));

  const survivingMutants: SurvivingMutant[] = (report.mutants ?? [])
    .filter((m) => m.status === "SURVIVED")
    .map((m) => ({
      file: m.file,
      line: m.line,
      mutator: m.mutator,
      description: `${m.original}->${m.mutated}`,
      status: "survived" as const,
    }));

  const dryRunFailed =
    report.schemaVersion === "stryker-cxx.report.v1" &&
    report.dryRun?.status === "FAILED";
  const result: MutationResult = {
    tool,
    totalMutants:
      report.totalMutants ??
      report.total ??
      scored + buildError + checkError + noCoverage + timeout + ignored,
    killed,
    survived,
    timeout,
    noCoverage: buildError + checkError + noCoverage,
    ignored,
    score,
    survivingMutants,
    thresholds: report.thresholds,
    dryRun: report.dryRun,
    resourceIsolation: report.execution?.resourceIsolation,
    error: dryRunFailed ? report.dryRun?.failureReason ?? "stryker-cxx dry run failed" : null,
    elapsedMs: 0,
  };

  return result;
}

function shellEscape(s: string): string {
  return s.replace(/'/g, "'\\''");
}
