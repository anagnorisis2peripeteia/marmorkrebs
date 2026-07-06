import { EMPTY_RESULT, type MutationResult, type SurvivingMutant, mutationScore } from "../types.js";
import { matchesScope, parseScopedTargets } from "./scope.js";

// Ground truth (cargo-mutants v27.1.0, probed live 2026-07-03): results are NEVER on
// stdout — the run writes <output>/mutants.out/outcomes.json. Top level carries summary
// counts {caught, missed, timeout, unviable, total_mutants}; outcomes[] entries have
// summary ("CaughtMutant" | "MissedMutant" | "Timeout" | "Unviable" | baseline "Success")
// and scenario.Mutant {name, file, span.start.line, genre, replacement}. Exit codes:
// 0 = all caught, 2 = missed mutants found (a VALID result — reconcileResult trusts a
// parsed report with mutants on non-zero exit), others = real errors.
interface CargoMutantsOutcome {
  scenario: "Baseline" | { Mutant: {
    name: string;
    file: string;
    span?: { start?: { line?: number } };
    genre?: string;
    replacement?: string;
  } };
  summary: string;
}

export function parseCargoMutants(output: string, changedFiles: string[] = []): MutationResult {
  try {
    const report = JSON.parse(output.trim());
    const outcomes: CargoMutantsOutcome[] = report.outcomes ?? [];
    const mutants: SurvivingMutant[] = [];
    for (const o of outcomes) {
      if (o.scenario === "Baseline" || typeof o.scenario === "string") continue;
      if (o.summary === "MissedMutant" || o.summary === "Timeout") {
        const m = o.scenario.Mutant;
        mutants.push({
          file: m.file,
          line: m.span?.start?.line ?? 0,
          mutator: m.genre ?? "cargo-mutants",
          description: m.name,
          status: o.summary === "MissedMutant" ? "survived" : "timeout",
        });
      }
    }
    const targets = parseScopedTargets(changedFiles);
    const hasRanges = targets.some((t) => t.ranges.length > 0);
    let killed = report.caught ?? 0;
    let survived = report.missed ?? 0;
    let timeout = report.timeout ?? 0;
    let notViable = report.unviable ?? 0;
    if (hasRanges) {
      // --file scopes to files only; recompute counts from per-outcome line spans
      // so scoring honors the PR's line ranges. Baseline outcomes are excluded.
      killed = survived = timeout = notViable = 0;
      const scoped = outcomes.filter(
        (o) =>
          o.scenario !== "Baseline" &&
          typeof o.scenario !== "string" &&
          matchesScope(o.scenario.Mutant.file, o.scenario.Mutant.span?.start?.line ?? 0, targets),
      );
      for (const o of scoped) {
        if (o.summary === "CaughtMutant") killed++;
        else if (o.summary === "MissedMutant") survived++;
        else if (o.summary === "Timeout") timeout++;
        else notViable++;
      }
      mutants.length = 0;
      for (const o of scoped) {
        if (typeof o.scenario === "string") continue;
        if (o.summary === "MissedMutant" || o.summary === "Timeout") {
          const m = o.scenario.Mutant;
          mutants.push({
            file: m.file,
            line: m.span?.start?.line ?? 0,
            mutator: m.genre ?? "cargo-mutants",
            description: m.name,
            status: o.summary === "MissedMutant" ? "survived" : "timeout",
          });
        }
      }
    }
    return {
      tool: "cargo-mutants",
      totalMutants: hasRanges
        ? killed + survived + timeout + notViable
        : report.total_mutants ?? killed + survived + timeout + notViable,
      killed,
      survived,
      timeout,
      noCoverage: 0,
      ignored: notViable,
      score: mutationScore(killed, timeout, survived, 0),
      survivingMutants: mutants,
      error: null,
      elapsedMs: 0,
    };
  } catch (error) {
    return {
      ...EMPTY_RESULT,
      tool: "cargo-mutants",
      error: `Failed to parse cargo-mutants outcomes.json: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function buildCargoMutantsCommand(sourceFiles: string[], workDir: string): string {
  // --file scopes mutation to the changed files natively; the temp --output dir keeps
  // mutants.out/ out of the target repo. Progress goes to stderr; stdout is the report.
  const fileArgs = sourceFiles
    .map((f) => `--file '${shellEscape(f.replace(/:\d+(?:-\d+)?$/, ""))}'`)
    .join(" ");
  return (
    `cd '${shellEscape(workDir)}' && RPT="$(mktemp -d)" && ` +
    `cargo mutants ${fileArgs} --output "$RPT" 1>&2; code=$?; ` +
    `cat "$RPT/mutants.out/outcomes.json" 2>/dev/null; rm -rf "$RPT"; exit $code`
  );
}

function shellEscape(s: string): string {
  return s.replace(/'/g, "'\\''");
}
