// marmorkrebs hunt — whole-repo / module survivor discovery (#36).
//
// The gate answers "did the tests a PR ADDED kill mutants on the lines it TOUCHED". Hunt answers
// "where in EXISTING code do mutants survive" — latent test-debt discovery independent of a diff.
// Both run the SAME lanes and the SAME MutationReport; hunt is a new DRIVER, not a new engine:
//
//   1. gather all source files under a scope (module/repo), with NO diff        -> gatherHuntFiles
//   2. run the validated lane over them (the caller reuses runMutationAnalysis)
//   3. a SURVIVING mutant on COVERED code = "a bug-shaped edit here that no test catches" — a
//      concrete, already-proven test gap (unlike a raeuberkrebs sink, which is only a lead).
//   4. rank survivors by blast radius / centrality, and filter likely-equivalent ones (#31) so
//      the issue-first output isn't polluted                                     -> buildHuntReport
//
// This module is the deterministic pre-filter. The LLM test-authoring + prove stages live in the
// marmorkrebs-hunt skill, which consumes this report.
//
// COST NOTE: unlike signalkrebs/raeuberkrebs, whose sweep is a free grep, marmorkrebs' sweep is
// the mutation run itself — O(mutants x suite-runtime). So scoping (--scope <module>) and the
// lane's own --max-mutants cap are LOAD-BEARING here, not optional. The caller enforces scope; this
// module never widens it.

import { readdirSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import { filterSourceFiles } from "./runner.js";
import type { MutationResult, MutationTool, SurvivingMutant } from "./types.js";

// Directories that never hold huntable source (build output, deps, VCS, tool scratch). Skipping
// them keeps the walk cheap and avoids mutating vendored/generated code.
const SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "bin",
  "obj",
  ".vs",
  ".idea",
  "packages",
  "StrykerOutput",
  ".marmorkrebs-stryker",
  "coverage",
  "TestResults",
  "target", // rust/maven build dir
  "__pycache__",
]);

/**
 * Recursively collect every source file under `scopeDir` that the tool can mutate, as
 * REPO-RELATIVE paths (relative to `repoDir`), excluding tests and build/dep dirs. Reuses the
 * runner's `filterSourceFiles` for the extension + test-file rules so hunt and the gate agree on
 * "what is a source file". `scopeDir` must be inside `repoDir` (the caller scopes the hunt).
 */
export function gatherHuntFiles(repoDir: string, scopeDir: string, tool: MutationTool): string[] {
  const acc: string[] = [];
  walk(scopeDir, repoDir, acc);
  // Stable order so a hunt is deterministic run-to-run (ranking is by centrality, but the input
  // list feeding the lane should not depend on filesystem enumeration order).
  return filterSourceFiles(acc, tool).sort();
}

function walk(dir: string, repoDir: string, acc: string[]): void {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable dir — skip, never throw the whole hunt
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== "." && entry.name !== "..") {
      // Skip dotfiles/dotdirs (.git, .vs, …) — none carry huntable source. (SKIP_DIRS also lists
      // the common ones explicitly for readability.)
      if (entry.isDirectory()) continue;
    }
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name), repoDir, acc);
    } else if (entry.isFile()) {
      acc.push(relative(repoDir, join(dir, entry.name)));
    }
  }
}

export type HuntTier = "survivor" | "no-coverage" | "equivalent";

export interface HuntFinding {
  /** 1-based rank among real (non-equivalent) survivors; higher blast radius first. */
  rank: number;
  file: string;
  line: number;
  mutator: string;
  description: string;
  tier: HuntTier;
  /** Blast-radius proxy: how many OTHER source files reference this file (see computeCentrality). */
  centrality: number;
  /** Survivor count in the same file — a cluster of survivors is a weak-tested unit. */
  fileSurvivors: number;
  /** Reason from the #31 classifier when tier === "equivalent". */
  likelyEquivalent?: string;
}

export interface HuntReport {
  tool: string;
  scope: string;
  filesSwept: number;
  totalMutants: number;
  /** Real test-debt: survivors on covered code, minus likely-equivalent ones. */
  survivorsCovered: number;
  /** Survivors the #31 classifier flagged equivalent — reported but not ranked as findings. */
  equivalentFiltered: number;
  /** No-coverage mutants (a coverage gap, not a test-strength gap) — a separate, optional tier. */
  noCoverage: number;
  score: number;
  /** Ranked real survivors (blast radius desc). Equivalent/no-coverage appended only when requested. */
  findings: HuntFinding[];
  error: string | null;
}

export interface BuildHuntReportOptions {
  scope: string;
  filesSwept: number;
  /** Include a secondary no-coverage tier after the ranked survivors (default false). */
  includeNoCoverage?: boolean;
  /** Cap the number of ranked survivor findings emitted (0/undefined = no cap). */
  maxFindings?: number;
}

/**
 * Blast-radius proxy for each file that has a survivor: the number of OTHER source files whose
 * content references the file's basename-without-extension as a whole word. A file everything
 * imports (core logic) outranks one nothing references (a rarely-reached leaf). `readSource` is
 * injected so this is unit-testable without disk. Bounded O(allFiles x survivorFiles).
 */
export function computeCentrality(
  allFiles: readonly string[],
  survivorFiles: readonly string[],
  readSource: (file: string) => string | null,
): Map<string, number> {
  const centrality = new Map<string, number>();
  // token -> the survivor file(s) that own it; multiple files can share a basename (e.g. two
  // Options.cs), so we count references to the token and attribute to every owner.
  const tokens = new Map<string, string>();
  for (const f of survivorFiles) {
    tokens.set(f, tokenOf(f));
    centrality.set(f, 0);
  }
  const matchers = [...tokens.entries()].map(([file, token]) => ({
    file,
    token,
    re: new RegExp(`\\b${escapeRegExp(token)}\\b`),
  }));
  for (const other of allFiles) {
    const content = readSource(other);
    if (content == null) continue;
    for (const m of matchers) {
      if (other === m.file) continue; // a file referencing itself is not blast radius
      if (m.token.length === 0) continue;
      if (m.re.test(content)) centrality.set(m.file, (centrality.get(m.file) ?? 0) + 1);
    }
  }
  return centrality;
}

function tokenOf(file: string): string {
  const b = basename(file);
  return b.slice(0, b.length - extname(b).length);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Turn a raw MutationResult from a hunt sweep into a ranked, equivalent-aware HuntReport.
 * - Real survivors (status "survived", NOT flagged equivalent by #31) become ranked findings,
 *   sorted by centrality desc, then same-file survivor count desc, then line asc.
 * - Survivors the #31 classifier flagged (`likelyEquivalent`) are counted and, only if requested,
 *   appended as an "equivalent" tier — never ranked as real test-debt.
 * - No-coverage mutants are a coverage gap, not a test-strength gap; appended only when asked.
 */
export function buildHuntReport(
  result: MutationResult,
  allFiles: readonly string[],
  opts: BuildHuntReportOptions,
  readSource: (file: string) => string | null,
): HuntReport {
  const survived: SurvivingMutant[] = [];
  const equivalent: SurvivingMutant[] = [];
  const noCoverage: SurvivingMutant[] = [];
  for (const m of result.survivingMutants) {
    if (m.status === "no_coverage") noCoverage.push(m);
    else if (m.likelyEquivalent) equivalent.push(m);
    else survived.push(m);
  }

  // Same-file survivor counts (a cluster = a weak-tested unit).
  const fileSurvivors = new Map<string, number>();
  for (const m of survived) fileSurvivors.set(m.file, (fileSurvivors.get(m.file) ?? 0) + 1);

  const survivorFiles = [...fileSurvivors.keys()];
  const centrality = computeCentrality(allFiles, survivorFiles, readSource);

  const ranked = survived
    .map((m) => ({
      m,
      centrality: centrality.get(m.file) ?? 0,
      fileSurvivors: fileSurvivors.get(m.file) ?? 1,
    }))
    .sort(
      (a, b) =>
        b.centrality - a.centrality ||
        b.fileSurvivors - a.fileSurvivors ||
        a.m.file.localeCompare(b.m.file) ||
        a.m.line - b.m.line,
    );

  const capped = opts.maxFindings && opts.maxFindings > 0 ? ranked.slice(0, opts.maxFindings) : ranked;

  const findings: HuntFinding[] = capped.map((r, i) => ({
    rank: i + 1,
    file: r.m.file,
    line: r.m.line,
    mutator: r.m.mutator,
    description: r.m.description,
    tier: "survivor",
    centrality: r.centrality,
    fileSurvivors: r.fileSurvivors,
  }));

  if (opts.includeNoCoverage) {
    for (const m of noCoverage) {
      findings.push({
        rank: 0, // no-coverage is a coverage gap, not a ranked test-strength finding
        file: m.file,
        line: m.line,
        mutator: m.mutator,
        description: m.description,
        tier: "no-coverage",
        centrality: centrality.get(m.file) ?? 0,
        fileSurvivors: fileSurvivors.get(m.file) ?? 0,
      });
    }
  }

  return {
    tool: result.tool,
    scope: opts.scope,
    filesSwept: opts.filesSwept,
    totalMutants: result.totalMutants,
    survivorsCovered: survived.length,
    equivalentFiltered: equivalent.length,
    noCoverage: noCoverage.length,
    score: result.score,
    findings,
    error: result.error,
  };
}

/** Compact human-readable summary of a hunt report for the terminal / job log. */
export function formatHuntReport(report: HuntReport): string {
  const lines: string[] = [];
  lines.push(
    `[marmorkrebs hunt] scope=${report.scope} tool=${report.tool} files=${report.filesSwept} ` +
      `mutants=${report.totalMutants} survivors=${report.survivorsCovered} ` +
      `equivalent-filtered=${report.equivalentFiltered} no-coverage=${report.noCoverage} ` +
      `score=${Math.round(report.score * 100)}%`,
  );
  if (report.error) {
    // A lane error is fail-closed: never follow it with a "no test-debt found" reassurance, which
    // would read as a clean sweep. The error IS the result.
    lines.push(`[marmorkrebs hunt] ERROR: ${report.error}`);
    lines.push("[marmorkrebs hunt] sweep did not complete — result is NOT a clean bill of health");
    return lines.join("\n");
  }
  const survivors = report.findings.filter((f) => f.tier === "survivor");
  if (survivors.length === 0) {
    lines.push("[marmorkrebs hunt] no real (non-equivalent) survivors — no test-debt found in scope");
  } else {
    lines.push(`[marmorkrebs hunt] top test-debt (ranked by blast radius):`);
    for (const f of survivors) {
      lines.push(
        `  #${f.rank} ${f.file}:${f.line} [${f.mutator}] centrality=${f.centrality} ` +
          `file-survivors=${f.fileSurvivors} — ${f.description}`,
      );
    }
  }
  return lines.join("\n");
}
