using Xunit;

// Integration-style smoke test: it references Lib but deliberately does NOT exercise Calc.Add /
// Calc.Sub, so it cannot kill mutants of those methods. It exists to give the stryker-net fixture
// TWO test projects that reference Lib, so `findStrykerNetTestProject` has to RANK rather than pick
// the sole candidate — exercising the #28 multi-candidate ranking against the real dotnet-stryker
// in CI. This project is walked before Lib.Tests and is integration-named, so a correct ranking
// picks Lib.Tests; were it (wrongly) picked, the Add mutants would survive and the validator would
// fail — which is precisely the regression #28 fixed.
public class SmokeTests
{
    [Fact]
    public void CalcTypeIsAvailable()
    {
        Assert.NotNull(typeof(Lib.Calc));
    }
}
