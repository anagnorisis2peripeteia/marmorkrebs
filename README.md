# marmorkrebs

PR-scoped mutation testing, optionally executed inside [crabbox](https://github.com/openclaw/crabbox) sandboxes.

Instead of mutation-testing a whole repo (slow, noisy), marmorkrebs focuses the mutation run on **the lines a PR actually touched**, then reports a mutation score for exactly that surface. Use it as a PR proof step: "the new tests kill N/M mutants on the changed lines."

> Named after the marbled crayfish — a mutant crustacean that took over the world. Sibling tooling to crabbox/ClawSweeper/mantis in the openclaw proof ecosystem.

## Supported mutation tools

| Tool | Ecosystem |
|---|---|
| `stryker` | JS/TS (Stryker) |
| `mutmut` | Python |
| `cargo-mutants` | Rust |
| `go-mutesting` | Go |
| `gomu` | Go |

Each tool has a parser (`src/parsers/`) that normalizes its output into a common `MutationReport` (killed / survived / timeout / no-coverage per mutant, plus score).

## Usage

```
marmorkrebs --dir <path> --tool <tool> --changed-files <file,...> [options]
marmorkrebs --repo <owner/repo> --pr <number> --tool <tool> [options]
```

Key options:

- `--repo` + `--pr` — derive the changed-file list from a GitHub PR (requires `gh` CLI)
- `--changed-files` — or pass the file list explicitly
- `--test-command <cmd>` — override the tool-default test command
- `--threshold <0-1>` — fail the run below a minimum mutation score
- `--timeout <ms>` — mutation run timeout (default 480000)

### Crabbox execution (optional)

Omit all crabbox flags to run locally. To run the mutation suite inside a disposable crabbox lease:

- `--provider <name>` + `--image <image>` (+ `--cpus`, `--memory`) — provision a fresh lease
- `--lease-id <id>` — reuse an existing lease (skips provision + cleanup)
- `--skip-sync` + `--remote-dir <path>` — code already present in the lease

## Build & test

```
npm install
npm run build     # tsc -> dist/
npm test          # node --test against dist
npm run check     # typecheck only
```

Node >= 20. `test-fixtures/` holds real captured outputs from each mutation tool that the parser tests assert against.

## Example: focused Stryker on a PR

```
marmorkrebs --repo openclaw/openclaw --pr 12345 --tool stryker \
  --threshold 0.6 --provider local-container --image deps-base
```
