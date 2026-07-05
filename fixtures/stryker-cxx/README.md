# stryker-cxx validation fixture

Single-file C++ project for `scripts/validate-provider.mjs stryker-cxx` (needs the local
stryker-cxx shim — `~/.local/bin/stryker-cxx` on the Mac; CI skips when absent):
- `add()` — asserted by main(): mutants killed
- `sub()` — untested: survivors MUST be reported

Build compiles the mutated source per mutant to a TMPDIR binary (the target repo must stay clean); test runs it.
