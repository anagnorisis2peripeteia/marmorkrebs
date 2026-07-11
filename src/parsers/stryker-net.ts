import { EMPTY_RESULT, type MutationResult, type SurvivingMutant, mutationScore } from "../types.js";

// Stryker.NET (`dotnet stryker`) emits the same mutation-testing-elements JSON schema as
// StrykerJS (files -> mutants -> status), so parsing mirrors the stryker parser. Unlike
// StrykerJS, the command writes the report to a file under StrykerOutput/, so
// buildStrykerNetCommand cats that report to stdout for parsing here.
export function parseStrykerNet(output: string): MutationResult {
  const mutants: SurvivingMutant[] = [];
  let killed = 0;
  let survived = 0;
  let timeout = 0;
  let noCoverage = 0;
  let ignored = 0;

  try {
    const jsonStart = output.indexOf("{");
    const jsonEnd = output.lastIndexOf("}");
    if (jsonStart === -1 || jsonEnd === -1) throw new Error("No JSON output from Stryker.NET");

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
      tool: "stryker-net",
      score: 0,
      error: `Failed to parse Stryker.NET output: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const scored = killed + survived + timeout + noCoverage;
  const total = killed + survived + timeout + noCoverage + ignored;
  if (total > 0 && scored === 0) {
    // Every mutant Ignored = the mutate filter matched nothing; scoring this as a
    // vacuous 1.0 is exactly how a mis-rooted glob passes a gate silently.
    return {
      ...EMPTY_RESULT,
      tool: "stryker-net",
      error: `all ${total} mutants were Ignored — --mutate patterns likely matched nothing (glob resolution root mismatch)`,
    };
  }

  return {
    tool: "stryker-net",
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

export function buildStrykerNetCommand(
  sourceFiles: string[],
  workDir: string,
  testProject?: string,
): string {
  // Stryker.NET takes one or more `--mutate` glob patterns; repo-relative file paths work
  // as degenerate globs. The json reporter writes the report to a file under the output
  // folder, so run quietly and cat that report to stdout for parseStrykerNet (clean JSON).
  // Stryker.NET resolves mutate globs against the project under test, NOT the
  // solution/repo root our changed-file entries are relative to — a bare
  // 'Lib/Calc.cs' matched nothing and every mutant came back Ignored (validator
  // CI catch, 2026-07-04). '**/'-anchor each pattern so it matches the full path
  // suffix regardless of the resolution root; line-range suffixes are stripped
  // (Stryker.NET has no range support).
  const mutateArgs = sourceFiles
    .map((f) => f.replace(/:\d+(?:-\d+)?$/, ""))
    .map((f) => `--mutate '${shellEscape(f.startsWith("**/") ? f : `**/${f}`)}'`)
    .join(" ");
  const escWork = shellEscape(workDir);
  // Multi-project repos (app + separate test csproj): running from the source-project
  // dir alone makes Stryker.NET treat the cwd project as its "test project" candidate
  // and abort with "can't be mutated because no test project references it"
  // (issue #14, live-fired on DS4Windows 2026-07-11). When the caller discovered the
  // referencing test project, hand it over explicitly.
  const testProjectArg = testProject ? ` --test-project '${shellEscape(testProject)}'` : "";
  // Scrub-FIRST (a crashed prior run's leftover report must never be cat'd by a
  // failed run — same stale-report class as the stryker lane), preserve the
  // runner's exit code through the cat (PR #1's lesson), and clean the output
  // dirs once the report is on stdout (validator artifact-hygiene catch).
  return (
    `cd '${escWork}' && rm -rf .marmorkrebs-stryker StrykerOutput && ` +
    `dotnet stryker ${mutateArgs}${testProjectArg} --reporter json --output .marmorkrebs-stryker 1>&2; code=$?; ` +
    `cat "$(find .marmorkrebs-stryker StrykerOutput -name mutation-report.json -path '*reports*' 2>/dev/null | sort | tail -1)" 2>/dev/null; ` +
    `rm -rf .marmorkrebs-stryker StrykerOutput; exit $code`
  );
}

function shellEscape(s: string): string {
  return s.replace(/'/g, "'\\''");
}
