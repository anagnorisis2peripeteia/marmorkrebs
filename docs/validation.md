# Validation

Marmorkrebs validates the `stryker-cxx` provider through:

```bash
npm run validate:stryker-cxx-provider
```

The script runs:

- TypeScript typecheck;
- build;
- syntax lint for validation script entrypoints;
- parser/CLI tests;
- an optional `stryker-cxx` provider smoke when `stryker-cxx` is on `PATH` or
  `STRYKER_CXX_BIN` points to a local checkout/binary.

The provider smoke creates a temporary C++ file, runs Marmorkrebs with
`--tool stryker-cxx`, forwards `--dry-run-only`, and asserts the normalized
result is a non-empty `stryker-cxx` result without an error.

## Provider proof sequence for tandem release

- Run `npm run validate:full-spec` in `stryker-cxx` to prove standalone runtime
  and contract completeness.
- Ensure a runnable `stryker-cxx` binary is available (`PATH`/`STRYKER_CXX_BIN`).
- Run `npm run validate:stryker-cxx-provider` in Marmorkrebs.
- Optionally run both repos' docs-checking and smoke commands together in your CI
  release job.
- Keep embedded historical C++ behavior discussions out of new PR/prod gate flows;
  treat `--tool stryker-cxx` as the current supported path for C++ mutation.
