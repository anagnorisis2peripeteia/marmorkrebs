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
 * The default provider is the external stryker-cxx tool. `mull` now uses a
 * preference-first flow with a built-in fallback to stryker-cxx when `mull`
 * is unavailable.
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
    mutationLevel?: string;
    enabledMutators?: string[];
    executionMode?: string;
    requestedExecutionMode?: string;
    executionBackend?: string;
    requestedExecutionBackend?: string;
    executionBackendFallbackReason?: string;
    analysis?: Record<string, unknown>;
    artifactBackend?: string;
    requestedArtifactBackend?: string;
    artifactFallback?: string;
    artifactFallbackReason?: string;
    testScheduler?: Record<string, unknown>;
    mutantSwitch?: Record<string, unknown>;
    llvmSwitch?: Record<string, unknown>;
    resourceIsolation?: Record<string, unknown>;
    parity?: Record<string, unknown>;
  };
  parity?: Record<string, unknown>;
  lifecycle?: Record<string, unknown>;
  artifactPlacement?: Record<string, unknown>;
  projectAnalysis?: Record<string, unknown>;
}

interface CxxTargetSpec {
  files: string[];
  lines: string[];
}

function enginePath(): string {
  return fileURLToPath(new URL("../../engines/cxx-source/marmorkrebs-cxx.py", import.meta.url));
}

export function buildCxxSourceCommand(
  sourceFiles: string[],
  workDir: string,
  config: MutationConfig,
): string {
  if (config.tool === "mull") {
    const mullBinary = config.mullBinary ?? "mull";
    const fallbackBinary = config.strykerCxxBinary ?? "stryker-cxx";
    return buildMullWithFallbackCxxSourceCommand(
      sourceFiles,
      workDir,
      config,
      mullBinary,
      fallbackBinary,
    );
  }
  if (config.tool === "stryker-cxx" || config.strykerCxxBinary) {
    return buildExternalCxxSourceCommand(
      sourceFiles,
      workDir,
      config,
      config.strykerCxxBinary ?? "stryker-cxx",
    );
  }

  if (!config.buildCommand || !config.testCommand) {
    throw new Error("cxx-source requires --build-command and --test-command");
  }

  const engine = enginePath();
  const { files, lines } = parseScopedCxxTargets(sourceFiles);

  const parts = [
    "python3",
    `'${shellEscape(engine)}'`,
    "--repo-dir",
    `'${shellEscape(workDir)}'`,
    "--files",
    `'${shellEscape(files.join(","))}'`,
  ];
  if (lines.length) {
    parts.push("--lines", `'${shellEscape(lines.join(","))}'`);
  }
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

function buildMullWithFallbackCxxSourceCommand(
  sourceFiles: string[],
  workDir: string,
  config: MutationConfig,
  mullBinary: string,
  fallbackBinary: string,
): string {
  const preferred = buildExternalCxxSourceInvocation(
    sourceFiles,
    workDir,
    config,
    mullBinary,
  );
  const fallback = buildExternalCxxSourceInvocation(
    sourceFiles,
    workDir,
    { ...config, tool: "stryker-cxx", strykerCxxBinary: fallbackBinary },
    fallbackBinary,
  );

  return `report="$(mktemp)" && if command -v '${shellEscape(mullBinary)}' >/dev/null 2>&1; then ${preferred}; else ${fallback}; fi && cat "$report"`;
}

function buildExternalCxxSourceCommand(
  sourceFiles: string[],
  workDir: string,
  config: MutationConfig,
  binary: string,
): string {
  return `report="$(mktemp)" && ${buildExternalCxxSourceInvocation(
    sourceFiles,
    workDir,
    config,
    binary,
  )} && cat "$report"`;
}

function buildExternalCxxSourceInvocation(
  sourceFiles: string[],
  workDir: string,
  config: MutationConfig,
  binary: string,
): string {
  if (!config.buildCommand && !config.buildSystem) {
    throw new Error("stryker-cxx requires --build-command or --build-system");
  }
  if (!config.testCommand && !config.skipTests && !config.buildSystem) {
    throw new Error(
      "stryker-cxx requires --test-command unless --skip-tests or --build-system is set",
    );
  }

  const { files, lines } = parseScopedCxxTargets(sourceFiles);
  const timeoutSeconds =
    config.timeoutMs !== undefined
      ? Math.max(1, Math.ceil(config.timeoutMs / 1000))
      : undefined;
  const buildCommand = config.buildCommand;
  const testCommand = config.testCommand;

  const parts = [
    `'${shellEscape(binary)}'`,
    "run",
    "--repo",
    `'${shellEscape(workDir)}'`,
    "--files",
    `'${shellEscape(files.join(","))}'`,
    "--format",
    "json",
  ];
  if (lines.length) {
    parts.push("--lines", `'${shellEscape(lines.join(","))}'`);
  }
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
  if (config.artifactPath) {
    parts.push("--artifact-path", `'${shellEscape(config.artifactPath)}'`);
  }
  if (config.artifactBackend) {
    parts.push("--artifact-backend", `'${shellEscape(config.artifactBackend)}'`);
  }
  if (config.artifactFallback) {
    parts.push("--artifact-fallback", `'${shellEscape(config.artifactFallback)}'`);
  }
  if (config.xcodeWorkspace) {
    parts.push("--xcode-workspace", `'${shellEscape(config.xcodeWorkspace)}'`);
  }
  if (config.xcodeProject) {
    parts.push("--xcode-project", `'${shellEscape(config.xcodeProject)}'`);
  }
  if (config.xcodeScheme) {
    parts.push("--xcode-scheme", `'${shellEscape(config.xcodeScheme)}'`);
  }
  if (config.xcodeConfiguration) {
    parts.push("--xcode-configuration", `'${shellEscape(config.xcodeConfiguration)}'`);
  }
  if (config.xcodeSdk) {
    parts.push("--xcode-sdk", `'${shellEscape(config.xcodeSdk)}'`);
  }
  if (config.xcodeDestination) {
    parts.push("--xcode-destination", `'${shellEscape(config.xcodeDestination)}'`);
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
  if (config.executionMode) {
    parts.push("--execution-mode", `'${shellEscape(config.executionMode)}'`);
  }
  if (config.executionBackend) {
    parts.push("--execution-backend", `'${shellEscape(config.executionBackend)}'`);
  }
  if (config.equivalentSuppression) {
    parts.push("--equivalent-suppression", `'${shellEscape(config.equivalentSuppression)}'`);
  }
  if (config.base) {
    parts.push("--base", `'${shellEscape(config.base)}'`);
  } else if (config.since) {
    parts.push("--since", `'${shellEscape(config.since)}'`);
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
  if (config.mutationLevel) {
    parts.push("--mutation-level", `'${shellEscape(config.mutationLevel)}'`);
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
  if (config.dashboardUploadRetries !== undefined) {
    parts.push("--dashboard-upload-retries", String(config.dashboardUploadRetries));
  }
  if (config.dashboardUploadRetryDelayMs !== undefined) {
    parts.push("--dashboard-upload-retry-delay-ms", String(config.dashboardUploadRetryDelayMs));
  }
  if (config.dashboardProject) {
    parts.push("--dashboard-project", `'${shellEscape(config.dashboardProject)}'`);
  }
  if (config.dashboardBranch) {
    parts.push("--dashboard-branch", `'${shellEscape(config.dashboardBranch)}'`);
  }
  if (config.dashboardCommit) {
    parts.push("--dashboard-commit", `'${shellEscape(config.dashboardCommit)}'`);
  }
  if (config.dashboardBuildUrl) {
    parts.push("--dashboard-build-url", `'${shellEscape(config.dashboardBuildUrl)}'`);
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
  if (config.coverageAnalysis) {
    parts.push("--coverage-analysis", `'${shellEscape(config.coverageAnalysis)}'`);
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
  if (config.workerLabel) {
    parts.push("--worker-label", `'${shellEscape(config.workerLabel)}'`);
  }
  if (config.distributionManifest) {
    parts.push("--distribution-manifest", `'${shellEscape(config.distributionManifest)}'`);
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

  return `${parts.join(" ")} --report "$report" 1>&2`;
}

function parseScopedCxxTargets(sourceFiles: string[]): CxxTargetSpec {
  const files = new Set<string>();
  const lineByFile = new Map<string, Set<string>>();

  for (const raw of sourceFiles) {
    const fileOrRange = raw.trim();
    if (!fileOrRange) {
      continue;
    }

    let file = fileOrRange;
    const lastColon = fileOrRange.lastIndexOf(":");
    if (lastColon > 0) {
      const candidateRange = fileOrRange.slice(lastColon + 1);
      if (/^\d+(?:-\d+)?$/.test(candidateRange)) {
        file = fileOrRange.slice(0, lastColon);
        const ranges = lineByFile.get(file) ?? new Set<string>();
        ranges.add(candidateRange);
        lineByFile.set(file, ranges);
      }
    }
    if (file) {
      files.add(file);
    }
  }

  const lines: string[] = [];
  for (const scoped of lineByFile.values()) {
    lines.push(...scoped);
  }
  return {
    files: [...files],
    lines,
  };
}

export function parseCxxSource(
  output: string,
  tool: MutationTool = "stryker-cxx",
  config: Pick<MutationConfig, "parityProfile"> = {},
): MutationResult {
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
  const parity = report.parity ?? report.execution?.parity;
  const parityProfile = config.parityProfile ?? "summary";
  const parityFailures = parityProfileFailures(parity, parityProfile);
  const parityError = parityFailures.length
    ? `stryker-cxx parity ${parityProfile} failed: ${parityFailures.join(", ")}`
    : null;
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
    provider: {
      name: tool,
      schemaVersion: report.schemaVersion,
      ...(report.execution?.mutationLevel !== undefined
        ? { mutationLevel: report.execution.mutationLevel }
        : {}),
      ...(report.execution?.enabledMutators !== undefined
        ? { enabledMutators: report.execution.enabledMutators }
        : {}),
      executionMode: report.execution?.executionMode,
      requestedExecutionMode: report.execution?.requestedExecutionMode,
      ...(report.execution?.executionBackend !== undefined
        ? { executionBackend: report.execution.executionBackend }
        : {}),
      ...(report.execution?.requestedExecutionBackend !== undefined
        ? { requestedExecutionBackend: report.execution.requestedExecutionBackend }
        : {}),
      ...(report.execution?.executionBackendFallbackReason !== undefined
        ? { executionBackendFallbackReason: report.execution.executionBackendFallbackReason }
        : {}),
      ...(report.execution?.analysis !== undefined
        ? { analysis: report.execution.analysis }
        : {}),
      ...(typeof report.execution?.analysis === "object" &&
      report.execution?.analysis !== null &&
      "sourcePrecision" in report.execution.analysis
        ? { sourcePrecision: report.execution.analysis.sourcePrecision }
        : {}),
      artifactBackend: report.execution?.artifactBackend,
      requestedArtifactBackend: report.execution?.requestedArtifactBackend,
      artifactFallback: report.execution?.artifactFallback,
      artifactFallbackReason: report.execution?.artifactFallbackReason,
      testScheduler: report.execution?.testScheduler,
      mutantSwitch: report.execution?.mutantSwitch,
      ...(report.execution?.llvmSwitch !== undefined
        ? { llvmSwitch: report.execution.llvmSwitch }
        : {}),
      ...(parity !== undefined
        ? { parity }
        : {}),
      ...(parityProfile !== "summary"
        ? {
            parityGate: {
              profile: parityProfile,
              status: parityError ? "failed" : "passed",
              failures: parityFailures,
            },
          }
        : {}),
      lifecycle: report.lifecycle,
      artifactPlacement: report.artifactPlacement,
      projectAnalysis: report.projectAnalysis,
    },
    error: dryRunFailed
      ? report.dryRun?.failureReason ?? "stryker-cxx dry run failed"
      : parityError,
    elapsedMs: 0,
  };

  return result;
}

function parityProfileFailures(
  parity: Record<string, unknown> | undefined,
  profile: "summary" | "review" | "strict",
): string[] {
  if (profile === "summary") {
    return [];
  }
  if (!parity) {
    return ["missing-parity-metadata"];
  }
  const items = parity.items;
  if (!Array.isArray(items) || items.length === 0) {
    return ["missing-parity-items"];
  }
  const allowed =
    profile === "review"
      ? new Set(["covered", "partial", "external"])
      : new Set(["covered", "external"]);
  const failures: string[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") {
      failures.push("invalid-parity-item");
      continue;
    }
    const record = item as Record<string, unknown>;
    const status = String(record.status ?? "unknown");
    if (!allowed.has(status)) {
      failures.push(`${String(record.id ?? "unknown")}=${status}`);
    }
  }
  return failures;
}

function shellEscape(s: string): string {
  return s.replace(/'/g, "'\\''");
}
