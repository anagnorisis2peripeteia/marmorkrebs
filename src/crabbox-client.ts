import { spawnSync } from "node:child_process";
import type { CrabboxLease, CrabboxLeaseOptions, CrabboxRunResult } from "./types.js";

function crabboxBin(): string {
  return process.env.CRABBOX_BIN ?? "crabbox";
}

function crabboxEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
}

export function crabboxProvision(options: CrabboxLeaseOptions): CrabboxLease {
  const args = ["run", "--provider", options.provider, "--no-exec"];
  if (options.image) args.push("--image", options.image);
  if (options.cpus) args.push("--cpu", String(options.cpus));
  if (options.memory) args.push("--memory", String(options.memory));
  if (options.disk) args.push("--disk", String(options.disk));
  if (options.targetOS) args.push("--target", options.targetOS);

  const result = spawnSync(crabboxBin(), args, {
    encoding: "utf8",
    env: crabboxEnv(),
    timeout: 5 * 60 * 1000,
  });

  if (result.status !== 0) {
    throw new Error(
      `crabbox provision failed (exit ${result.status}): ${result.stderr || result.stdout || "no output"}`,
    );
  }

  const idMatch = result.stdout.match(/lease=(\S+)/);
  if (!idMatch) {
    throw new Error(
      `crabbox provision succeeded but could not extract lease ID from output: ${result.stdout}`,
    );
  }

  return { id: idMatch[1], provider: options.provider };
}

export function crabboxExec(
  leaseId: string,
  command: string,
  timeoutMs = 10 * 60 * 1000,
): CrabboxRunResult {
  const result = spawnSync(crabboxBin(), ["ssh", "--id", leaseId, "--", "bash", "-c", command], {
    encoding: "utf8",
    env: crabboxEnv(),
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });

  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status ?? 1,
  };
}

export function crabboxSync(
  leaseId: string,
  localDir: string,
  remoteDir: string,
  timeoutMs = 5 * 60 * 1000,
): void {
  const result = spawnSync(
    crabboxBin(),
    ["cache", "--id", leaseId, "--push", localDir, "--to", remoteDir],
    {
      encoding: "utf8",
      env: crabboxEnv(),
      timeout: timeoutMs,
    },
  );

  if (result.status !== 0) {
    throw new Error(
      `crabbox sync failed (exit ${result.status}): ${result.stderr || result.stdout || "no output"}`,
    );
  }
}

export function crabboxStop(leaseId: string): void {
  spawnSync(crabboxBin(), ["stop", "--id", leaseId], {
    encoding: "utf8",
    env: crabboxEnv(),
    timeout: 60 * 1000,
  });
}

export function crabboxCleanup(leaseId: string): void {
  spawnSync(crabboxBin(), ["cleanup", "--id", leaseId], {
    encoding: "utf8",
    env: crabboxEnv(),
    timeout: 60 * 1000,
  });
}
