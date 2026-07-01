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
  threshold?: number;
  thresholdHigh?: number;
  thresholdLow?: number;
  thresholdBreak?: number;
  timeoutMs?: number;
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
