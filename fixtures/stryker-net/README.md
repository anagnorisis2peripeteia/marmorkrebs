# stryker-net validation fixture

Minimal net8.0 xunit solution for `scripts/validate-provider.mjs stryker-net`
(runs in Windows CI; locally needs the dotnet SDK + `dotnet tool install -g dotnet-stryker`):
- `Lib/Calc.cs::Add` — changed + tested: mutants killed
- `Lib/Calc.cs::Sub` — changed + untested: survivors MUST be reported
