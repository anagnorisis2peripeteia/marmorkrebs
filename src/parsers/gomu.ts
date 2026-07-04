import { type MutationResult, type SurvivingMutant } from "../types.js";
import { matchesScope, parseScopedTargets } from "./scope.js";

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

function stripLineRange(file: string): string {
  return file.replace(/:\d+(?:-\d+)?$/, "");
}

export function parseGomu(output: string, changedFiles?: string[]): MutationResult {
  try {
    // buildGomuCommand emits one report per package dir, separated by ASCII RS
    // (0x1e). A single plain report (no separator) is the one-chunk case.
    const chunks = output.split("\u001e").map((c) => c.trim()).filter(Boolean);
    if (!chunks.length) throw new Error("empty gomu report stream");
    const reports: GomuReport[] = chunks.map((c) => JSON.parse(c));

    let results: GomuResult[] = [];
    let durationNsTotal = 0;
    for (const report of reports) {
      results.push(...(report.results ?? []));
      durationNsTotal += report.duration ?? 0;
    }

    const stats = { killed: 0, survived: 0, timedOut: 0, errors: 0, notViable: 0 };
    if (changedFiles?.length) {
      // Package-dir runs mutate the whole package; score only the PR's files —
      // and only the PR's LINES when entries carry :start-end ranges.
      const targets = parseScopedTargets(changedFiles);
      results = results.filter((r) => matchesScope(r.mutant.filePath, r.mutant.line ?? 0, targets));
      for (const r of results) {
        const status = r.status.toUpperCase();
        if (status === "KILLED") stats.killed += 1;
        else if (status === "SURVIVED") stats.survived += 1;
        else if (status === "TIMED_OUT") stats.timedOut += 1;
        else if (status === "ERROR") stats.errors += 1;
        else stats.notViable += 1;
      }
    } else {
      for (const report of reports) {
        stats.killed += report.statistics?.killed ?? 0;
        stats.survived += report.statistics?.survived ?? 0;
        stats.timedOut += report.statistics?.timedOut ?? 0;
        stats.errors += report.statistics?.errors ?? 0;
        stats.notViable += report.statistics?.notViable ?? 0;
      }
    }

    const mutants: SurvivingMutant[] = [];
    for (const r of results) {
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

    const { killed, survived, timedOut, errors, notViable } = stats;
    const total = killed + survived + timedOut + errors;
    const denom = killed + survived + timedOut;
    const durationNs = durationNsTotal;

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

// gomu's `run` accepts at most ONE positional path, and `--output json` writes the
// report to mutation-report.json in the CWD (stdout is human progress). It also skips
// a bare file that has no test file of its own, and consults .gomu_history.json to
// silently skip "unchanged" files EVEN WITH --incremental=false. So: run gomu once
// per unique PACKAGE DIR of the changed files (Go tests are package-scoped), scrub
// the history file around every run, collect each report into a temp dir, then emit
// them on stdout separated by ASCII RS (0x1e); parseGomu merges the reports and
// filters mutants back down to the changed files. The `&&` chain is fail-closed:
// gomu (v0.2.1) exits 0 when mutants merely survive and non-zero only on real
// errors, so any failed run aborts the chain and a partial result can never be
// scored as a full one.
export function buildGomuCommand(
  sourceFiles: string[],
  workDir: string,
  timeoutSecs = 30,
  workers = 4,
): string {
  const dirs = [
    ...new Set(
      sourceFiles.map((f) => {
        const file = stripLineRange(f);
        const slash = file.lastIndexOf("/");
        return slash === -1 ? "." : file.slice(0, slash);
      }),
    ),
  ];
  const runs = dirs
    .map(
      (d, i) =>
        `rm -f .gomu_history.json && gomu run --output json --timeout ${timeoutSecs} --workers ${workers} ` +
        `--incremental=false '${shellEscape(d)}' 1>&2 && mv -f mutation-report.json "$RPT/r${i}.json"`,
    )
    .join(" && ");
  return (
    `cd '${shellEscape(workDir)}' && RPT="$(mktemp -d)" && rm -f mutation-report.json && ` +
    `${runs} && rm -f .gomu_history.json && ` +
    `for r in "$RPT"/*.json; do cat "$r"; printf '\\n\\036\\n'; done && rm -rf "$RPT"`
  );
}

function shellEscape(s: string): string {
  return s.replace(/'/g, "'\\''");
}
