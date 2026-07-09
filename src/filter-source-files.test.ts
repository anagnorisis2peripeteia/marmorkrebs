import { strict as assert } from "node:assert";
import { test } from "node:test";
import { filterSourceFiles, redactSecrets } from "./runner.js";

test("stryker-net: keeps .cs source, drops non-source and test files", () => {
  const out = filterSourceFiles(
    [
      "DS4Windows/DS4Control/DTOXml/AppSettingsDTO.cs",
      "DS4WindowsTests/AppSettingsTests.cs", // .NET test project dir + *Tests.cs file
      "DS4Windows/DS4WinWPF.csproj",
      ".github/workflows/ci-build.yml",
      "global.json",
    ],
    "stryker-net",
  );
  assert.deepEqual(out, ["DS4Windows/DS4Control/DTOXml/AppSettingsDTO.cs"]);
});

test("isTestFile CamelCase detection: excludes real tests, keeps look-alikes", () => {
  const files = [
    "src/WidgetTest.cs", // *Test.cs -> test
    "src/OrderTests.cs", // *Tests.cs -> test
    "Foo.Tests/Helper.cs", // *.Tests/ dir -> test
    "app/Latest.cs", // ends in "test" lowercase -> NOT a test
    "app/Greatest.cs", // ditto
    "app/Contest.cs", // ditto
    "app/OrderService.cs", // plain source
  ];
  const out = filterSourceFiles(files, "stryker-net");
  assert.deepEqual(out.sort(), ["app/Contest.cs", "app/Greatest.cs", "app/Latest.cs", "app/OrderService.cs"].sort());
});

test("line-range suffixes are stripped before filtering (scoped-line entries pass)", () => {
  const out = filterSourceFiles(["DS4Windows/DS4Control/DTOXml/AppSettingsDTO.cs:10-24"], "stryker-net");
  assert.deepEqual(out, ["DS4Windows/DS4Control/DTOXml/AppSettingsDTO.cs:10-24"]);
});

test("dotted .NET test basenames are excluded, look-alikes kept", () => {
  const out = filterSourceFiles(
    [
      "src/Foo.Tests.cs", // dotted .Tests. -> test
      "src/Order.IntegrationTests.cs", // dotted + CamelCase -> test
      "src/Foo.BarTests.cs", // -> test
      "src/Latest.cs", // lowercase "test" -> NOT a test
      "src/MyGreatestHits.cs", // -> NOT a test
      "src/Widget.cs", // plain source
    ],
    "stryker-net",
  );
  assert.deepEqual(out.sort(), ["src/Latest.cs", "src/MyGreatestHits.cs", "src/Widget.cs"].sort());
});

test("redactSecrets masks auth-like values in a logged command, leaves the rest", () => {
  assert.equal(
    redactSecrets("dotnet stryker --mutate '**/A.cs' --test-command 'curl -H \"Authorization: Bearer abc123\" x'"),
    "dotnet stryker --mutate '**/A.cs' --test-command 'curl -H \"Authorization: Bearer ***\" x'",
  );
  assert.equal(redactSecrets("run --token=SECRET123 --files a.cs"), "run --token=*** --files a.cs");
  assert.equal(redactSecrets("deploy --password foopass --dir ."), "deploy --password *** --dir .");
  // non-secret flags untouched
  assert.equal(redactSecrets("stryker --mutate '**/AppSettingsDTO.cs' --threshold 0.6"), "stryker --mutate '**/AppSettingsDTO.cs' --threshold 0.6");
});

test("existing slash-delimited test conventions still excluded", () => {
  const out = filterSourceFiles(
    ["pkg/foo.go", "pkg/foo_test.go", "src/a.ts", "src/a.test.ts", "test/helper.ts"],
    "go-mutesting",
  );
  assert.deepEqual(out, ["pkg/foo.go"]);
});
