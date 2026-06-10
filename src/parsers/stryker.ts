import { EMPTY_RESULT, type MutationResult, type SurvivingMutant } from "../types.js";

export function parseStryker(output: string): MutationResult {
  const mutants: SurvivingMutant[] = [];
  let killed = 0;
  let survived = 0;
  let timeout = 0;
  let noCoverage = 0;

  try {
    const jsonStart = output.indexOf("{");
    const jsonEnd = output.lastIndexOf("}");
    if (jsonStart === -1 || jsonEnd === -1) throw new Error("No JSON output from Stryker");

    const report = JSON.parse(output.slice(jsonStart, jsonEnd + 1));
    const files = report.files ?? {};

    for (const [filePath, fileData] of Object.entries(files) as [string, any][]) {
      for (const mutant of fileData.mutants ?? []) {
        switch (mutant.status) {
          case "Killed":
            killed++;
            break;
          case "Survived":
            survived++;
            mutants.push({
              file: filePath,
              line: mutant.location?.start?.line ?? 0,
              mutator: mutant.mutatorName ?? "unknown",
              description: mutant.replacement ?? mutant.description ?? "survived mutant",
              status: "survived",
            });
            break;
          case "Timeout":
            timeout++;
            break;
          case "NoCoverage":
            noCoverage++;
            mutants.push({
              file: filePath,
              line: mutant.location?.start?.line ?? 0,
              mutator: mutant.mutatorName ?? "unknown",
              description: "no test covers this code path",
              status: "no_coverage",
            });
            break;
        }
      }
    }
  } catch (error) {
    return {
      ...EMPTY_RESULT,
      tool: "stryker",
      error: `Failed to parse Stryker output: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const denominator = killed + survived + noCoverage;
  return {
    tool: "stryker",
    totalMutants: killed + survived + timeout + noCoverage,
    killed,
    survived,
    timeout,
    noCoverage,
    score: denominator > 0 ? Math.round((killed / denominator) * 100) / 100 : 1,
    survivingMutants: mutants,
    error: null,
    elapsedMs: 0,
  };
}

export function buildStrykerCommand(sourceFiles: string[], workDir: string): string {
  const mutateGlobs = sourceFiles.map((f) => `'${f}'`).join(",");
  return `cd '${shellEscape(workDir)}' && npx stryker run --mutate ${mutateGlobs} --reporters json 2>&1`;
}

function shellEscape(s: string): string {
  return s.replace(/'/g, "'\\''");
}
