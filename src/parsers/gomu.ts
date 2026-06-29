import { type MutationResult, type SurvivingMutant } from "../types.js";

interface GomuResult {
  mutant: {
    id: string;
    filePath: string;
    line: number;
    column?: number;
    type: string;
    original: string;
    mutated: string;
    description?: string;
    function?: string;
  };
  status: string;
  output?: string;
  error?: string;
  executionTime?: number;
}

interface GomuReport {
  statistics: {
    killed: number;
    survived: number;
    timedOut: number;
    errors: number;
    notViable: number;
    mutationScore: number;
  };
  results: GomuResult[];
  duration?: number;
}

export function parseGomu(output: string): MutationResult {
  try {
    const report: GomuReport = JSON.parse(output);
    const stats = report.statistics;
    const mutants: SurvivingMutant[] = [];

    for (const r of report.results ?? []) {
      const status = r.status.toUpperCase();
      if (status === "SURVIVED" || status === "TIMED_OUT" || status === "ERROR") {
        mutants.push({
          file: r.mutant.filePath,
          line: r.mutant.line,
          mutator: r.mutant.type,
          description: r.mutant.description ?? `${r.mutant.original} -> ${r.mutant.mutated}`,
          status: status === "SURVIVED" ? "survived" : "timeout",
        });
      }
    }

    const killed = stats.killed ?? 0;
    const survived = stats.survived ?? 0;
    const timedOut = stats.timedOut ?? 0;
    const errors = stats.errors ?? 0;
    const notViable = stats.notViable ?? 0;
    const total = killed + survived + timedOut + errors;
    const denom = killed + survived + timedOut;
    const durationNs = report.duration ?? 0;

    return {
      tool: "gomu",
      totalMutants: total + notViable,
      killed,
      survived: survived + errors,
      timeout: timedOut,
      noCoverage: 0,
      ignored: 0,
      score: denom > 0 ? Math.round((killed / denom) * 100) / 100 : 1,
      survivingMutants: mutants,
      error: null,
      elapsedMs: Math.round(durationNs / 1_000_000),
    };
  } catch {
    return {
      tool: "gomu",
      totalMutants: 0,
      killed: 0,
      survived: 0,
      timeout: 0,
      noCoverage: 0,
      ignored: 0,
      score: 0,
      survivingMutants: [],
      error: `Failed to parse gomu JSON output: ${output.slice(0, 200)}`,
      elapsedMs: 0,
    };
  }
}

export function buildGomuCommand(
  sourceFiles: string[],
  workDir: string,
  baseBranch = "main",
  timeoutSecs = 30,
  workers = 4,
): string {
  const fileArgs = sourceFiles.length > 0 ? sourceFiles.map((f) => `'${shellEscape(f)}'`).join(" ") : ".";
  return `cd '${shellEscape(workDir)}' && gomu run --output json --timeout ${timeoutSecs} --workers ${workers} --incremental=false ${fileArgs} 2>&1`;
}

function shellEscape(s: string): string {
  return s.replace(/'/g, "'\\''");
}
