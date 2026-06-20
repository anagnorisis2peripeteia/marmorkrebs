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
| `cxx-source` | C++/ObjC++ (built-in source engine) |

Each tool has a parser (`src/parsers/`) that normalizes its output into a common `MutationReport` (killed / survived / timeout / no-coverage per mutant, plus score).

### `cxx-source` (built-in C++/ObjC++ engine)

There is no external mutation CLI to drive for C++/ObjC++, so marmorkrebs ships its own source-mutation engine at `engines/cxx-source/marmorkrebs-cxx.py`. It applies Stryker-style operators (conditional-boundary, equality, logical, boolean-literal) to one source token at a time, then for **each** mutant **recompiles** the project (via `--build-command`) and re-runs a targeted test command (`--test-command`), classifying the mutant as KILLED (tests failed — good), SURVIVED (tests still passed — a coverage gap), or BUILD_ERROR (skipped, didn't compile).

`mull` (LLVM-bitcode mutation) is not used because it needs a self-contained test binary to toggle mutants in. This engine instead recompiles per mutant, which fits projects built as a single library and driven by an external test runner. Because each mutant triggers a full rebuild, scope the run tightly — `--base <ref>` restricts it to the lines a PR changed.

`--build-command` is **required** for `cxx-source` (along with `--test-command`).

```
marmorkrebs --dir <path> --tool cxx-source --base <ref> \
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
- `--build-command <cmd>` — build run between mutants (**required** for `cxx-source`)
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
