import { afterEach, beforeEach, describe, it } from "node:test";

// The fake crabbox is a POSIX shell script: Node cannot spawnSync a shebang file on
// Windows (and refuses .cmd/.bat without shell since the EINVAL hardening), so these
// suites skip there EXPLICITLY. The client code under test is platform-neutral
// spawnSync plumbing; only the test double is POSIX-bound.
const POSIX_ONLY = { skip: process.platform === "win32" ? "fake crabbox needs POSIX exec" : false };
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  crabboxCleanup,
  crabboxExec,
  crabboxProvision,
  crabboxStop,
  crabboxSync,
} from "./crabbox-client.js";

// Fake crabbox binary driven by FAKE_CRABBOX_MODE; appends every invocation's
// subcommand to FAKE_CRABBOX_CALLS so lifecycle ordering is assertable.
// `ssh` mode passes the command through to local bash, making the lease paths
// testable end to end without a real crabbox.
const FAKE = `#!/bin/bash
echo "$1" >> "$FAKE_CRABBOX_CALLS"
case "$FAKE_CRABBOX_MODE:$1" in
  provision-ok:run)   echo "provisioned lease=fake-lease-42 ready"; exit 0 ;;
  provision-noid:run) echo "provisioned but no id here"; exit 0 ;;
  provision-fail:run) echo "quota exceeded" >&2; exit 1 ;;
  *:ssh)
    # argv: ssh --id <id> -- bash -c <command>  -> the command is $7
    shift 6
    exec bash -c "$1" ;;
  sync-fail:cache) echo "rsync: connection refused" >&2; exit 12 ;;
  *:cache) exit 0 ;;
  *:stop) exit 0 ;;
  *:cleanup) exit 0 ;;
  *) exit 0 ;;
esac
`;

let dir: string;
let calls: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marmorkrebs-fakecrab-"));
  const bin = join(dir, "crabbox");
  writeFileSync(bin, FAKE, { mode: 0o755 });
  calls = join(dir, "calls.log");
  writeFileSync(calls, "");
  process.env.CRABBOX_BIN = bin;
  process.env.FAKE_CRABBOX_CALLS = calls;
});

afterEach(() => {
  delete process.env.CRABBOX_BIN;
  delete process.env.FAKE_CRABBOX_CALLS;
  delete process.env.FAKE_CRABBOX_MODE;
  rmSync(dir, { recursive: true, force: true });
});

function callLog(): string[] {
  return readFileSync(calls, "utf8").split("\n").filter(Boolean);
}

describe("crabboxProvision", POSIX_ONLY, () => {
  it("parses the lease id", () => {
    process.env.FAKE_CRABBOX_MODE = "provision-ok";
    const lease = crabboxProvision({ provider: "tart" });
    assert.equal(lease.id, "fake-lease-42");
  });

  it("throws with exit code and stderr on failure", () => {
    process.env.FAKE_CRABBOX_MODE = "provision-fail";
    assert.throws(() => crabboxProvision({ provider: "tart" }), /exit 1.*quota exceeded/s);
  });

  it("throws when no lease id is present in successful output", () => {
    process.env.FAKE_CRABBOX_MODE = "provision-noid";
    assert.throws(() => crabboxProvision({ provider: "tart" }), /could not extract lease ID/);
  });
});

describe("crabboxExec", POSIX_ONLY, () => {
  it("returns stdout/stderr/exitCode from the remote command", () => {
    process.env.FAKE_CRABBOX_MODE = "exec";
    const r = crabboxExec("fake-lease-42", "echo out; echo err >&2; exit 3");
    assert.equal(r.stdout.trim(), "out");
    assert.equal(r.stderr.trim(), "err");
    assert.equal(r.exitCode, 3);
  });
});

describe("crabboxSync", POSIX_ONLY, () => {
  it("throws with exit code on sync failure", () => {
    process.env.FAKE_CRABBOX_MODE = "sync-fail";
    assert.throws(() => crabboxSync("fake-lease-42", "/a", "/b"), /exit 12.*connection refused/s);
  });
});

describe("stop/cleanup are best-effort", POSIX_ONLY, () => {
  it("record their subcommands", () => {
    process.env.FAKE_CRABBOX_MODE = "exec";
    crabboxStop("fake-lease-42");
    crabboxCleanup("fake-lease-42");
    assert.deepEqual(callLog(), ["stop", "cleanup"]);
  });
});
