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

export function buildStrykerCommand(
  sourceFiles: string[],
  workDir: string,
  testCommand?: string,
): string {
  const wd = shellEscape(workDir);
  const mutateGlobs = sourceFiles.map((f) => `'${shellEscape(f)}'`).join(",");
  // One machine-wide global Stryker (never a per-repo/venv dep) — install it once if
  // missing. A global install also lets Stryker resolve `typescript` for its config
  // preprocessor; a transient `npx` sandbox can't, which is what made npx flaky.
  const ensure =
    `command -v stryker >/dev/null 2>&1 || npm install -g @stryker-mutator/core typescript 1>&2`;
  // Keep Stryker's artifacts out of git status so they don't trip later clean-tree gates.
  const exclude =
    `E="$(git rev-parse --git-path info/exclude 2>/dev/null)"; ` +
    `[ -n "$E" ] && { grep -qxF 'reports/' "$E" 2>/dev/null || ` +
    `printf 'reports/\\n.stryker-tmp/\\n.marmorkrebs-stryker.json\\n' >> "$E"; }; true`;

  if (testCommand) {
    // No usable repo Stryker config: drive it with a throwaway one — the `command` test
    // runner (exit code = pass/fail) on the focused test command; babel mutator (skip the
    // tsconfig preprocessor via a nonexistent tsconfigFile); JSON report.
    const cfg = JSON.stringify({
      mutate: sourceFiles,
      testRunner: "command",
      commandRunner: { command: testCommand },
      reporters: ["json"],
      tsconfigFile: "marmorkrebs.notsconfig.json",
      tempDirName: ".stryker-tmp",
    }).replace(/'/g, `'\\''`);
    return (
      `${ensure} && cd '${wd}' && { ${exclude}; } && ` +
      `printf '%s' '${cfg}' > .marmorkrebs-stryker.json && ` +
      `stryker run .marmorkrebs-stryker.json 1>&2; ` +
      `code=$?; cat reports/mutation/mutation.json 2>/dev/null; ` +
      `rm -f .marmorkrebs-stryker.json; exit $code`
    );
  }
  return (
    `${ensure} && cd '${wd}' && { ${exclude}; } && ` +
    `stryker run --mutate ${mutateGlobs} --reporters json 1>&2; ` +
    `code=$?; cat reports/mutation/mutation.json 2>/dev/null; exit $code`
  );
}

function shellEscape(s: string): string {
  return s.replace(/'/g, "'\\''");
}
