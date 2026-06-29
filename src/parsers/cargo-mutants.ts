import { EMPTY_RESULT, type MutationResult, type SurvivingMutant } from "../types.js";

export function parseCargoMutants(output: string): MutationResult {
  const mutants: SurvivingMutant[] = [];
  let killed = 0;
  let survived = 0;
  let timeout = 0;

  try {
    const lines = output.split("\n").filter((line) => line.trim().startsWith("{"));
    for (const line of lines) {
      const entry = JSON.parse(line);
      if (entry.caught) {
        killed++;
      } else if (entry.timeout) {
        timeout++;
      } else if (entry.unviable === false || entry.missed) {
        survived++;
        mutants.push({
          file: entry.file ?? "unknown",
          line: entry.line ?? 0,
          mutator: entry.genre ?? "cargo-mutants",
          description: entry.function ?? entry.replacement ?? "survived mutant",
          status: "survived",
        });
      }
    }
  } catch {
    const survivedMatch = output.match(/(\d+) survived/);
    const killedMatch = output.match(/(\d+) caught/);
    if (survivedMatch) survived = parseInt(survivedMatch[1], 10);
    if (killedMatch) killed = parseInt(killedMatch[1], 10);
  }

  const total = killed + survived;
  return {
    tool: "cargo-mutants",
    totalMutants: killed + survived + timeout,
    killed,
    survived,
    timeout,
    noCoverage: 0,
    ignored: 0,
    score: total > 0 ? Math.round((killed / total) * 100) / 100 : 1,
    survivingMutants: mutants,
    error: null,
    elapsedMs: 0,
  };
}

export function buildCargoMutantsCommand(sourceFiles: string[], workDir: string): string {
  const fileArgs = sourceFiles.map((f) => `--file '${shellEscape(f)}'`).join(" ");
  return `cd '${shellEscape(workDir)}' && cargo mutants ${fileArgs} --json 2>&1`;
}

function shellEscape(s: string): string {
  return s.replace(/'/g, "'\\''");
}
