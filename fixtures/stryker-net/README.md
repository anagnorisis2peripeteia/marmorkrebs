# stryker-net validation fixture

Minimal net8.0 xunit solution for `scripts/validate-provider.mjs stryker-net`
(runs in Windows CI; locally needs the dotnet SDK + `dotnet tool install -g dotnet-stryker`):
- `Lib/Calc.cs::Add` — changed + tested: mutants killed
- `Lib/Calc.cs::Sub` — changed + untested: survivors MUST be reported

## Multi-project ranking (#28)

`Lib.IntegrationTests/` is a second test project that references `Lib` but covers nothing, so the
fixture has TWO referencing test projects. `findStrykerNetTestProject` must RANK them (not pick the
sole candidate) and choose `Lib.Tests` (name-matching, non-integration). It is walked before
`Lib.Tests`, so a correct ranking — not walk order — is required. If the integration project were
wrongly picked, nothing would be killed and the `minKilled: 1` validator check would fail.
