export type MutationTool =
  | "stryker"
  | "stryker-net"
  | "stryker-cxx"
  | "go-mutesting"
  | "cargo-mutants"
  | "mutmut"
  | "gomu"
  | "cxx-source";

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
  base?: string;
  threshold?: number;
  timeoutMs?: number;
  maxMutants?: number;
  includeMetal?: boolean;
  mutators?: string;
  strykerCxxBinary?: string;
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
  score: number;
  survivingMutants: SurvivingMutant[];
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
  score: 1,
  survivingMutants: [],
  error: null,
  elapsedMs: 0,
};
