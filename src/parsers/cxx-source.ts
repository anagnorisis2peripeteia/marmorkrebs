import { fileURLToPath } from "node:url";
import {
  EMPTY_RESULT,
  type MutationConfig,
  type MutationResult,
  type MutationTool,
  type SurvivingMutant,
} from "../types.js";

/**
 * Marmorkrebs' C++/ObjC++ source mutation path. The preferred implementation is
 * the external stryker-cxx CLI; the embedded cxx-source engine remains as a
 * legacy fallback for old local flows.
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
  timeouts?: number;
  ignored?: number;
  mutants: CxxMutant[];
  score: number;
  scorePercent?: number;
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
    throw new Error("stryker-cxx requires --build-command and --test-command");
  }

  if (config.tool === "stryker-cxx" || config.strykerCxxBinary) {
    return buildExternalCxxSourceCommand(sourceFiles, workDir, config);
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

  // The engine's own progress goes to stdout; redirect it to stderr and emit
  // only the JSON report (written to a temp file) on stdout.
  return `report="$(mktemp)" && ${parts.join(" ")} --report "$report" 1>&2; cat "$report"`;
}

function buildExternalCxxSourceCommand(
  sourceFiles: string[],
  workDir: string,
  config: MutationConfig,
): string {
  if (!config.buildCommand || !config.testCommand) {
    throw new Error("stryker-cxx requires --build-command and --test-command");
  }

  const files = sourceFiles.join(",");
  const timeoutSeconds =
    config.timeoutMs !== undefined ? Math.max(1, Math.ceil(config.timeoutMs / 1000)) : undefined;
  const buildCommand = config.buildCommand;
  const testCommand = config.testCommand;

  const parts = [
    `'${shellEscape(config.strykerCxxBinary ?? "stryker-cxx")}'`,
    "run",
    "--repo",
    `'${shellEscape(workDir)}'`,
    "--files",
    `'${shellEscape(files)}'`,
    "--build-command",
    `'${shellEscape(buildCommand)}'`,
    "--test-command",
    `'${shellEscape(testCommand)}'`,
    "--format",
    "json",
  ];
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
  if (timeoutSeconds !== undefined) {
    parts.push("--timeout", String(timeoutSeconds));
  }
  parts.push("--output-format", "stryker-cxx");

  return (
    `report="$(mktemp)" && ${parts.join(" ")} --report "$report" 1>&2; cat "$report"`
  );
}

export function parseCxxSource(output: string, tool: MutationTool = "cxx-source"): MutationResult {
  let report: CxxReport;
  try {
    report = JSON.parse(output) as CxxReport;
  } catch (error) {
    return {
      ...EMPTY_RESULT,
      tool,
      error: `Failed to parse ${tool} output: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const killed = report.killed ?? 0;
  const survived = report.survived ?? 0;
  const buildError = report.buildErrors ?? report.build_error ?? 0;
  const timeout = report.timeouts ?? 0;
  const ignored = report.ignored ?? (report.mutants ?? []).filter((m) => m.status === "IGNORED").length;

  const scored = killed + survived;
  let score: number;
  if (typeof report.score === "number") {
    // stryker-cxx.report.v1 reports a 0-1 fraction; the legacy embedded
    // Marmorkrebs engine reported a 0-100 percentage.
    score = report.schemaVersion === "stryker-cxx.report.v1" ? report.score : report.score / 100;
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
    tool,
    totalMutants: report.totalMutants ?? report.total ?? scored + buildError + timeout + ignored,
    killed,
    survived,
    timeout,
    noCoverage: buildError,
    ignored,
    score,
    survivingMutants,
    error: null,
    elapsedMs: 0,
  };
}

function shellEscape(s: string): string {
  return s.replace(/'/g, "'\\''");
}
