import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

export function runMutationAnalysis(
  repoDir: string,
  changedFiles: string[],
  config: MutationConfig,
): MutationResult {
  if (!changedFiles.length) return { ...EMPTY_RESULT, tool: config.tool };

  const sourceFiles = filterSourceFiles(changedFiles, config.tool);
  if (!sourceFiles.length) return { ...EMPTY_RESULT, tool: config.tool };

  const startMs = Date.now();

  if (config.leaseId) {
    return runOnExistingLease(repoDir, sourceFiles, config, config.leaseId, startMs);
  }
  if (config.crabbox) {
    return runInCrabbox(repoDir, sourceFiles, config, startMs);
  }
  return runLocally(repoDir, sourceFiles, config, startMs);
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
    return { ...parsed, elapsedMs: Date.now() - startMs };
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
    return { ...parsed, elapsedMs: Date.now() - startMs };
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
    return { ...parsed, elapsedMs: Date.now() - startMs };
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
      return buildStrykerCommand(sourceFiles, workDir, config.testCommand);
    case "stryker-net":
      return buildStrykerNetCommand(sourceFiles, workDir);
    case "cargo-mutants":
      return buildCargoMutantsCommand(sourceFiles, workDir);
    case "mutmut":
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
      return parseGoMutesting(stdout + "\n" + stderr);
    case "gomu":
      // Package-dir runs mutate whole packages; scope scoring to the PR's files.
      return parseGomu(stdout, sourceFiles);
    case "stryker":
      return parseStryker(stdout);
    case "stryker-net":
      return parseStrykerNet(stdout);
    case "cargo-mutants":
      return parseCargoMutants(stdout);
    case "mutmut":
      return parseMutmut(stdout);
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
    file.includes("_test.") ||
    file.includes(".test.") ||
    file.includes(".spec.") ||
    file.includes("/test/") ||
    file.includes("/tests/") ||
    file.includes("/__tests__/") ||
    file.endsWith("_test.go")
  );
}
