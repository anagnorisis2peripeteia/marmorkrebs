export type MutationTool =
  | "stryker"
  | "stryker-net"
  | "stryker-cxx"
  | "mull"
  | "go-mutesting"
  | "cargo-mutants"
  | "mutmut"
  | "gomu";

export interface CrabboxLeaseOptions {
  provider: string;
  image?: string;
  cpus?: number;
  memory?: number;
  disk?: number;
  targetOS?: string;
}

export interface CrabboxLease {
  id: string;
  provider: string;
}

export interface CrabboxRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface MutationConfig {
  tool: MutationTool;
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
  base?: string;
  since?: string;
  threshold?: number;
  thresholdHigh?: number;
  thresholdLow?: number;
  thresholdBreak?: number;
  timeoutMs?: number;
  /** Allow a zero-mutant result to pass (default: fail closed — see reconcileResult). */
  allowEmpty?: boolean;
  /** Mutator names excluded from scoring (stryker lane; e.g. StringLiteral). */
  excludeMutations?: string[];
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
  maxMutants?: number;
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
}

export interface SurvivingMutant {
  file: string;
  line: number;
  mutator: string;
  description: string;
  status: "survived" | "timeout" | "no_coverage";
}

export interface MutationResult {
  tool: string;
  totalMutants: number;
  killed: number;
  survived: number;
  timeout: number;
  noCoverage: number;
  ignored: number;
  score: number;
  survivingMutants: SurvivingMutant[];
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
  resourceIsolation?: Record<string, unknown>;
  provider?: Record<string, unknown>;
  error: string | null;
  elapsedMs: number;
}

/**
 * Uniform mutation score across lanes (StrykerJS convention): a TIMEOUT counts as
 * DETECTED — the mutant made the suite hang, which is detection, not escape.
 *   score = (killed + timeout) / (killed + timeout + survived + noCoverage)
 * `ignored` never enters the formula (and an all-ignored run is a hard error via
 * reconcileResult's vacuous-run guard). Exception: stryker-cxx reports the shim's
 * own thresholds/score untouched — the shim's semantics govern the pytorch gates.
 */
export function mutationScore(
  killed: number,
  timeout: number,
  survived: number,
  noCoverage: number,
): number {
  const detected = killed + timeout;
  const denom = detected + survived + noCoverage;
  return denom > 0 ? Math.round((detected / denom) * 100) / 100 : 1;
}

export const EMPTY_RESULT: MutationResult = {
  tool: "none",
  totalMutants: 0,
  killed: 0,
  survived: 0,
  timeout: 0,
  noCoverage: 0,
  ignored: 0,
  score: 1,
  survivingMutants: [],
  error: null,
  elapsedMs: 0,
};
