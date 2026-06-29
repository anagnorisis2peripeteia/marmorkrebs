# stryker-cxx standalone tool spec

## Purpose

`stryker-cxx` is a standalone source-level mutation tester for C, C++,
Objective-C++, and optionally Metal shader sources.

It owns the C++ mutation engine as an independent tool with a stable CLI,
reports, configuration, and release story. Marmorkrebs treats it like other
mutation tools: an external engine with a parser/adapter, not a private
implementation detail.

The tool is intended for PR-sized mutation gates where the caller supplies the
build and test commands. It validates those commands on the unmodified checkout
before executing mutants, then recompiles per mutant. That makes it suitable for
projects that do not expose a single self-contained test binary and where
LLVM-bitcode mutation tools are awkward to integrate.

## Non-goals

`stryker-cxx` is not trying to replace full compiler-integrated mutation systems on day one.

Initial non-goals:

- No requirement for whole-program LLVM instrumentation.
- No automatic test selection beyond changed-line and file scoping.
- No claim that all survivors are non-equivalent.
- No mutation of macros, generated files, vendored code, or shader files unless explicitly enabled.
- No hidden dependency on Marmorkrebs.

## Current embedded engine baseline

The current Marmorkrebs engine already provides the seed implementation:

- Discovers changed lines via `git diff --unified=0 <base>`.
- Restricts to caller-provided files and optional line ranges.
- Generates token-level mutants while skipping comments and string/character literals.
- Applies one source mutation at a time.
- Runs caller-supplied build and test commands.
- Classifies mutants as `KILLED`, `SURVIVED`, or `BUILD_ERROR`.
- Emits JSON with target files, totals, score, and per-mutant records.
- Supports `--max-mutants`, `--include-metal`, and `--mutators`.

That behavior should remain available as the first standalone implementation.

## CLI contract

The first release should expose a small stable command surface.

### `run`

Run mutation testing and emit a report.

```bash
stryker-cxx run \
  --repo . \
  --files src/foo.cpp,src/bar.mm \
  --base origin/main \
  --build-command "ninja -C build target" \
  --test-command "./build/bin/target_test" \
  --report mutation.json
```

Required options:

- `--repo <path>`: repository root.
- `--files <paths>`: comma-separated repo-relative source paths.
- `--build-command <cmd>`: command that rebuilds the mutated artifact.
- `--test-command <cmd>`: command whose non-zero exit kills a mutant.

Scoping options:

- `--base <ref>`: restrict to changed lines versus a git ref.
- `--lines <ranges>`: further restrict to line ranges such as `10-20,40`.
- `--include <glob>`: include source paths matching a glob.
- `--exclude <glob>`: exclude source paths matching a glob.

Mutation options:

- `--mutators <names>`: comma-separated mutator list.
- `--max-mutants <n>`: cap generated mutants.
- `--include-metal`: include `.metal` files in token-level mode.
- `--mode token|clang|clang-ast`: choose mutation implementation, default
  `token` initially.
- `--dry-run-only`: validate the unmodified build/test lifecycle and stop.
- `--skip-initial-test`: skip the unmodified build/test lifecycle for advanced or legacy flows.
- `--check-command`: run a compile/type-check command after mutated build and before tests.
- `--skip-tests`: run build/check only; viable mutants are reported as survivors.
- `--coverage-file`, `--coverage-provider`: ingest simple JSON, `llvm-cov
  export` JSON, or LCOV data and mark uncovered mutants as `NO_COVERAGE`.
- `--coverage-test-command-template`: narrow per-mutant test commands from
  supplied test-level coverage mappings.
- `--coverage-helper-command-template`, `--coverage-helper-tests`: generate
  per-test coverage exports through `stryker-cxx` and merge them into
  `coveredBy` mappings before selecting per-mutant tests.
- `--incremental`, `--baseline-file`, `--baseline-max-age-days`,
  `--baseline-branch`, `--write-baseline`, `--clear-baseline`: reuse or update
  compatible baseline cache entries.
- `--batch-mutants`, `--batch-size`: batch compatible mutants in isolated worktrees and split failed batches for attribution.
- `--plugin`, `--plugin-dir`, `--reporter`: load local plugin manifests for mutators and reporter metadata.
- `--build-system`, `--build-dir`, `--build-target`, `--check-system`,
  `--check-args`, `--test-target`, `--test-filter`: synthesize common
  CMake/CTest/Ninja/Make/Meson/Bazel build/test commands plus `clang-tidy` or
  `cppcheck` checker commands.
- `--test-framework`, `--test-binary`, `--xctest-bundle`,
  `--xctest-destination`, `--xctest-only-testing`, `--xctest-skip-testing`:
  synthesize GoogleTest, Catch2, doctest, or XCTest test commands, including
  xcodebuild-backed XCTest destination and target selection controls.
- `--dashboard-export`, `--dashboard-upload-url`: write or explicitly upload dashboard JSON.
- `--dashboard-version`, `--dashboard-retention-days`,
  `--dashboard-auth-token-env`, `--dashboard-auth-header`: dashboard payload
  compatibility, retention, and explicit upload-auth metadata forwarded to
  `stryker-cxx`.
- release provenance workflow and adapter/plugin fixtures live in the standalone
  `stryker-cxx` repository.
- package contents, signed-release policy, and dashboard upload policy are owned
  by the standalone `stryker-cxx` repository.
- full-spec validation is owned by the standalone `stryker-cxx` repository via
  `npm run validate:full-spec`.
- Marmorkrebs validates its provider forwarding with
  `npm run validate:stryker-cxx-provider`.
- `--timeout-factor`, `--timeout-constant-ms`: derive mutant timeouts from the
  dry-run test duration when fixed `--timeout` is not supplied.
- `--threshold-high`, `--threshold-low`, `--threshold-break`: Stryker-style
  threshold bands. Marmorkrebs' `--threshold` maps to `--threshold-break`.
- `--retain-worktrees`, `--retain-worktrees-for`,
  `--retained-worktree-ttl-hours`, `--worker-tmp-dir`, `--env KEY=VALUE`:
  resource and debug controls for isolated mutation workers.
- `--env-inherit`, `--env-block`: inherited process-environment allow/block
  controls for build/check/test commands and provider hooks.
- Provider reports record env keys and redaction metadata, but explicit env
  values and shell-style sensitive assignments such as `TOKEN=value` are
  redacted before Marmorkrebs consumes or archives the report.

Marmorkrebs must preserve `stryker-cxx` naming and semantics at this boundary:
CLI options remain kebab-case, provider config fields remain lowerCamelCase, and
status names are forwarded in Stryker/MTE-style uppercase. Marmorkrebs may
normalize the resulting report into its own QA-gate view, but it should not
rename or reinterpret `stryker-cxx` inputs before invoking the provider.
The normalized `MutationResult` may expose provider evidence metadata such as
`resourceIsolation`, but scoring and threshold interpretation remain
Marmorkrebs-owned.

Execution options:

- `--timeout <seconds>`: per-mutant timeout.
- `--dry-run-only`: run the unmutated build/test lifecycle and stop.
- `--skip-initial-test`: skip the unmutated build/test lifecycle check.
- `--timeout-factor <n>`: multiplier for dry-run-derived mutant timeouts.
- `--timeout-constant-ms <n>`: constant milliseconds added to calibrated mutant timeouts.
- `--jobs <n>`: parallel mutant workers, introduced after isolated worktrees exist.
- `--worktree-mode inplace|copy|git-worktree`: choose mutation isolation mode.
- `--resume <report>`: skip completed mutants from a prior report.

Report options:

- `--report <path>`: JSON report path.
- `--format json|markdown|html|sarif|mutation-testing-elements|github-annotations`:
  output format for stdout or generated report.
- `--threshold-high <0-1>`, `--threshold-low <0-1>`, `--threshold-break <0-1>`:
  Stryker-style score bands. `--threshold` remains a compatibility alias for
  `threshold-break`.
- `--quiet`: write only report output to stdout.

### `list-mutants`

Discover mutants without running build/test commands.

```bash
stryker-cxx list-mutants \
  --repo . \
  --files src/foo.cpp \
  --base origin/main \
  --format json
```

This supports fast review of mutation scope and stable mutant IDs before a long run.

### `run-mutant`

Run one mutant by stable ID.

```bash
stryker-cxx run-mutant \
  --repo . \
  --id src/foo.cpp:42:17:EqualityOperator:sha256... \
  --build-command "ninja -C build target" \
  --test-command "./build/bin/target_test"
```

This is useful for reproducing a survivor locally.

## Exit codes

Exit codes must be stable and CI-friendly.

- `0`: mutation run completed and met the configured threshold.
- `1`: infrastructure or usage error.
- `2`: run completed but did not meet threshold, including surviving mutants.
- `3`: no mutants generated, when `--fail-on-empty` is enabled.

Marmorkrebs can map these into its existing gate semantics.

## Report schema

The JSON report should be stable and versioned.

The standalone `stryker-cxx` report is the native C/C++ mutation contract.
Marmorkrebs consumes `stryker-cxx.report.v1` and projects it into its
language-agnostic result shape only at the orchestration boundary. New C++
mutation output should be `stryker-cxx` by design rather than an embedded
Marmorkrebs format with a compatibility wrapper.

Marmorkrebs keeps old cross-language report consumers stable by normalizing
the standalone report after parsing. If a native-format output switch is
selected, it should emit the unnormalized `stryker-cxx.report.v1` payload.

```json
{
  "schemaVersion": "stryker-cxx.report.v1",
  "tool": "stryker-cxx",
  "repo": "/path/to/repo",
  "base": "origin/main",
  "startedAt": "2026-06-28T12:00:00Z",
  "completedAt": "2026-06-28T12:05:00Z",
  "score": 0.83,
  "threshold": 0.6,
  "thresholds": {
    "high": 0.9,
    "low": 0.7,
    "break": 0.6,
    "status": "high"
  },
  "dryRun": {
    "status": "PASSED"
  },
  "totalMutants": 6,
  "killed": 5,
  "survived": 1,
  "buildErrors": 0,
  "timeouts": 0,
  "ignored": 0,
  "summary": {
    "byStatus": {"KILLED": 5, "SURVIVED": 1},
    "byFile": {},
    "byMutator": {}
  },
  "mutants": [
    {
      "id": "src/foo.cpp:42:17:EqualityOperator:abc123",
      "file": "src/foo.cpp",
      "line": 42,
      "column": 17,
      "mutator": "EqualityOperator",
      "original": "==",
      "mutated": "!=",
      "status": "SURVIVED",
      "durationMs": 1200,
      "buildLog": "agent_space/stryker-cxx/build_1.log",
      "testLog": "agent_space/stryker-cxx/test_1.log",
      "detail": "all targeted tests passed"
    }
  ]
}
```

Required compatibility notes:

- Scores should be `0.0` to `1.0` in standalone reports.
- The Marmorkrebs adapter can normalize older embedded reports that use percentages.
- `totalMutants: 0` should be explicit so callers can distinguish vacuous proof from strong evidence.
- Build errors should not silently improve the score; they should be counted separately.
- Ignored mutants should remain visible in reports but excluded from Marmorkrebs score interpretation.
- Failed initial dry runs should be treated as infrastructure failures, not mutation proof.

## Stryker compatibility seam

`stryker-cxx` should integrate with the Stryker ecosystem through
`mutation-testing-elements`, not by depending on StrykerJS or Stryker.NET
internals.

The first compatibility layer should be report-level:

- Keep Stryker-style mutator names where the concepts match.
- Emit stable mutant IDs.
- Emit Stryker-style statuses in a report projection: `Killed`, `Survived`,
  `NoCoverage`, `Timeout`, `Ignored`, `Pending`, and infrastructure error
  statuses where needed.
- Preserve source locations as start/end line and column ranges.
- Include source text per file when generating the report projection.
- Keep the native `stryker-cxx.report.v1` schema as the authoritative contract,
  then project into `mutation-testing-elements` for Stryker viewers and future
  upstream discussion.

This keeps the tool Stryker-shaped from the start: the C++ engine speaks the
reporting vocabulary used by Stryker tooling, while Marmorkrebs performs only its
own gate-result normalization.

## Mutator set

Initial mutators should match the embedded engine:

- `ConditionalBoundary`: `<`, `<=`, `>`, `>=` boundary changes.
- `EqualityOperator`: `==` and `!=` swaps.
- `LogicalOperator`: `&&` and `||` swaps.
- `BooleanLiteral`: `true` and `false` swaps.
- `ArithmeticOperator`: `+` `-` `*` `/` swaps, opt-in by default.

Near-term additions:

- `UnaryOperator`: remove or add `!` where syntactically safe.
- `ReturnValue`: mutate simple boolean/integer return constants.
- `AssignmentOperator`: selected `+=`, `-=`, `*=`, `/=` changes.
- `BitwiseOperator`: `&`, `|`, `^` swaps where AST context proves they are operators.
- `CallRemoval`: replace selected side-effect-free predicate/helper calls only when configured.

Default mutators should bias toward branch and dispatch logic, not broad arithmetic. Arithmetic creates too many equivalent or noisy mutants in pointer/indexing code.

## Source analysis modes

### Token mode

Token mode is the compatibility path. It should remain simple, fast, and dependency-light.

Requirements:

- Skip comments, string literals, and character literals.
- Avoid template brackets and common C++ punctuation traps.
- Avoid includes and preprocessor lines by default.
- Keep deterministic mutant ordering.
- Support `.cpp`, `.cc`, `.cxx`, `.c`, `.mm`, `.m`, `.h`, `.hpp`, `.hh`, `.hxx`, and optional `.metal`.

### Clang-aware mode

Clang-aware mode is the path toward Stryker/gomu-level trustworthiness.

Requirements:

- Use compile commands from `compile_commands.json` when available.
- Mutate AST-confirmed expressions rather than raw token matches.
- Preserve formatting enough that diagnostics remain useful.
- Avoid macro expansions unless explicitly enabled.
- Record AST node kind in the mutant record.

Implementation options:

- Python `libclang` bindings for continuity with the current engine.
- A small C++/LLVM binary if Python bindings become too brittle.
- Tree-sitter as an intermediate parser for lighter-weight structural filtering, but not as the final semantic authority.

## Workspace safety

The embedded engine currently mutates files in place and restores them, then uses `git checkout -- <path>` as a final cleanup. A standalone tool needs safer modes.

Required phases:

1. Keep `inplace` mode for compatibility.
2. Add `git-worktree` mode to run each mutant or shard in an isolated worktree.
3. Add resume support so interrupted runs do not require starting over.
4. Avoid destructive cleanup of files not owned by the run.

Safety rules:

- Refuse to run in `inplace` mode on a dirty target file unless `--allow-dirty` is set.
- Never reset unrelated files.
- Write all logs under a configurable artifact directory.
- Emit enough cleanup metadata to recover after interruption.

## Configuration file

Support `stryker-cxx.yml` at the repo root.

```yaml
schemaVersion: stryker-cxx.config.v1
base: origin/main
files:
  include:
    - "aten/src/**/*.mm"
    - "aten/src/**/*.cpp"
  exclude:
    - "**/generated/**"
mutators:
  enabled:
    - ConditionalBoundary
    - EqualityOperator
    - LogicalOperator
    - BooleanLiteral
execution:
  buildCommand: "ninja -C build target"
  testCommand: "python test/run_test.py test_mps --keep-going"
  timeoutSeconds: 300
  timeoutFactor: 1.5
  timeoutConstantMs: 5000
  maxMutants: 50
  worktreeMode: inplace
report:
  thresholds:
    high: 0.9
    low: 0.7
    break: 0.6
  failOnEmpty: false
  artifactDir: agent_space/stryker-cxx
```

CLI flags should override config values.

## Reports for humans

The JSON report is the canonical machine contract. The tool should also generate human reports.

Markdown report should include:

- Summary table.
- Score and threshold.
- Initial dry-run status and calibrated timeout.
- Threshold band status and per-file/per-mutator/per-status summaries.
- Changed files targeted.
- Survivor list with file/line/mutator/before/after.
- Build errors and timeout list.
- Exact build/test commands.
- Reproduction command for each survivor.

HTML can come later and should be generated from the same report schema.

SARIF can come later for GitHub code-scanning integration.

## Marmorkrebs integration

Marmorkrebs should remain the language-agnostic orchestrator. `stryker-cxx` should become the C/C++ provider.

Adapter plan:

1. Run `stryker-cxx run` for `marmorkrebs --tool stryker-cxx`.
2. Parse `stryker-cxx.report.v1`.
3. Preserve current Marmorkrebs CLI flags: `--max-mutants`, `--include-metal`, and `--mutators`.
4. Treat embedded C++ source mutation as historical only; PR skills and new local flows use `stryker-cxx`.

Current status: Marmorkrebs has a first-class `--tool stryker-cxx` path, can use
`--stryker-cxx-bin` (or `STRYKER_CXX_BIN`) to select a binary, forwards dry-run,
checker, coverage, test-level coverage selection, baseline-cache policy, plugin, resource-control, build/test adapter, framework-discovery, timeout-calibration, and threshold-band options, treats
failed `stryker-cxx` dry runs as infrastructure errors, and accepts
`stryker-cxx.report.v1` through the C++ parser.

Marmorkrebs result mapping:

- `totalMutants` -> `MutationResult.totalMutants`
- `killed` -> `MutationResult.killed`
- `survived` -> `MutationResult.survived`
- `buildErrors` -> `MutationResult.noCoverage`
- `timeouts` -> `MutationResult.timeout`
- `ignored` -> `MutationResult.ignored`
- `score` -> `MutationResult.score`
- surviving mutants -> `MutationResult.survivingMutants`

## First repository layout

```text
stryker-cxx/
  package.json
  bin/stryker-cxx.js
  src/
    cli.js
    index.js
  python/
    stryker_cxx/
      __init__.py
      cli.py
      engine.py
      __main__.py
      schema.py
  README.md
  LICENSE
  docs/
    spec.md
    validation.md
    fixtures.md
    mutators.md
    release.md
    signing.md
    dashboard.md
    contract.md
    schemas/
  fixtures/
    adapters/
    frameworks/
    plugins/
    config/
```

This repo is intentionally split: JS owns CLI surface and orchestration glue, Python
hosts discovery/execution/reporting. `marmorkrebs` treats this project as the
authoritative standalone provider and keeps C++ normalization outside its own
language-agnostic gate model.

## Milestones

### M0: extraction without behavior change

- ✅ Move the embedded Python engine into a standalone repo.
- ✅ Keep token-level mutation behavior equivalent.
- ✅ Add CLI tests for report generation and exit codes.
- ✅ Add docs for local PR-gate use.
- ✅ Update Marmorkrebs to call the external tool when present.

### M1: product-quality CLI

- ✅ Add `list-mutants` and `run-mutant`.
- ✅ Add stable mutant IDs.
- ✅ Add config file support.
- ✅ Add markdown report generation.
- ✅ Add dirty-tree checks and safer artifact handling.

### M2: safer execution

- ✅ Add timeout handling and calibration.
- ✅ Add resume from report.
- ✅ Add isolated copy/git-worktree execution.
- ✅ Add sharding groundwork.

### M3: clang-aware mutation

- ✅ Add `--mode clang` and `--mode clang-ast`.
- ✅ Read `compile_commands.json` when available.
- ✅ Generate AST-confirmed candidates for selected operators.
- ✅ Add `--coverage-helper` + test-level coverage selection coverage.

### M4: CI and ecosystem parity

- ✅ Publish installable package.
- ✅ Add GitHub release/provenance workflow and validation scripts.
- ✅ Add SARIF and GitHub annotation output.
- ✅ Add threshold band policy and CI-facing validation.
- ✅ Add equivalent-noise handling via ignore comments.

### M5: remaining

- Tighten mutation catalog breadth and noise filtering.
- Add richer source-language-specific AST generators for wider C++/ObjC++/Metal domains.
- Expand cross-tool workflow parity and hosted dashboard integrations.
- Add deeper equivalent-mutant/logic reduction logic.

These are explicit follow-on parity items for the broader Stryker ecosystem and
do not block production PR-gate flows that use `marmorkrebs --tool stryker-cxx`.

## Acceptance criteria for independence

The standalone tool is ready to be treated as independent when:

- It can run outside Marmorkrebs with only documented CLI/config inputs.
- It has tests for discovery, mutation application, restoration, report schema, and exit codes.
- Marmorkrebs can use it as an external provider.
- A real C++/ObjC++ repo can run it from a clean checkout and get a deterministic JSON report.
- A survivor can be reproduced with a single `run-mutant` command.
- An interrupted run leaves the target repo recoverable and reports what happened.

## Open decisions

- Whether Metal should get a dedicated shader-mutator mode versus token-only defaults.
- Whether additional ecosystem integrations should remain externalized to Marmorkrebs or be added as provider-native helpers.
- Whether `stryker-cxx` and Marmorkrebs should share any additional proof/review metadata beyond `threshold` and `score`.
- Whether clang-aware execution should move further toward precompiled helpers without losing reproducibility.

## Conventions and boundary guarantees

Conventions are part of compatibility:

- PR and local production flows should use `--tool stryker-cxx`; `cxx-source` is
  historical migration-only behavior and must not be the default path for new gate
  flows.
- Native `stryker-cxx` status vocabularies (`KILLED`, `SURVIVED`, etc.) stay
  stable and are only normalized once at Marmorkrebs’ orchestration boundary.
- CLI flags remain kebab-case; provider config/report fields remain
  lowerCamelCase.
- Shell command construction should stay shell-safe and preserve explicit env
  policy (`env-inherit`/`env-block`), with no accidental token leakage in
  generated normalized payloads.
- Code and docs should keep the same operational conventions as the standalone
  tool: repository-level formatting, command semantics, and boundary-oriented
  normalization.

### Coding and review conventions that must stay aligned

- Keep repo-level and file-level formatting conventions identical where shared:
  - `.editorconfig` whitespace and newline rules.
  - TypeScript/JavaScript/JSON/YAML/Markdown: 2-space indentation.
  - Repository docs and scripts should continue to spell command semantics in
    repository-native terms.
- Keep CLI flags kebab-case and config/report fields lowerCamelCase across both
  repos.
- Keep status families and command names stable at the seam (`STRYKER`-native
  statuses from stryker-cxx are normalized only by Marmorkrebs orchestration
  policy).
- Keep shell-argument construction through helper escaping, not string interpolation.
- New options that touch forwarding behavior must have paired parser/command tests
  in Marmorkrebs and corresponding contract coverage in `stryker-cxx`.
- Treat `cxx-source` references as legacy migration context; new production flows
  use `--tool stryker-cxx`.

### Concrete convention gate

Before marking a feature as compatible with Stryker conventions, verify this:

- `.editorconfig` rules stay the same in both repos.
- CLI option names stay kebab-case and report/config fields stay lowerCamelCase.
- Command and status semantics stay `stryker-cxx`-native until Marmorkrebs
  normalization.
- `marmorkrebs` parser changes have matching contract-focused tests in
  `src/parsers/cxx-source.test.ts`.
- `stryker-cxx` contract or schema changes update docs in `docs/spec.md`,
  `docs/contract.md`, and any migration notes in `docs/validation.md`.
- parser/normalization behavior changes include evidence via
  `npm run validate:stryker-cxx-provider`.
- Any flow touching reporting includes explicit mention of output shape and exit-code
  compatibility in `docs/stryker-cxx-spec.md`.

## Repository boundary note

`cxx-mutant` remains a historical extraction point. The active C++ provider path for
`marmorkrebs --tool stryker-cxx` is this repository (`cxx-mutant` compatibility mode is no longer required for current PR gates).
