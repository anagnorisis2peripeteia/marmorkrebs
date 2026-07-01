# Local vs PR usage

Marmorkrebs does not require an open pull request. It has three scoping modes, and the local mode is the one to use for pre-PR gates, staged branches, and ClawSweeper-style local review loops.

## Pre-PR local gate

Use `--dir` with `--base` when the work exists only in a local checkout:

```bash
marmorkrebs \
  --dir /path/to/repo \
  --tool stryker \
  --base origin/main \
  --threshold 0.6
```

`--base <ref>` derives the candidate set from the local git diff. That includes commits on the current branch since the merge base, plus staged, unstaged, and untracked files. This is the closest Marmorkrebs equivalent to ClawSweeper's local-range flow: it can run before a PR exists and before anything is pushed.

Use this mode when:

- The branch is still private or local-only.
- You want to gate work before opening a PR.
- You are iterating with ClawSweeper local review and want mutation proof over the same changed surface.
- The public repo does not yet have a PR number.

For fork-based repos, choose the same base ref the PR will target, for example `upstream/main`. For same-remote repos, `origin/main` is usually correct.

## Manual changed-file scope

Use `--changed-files` when another tool has already selected the files to mutate:

```bash
marmorkrebs \
  --dir /path/to/repo \
  --tool stryker \
  --changed-files src/foo.ts,src/bar.ts
```

This is narrower than `--base` and is useful for scripted handoff, but it does not infer branch commits or dirty-tree state by itself.

## Open PR mode

Use `--repo` and `--pr` only after a PR exists:

```bash
marmorkrebs \
  --repo owner/repo \
  --pr 123 \
  --tool stryker \
  --threshold 0.6
```

This mode fetches the PR diff from GitHub and is useful for public PR validation, review-bot follow-up, or reproducing a maintainer-visible mutation gate. It is not required for the local gate.

## C++ / ObjC++ / Metal flow

`stryker-cxx` is the canonical path for C++/ObjC++/Metal. It validates the
unmodified checkout first, so `--test-command` must pass before any mutants are
executed. Use `--tool mull` only for C++-only runs.

This is the supported C++ gate path for both local and PR-based workflows in
this repo. For Metal-enabled projects, use `--tool stryker-cxx`.
Add `--distribution-manifest <path>` when a CI or proof flow needs to archive
the exact selected shard, worker label, redacted commands, and mutant IDs that
`stryker-cxx` executed.

```bash
marmorkrebs \
  --dir /path/to/repo \
  --tool stryker-cxx \
  --base origin/main \
  --build-command "ninja -C build target" \
  --check-command "clang++ -fsyntax-only src/foo.cpp" \
  --test-command "./build/bin/target_test" \
  --max-mutants 25
```

Use a specific `mull` or `stryker-cxx` binary by adding:

```bash
--mull-bin /usr/local/bin/mull-cxx
--stryker-cxx-bin /usr/local/bin/stryker-cxx
```

If `--mull-bin` (or `MULL_CXX_BIN`) is set, Marmorkrebs uses that C++-only
binary. For Metal-capable invocation, use `--tool stryker-cxx` and
`--stryker-cxx-bin`.

Marmorkrebs forwards compiled artifact selectors directly to `stryker-cxx`.
Use them only when the selected `stryker-cxx` binary supports the requested
backend. `compiled-library` supports CMake/CTest plus explicit Make/Ninja/Meson
library targets when an original `lib<target>` artifact already exists.
`compiled-object` supports CMake/CTest and explicit Make/Ninja/Meson/Bazel
targets when `--artifact-path` names the linked artifact and the selected build
emits `compile_commands.json`; Xcode object support remains provider-blocked.

```bash
--artifact-backend compiled-object --artifact-fallback source-overlay
```

Optional controls:

- `--max-mutants <n>` caps the number of generated mutants for a run.
- `--lines` is automatically forwarded from file-range inputs such as
  `src/foo.cpp:123`; this keeps the command focused on touched lines rather than
  whole files where possible.
- `--include-metal` includes `.metal` files in the C++ source mutation pass.
- `--mutators <names>` restricts the engine to a comma-separated mutator list.
- `--mode clang-ast` asks `stryker-cxx` to generate candidates from libclang cursor ranges before rewriting source.
- `--execution-mode <source-overlay|mutant-switch>` forwards the native
  `stryker-cxx` execution model selector. Use `mutant-switch` when the selected
  provider can build guarded artifacts; fallback evidence remains available in
  the normalized provider metadata.
- `--equivalent-suppression <off|conservative|aggressive>` forwards native
  equivalent/noise suppression; use `off` when proof requires every discovered
  mutant to execute.
- `--check-command <cmd>` runs an additional compile/type-check phase before tests.
- `--skip-tests` runs build/check only and treats viable mutants as survivors.
- `--coverage-file <path>` supplies simple JSON, `llvm-cov export` JSON, or LCOV data so uncovered mutants are reported as `NO_COVERAGE`; with JSON `coveredTests`/`testsByLine` data or helper-generated per-test coverage from `--coverage-helper-command-template <cmd>` plus `--coverage-helper-tests <tests>`, `--coverage-test-command-template <cmd>` can select per-mutant test commands via `{tests}`, `{tests_csv}`, `{tests_space}`, or `{first_test}`.
- `--incremental` with `--baseline-file <path>` reuses compatible previous mutant results; add `--baseline-max-age-days <n>` and `--baseline-branch <name>` when cache reuse must be bounded by freshness or branch lifecycle.
- `--batch-mutants --batch-size <n>` batches compatible mutants in isolated worktrees and splits failed batches for attribution.
- `--worktree-mode <copy|git-worktree>` selects isolated worker mode for batching or retained debug workers.
- `--artifact-backend <source-overlay|compiled-executable|compiled-library|compiled-object>` selects the native `stryker-cxx` artifact backend. `compiled-executable` supports CMake/CTest and simple Make/Ninja/Meson/Bazel/Xcode executable targets; Bazel requires an explicit `--build-target` label and `--test-binary` artifact path, and Xcode requires `--test-binary` plus either `--build-target` or `--xcode-scheme`. `compiled-library` supports CMake/CTest, explicit Make/Ninja/Meson `lib<target>` artifacts, and Bazel/Xcode libraries when `--artifact-path` names the original artifact to swap/restore. `compiled-object` supports CMake/CTest and explicit Make/Ninja/Meson/Bazel targets when `--artifact-path` names the linked artifact and the build emits `compile_commands.json`; Xcode object support remains provider-blocked. Marmorkrebs forwards the flags and lets the provider preflight unsupported build systems.
- `--artifact-fallback <none|source-overlay>` forwards the provider fallback policy; when fallback is used, normalized `provider` metadata preserves the requested backend, actual backend, and fallback reason.
- `--build-system <name>` lets `stryker-cxx` synthesize CMake/CTest/Ninja/Make/Meson/Bazel build/test commands when explicit commands are not supplied; `--check-system <clang-tidy|cppcheck>` plus `--check-args <args>` can synthesize common static-check commands.
- `--test-framework <name>` with optional `--test-binary` lets `stryker-cxx` synthesize GoogleTest, Catch2, doctest, or XCTest commands; gtest/catch2/doctest can discover one repo-local test executable automatically, while XCTest still needs a bundle/binary.
- `--plugin`, `--plugin-dir`, and `--reporter` forward local `stryker-cxx` plugin manifests, provider hooks, and reporter requests.
- `--retain-worktrees`, `--retain-worktrees-for <statuses>`,
  `--retained-worktree-ttl-hours <n>`, `--worker-tmp-dir <path>`, and
  `--env <KEY=VALUE,...>` forward resource/debug controls to `stryker-cxx` for
  retained isolated workers and explicit build/check/test environment injection;
  add `--env-inherit <KEY,...>` or `--env-block <KEY,...>` when inherited
  process environment needs an explicit allow/deny policy. Retained workers
  should use `copy` or `git-worktree` mode.
- `--dashboard-export` writes a compact dashboard payload; `--dashboard-upload-url` posts it only to the explicit URL supplied by the caller. Add `--dashboard-upload-retries` and `--dashboard-upload-retry-delay-ms` when hosted dashboard uploads should record retry-attempt metadata.
- `--threshold-high`, `--threshold-low`, and `--threshold-break` forward Stryker-style score bands.
- `--skip-initial-test` is available for legacy/debug flows, but PR gates should normally keep the dry run enabled.
- `--dry-run-only` validates the build/test lifecycle without executing mutants.

Use `--include-metal` only when the test command actually exercises the shader path. Otherwise the run will spend time creating mutants the selected tests cannot kill.

## Output contract

A successful run exits zero and writes a `MutationResult` JSON object to stdout. Important fields are:

- `score`: mutation score for the scoped run.
- `thresholds`: optional `stryker-cxx` high/low/break band result.
- `dryRun`: optional `stryker-cxx` initial build/test validation result.
- `baseline`: optional `stryker-cxx` cache hit/miss/write metadata.
- `provider`: optional provider-native metadata from `stryker-cxx.report.v1`,
  including execution mode, requested/actual artifact backend, fallback reason,
  scheduler, lifecycle, artifact placement, mutant-switch, and project-analysis
  evidence when present.
- `totalMutants`: number of mutants reported for the scoped run.
- `ignored`: mutants suppressed by Stryker-style ignore comments and excluded from score.
- `noCoverage`: mutants skipped because supplied coverage data did not cover their line, plus legacy non-viable C++ counts normalized into Marmorkrebs' common shape.
- `survivingMutants`: mutants not killed by the selected tests.

For PR gates, treat `totalMutants: 0` as vacuous proof rather than strong evidence. Also treat `totalMutants - ignored == 0` as no scored mutation proof. A survivor is a signal that the test plan may not cover the behavior being changed. A failed `dryRun` is an infrastructure/test-selection error, not a mutation pass.

## Relationship to ClawSweeper and local Mantis

ClawSweeper decides whether the review needs real-behavior proof and may emit a Mantis recommendation. Local Mantis records the user-visible proof. Marmorkrebs is separate: it checks whether the tests can kill behavior-changing mutations in the changed code.

A typical local pre-push sequence is:

1. Run the repo's normal checks.
2. Run ClawSweeper local review over the local range.
3. If ClawSweeper asks for real-behavior proof, run local Mantis/proofrig for that scenario.
4. Run Marmorkrebs with `--base <target-ref>` on the same checkout.
5. Push only after the docs, proof, review body, and mutation result describe the same final HEAD.
