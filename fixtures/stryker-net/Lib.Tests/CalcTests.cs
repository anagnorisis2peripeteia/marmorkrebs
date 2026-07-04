using Lib;
using Xunit;

public class CalcTests
{
    [Fact]
    public void AddWorks()
    {
        Assert.Equal(3, Calc.Add(1, 2));
        Assert.Equal(0, Calc.Add(-1, 1));
    }
}
