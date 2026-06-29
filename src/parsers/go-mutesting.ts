import { EMPTY_RESULT, type MutationResult, type SurvivingMutant } from "../types.js";

export function parseGoMutesting(output: string): MutationResult {
  const mutants: SurvivingMutant[] = [];
  let killed = 0;
  let survived = 0;
  let timeout = 0;

  for (const line of output.split("\n")) {
    const passMatch = line.match(/^PASS:\s+(.+):(\d+):\s+(.+)/);
    if (passMatch) {
      killed++;
      continue;
    }

    const failMatch = line.match(/^FAIL:\s+(.+):(\d+):\s+(.+)/);
    if (failMatch) {
      survived++;
      mutants.push({
        file: failMatch[1],
        line: parseInt(failMatch[2], 10),
        mutator: "go-mutesting",
        description: failMatch[3].trim(),
        status: "survived",
      });
      continue;
    }

    if (/^SKIP:\s+/.test(line)) {
      timeout++;
    }
  }

  const scoreMatch = output.match(/The mutation score is ([\d.]+)/);
  const total = killed + survived;
  const score = scoreMatch ? parseFloat(scoreMatch[1]) : total > 0 ? killed / total : 1;

  return {
    tool: "go-mutesting",
    totalMutants: killed + survived + timeout,
    killed,
    survived,
    timeout,
    noCoverage: 0,
    ignored: 0,
    score: Math.round(score * 100) / 100,
    survivingMutants: mutants,
    error: null,
    elapsedMs: 0,
  };
}

export function buildGoMutestingCommand(sourceFiles: string[], workDir: string): string {
  return `cd '${shellEscape(workDir)}' && go-mutesting ${sourceFiles.join(" ")} 2>&1`;
}

function shellEscape(s: string): string {
  return s.replace(/'/g, "'\\''");
}
