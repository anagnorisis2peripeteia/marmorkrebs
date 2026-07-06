import { EMPTY_RESULT, type MutationResult, type SurvivingMutant, mutationScore } from "../types.js";

export function parseStryker(output: string): MutationResult {
  const mutants: SurvivingMutant[] = [];
  let killed = 0;
  let survived = 0;
  let timeout = 0;
  let noCoverage = 0;
  let ignored = 0;

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
          case "Ignored":
            ignored++;
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


  return {
    tool: "stryker",
    totalMutants: killed + survived + timeout + noCoverage + ignored,
    killed,
    survived,
    timeout,
    noCoverage,
    ignored,
    score: mutationScore(killed, timeout, survived, noCoverage),
    survivingMutants: mutants,
    error: null,
    elapsedMs: 0,
  };
}

export function buildStrykerCommand(
  sourceFiles: string[],
  workDir: string,
  testCommand?: string,
  excludeMutations?: string[],
): string {
  const wd = shellEscape(workDir);
  const mutateGlobs = sourceFiles.map((f) => `'${shellEscape(f)}'`).join(",");
  // One machine-wide global Stryker (never a per-repo/venv dep) — install it once if
  // missing. A global install also lets Stryker resolve `typescript` for its config
  // preprocessor; a transient `npx` sandbox can't, which is what made npx flaky.
  const ensure =
    `command -v stryker >/dev/null 2>&1 || npm install -g @stryker-mutator/core typescript 1>&2`;
  // Keep Stryker's artifacts out of git status so they don't trip later clean-tree gates.
  // The PRIOR report is scrubbed before each run: a failed run must not let anything
  // downstream read a stale reports/mutation/mutation.json as a fresh pass (fail-open
  // caught live by the validator's hidden-binary probe, 2026-07-04).
  const exclude =
    `E="$(git rev-parse --git-path info/exclude 2>/dev/null)"; ` +
    `[ -n "$E" ] && { grep -qxF '.marmorkrebs.lock' "$E" 2>/dev/null || ` +
    // Guard on the NEWEST entry: guarding on 'reports/' skipped the append on every
    // checkout that ran the lane before an entry was added (review catch, PR #9).

    `printf 'reports/\\n.stryker-tmp/\\n.marmorkrebs-stryker.json\\n.marmorkrebs.lock\\n' >> "$E"; }; true`;

  if (testCommand) {
    // No usable repo Stryker config: drive it with a throwaway one — the `command` test
    // runner (exit code = pass/fail) on the focused test command; babel mutator (skip the
    // tsconfig preprocessor via a nonexistent tsconfigFile); JSON report.
    // `mutate` entries may carry :start-end line ranges — StrykerJS consumes them
    // natively, so line-scoped runs need no marmorkrebs-side filtering here.
    const cfg = JSON.stringify({
      mutate: sourceFiles,
      testRunner: "command",
      commandRunner: { command: testCommand },
      reporters: ["json"],
      tsconfigFile: "marmorkrebs.notsconfig.json",
      tempDirName: ".stryker-tmp",
      ...(excludeMutations?.length ? { mutator: { excludedMutations: excludeMutations } } : {}),
    }).replace(/'/g, `'\\''`);
    // cd + scrub the PRIOR report FIRST: the trailing `cat` runs on every exit path,
    // so a stale report from an earlier run must be gone BEFORE anything can fail —
    // otherwise a failed run emits stale-report+nonzero-exit, which reconcileResult
    // trusts as a tool-threshold verdict (fail-open caught by the validator probe).
    return (
      `cd '${wd}' && rm -f reports/mutation/mutation.json && ${ensure} && { ${exclude}; } && ` +
      `printf '%s' '${cfg}' > .marmorkrebs-stryker.json && ` +
      `stryker run .marmorkrebs-stryker.json 1>&2; ` +
      `code=$?; cat reports/mutation/mutation.json 2>/dev/null; ` +
      `rm -f .marmorkrebs-stryker.json; exit $code`
    );
  }
  return (
    `cd '${wd}' && rm -f reports/mutation/mutation.json && ${ensure} && { ${exclude}; } && ` +
    `stryker run --mutate ${mutateGlobs} --reporters json 1>&2; ` +
    `code=$?; cat reports/mutation/mutation.json 2>/dev/null; exit $code`
  );
}

function shellEscape(s: string): string {
  return s.replace(/'/g, "'\\''");
}
