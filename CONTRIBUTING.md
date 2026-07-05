# Contributing to Marmorkrebs

Marmorkrebs is the PR-oriented mutation orchestration layer. Tool-specific
mutation behavior belongs in the provider tools; Marmorkrebs should normalize
provider output only at the orchestration boundary.

## Local setup

Requirements:

- Node.js 20 or newer
- TypeScript via `npm install`
- Optional: provider binaries such as `stryker-cxx`, StrykerJS, Stryker.NET,
  go-mutesting, gomu, cargo-mutants, or mutmut

Run the default checks:

```bash
npm run build
npm test
npm run check
npm run lint
```

Run the `stryker-cxx` bridge smoke when a local `stryker-cxx` binary is
available:

```bash
npm run validate:stryker-cxx-provider
```

## Code style and conventions

- Keep TypeScript strict and dependency-light.
- Use repo-local formatting: 2-space indentation, LF endings, final newlines,
  and no trailing whitespace as captured in `.editorconfig`.
- Keep CLI flags kebab-case and TypeScript config fields lowerCamelCase.
- Preserve native provider concepts where possible. Do not normalize
  `stryker-cxx` into another provider's shape before the Marmorkrebs result
  boundary.
- Keep provider commands shell-safe with `shellEscape` and avoid leaking
  explicit credentials or env values in logs or normalized output.
- Treat `cxx-source` as historical migration compatibility only. New provider
  behavior and new options should route through `--tool stryker-cxx` and stay
  within the same naming and report-shape conventions as the standalone tool.

## Provider changes

When adding or changing provider behavior:

- update the parser or command-builder tests;
- update the README and provider docs for user-visible flags;
- preserve local staged-diff workflows via `--base` unless intentionally
  documented otherwise;
- keep crabbox options optional so local execution remains the default.

## Pull request checklist

Before opening a PR:

- `npm run build` passes;
- `npm test` passes;
- `npm run check` passes;
- `npm run lint` passes;
- provider docs match the exposed CLI flags;
- new provider behavior has focused parser or command-builder coverage.

## Lane rules (hard-learned)

- **No dormant lanes:** a new tool lane enters `QUARANTINED_TOOLS` and stays there until a
  `fixtures/<tool>` project passes `node scripts/validate-provider.mjs <tool>` against the
  REAL binary. Parser unit tests with hand-written fixtures cannot detect a wrong CLI flag
  or a report written to disk instead of stdout.
- **Captured fixtures only:** parser-test fixtures must be captured from real tool output
  and marked with the tool version + capture date.
- **Scrub before, clean after:** any lane whose tool writes report files must delete prior
  reports BEFORE running (a leftover report + non-zero exit reads as a trusted threshold
  verdict — the stale-report fail-open class) and leave the target repo clean afterwards
  (the validator's artifact check enforces it).
- **Exit codes end-to-end:** never `runner && cat report` (drops the report on exit 2);
  never judge any step through a pipe. `runner; code=$?; cat report; exit $code`.
