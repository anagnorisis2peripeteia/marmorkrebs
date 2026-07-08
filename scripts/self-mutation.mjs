#!/usr/bin/env node
/**
 * PR-scoped, report-only self-mutation for marmorkrebs.
 *
 * Mutates only the source files changed vs a base ref (the PR diff), runs
 * StrykerJS (with the TypeScript checker) scoped to them, then prints the
 * mutation score + surviving mutants and appends a markdown summary for CI.
 *
 * This is a SIGNAL, not a gate: it exits 0 no matter how low the score is, and
 * fails only when StrykerJS itself crashes. Turn it into a gate later by setting
 * `thresholds.break` in stryker.conf.json once a floor has been agreed.
 *
 * Usage: node scripts/self-mutation.mjs [baseRef]     (default: origin/master)
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

// Default to the remote's own default branch (origin/HEAD -> e.g. origin/master or origin/main)
// rather than hardcoding a name, so this works regardless of what the default branch is called.
function defaultBase() {
  const r = spawnSync("git", ["rev-parse", "--abbrev-ref", "origin/HEAD"], { encoding: "utf8" });
  const ref = (r.stdout || "").trim();
  return r.status === 0 && ref && ref !== "origin/HEAD" ? ref : "origin/master";
}

const base = process.argv[2] || process.env.MUTATION_BASE || defaultBase();

// Fail closed on a missing/unfetched base ref: without this the base-diff below would fail and
// the run could report "nothing to mutate — pass", a false pass on the whole self-mutation.
if (spawnSync("git", ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]).status !== 0) {
  console.error(
    `[self-mutation] base ref '${base}' not found — fetch it first ` +
      `(CI needs actions/checkout with fetch-depth: 0). Refusing to report a false pass.`,
  );
  process.exit(1);
}

// Run git with an argument ARRAY (never a shell-built string, so base/MUTATION_BASE can't inject)
// and FAIL CLOSED: if source selection fails we must not fall through to a "nothing to mutate" pass.
function git(args) {
  const r = spawnSync("git", args, { encoding: "utf8" });
  if (r.status !== 0) {
    console.error(
      `[self-mutation] \`git ${args.join(" ")}\` failed — refusing to report a false pass.\n` +
        (r.stderr || "").trim(),
    );
    process.exit(1);
  }
  return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

const isTarget = (f) => f.startsWith("src/") && f.endsWith(".ts") && !f.endsWith(".test.ts");

const changed = [
  ...git(["diff", "--name-only", `${base}...HEAD`]), // committed on the branch since merge-base
  ...git(["diff", "--name-only"]), // unstaged working edits
  ...git(["diff", "--name-only", "--cached"]), // staged edits
  ...git(["ls-files", "--others", "--exclude-standard"]), // untracked new files
].filter(isTarget);

const files = [...new Set(changed)].filter((f) => existsSync(f));

if (files.length === 0) {
  emit(`[self-mutation] no changed \`src/*.ts\` vs \`${base}\` — nothing to mutate (pass).`);
  process.exit(0);
}

console.log(`[self-mutation] mutating ${files.length} changed file(s) vs ${base}:`);
files.forEach((f) => console.log(`  - ${f}`));

// Scrub any prior report FIRST so a stale one from an earlier run can never be read as this
// run's evidence (a run that exits 0 without writing a fresh report then fails closed below).
rmSync("reports/mutation/mutation.json", { force: true });

const res = spawnSync("npx", ["stryker", "run", "--mutate", files.join(",")], { stdio: "inherit" });
if (res.status !== 0) {
  console.error(`[self-mutation] StrykerJS exited ${res.status} — tool failure (no score gate is set), so this fails.`);
  process.exit(res.status ?? 1);
}

summarize(files);
process.exit(0);

function summarize(scopedFiles) {
  const reportPath = "reports/mutation/mutation.json";
  if (!existsSync(reportPath)) {
    // Fail closed: StrykerJS exited 0 but wrote no report. A mutation signal only counts with
    // parsed report evidence, so a no-evidence run must fail rather than publish a false pass.
    console.error(`[self-mutation] StrykerJS exited 0 but produced no ${reportPath} — treating as a tool failure.`);
    process.exit(1);
  }
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const c = { Killed: 0, Timeout: 0, Survived: 0, NoCoverage: 0, CompileError: 0, Ignored: 0 };
  const survivors = [];
  for (const [file, data] of Object.entries(report.files || {})) {
    for (const m of data.mutants || []) {
      if (m.status in c) c[m.status]++;
      if (m.status === "Survived") survivors.push(`${file}:${m.location?.start?.line ?? "?"} ${m.mutatorName}`);
    }
  }
  const detected = c.Killed + c.Timeout;
  const denom = detected + c.Survived + c.NoCoverage;
  if (denom === 0) {
    // Fail closed: mutants were generated but none are scorable (all ignored/compile-error, or
    // none produced) — a vacuous run proves nothing, so it must not report a passing "n/a"
    // (matches the repo's "an all-ignored run is a hard error" fail-closed rule).
    console.error(
      `[self-mutation] no scorable mutants (killed ${c.Killed} · timeout ${c.Timeout} · ` +
        `survived ${c.Survived} · no-coverage ${c.NoCoverage} · ignored ${c.Ignored} · ` +
        `compile-error ${c.CompileError}) — vacuous run, failing closed.`,
    );
    process.exit(1);
  }
  const score = ((detected / denom) * 100).toFixed(2) + "%";
  const lines = [
    `## marmorkrebs self-mutation (PR-scoped, report-only)`,
    ``,
    `Mutated ${scopedFiles.length} changed file(s) vs \`${base}\`.`,
    ``,
    `**Mutation score: ${score}** — ` +
      `✅ ${c.Killed} killed · ⏱ ${c.Timeout} timeout · 🙁 ${c.Survived} survived · ` +
      `🚫 ${c.NoCoverage} no-coverage · 🧪 ${c.CompileError} compile-error (excluded) · 🔇 ${c.Ignored} ignored`,
  ];
  if (survivors.length) {
    lines.push(``, `<details><summary>${survivors.length} surviving mutant(s)</summary>`, ``);
    survivors.slice(0, 100).forEach((s) => lines.push(`- \`${s}\``));
    if (survivors.length > 100) lines.push(`- …and ${survivors.length - 100} more`);
    lines.push(``, `</details>`);
  }
  emit(lines.join("\n"));
}

function emit(md) {
  console.log("\n" + md);
  const out = process.env.GITHUB_STEP_SUMMARY;
  if (out) {
    try {
      writeFileSync(out, md + "\n", { flag: "a" });
    } catch {
      /* not in CI */
    }
  }
}
