# marmorkrebs

PR-scoped mutation testing, optionally executed inside [crabbox](https://github.com/openclaw/crabbox) sandboxes.

Instead of mutation-testing a whole repo (slow, noisy), marmorkrebs focuses the mutation run on **the lines a PR actually touched**, then reports a mutation score for exactly that surface. Use it as a PR proof step: "the new tests kill N/M mutants on the changed lines."

> Named after the marbled crayfish — a mutant crustacean that took over the world. Sibling tooling to crabbox in the proof ecosystem.

## Supported mutation tools

| Tool | Ecosystem |
|---|---|
| `stryker` | JS/TS (Stryker) |
| `stryker-net` | C# / .NET (Stryker.NET) |
| `mutmut` | Python |
| `cargo-mutants` | Rust |
| `go-mutesting` | Go |
| `gomu` | Go |
| `stryker-cxx` | C++/ObjC++/Metal |
| `cxx-source` | C++/ObjC++ legacy embedded fallback |

Each tool has a parser (`src/parsers/`) that normalizes its output into a common `MutationReport` (killed / survived / timeout / no-coverage / ignored counts, plus score).

### `stryker-cxx` (C++/ObjC++/Metal)

Marmorkrebs treats C++ as an external Stryker-style tool. `stryker-cxx` applies source-level operators to one source token or statement at a time, then for each non-ignored mutant recompiles the project (via `--build-command`) and re-runs a targeted test command (`--test-command`). Native statuses such as `KILLED`, `SURVIVED`, `BUILD_ERROR`, `TIMEOUT`, and `IGNORED` are normalized into Marmorkrebs' common result shape.

`mull` (LLVM-bitcode mutation) is not used because it needs a self-contained test binary to toggle mutants in. This engine instead recompiles per mutant, which fits projects built as a single library and driven by an external test runner. Because each mutant triggers a full rebuild, scope the run tightly — `--base <ref>` restricts it to the lines a PR changed.

`--build-command` is **required** for `stryker-cxx` (along with `--test-command`).

`--tool stryker-cxx` invokes `stryker-cxx` from `PATH` by default. Use `--stryker-cxx-bin <path>` or `STRYKER_CXX_BIN` when Marmorkrebs should call a specific checkout or installed binary. The old `--tool cxx-source` path remains as an embedded fallback for existing local scripts.

```
marmorkrebs --dir <path> --tool stryker-cxx --base <ref> \
  --build-command '<compile>' --test-command '<targeted tests>'
```

## Usage

```
marmorkrebs --dir <path> --tool <tool> --changed-files <file,...> [options]
marmorkrebs --dir <path> --tool <tool> --base <ref> [options]
marmorkrebs --repo <owner/repo> --pr <number> --tool <tool> [options]
```

Key options:

- `--repo` + `--pr` — derive the changed-file list from a GitHub PR (requires `gh` CLI)
- `--base <ref>` — derive it from the **local git diff** vs `<ref>`: branch commits since the merge-base, plus staged/unstaged edits and untracked files. This is the mode for locally staged PRs — review-grade mutation testing before anything is pushed.
- `--changed-files` — or pass the file list explicitly
- `--test-command <cmd>` — override the tool-default test command
- `--build-command <cmd>` — build run between mutants (**required** for `stryker-cxx`)
- `--stryker-cxx-bin <path>` — use a specific `stryker-cxx` binary
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

## Local and PR usage

Marmorkrebs can run before a pull request exists. See [docs/local-vs-pr-usage.md](docs/local-vs-pr-usage.md) for the local `--base` flow, manual changed-file flow, PR flow, and C++/Metal mutation controls.

## Stryker C++ mutation tool spec

Marmorkrebs uses `stryker-cxx` as the C++ provider. See [docs/stryker-cxx-spec.md](docs/stryker-cxx-spec.md) for the standalone CLI, report schema, milestones, and Marmorkrebs adapter plan.
