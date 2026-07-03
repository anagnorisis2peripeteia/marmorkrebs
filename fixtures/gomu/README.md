# gomu validation fixture

Two-package Go module for `scripts/validate-provider.mjs gomu`:
- `a.go` — changed + tested: mutants must be killed
- `b.go` — changed + untested: survivors MUST be reported
- `pkg/c.go` — changed + tested (second package dir, proves per-dir runs merge)
- `pkg/d.go` — UNCHANGED + untested: must be filtered out of scoring

Validated live against gomu v0.2.1 (sivchari/gomu).
