import { EMPTY_RESULT, type MutationResult, type SurvivingMutant } from "../types.js";

export function parseMutmut(output: string): MutationResult {
  const mutants: SurvivingMutant[] = [];
  let killed = 0;
  let survived = 0;
  let timeout = 0;

  try {
    const jsonStart = output.lastIndexOf("[");
    const jsonEnd = output.lastIndexOf("]");
    if (jsonStart !== -1 && jsonEnd !== -1) {
      const results = JSON.parse(output.slice(jsonStart, jsonEnd + 1));
      for (const entry of results) {
        if (entry.status === "killed") {
          killed++;
        } else if (entry.status === "survived") {
          survived++;
          mutants.push({
            file: entry.filename ?? "unknown",
            line: entry.line_number ?? 0,
            mutator: "mutmut",
            description: entry.mutation ?? "survived mutant",
            status: "survived",
          });
        } else if (entry.status === "timeout") {
          timeout++;
        }
      }
    }
  } catch {
    const survivedMatch = output.match(/(\d+) survived/);
    const killedMatch = output.match(/(\d+) killed/);
    if (survivedMatch) survived = parseInt(survivedMatch[1], 10);
    if (killedMatch) killed = parseInt(killedMatch[1], 10);
  }

  const total = killed + survived;
  return {
    tool: "mutmut",
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

export function buildMutmutCommand(
  sourceFiles: string[],
  workDir: string,
  testCommand = "pytest",
): string {
  const pathArgs = sourceFiles.map((f) => `--paths-to-mutate=${f}`).join(" ");
  return `cd '${shellEscape(workDir)}' && mutmut run ${pathArgs} --runner="${testCommand}" 2>&1; mutmut results --json 2>&1`;
}

function shellEscape(s: string): string {
  return s.replace(/'/g, "'\\''");
}
