# cargo-mutants validation fixture

Lib crate for `scripts/validate-provider.mjs cargo-mutants`:
- `src/lib.rs::add` — changed + tested: mutants killed
- `src/untested.rs::sub` — changed + untested: survivors MUST be reported (tool exit 2 = valid result)
- `src/other.rs::mul` — UNCHANGED + untested: excluded via native --file scoping
