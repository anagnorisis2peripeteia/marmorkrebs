# stryker validation fixture

Plain-ESM JS project for `scripts/validate-provider.mjs stryker` (command test runner,
`node test.js` — no framework):
- `lib/tested.js` — changed + tested: mutants killed
- `lib/untested.js` — changed + untested: survivors MUST be reported
- `lib/neighbor.js` — UNCHANGED + untested: excluded via mutate scoping
