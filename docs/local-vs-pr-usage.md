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

## C++ / ObjC++ / Metal local flow

`stryker-cxx` mutates source files and reruns commands supplied by the caller. Keep this tightly scoped because each mutant rebuilds and retests the target.

```bash
marmorkrebs \
  --dir /path/to/repo \
  --tool stryker-cxx \
  --base origin/main \
  --build-command "ninja -C build target" \
  --test-command "./build/bin/target_test" \
  --max-mutants 25
```

Use a specific `stryker-cxx` binary by adding:

```bash
--stryker-cxx-bin /usr/local/bin/stryker-cxx
```

If `--stryker-cxx-bin` (or `STRYKER_CXX_BIN`) is set, Marmorkrebs will call that binary while keeping the rest of the C++ mutation options stable. The old `--tool cxx-source` mode remains as an embedded fallback for existing local scripts.

Optional controls:

- `--max-mutants <n>` caps the number of generated mutants for a run.
- `--include-metal` includes `.metal` files in the C++ source mutation pass.
- `--mutators <names>` restricts the engine to a comma-separated mutator list.

Use `--include-metal` only when the test command actually exercises the shader path. Otherwise the run will spend time creating mutants the selected tests cannot kill.

## Output contract

A successful run exits zero and writes a `MutationResult` JSON object to stdout. Important fields are:

- `score`: mutation score for the scoped run.
- `totalMutants`: number of mutants actually executed.
- `survivingMutants`: mutants not killed by the selected tests.

For PR gates, treat `totalMutants: 0` as vacuous proof rather than strong evidence. A survivor is a signal that the test plan may not cover the behavior being changed.

## Relationship to ClawSweeper and local Mantis

ClawSweeper decides whether the review needs real-behavior proof and may emit a Mantis recommendation. Local Mantis records the user-visible proof. Marmorkrebs is separate: it checks whether the tests can kill behavior-changing mutations in the changed code.

A typical local pre-push sequence is:

1. Run the repo's normal checks.
2. Run ClawSweeper local review over the local range.
3. If ClawSweeper asks for real-behavior proof, run local Mantis/proofrig for that scenario.
4. Run Marmorkrebs with `--base <target-ref>` on the same checkout.
5. Push only after the docs, proof, review body, and mutation result describe the same final HEAD.
