import { fileURLToPath } from "node:url";
import { EMPTY_RESULT, type MutationConfig, type MutationResult, type SurvivingMutant } from "../types.js";

/**
 * marmorkrebs' built-in C++/ObjC++ source-mutation engine. Unlike the other
 * tools (external CLIs), this one ships in-repo at engines/cxx-source and is
 * driven per mutant: it recompiles the project and re-runs a targeted test
 * command for each mutation, classifying KILLED / SURVIVED / BUILD_ERROR.
 */

interface CxxMutant {
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
  target_files: string[];
  total: number;
  killed: number;
  survived: number;
  build_error: number;
  mutants: CxxMutant[];
  score: number;
}

function enginePath(): string {
  return fileURLToPath(new URL("../../engines/cxx-source/marmorkrebs-cxx.py", import.meta.url));
}

export function buildCxxSourceCommand(
  sourceFiles: string[],
  workDir: string,
  config: MutationConfig,
): string {
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

  // The engine's own progress goes to stdout; redirect it to stderr and emit
  // only the JSON report (written to a temp file) on stdout.
  return `report="$(mktemp)" && ${parts.join(" ")} --report "$report" 1>&2; cat "$report"`;
}

export function parseCxxSource(output: string): MutationResult {
  let report: CxxReport;
  try {
    report = JSON.parse(output) as CxxReport;
  } catch (error) {
    return {
      ...EMPTY_RESULT,
      tool: "cxx-source",
      error: `Failed to parse cxx-source output: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const killed = report.killed ?? 0;
  const survived = report.survived ?? 0;
  const buildError = report.build_error ?? 0;

  const scored = killed + survived;
  let score: number;
  if (typeof report.score === "number") {
    // Engine reports a 0-100 percentage; normalize to a 0-1 fraction.
    score = report.score / 100;
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

  return {
    tool: "cxx-source",
    totalMutants: report.total ?? scored + buildError,
    killed,
    survived,
    timeout: 0,
    noCoverage: buildError,
    score,
    survivingMutants,
    error: null,
    elapsedMs: 0,
  };
}

function shellEscape(s: string): string {
  return s.replace(/'/g, "'\\''");
}
