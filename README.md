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
| `mull` | C++/ObjC++ (optional; use when you want the Mull path) |

Each tool has a parser (`src/parsers/`) that normalizes its output into a common `MutationReport` (killed / survived / timeout / no-coverage / ignored counts, plus score).

### C++ / ObjC++ / Metal

Marmorkrebs delegates C++/ObjC++/Metal mutation to external engines.

Use `--tool stryker-cxx` as the canonical path for C++/ObjC++/Metal. It validates the unmodified project, runs scoped mutants, and normalizes native outcomes (`KILLED`, `SURVIVED`, `BUILD_ERROR`, `CHECK_ERROR`, `NO_COVERAGE`, `TIMEOUT`, `IGNORED`, `RUNTIME_ERROR`) to Marmorkrebs' common result shape.

For C++-only workflows where you prefer the lighter command path, `--tool mull` is available and automatically falls back to `stryker-cxx` when `mull` is not available.

`--build-command` is required for `stryker-cxx` (along with `--test-command`) unless using `--build-system`. The test command must pass on the unmutated checkout unless you deliberately pass `--skip-initial-test`.

`--tool mull` invokes `mull` from `PATH` by default and automatically falls back to `stryker-cxx` if `mull` is not available. Use `--mull-bin <path>` or `MULL_CXX_BIN` to pin the executable.

`--tool stryker-cxx` invokes `stryker-cxx` from `PATH` by default. Use `--stryker-cxx-bin <path>` or `STRYKER_CXX_BIN` when Marmorkrebs should call a specific checkout or installed binary. Local and PR flows use `--tool stryker-cxx` as the standard path for C++/ObjC++/Metal; `--tool mull` is supported as an optional C++-only alternative.

Marmorkrebs forwards `stryker-cxx` artifact backend selectors without
renaming them. Use `--artifact-backend compiled-executable|compiled-library|compiled-object`
for native compiled-artifact execution when the selected `stryker-cxx` binary
supports it. `compiled-executable` supports CMake/CTest and simple
Make/Ninja/Meson/Bazel/Xcode executable targets; Bazel requires an explicit
`--build-target` label and `--test-binary` artifact path, and Xcode requires
`--test-binary` plus either `--build-target` or `--xcode-scheme`.
`compiled-library` supports CMake/CTest, explicit Make/Ninja/Meson
`lib<target>` artifacts, and Bazel/Xcode libraries when `--artifact-path` names
the original library to swap/restore. `compiled-object` supports CMake/CTest
and explicit Make/Ninja/Meson/Bazel targets when `--artifact-path` names the
linked artifact and the selected build emits `compile_commands.json`; Xcode
object support remains provider-blocked. Use
`--artifact-fallback source-overlay` when unsupported projects should downgrade
explicitly instead of failing preflight.

File-scope syntax such as `src/foo.cpp:123` is normalized for the engine as
`--lines 123`, and forwarded as global ranges so C++ scope stays tight to the
actual PR-touched lines.

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
- `--since <ref>` — Stryker-style alias for `--base <ref>` when using
  `stryker-cxx`; useful when review docs mirror Stryker/Stryker.NET terminology.
- `--changed-files` — or pass the file list explicitly
- `--test-command <cmd>` — override the tool-default test command
- `--build-command <cmd>` — build run between mutants (**required** for `stryker-cxx`)
- `--check-command <cmd>` — optional compile/type-check phase run before tests for each C++ mutant
- `--skip-tests` — run `stryker-cxx` build/check phases only and mark viable mutants as survivors
- `--coverage-file <path>` / `--coverage-analysis <off|all|perTest|perTestInIsolation>` / `--coverage-provider <id>` / `--coverage-test-command-template <cmd>` / `--coverage-helper-command-template <cmd>` / `--coverage-helper-tests <tests>` — forward coverage data so `stryker-cxx` can mark uncovered mutants as `NO_COVERAGE`; when coverage includes covering tests or helper-generated per-test coverage and the selected mode supports it, select per-mutant test commands
- `--incremental`, `--baseline-file <path>`, `--baseline-max-age-days <n>`, `--baseline-branch <name>`, `--write-baseline <path>`, `--clear-baseline` — forward baseline-cache and reuse-policy controls to `stryker-cxx`
- `--artifact-backend <source-overlay|compiled-executable|compiled-library|compiled-object>` / `--artifact-path <path>` / `--artifact-fallback <none|source-overlay>` — forward `stryker-cxx` artifact backend selection. Marmorkrebs does not emulate compiled artifacts; it preserves the provider's requested/actual backend and fallback evidence in normalized output.
- `--batch-mutants`, `--batch-size <n>`, `--worktree-mode <inplace|copy|git-worktree>` — forward opt-in batching controls to `stryker-cxx`; batching uses conservative proximity/source-structure heuristics, and backend-specific constraints are enforced by the selected `stryker-cxx` binary
- `--retain-worktrees`, `--retain-worktrees-for <statuses>`,
  `--retained-worktree-ttl-hours <n>`, `--worker-tmp-dir <path>`,
  `--worker-label <label>`,
  `--env <KEY=VALUE,...>`, `--env-inherit <KEY,...>`,
  `--env-block <KEY,...>`, `--dashboard-version <v>`,
  `--dashboard-retention-days <n>`, `--dashboard-auth-token-env <KEY>`,
  `--dashboard-auth-header <name>` — forward debug worktree retention,
  per-status retention policy, retained-worker cleanup TTL, worker temp-root and
  worker label,
  explicit env injection, inherited-env allow/block controls, and dashboard
  policy metadata to `stryker-cxx`; provider reports keep env keys and
  redaction metadata, not explicit env values, and Marmorkrebs preserves
  `resourceIsolation` evidence metadata in the normalized result; use `copy` or
  `git-worktree` mode when retaining workers
- `--build-system <cmake|ctest|ninja|make|meson|bazel|xcodebuild>` plus `--build-dir`, `--build-target`, `--xcode-workspace`, `--xcode-project`, `--xcode-scheme`, `--xcode-configuration`, `--xcode-sdk`, `--xcode-destination`, `--check-system <clang|clang++|clang-tidy|cppcheck>`, `--check-args <args>`, `--test-target`, `--test-filter` — let `stryker-cxx` synthesize common build/check/test commands
- `--test-framework <gtest|catch2|doctest|xctest>`, `--test-binary`,
  `--xctest-bundle`, `--xctest-destination`,
  `--xctest-only-testing`, `--xctest-skip-testing` — let `stryker-cxx`
  synthesize framework-specific test commands; for gtest/catch2/doctest,
  `--test-binary` is optional when exactly one repo-local test executable is
  discoverable, and XCTest destination/only/skip controls use the
  `xcodebuild test-without-building` path
- `--plugin`, `--plugin-dir`, `--reporter` — forward local plugin manifests, provider hooks, and reporter selection to `stryker-cxx`
- `--mutation-level <Basic|Standard|Advanced|Complete>` — forward Stryker-style
  default mutator breadth to `stryker-cxx`; explicit `--mutators` remains the
  exact PR-scope override.
- `--ignore-mutations <names>` — forward Stryker-style mutator-family ignores;
  matching provider mutants stay visible as `IGNORED`.
- `--parity-profile <summary|review|strict>` — enforce the preserved
  `stryker-cxx` eight-gap parity metadata in Marmorkrebs; `review` fails
  missing/unknown evidence and `strict` also fails partial evidence.
- `--dashboard-export`, `--dashboard-upload-url`, `--dashboard-upload-retries`, `--dashboard-upload-retry-delay-ms`, `--dashboard-project`, `--dashboard-branch`, `--dashboard-commit`, `--dashboard-build-url` — forward dashboard export/upload, retry policy, and CI provenance controls to `stryker-cxx`
- `--execution-mode <source-overlay|mutant-switch>` / `--execution-backend <auto|source-overlay|mutant-switch|compiled-artifact|llvm-switch>` — forward the native
  `stryker-cxx` execution model/backend selectors and preserve provider fallback
  evidence in the normalized result
- `--equivalent-suppression <off|conservative|aggressive>` — forward native
  equivalent/noise suppression mode; use `off` for raw proof runs
- `--stryker-cxx-bin <path>` — use a specific `stryker-cxx` binary
- `--mull-bin <path>` — use a specific `mull` binary for `--tool mull`
- `--threshold <0-1>` — compatibility alias for the `stryker-cxx` break threshold
- `--threshold-high <0-1>`, `--threshold-low <0-1>`, `--threshold-break <0-1>` — forward Stryker-style score bands to `stryker-cxx`
- `--timeout <ms>` — mutation run timeout (default 480000)
- `--timeout-factor <n>`, `--timeout-constant-ms <n>` — forward dry-run-derived timeout calibration to `stryker-cxx`
- `--distribution-manifest <path>` — forward `stryker-cxx` shard/worker manifest output for CI artifacts and proof bundles
- `--skip-initial-test` — skip the unmutated build/test validation for advanced or legacy flows
- `--dry-run-only` — validate build/test commands and emit the lifecycle report without executing mutants

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
npm run validate:stryker-cxx-provider
```

Node >= 20. `test-fixtures/` holds real captured outputs from each mutation tool that the parser tests assert against.
The `validate:stryker-cxx-provider` target runs the normal Marmorkrebs checks and
smokes the standalone `stryker-cxx` provider when `stryker-cxx` is available on
`PATH` or `STRYKER_CXX_BIN` points at a local checkout/binary.
Security reporting for provider credentials, crabbox/local proof paths, and
artifact upload behavior is documented in [`SECURITY.md`](SECURITY.md).

## Example: focused Stryker on a PR

```
marmorkrebs --repo openclaw/openclaw --pr 12345 --tool stryker \
  --threshold-break 0.6 --provider local-container --image deps-base
```

## Local and PR usage

Marmorkrebs can run before a pull request exists. See [docs/local-vs-pr-usage.md](docs/local-vs-pr-usage.md) for the local `--base` flow, manual changed-file flow, PR flow, and C++/Metal mutation controls.

## Stryker C++ mutation tool spec

Marmorkrebs uses `stryker-cxx` as the C++ provider. PR skills and new profiles should use `--tool stryker-cxx`; embedded C++ mutation is historical and not the supported gate path. Marmorkrebs preserves native provider evidence including mutation level, enabled mutators, execution backend fallback, source precision, coverage, baseline, scheduler, compile pruning, reporter/dashboard metadata, lifecycle, artifact placement, build graph, and `parity` / `execution.parity` eight-gap Mull/Stryker.NET metadata. Use `--parity-profile review` or `--parity-profile strict` when a review should fail on incomplete parity evidence. See [docs/stryker-cxx-spec.md](docs/stryker-cxx-spec.md) for the standalone CLI, report schema, milestones, and Marmorkrebs adapter plan.
