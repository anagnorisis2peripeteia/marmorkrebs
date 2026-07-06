import { spawnSync } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  if (parsed.error) return parsed;
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
    if (!config.allowEmpty) {
      return {
        ...parsed,
        error:
          "tool produced 0 mutants (exit 0) — refusing to score an empty run as a pass; " +
          "pass --allow-empty if this diff legitimately has nothing to mutate",
      };
    }
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
  const command = buildCommand(config, sourceFiles, repoDir);

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

function buildCommand(config: MutationConfig, sourceFiles: string[], workDir: string): string {
  switch (config.tool) {
    case "go-mutesting":
      return buildGoMutestingCommand(sourceFiles, workDir);
    case "stryker":
      return buildStrykerCommand(sourceFiles, workDir, config.testCommand, config.excludeMutations);
    case "stryker-net":
      return buildStrykerNetCommand(sourceFiles, workDir);
    case "cargo-mutants":
      return buildCargoMutantsCommand(sourceFiles, workDir);
    case "mutmut":
      // mutmut 3 is config-driven (repo [mutmut] section); no per-call test command.
      return buildMutmutCommand(sourceFiles, workDir);
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
      return parseStrykerNet(stdout);
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

function filterSourceFiles(files: string[], tool: MutationTool): string[] {
  const extensions = sourceExtensions(tool);
  return files.filter((file) => {
    // Strip a trailing line-range (e.g. "index.ts:1-388" / "index.ts:42") before the extension
    // check so focused mutation on PR-touched lines passes the filter.
    const lower = file.toLowerCase().replace(/:\d+(?:-\d+)?$/, "");
    if (isTestFile(lower)) return false;
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
  return (
    file.includes("/fixtures/") ||
    file.startsWith("fixtures/") ||
    file.includes("_test.") ||
    file.includes(".test.") ||
    file.includes(".spec.") ||
    file.includes("/test/") ||
    file.includes("/tests/") ||
    file.includes("/__tests__/") ||
    file.endsWith("_test.go")
  );
}
