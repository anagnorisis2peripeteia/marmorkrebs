import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  crabboxCleanup,
  crabboxExec,
  crabboxProvision,
  crabboxStop,
  crabboxSync,
} from "./crabbox-client.js";
import {
  buildCargoMutantsCommand,
  buildCxxSourceCommand,
  buildGoMutestingCommand,
  buildGomuCommand,
  buildMutmutCommand,
  buildStrykerCommand,
  buildStrykerNetArgs,
  buildStrykerNetCommand,
  parseCargoMutants,
  parseCxxSource,
  parseGoMutesting,
  parseGomu,
  parseMutmut,
  parseStryker,
  parseStrykerNet,
} from "./parsers/index.js";
import {
  EMPTY_RESULT,
  mutationScore,
  type CrabboxLease,
  type MutationConfig,
  type MutationResult,
  type MutationTool,
} from "./types.js";

// Lanes with a known-broken or never-validated adapter go here and hard-error
// instead of producing plausible wrongness (see 2026-07-03 audit — the gomu lane
// shipped broken for three weeks). Lifting an entry requires fixing the adapter
// against a REAL install, adding a fixtures/<tool> project, and a passing
// `node scripts/validate-provider.mjs <tool>`.
const QUARANTINED_TOOLS: Partial<Record<MutationTool, string>> = {
  mull: "the mull fallback chain has never been validated against a real mull binary (none installed on any of our boxes); use --tool stryker-cxx, or lift via a fixtures/mull project + validator spec when mull is actually needed",
};

interface ExecEvidence {
  exitCode: number;
  signal: string | null;
  spawnError: string | null;
  stderr: string;
}

// Fail-closed reconciliation (2026-07-03 audit): a mutation result only counts with
// evidence. Before this, a MISSING BINARY scored 100% and exited 0 — the child's
// exit code was ignored and every parser scores an empty mutant set as 1.0.
// Rules: an existing parse error wins; a spawn failure or kill signal is an error;
// a zero-mutant result is an error when the tool exited non-zero (nothing ran), and
// still an error on exit 0 unless config.allowEmpty says this diff legitimately has
// nothing to mutate. A non-zero exit WITH parsed mutants is trusted — tools like
// stryker exit non-zero on their own threshold verdicts, which are not ours to obey.
export function reconcileResult(
  parsed: MutationResult,
  exec: ExecEvidence,
  config: MutationConfig,
): MutationResult {
  if (parsed.error) {
    // A parse error on a FAILED tool run is only the SYMPTOM (e.g. "no JSON output from Stryker.NET"
    // because the tool crashed before writing a report). Surface the tool's own stderr so the real
    // cause — a compile error, an unhandled exception — is visible, instead of hiding it behind the
    // parse symptom. (P0 diagnosability: this masked a Stryker.NET CompilationException on
    // DS4Windows — CsWin32 source-generated symbols vanish under Stryker's mutant recompile — and
    // reported only "No JSON output" for hours.)
    const failed = Boolean(exec.spawnError) || Boolean(exec.signal) || exec.exitCode !== 0;
    const toolErr = exec.stderr.trim();
    if (failed) {
      const spawnError = exec.spawnError
        ? `tool process failed to spawn: ${exec.spawnError}`
        : `tool exited ${exec.exitCode}`;
      const signalInfo = exec.signal ? `signal ${exec.signal}` : null;
      const details = [spawnError, signalInfo].filter(Boolean).join("; ");
      // Append the exit detail even when stderr is empty — a silent tool death
      // must still carry its exit code in the surfaced error.
      const tail = toolErr ? `\n--- tool stderr (tail) ---\n${toolErr.slice(-2000)}` : "";
      return {
        ...parsed,
        error: `${parsed.error ?? "tool run failed"}\n${details}${tail}`,
      };
    }
    return parsed;
  }
  const stderrTail = exec.stderr.trim().slice(-300);
  if (exec.spawnError) {
    return { ...parsed, error: `tool process failed to spawn: ${exec.spawnError}` };
  }
  if (exec.signal) {
    return { ...parsed, error: `tool killed by ${exec.signal} (timeout?): ${stderrTail}` };
  }
  const scored = parsed.killed + parsed.survived + parsed.timeout + parsed.noCoverage;
  if (parsed.totalMutants > 0 && scored === 0) {
    // Universal vacuous-run guard (2026-07-06): mutants existed but NONE were scored
    // (all ignored/unviable — filters matched nothing, or the target doesn't build).
    // Lane parsers may fire first with a sharper message (stryker-net's glob hint);
    // this net catches every lane, including ones added later.
    return {
      ...parsed,
      error:
        `${parsed.totalMutants} mutants were generated but NONE were scored ` +
        "(all ignored/unviable) — the run proved nothing; check scope filters and that the target builds",
    };
  }
  if (parsed.totalMutants === 0) {
    if (exec.exitCode !== 0) {
      return {
        ...parsed,
        error: `tool exited ${exec.exitCode} with no parseable result: ${stderrTail}`,
      };
    }
    // `totalMutants === 0` alone does NOT prove an empty run: the cargo-mutants and cxx lanes read
    // totalMutants straight from the report (not derived from the scored counts), so a corrupt or
    // truncated report can claim `total: 0` while carrying real scored mutants / survivors. Treating
    // that as an allowed-empty run would let the normalization below erase those survivors into a
    // perfect pass — a malformed-report → score-1.0 fail-open through the net itself. Only a
    // genuinely all-zero parse is empty; anything else is corrupt evidence and fails closed.
    const scoredCounts = parsed.killed + parsed.survived + parsed.timeout + parsed.noCoverage;
    if (scoredCounts > 0 || parsed.survivingMutants.length > 0) {
      return {
        ...parsed,
        error:
          `report claims totalMutants=0 but carries ${scoredCounts} scored mutant(s) and ` +
          `${parsed.survivingMutants.length} survivor(s) — corrupt counts; refusing to score as empty`,
      };
    }
    if (!config.allowEmpty) {
      return {
        ...parsed,
        error:
          "tool produced 0 mutants (exit 0) — refusing to score an empty run as a pass; " +
          "pass --allow-empty if this diff legitimately has nothing to mutate",
      };
    }
    // An explicitly-allowed, genuinely-empty run is a pass BY POLICY — normalize it to the canonical
    // empty result (score 1, no error) so it matches runMutationAnalysis's staticEmpty path and never
    // reads as a threshold failure. Necessary now that mutationScore scores a proved-nothing run
    // 0 (#25): without this, an allowed empty parse would carry score 0 and fail `--threshold`,
    // silently regressing the deliberate allow-empty pass.
    return { ...EMPTY_RESULT, tool: parsed.tool };
  }
  return parsed;
}

// Per-repo lock: two concurrent runs on the same checkout corrupt each other's
// in-repo artifacts (the stryker lane's scrub-first rm can delete the OTHER run's
// report mid-flight). Steal only from a dead pid or a lock older than 2h.
const LOCK_NAME = ".marmorkrebs.lock";

function acquireRepoLock(repoDir: string): (() => void) | { error: string } {
  const lockPath = join(repoDir, LOCK_NAME);
  const claim = JSON.stringify({ pid: process.pid, started: new Date().toISOString() });
  const release = () => {
    try {
      unlinkSync(lockPath);
    } catch {
      // already gone — fine
    }
  };
  try {
    writeFileSync(lockPath, claim, { flag: "wx" });
    return release;
  } catch {
    // EEXIST (held/stale) or ENOENT/EACCES (bad repo dir) — both handled below:
    // the steal-write's catch converts a bad dir into a fail-closed error.
    let held: { pid?: number; started?: string } = {};
    try {
      held = JSON.parse(readFileSync(lockPath, "utf8"));
    } catch {
      // unreadable/corrupt lock — treat as stale
    }
    const alive = (() => {
      if (!held.pid) return false;
      try {
        process.kill(held.pid, 0);
        return true;
      } catch {
        return false;
      }
    })();
    const ageMs = held.started ? Date.now() - Date.parse(held.started) : Infinity;
    if (alive && ageMs < 2 * 3_600_000) {
      return {
        error: `another marmorkrebs run (pid ${held.pid}, since ${held.started}) holds ${lockPath} — concurrent runs on one checkout corrupt each other's artifacts`,
      };
    }
    try {
      writeFileSync(lockPath, claim); // stale: dead pid, ancient, or corrupt — steal
    } catch (e) {
      return { error: `cannot acquire ${lockPath} (repo dir missing or unwritable): ${e}` };
    }
    return release;
  }
}

export function runMutationAnalysis(
  repoDir: string,
  changedFiles: string[],
  config: MutationConfig,
): MutationResult {
  const quarantine = QUARANTINED_TOOLS[config.tool];
  if (quarantine) {
    return {
      ...EMPTY_RESULT,
      tool: config.tool,
      error: `${config.tool} lane is quarantined (never validated against the real tool): ${quarantine}. Fix the adapter and make scripts/validate-provider.mjs pass before use.`,
    };
  }
  // Static-empty is fail-closed like runtime-empty (2026-07-04 consistency fix):
  // a diff with nothing mutatable passes ONLY with an explicit --allow-empty, so a
  // docs/test-only PR says so out loud instead of scoring a silent vacuous 100%.
  const staticEmpty = (why: string): MutationResult =>
    config.allowEmpty
      ? { ...EMPTY_RESULT, tool: config.tool }
      : {
          ...EMPTY_RESULT,
          tool: config.tool,
          error: `${why} — pass --allow-empty if this diff legitimately has nothing to mutate`,
        };
  if (!changedFiles.length) return staticEmpty("no changed files");

  const sourceFiles = filterSourceFiles(changedFiles, config.tool);
  if (!sourceFiles.length) return staticEmpty("no mutatable sources in the diff");

  const lock = acquireRepoLock(repoDir);
  if (typeof lock !== "function") {
    return { ...EMPTY_RESULT, tool: config.tool, error: lock.error };
  }
  try {

  const startMs = Date.now();

  if (config.leaseId) {
    return runOnExistingLease(repoDir, sourceFiles, config, config.leaseId, startMs);
  }
  if (config.crabbox) {
    return runInCrabbox(repoDir, sourceFiles, config, startMs);
  }
  return runLocally(repoDir, sourceFiles, config, startMs);
  } finally {
    lock();
  }
}

function runOnExistingLease(
  repoDir: string,
  sourceFiles: string[],
  config: MutationConfig,
  leaseId: string,
  startMs: number,
): MutationResult {
  try {
    const remoteDir = config.remoteDir ?? "/tmp/mutation-target";
    if (!config.skipSync) {
      crabboxSync(leaseId, repoDir, remoteDir);
    }

    if (config.tool === "stryker-net") {
      return runStrykerNetInProjectGroupsCrabbox(repoDir, sourceFiles, config, remoteDir, leaseId, startMs);
    }

    const command = buildCommand(config, sourceFiles, remoteDir);
    const timeoutMs = config.timeoutMs ?? 8 * 60 * 1000;
    const result = crabboxExec(leaseId, command, timeoutMs);

    const parsed = parseOutput(config, result.stdout, result.stderr, sourceFiles);
    const reconciled = reconcileResult(
      parsed,
      { exitCode: result.exitCode, signal: null, spawnError: null, stderr: result.stderr },
      config,
    );
    return { ...reconciled, elapsedMs: Date.now() - startMs };
  } catch (error) {
    return {
      ...EMPTY_RESULT,
      tool: config.tool,
      error: error instanceof Error ? error.message : String(error),
      elapsedMs: Date.now() - startMs,
    };
  }
}

function runInCrabbox(
  repoDir: string,
  sourceFiles: string[],
  config: MutationConfig,
  startMs: number,
): MutationResult {
  let lease: CrabboxLease | null = null;
  try {
    lease = crabboxProvision(config.crabbox!);
    const remoteDir = "/tmp/mutation-target";
    crabboxSync(lease.id, repoDir, remoteDir);

    if (config.tool === "stryker-net") {
      return runStrykerNetInProjectGroupsCrabbox(repoDir, sourceFiles, config, remoteDir, lease.id, startMs);
    }

    const command = buildCommand(config, sourceFiles, remoteDir);
    const timeoutMs = config.timeoutMs ?? 8 * 60 * 1000;
    const result = crabboxExec(lease.id, command, timeoutMs);

    const parsed = parseOutput(config, result.stdout, result.stderr, sourceFiles);
    const reconciled = reconcileResult(
      parsed,
      { exitCode: result.exitCode, signal: null, spawnError: null, stderr: result.stderr },
      config,
    );
    return { ...reconciled, elapsedMs: Date.now() - startMs };
  } catch (error) {
    return {
      ...EMPTY_RESULT,
      tool: config.tool,
      error: error instanceof Error ? error.message : String(error),
      elapsedMs: Date.now() - startMs,
    };
  } finally {
    if (lease) {
      try {
        crabboxStop(lease.id);
        crabboxCleanup(lease.id);
      } catch {
        // best-effort cleanup
      }
    }
  }
}

function runLocally(
  repoDir: string,
  sourceFiles: string[],
  config: MutationConfig,
  startMs: number,
): MutationResult {
  if (config.tool === "stryker-net") {
    return runStrykerNetInProjectGroups(repoDir, sourceFiles, config, startMs);
  }

  const command = buildCommand(config, sourceFiles, repoDir);
  console.error(
    `[marmorkrebs] ${config.tool}: ${sourceFiles.length} source file(s) in scope; running: ${redactSecrets(command)}`,
  );

  const result = spawnSync("bash", ["-c", command], {
    cwd: repoDir,
    encoding: "utf8" as const,
    timeout: config.timeoutMs ?? 8 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024,
  });

  try {
    // Stryker's "json" reporter writes a FILE, not stdout — prefer it when present.
    // Freshness is guaranteed by the COMMAND: buildStrykerCommand cd+scrubs the prior
    // report before anything can fail, so a file here was written by THIS run (the
    // stale-report fail-open is regression-locked end-to-end in runner.test.ts).
    let stdout = result.stdout ?? "";
    if (config.tool === "stryker") {
      try {
        const report = readFileSync(join(repoDir, "reports/mutation/mutation.json"), "utf8");
        if (report.trim()) stdout = report;
      } catch {
        // fall back to stdout
      }
    }
    const parsed = parseOutput(config, stdout, result.stderr ?? "", sourceFiles);
    const reconciled = reconcileResult(
      parsed,
      {
        exitCode: result.status ?? 1,
        signal: result.signal ?? null,
        spawnError: result.error ? String(result.error) : null,
        stderr: result.stderr ?? "",
      },
      config,
    );
    return { ...reconciled, elapsedMs: Date.now() - startMs };
  } catch (error) {
    return {
      ...EMPTY_RESULT,
      tool: config.tool,
      error: error instanceof Error ? error.message : String(error),
      elapsedMs: Date.now() - startMs,
    };
  }
}

// Finalize an accumulated grouped stryker-net merge (shared by the local + crabbox variants).
// Pure (no timing/IO) so it is unit-testable — the merge score-recompute bug (an allowed all-empty
// run scoring 0) slipped through precisely because the grouped tail had no direct test.
//   - any group errored  -> score 0 + combined error (issue #15: a failed run never scores passing)
//   - EVERY group was an allowed-empty run (merged.totalMutants === 0; a non-allowed empty group
//     lands in `failures` first) -> the canonical empty PASS. Necessary because mutationScore now
//     scores a proved-nothing run 0 (#25); recomputing over all-zero counts would overwrite the
//     per-group score-1 normalization and fail --threshold — the exact allow-empty regression
//     reconcileResult prevents on the single-lane path.
//   - otherwise -> recompute the merged score from the pooled counts.
export function finalizeStrykerNetGroups(
  merged: MutationResult,
  failures: string[],
): MutationResult {
  if (failures.length) {
    return {
      ...merged,
      tool: "stryker-net",
      score: 0,
      error: `Stryker.NET failed in one or more project scopes: ${failures.join(" | ")}`,
    };
  }
  // Genuinely all-empty: every group was an allowed-empty run. reconcileResult fails a corrupt
  // count-vs-total group into `failures` (handled above) and normalizes a valid empty group to
  // all-zero counts, so `merged.totalMutants === 0` here provably implies every scored count is 0
  // too — no survivor can hide behind this empty PASS.
  if (merged.totalMutants === 0) {
    return { ...EMPTY_RESULT, tool: "stryker-net" };
  }
  return {
    ...merged,
    score: mutationScore(merged.killed, merged.timeout, merged.survived, merged.noCoverage),
  };
}

// Locate the Stryker.NET json report under an output dir (its json reporter writes
// `<output>/reports/mutation-report.json`). Replaces the old shell `find … -name mutation-report.json
// -path '*reports*' | sort | tail -1` — done in Node so the local lane needs no shell at all.
export function findMutationReport(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const matches: string[] = [];
  const walk = (d: string): void => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name === "mutation-report.json" && p.replace(/\\/g, "/").includes("reports")) {
        matches.push(p);
      }
    }
  };
  walk(dir);
  matches.sort();
  return matches.length ? matches[matches.length - 1] : null;
}

function runStrykerNetInProjectGroups(
  repoDir: string,
  sourceFiles: string[],
  config: MutationConfig,
  startMs: number,
): MutationResult {
  const groups = groupStrykerNetSourceFilesByProject(repoDir, sourceFiles);
  if (!groups.length) {
    return {
      ...EMPTY_RESULT,
      tool: "stryker-net",
      score: 0, // a failed resolution must never present EMPTY_RESULT's passing score (issue #15 class)
      error: "could not resolve any .csproj for the changed C# files; run from explicit --project/project file",
      elapsedMs: Date.now() - startMs,
    };
  }

  const timeoutMs = config.timeoutMs ?? 8 * 60 * 1000;
  let merged: MutationResult = {
    ...EMPTY_RESULT,
    tool: "stryker-net",
    survivingMutants: [],
    elapsedMs: 0,
    error: null,
  };
  const failures: string[] = [];

  for (const { projectDir, files: scopedFiles, testProject } of groups) {
    if (!scopedFiles.length) continue;

    const displayDir = projectDir === repoDir ? "<repo-root>" : relative(repoDir, projectDir);
    // Spawn `dotnet` DIRECTLY (no shell) — a `bash -c` wrapper let git-bash's MSYS mangle the
    // path/glob args on Windows and Stryker.NET crashed before writing a report. The scrub /
    // report-read / cleanup that used to be the `rm -rf … && … | cat` shell parts run here in Node.
    const { args, outputDir } = buildStrykerNetArgs(scopedFiles, testProject);
    const outDir = join(projectDir, outputDir);
    const strykerOutput = join(projectDir, "StrykerOutput");
    // Scrub-FIRST: a crashed prior run's leftover report must never be read by a failed run (the
    // stale-report fail-open class — regression-locked in runner.test.ts for the shell lane).
    rmSync(outDir, { recursive: true, force: true });
    rmSync(strykerOutput, { recursive: true, force: true });
    const dotnetBin = process.platform === "win32" ? "dotnet.exe" : "dotnet";
    const command = `${dotnetBin} ${args.join(" ")}`;
    const result = spawnSync(dotnetBin, args, {
      cwd: projectDir,
      env: {
        ...process.env,
        DOTNET_ROLL_FORWARD: process.env.DOTNET_ROLL_FORWARD || "LatestMajor",
      },
      encoding: "utf8" as const,
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    });
    // Read the report from disk (Stryker's json reporter writes a file, never stdout); freshness is
    // guaranteed by the scrub-first above. Then clean the output dirs (validator artifact-hygiene).
    let reportJson = "";
    const reportPath = findMutationReport(outDir) ?? findMutationReport(strykerOutput);
    if (reportPath) {
      try {
        reportJson = readFileSync(reportPath, "utf8");
      } catch {
        // fall through to the empty-report parse error below (fail-closed)
      }
    }
    rmSync(outDir, { recursive: true, force: true });
    rmSync(strykerOutput, { recursive: true, force: true });
    const parsed = parseOutput(config, reportJson, result.stderr ?? "", scopedFiles);
    const reconciled = reconcileResult(
      parsed,
      {
        exitCode: result.status ?? 1,
        signal: result.signal ?? null,
        spawnError: result.error ? String(result.error) : null,
        stderr: result.stderr ?? "",
      },
      config,
    );

    console.error(
      `[marmorkrebs] ${config.tool}: ${scopedFiles.length} source file(s) in scope for ${displayDir}; running: ${redactSecrets(
        command,
      )}`,
    );

    if (reconciled.error) {
      failures.push(`${displayDir || projectDir}: ${reconciled.error}`);
      continue;
    }

    merged.totalMutants += reconciled.totalMutants;
    merged.killed += reconciled.killed;
    merged.survived += reconciled.survived;
    merged.timeout += reconciled.timeout;
    merged.noCoverage += reconciled.noCoverage;
    merged.ignored += reconciled.ignored;
    merged.survivingMutants.push(
      ...reconciled.survivingMutants.map((m) => ({
        ...m,
        // survivors from a grouped run carry project-relative paths; re-anchor them
        // to the repo root so multi-project reports stay unambiguous
        file: displayDir === "<repo-root>" ? m.file : `${displayDir}/${m.file}`.replace(/\\/g, "/"),
      })),
    );
    merged.error = null;
  }

  // A failed run must never present a passing score, and an all-empty allowed run must present the
  // canonical empty PASS rather than mutationScore's now-0 proved-nothing score (see finalizer).
  const finalized = finalizeStrykerNetGroups(merged, failures);
  finalized.elapsedMs = Date.now() - startMs;
  return finalized;
}

function runStrykerNetInProjectGroupsCrabbox(
  repoDir: string,
  sourceFiles: string[],
  config: MutationConfig,
  remoteDir: string,
  leaseId: string,
  startMs: number,
): MutationResult {
  const groups = groupStrykerNetSourceFilesByProject(repoDir, sourceFiles);
  if (!groups.length) {
    return {
      ...EMPTY_RESULT,
      tool: "stryker-net",
      score: 0, // a failed resolution must never present EMPTY_RESULT's passing score (issue #15 class)
      error: "could not resolve any .csproj for the changed C# files; run from explicit --project/project file",
      elapsedMs: Date.now() - startMs,
    };
  }

  const timeoutMs = config.timeoutMs ?? 8 * 60 * 1000;
  let merged: MutationResult = {
    ...EMPTY_RESULT,
    tool: "stryker-net",
    survivingMutants: [],
    elapsedMs: 0,
    error: null,
  };
  const failures: string[] = [];

  for (const { projectDir, files: scopedFiles, testProject } of groups) {
    if (!scopedFiles.length) continue;

    // The remote workdir lives in a Linux container, so join with POSIX
    // separators regardless of host platform — resolve()/relative() on a
    // Windows host would mint a drive-anchored backslash path here.
    const localRelativeProjectDir = relative(resolve(repoDir), projectDir).replace(/\\/g, "/");
    const displayDir = localRelativeProjectDir === "" ? "<repo-root>" : localRelativeProjectDir;
    const remoteWorkDir =
      localRelativeProjectDir === "" ? remoteDir : `${remoteDir}/${localRelativeProjectDir}`;
    const command = buildStrykerNetCommand(scopedFiles, remoteWorkDir, testProject);
    const result = crabboxExec(leaseId, command, timeoutMs);

    const parsed = parseOutput(config, result.stdout, result.stderr, scopedFiles);
    const reconciled = reconcileResult(
      parsed,
      { exitCode: result.exitCode, signal: null, spawnError: null, stderr: result.stderr },
      config,
    );

    console.error(
      `[marmorkrebs] ${config.tool}: ${scopedFiles.length} source file(s) in scope for ${displayDir}; running: ${redactSecrets(
        command,
      )}`,
    );

    if (reconciled.error) {
      failures.push(`${displayDir || projectDir}: ${reconciled.error}`);
      continue;
    }

    merged.totalMutants += reconciled.totalMutants;
    merged.killed += reconciled.killed;
    merged.survived += reconciled.survived;
    merged.timeout += reconciled.timeout;
    merged.noCoverage += reconciled.noCoverage;
    merged.ignored += reconciled.ignored;
    merged.survivingMutants.push(
      ...reconciled.survivingMutants.map((m) => ({
        ...m,
        file: displayDir === "<repo-root>" ? m.file : `${displayDir}/${m.file}`.replace(/\\/g, "/"),
      })),
    );
    merged.error = null;
  }

  const finalized = finalizeStrykerNetGroups(merged, failures);
  finalized.elapsedMs = Date.now() - startMs;
  return finalized;
}

function groupStrykerNetSourceFilesByProject(
  repoDir: string,
  sourceFiles: string[],
): { projectDir: string; files: string[]; testProject?: string }[] {
  const repoRoot = resolve(repoDir);
  const bucketed = new Map<string, string[]>();

  for (const sourceFile of sourceFiles) {
    const abs = resolve(repoRoot, sourceFile);
    const projectDir = findNearestCsProjDir(repoRoot, abs) ?? repoRoot;
    const scoped = relative(projectDir, abs).replace(/\\/g, "/");
    const finalScoped = scoped.startsWith("..") ? sourceFile : scoped;
    const bucket = bucketed.get(projectDir);
    if (bucket) {
      bucket.push(finalScoped);
    } else {
      bucketed.set(projectDir, [finalScoped]);
    }
  }

  return [...bucketed.entries()].map(([projectDir, files]) => {
    const testProject = findStrykerNetTestProject(repoRoot, projectDir);
    return testProject ? { projectDir, files, testProject } : { projectDir, files };
  });
}

// Multi-project repos keep tests in a sibling csproj; running Stryker.NET from the
// source-project dir without pointing at it aborts with "can't be mutated because no
// test project references it" (issue #14). Find a test csproj that (a) looks like a
// test project (Microsoft.NET.Test.Sdk / IsTestProject / *Test(s) name) and
// (b) ProjectReferences a csproj inside the group's project dir; return it relative
// to the project dir for --test-project. Single-project repos return undefined and
// keep the old invocation.
export function findStrykerNetTestProject(repoRoot: string, projectDir: string): string | undefined {
  const projectCsprojs = new Set<string>();
  const sourceNames: string[] = [];
  for (const entry of readdirSync(projectDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".csproj")) {
      projectCsprojs.add(resolve(projectDir, entry.name));
      sourceNames.push(entry.name.slice(0, -".csproj".length));
    }
  }
  if (!projectCsprojs.size) return undefined;

  // Collect EVERY test project that references the source project, then rank — issue #14 only
  // returned the first in filesystem-walk order, so a repo with both a co-located unit-test project
  // and a distant integration-test project could get the integration one (which references but does
  // not unit-cover the file → `totalMutants: 0`, #28). Rank by name match then directory proximity;
  // walk order is the stable tiebreak (`>` keeps the earlier candidate on an equal score).
  const resolvedRepoRoot = resolve(repoRoot);
  const resolvedProjectDir = resolve(projectDir);
  let best: { path: string; score: TestProjectRank } | undefined;
  for (const candidate of walkCsProjFiles(resolvedRepoRoot)) {
    const candidateDir = dirname(candidate);
    if (candidateDir === resolvedProjectDir) continue;
    let content: string;
    try {
      content = readFileSync(candidate, "utf8");
    } catch {
      continue;
    }
    const looksLikeTests =
      /Microsoft\.NET\.Test\.Sdk|<IsTestProject>\s*true/i.test(content) ||
      /tests?\.csproj$/i.test(candidate);
    if (!looksLikeTests) continue;
    let references = false;
    for (const match of content.matchAll(/<ProjectReference\s+Include\s*=\s*"([^"]+)"/gi)) {
      const referenced = resolve(candidateDir, match[1].replace(/\\/g, "/"));
      if (projectCsprojs.has(referenced)) {
        references = true;
        break;
      }
    }
    if (!references) continue;
    const score = rankTestProjectCandidate(sourceNames, resolvedProjectDir, candidate);
    // Higher name rank wins; equal rank falls to closer proximity; a full tie keeps the earlier
    // walk-order candidate (strict `>` on both), preserving the pre-#28 behavior for single hits.
    if (
      !best ||
      score.nameRank > best.score.nameRank ||
      (score.nameRank === best.score.nameRank && score.proximity > best.score.proximity)
    ) {
      best = { path: candidate, score };
    }
  }
  return best ? relative(projectDir, best.path).replace(/\\/g, "/") : undefined;
}

interface TestProjectRank {
  nameRank: number;
  proximity: number;
}

// Rank a referencing test project by how likely it is to actually COVER the source project (#28),
// with the two signals the issue asks for — name match, then proximity:
//   nameRank — 2: the project NAMES the source (`<Source>`-prefixed with a WHOLE test-suffix token,
//                 e.g. `Core.UnitTest` / `Core.Tests`) — the strongest "this covers the source"
//                 signal; 1: any other referencing test project.
//   proximity — negated path-hop distance from the source project dir; a co-located sibling ranks
//               above a distant tree (e.g. a separate integration-test tree), breaking ties within
//               the same nameRank.
// There is deliberately NO separate "integration" penalty: a distant integration-test project loses
// on proximity to a co-located unit project, and one named `<Source>IntegrationTests` doesn't
// token-match so it stays rank 1 — whereas a substring check on "integration" misfired for repos
// whose own source product or an ancestor dir is integration-named.
function rankTestProjectCandidate(
  sourceNames: string[],
  resolvedProjectDir: string,
  candidatePath: string,
): TestProjectRank {
  const candName = basename(candidatePath).replace(/\.csproj$/i, "").toLowerCase();
  let nameRank = 1;
  for (const src of sourceNames) {
    const s = src.toLowerCase();
    if (!candName.startsWith(s)) continue;
    // The remainder after the source name must be EXACTLY a test-suffix token, not merely contain
    // "test" — otherwise a sibling product's tests match (source `Foo` would rank `FooBar.Tests` as
    // if it covered Foo, because "bartests" contains "test"). Only SEPARATORS are stripped (not
    // digits) so `Core.UnitTest`, `CoreUnitTests`, and `AppTests` qualify, while a numeric-suffixed
    // sibling product like `Foo2` (source `Foo`) keeps its `2` and stays rank 1 (`2tests` ≠ token).
    // Accept both orderings of the unit/test convention: `UnitTest(s)` and the tests-first
    // `Tests.Unit` layout (`Foo.Tests.Unit` → `testsunit`). `testsintegration` stays unmatched, so
    // an integration sibling in the same layout is still only rank 1 (no integration special-casing).
    const suffix = candName.slice(s.length).replace(/[._\-\s]/g, "");
    if (
      suffix === "test" ||
      suffix === "tests" ||
      suffix === "unittest" ||
      suffix === "unittests" ||
      suffix === "testunit" ||
      suffix === "testsunit"
    ) {
      nameRank = 2;
      break;
    }
  }

  const rel = relative(resolvedProjectDir, dirname(candidatePath));
  const hops = rel === "" ? 0 : rel.split(/[\\/]/).filter((seg) => seg.length > 0).length;
  return { nameRank, proximity: -hops };
}

function* walkCsProjFiles(root: string, depth = 0): Generator<string> {
  if (depth > 6) return;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (/^(\.git|node_modules|bin|obj|packages)$/i.test(entry.name)) continue;
      yield* walkCsProjFiles(join(root, entry.name), depth + 1);
    } else if (entry.isFile() && entry.name.endsWith(".csproj")) {
      yield join(root, entry.name);
    }
  }
}

function findNearestCsProjDir(repoRoot: string, filePath: string): string | null {
  const root = resolve(repoRoot);
  let current = dirname(resolve(filePath));
  while (current.startsWith(root)) {
    if (findCsProjInDir(current)) return current;
    const next = dirname(current);
    if (next === current) {
      break;
    }
    current = next;
  }
  return null;
}

function findCsProjInDir(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".csproj")) return entry.name;
  }
  return null;
}

function buildCommand(config: MutationConfig, sourceFiles: string[], workDir: string): string {
  switch (config.tool) {
    case "go-mutesting":
      return buildGoMutestingCommand(sourceFiles, workDir);
    case "stryker":
      return buildStrykerCommand(
        sourceFiles,
        workDir,
        config.testCommand,
        config.excludeMutations,
        config.strykerDryRunTimeoutMinutes,
      );
    case "stryker-net":
      return buildStrykerNetCommand(sourceFiles, workDir);
    case "cargo-mutants":
      return buildCargoMutantsCommand(sourceFiles, workDir);
    case "mutmut":
      // mutmut 3 is config-driven; adapt a pytest test command into its temporary config.
      return buildMutmutCommand(sourceFiles, workDir, config.testCommand);
    case "gomu":
      return buildGomuCommand(sourceFiles, workDir);
    case "stryker-cxx":
      return buildCxxSourceCommand(sourceFiles, workDir, config);
    case "mull":
      return buildCxxSourceCommand(sourceFiles, workDir, config);
    default:
      throw new Error(`Unsupported mutation tool: ${config.tool}`);
  }
}

function parseOutput(
  config: MutationConfig,
  stdout: string,
  stderr: string,
  sourceFiles: string[] = [],
): MutationResult {
  const tool = config.tool;
  switch (tool) {
    case "go-mutesting":
      return parseGoMutesting(stdout + "\n" + stderr, sourceFiles);
    case "gomu":
      // Package-dir runs mutate whole packages; scope scoring to the PR's files.
      return parseGomu(stdout, sourceFiles);
    case "stryker":
      return parseStryker(stdout);
    case "stryker-net":
      // #31: classify equivalent survivors (logging-only, etc.) from the report's own source.
      return parseStrykerNet(stdout, { classifyEquivalent: config.classifyEquivalent });
    case "cargo-mutants":
      // --file scopes files natively; line ranges are honored parser-side.
      return parseCargoMutants(stdout, sourceFiles);
    case "mutmut":
      // mutmut mutates everything under source_paths; scope scoring to the PR's files.
      return parseMutmut(stdout, sourceFiles);
    case "stryker-cxx":
      return parseCxxSource(stdout, tool, config);
    case "mull":
      return parseCxxSource(stdout, tool, config);
    default:
      return { ...EMPTY_RESULT, tool, error: `Unknown tool: ${tool}` };
  }
}

// Mask auth-like values before logging a command line — a user-supplied --test-command /
// --build-command can carry inline tokens, and the command log must not leak them to CI output.
// Keyword-targeted (low false-positive): only redacts values attached to secret-ish keys.
export function redactSecrets(command: string): string {
  return command
    .replace(
      /(--?(?:token|password|passwd|secret|api[-_]?key|access[-_]?key|auth[-_]?token|pat)[=:\s]+)("[^"]*"|'[^']*'|\S+)/gi,
      "$1***",
    )
    .replace(/(Authorization:\s*Bearer\s+)[^\s'"]+/gi, "$1***")
    .replace(/([?&](?:token|key|password|secret|sig)=)[^&\s'"]+/gi, "$1***");
}

export function filterSourceFiles(files: string[], tool: MutationTool): string[] {
  const extensions = sourceExtensions(tool);
  return files.filter((file) => {
    // Strip a trailing line-range (e.g. "index.ts:1-388" / "index.ts:42") before the checks so
    // focused mutation on PR-touched lines passes the filter. Pass the ORIGINAL case to isTestFile
    // so it can use CamelCase (capital-T) detection for *Tests/ dirs and *Tests.cs files.
    const stripped = file.replace(/:\d+(?:-\d+)?$/, "");
    const lower = stripped.toLowerCase();
    if (isTestFile(stripped)) return false;
    return extensions.some((ext) => lower.endsWith(ext));
  });
}

function sourceExtensions(tool: MutationTool): string[] {
  switch (tool) {
    case "go-mutesting":
    case "gomu":
      return [".go"];
    case "stryker":
      return [".ts", ".tsx", ".js", ".jsx"];
    case "stryker-net":
      return [".cs"];
    case "cargo-mutants":
      return [".rs"];
    case "mutmut":
      return [".py"];
    case "stryker-cxx":
    case "mull":
      return [".cpp", ".cc", ".cxx", ".c", ".mm", ".m", ".h", ".hpp", ".metal"];
    default:
      return [];
  }
}

function isTestFile(file: string): boolean {
  const lower = file.toLowerCase();
  if (
    lower.includes("/fixtures/") ||
    lower.startsWith("fixtures/") ||
    lower.includes("_test.") ||
    lower.includes(".test.") ||
    lower.includes(".spec.") ||
    lower.includes("/test/") ||
    lower.includes("/tests/") ||
    lower.includes("/__tests__/") ||
    lower.endsWith("_test.go")
  ) {
    return true;
  }
  // CamelCase test conventions common in .NET (and elsewhere): a *Tests/ or *Test/ project dir
  // (e.g. DS4WindowsTests/, Foo.Tests/), or a *Tests.cs / *Test.cs source file (WidgetTest.cs).
  // Matched CASE-SENSITIVELY (require a capital T) so "latest.cs" / "greatest/…" / "Contest.cs"
  // are NOT misread as tests — a false positive here silently drops real source from mutation.
  if (/(?:^|\/)[A-Za-z0-9_.]*Tests?\//.test(file)) return true;
  // Allow the *Tests/*Test token to be preceded by start, "/", or "." so dotted basenames like
  // Foo.Tests.cs and Foo.BarTests.cs are caught, not just CamelCase WidgetTest.cs.
  if (/(?:^|[/.])[A-Za-z0-9_]*Tests?\.(?:cs|fs|vb)$/.test(file)) return true;
  return false;
}
