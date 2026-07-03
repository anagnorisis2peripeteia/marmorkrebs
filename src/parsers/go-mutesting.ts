import { EMPTY_RESULT, type MutationResult, type SurvivingMutant } from "../types.js";

// Ground truth (avito-tech/go-mutesting fork, probed live 2026-07-03 — the original
// zimmski upstream finds 0 mutants on modern Go modules and is NOT supported): per
// mutant it prints
//     PASS "<tmpdir>/<file>.go.<n>" with checksum <sum>   (mutant killed)
//     FAIL "<tmpdir>/<file>.go.<n>" with checksum <sum>   (mutant survived)
// plus a final "The mutation score is <f> (N passed, M failed, ...)" line. The quoted
// path is a TEMP COPY — map it back to a changed file by basename (strip the trailing
// ".<n>" mutant index). No line numbers are available. Exit 0 even with survivors;
// non-zero only on real errors, so &&-chaining stays fail-closed.
const RESULT_LINE = /^(PASS|FAIL) "(.+)" with checksum/;

function originalName(tmpPath: string): string {
  const base = tmpPath.split("/").pop() ?? tmpPath;
  return base.replace(/\.\d+$/, "");
}

export function parseGoMutesting(output: string, changedFiles: string[] = []): MutationResult {
  const mutants: SurvivingMutant[] = [];
  let killed = 0;
  let survived = 0;
  let timeout = 0;

  for (const line of output.split("\n")) {
    const m = line.match(RESULT_LINE);
    if (m) {
      const fileName = originalName(m[2]);
      const changed = changedFiles.find((cf) => cf === fileName || cf.endsWith(`/${fileName}`));
      if (m[1] === "PASS") {
        killed++;
      } else {
        survived++;
        mutants.push({
          file: changed ?? fileName,
          line: 0,
          mutator: "go-mutesting",
          description: `survived mutant in ${changed ?? fileName}`,
          status: "survived",
        });
      }
      continue;
    }
    if (/^SKIP/.test(line)) timeout++;
  }

  const scoreMatch = output.match(/The mutation score is ([\d.]+)/);
  const total = killed + survived;
  if (total === 0 && !scoreMatch) {
    return {
      ...EMPTY_RESULT,
      tool: "go-mutesting",
      error: `no go-mutesting result lines parsed: ${output.trim().slice(0, 200)}`,
    };
  }
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
  const fileArgs = sourceFiles
    .map((f) => `'${shellEscape(f.replace(/:\d+(?:-\d+)?$/, ""))}'`)
    .join(" ");
  return `cd '${shellEscape(workDir)}' && go-mutesting ${fileArgs} 2>&1`;
}

function shellEscape(s: string): string {
  return s.replace(/'/g, "'\\''");
}
