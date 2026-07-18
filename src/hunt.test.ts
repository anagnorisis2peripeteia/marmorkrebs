import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHuntReport, computeCentrality, formatHuntReport, gatherHuntFiles } from "./hunt.js";
import type { MutationResult, SurvivingMutant } from "./types.js";

const survivor = (o: Partial<SurvivingMutant> & { file: string; line: number }): SurvivingMutant => ({
  mutator: "StringLiteral",
  description: "survived",
  status: "survived",
  ...o,
});

const baseResult = (survivors: SurvivingMutant[]): MutationResult => ({
  tool: "stryker-net",
  totalMutants: 10 + survivors.length,
  killed: 10,
  survived: survivors.filter((s) => s.status === "survived").length,
  timeout: 0,
  noCoverage: survivors.filter((s) => s.status === "no_coverage").length,
  ignored: 0,
  score: 0.7,
  survivingMutants: survivors,
  error: null,
  elapsedMs: 0,
});

describe("gatherHuntFiles", () => {
  it("collects source files under scope, excluding tests and build/dep dirs", () => {
    const root = mkdtempSync(join(tmpdir(), "mk-hunt-"));
    try {
      mkdirSync(join(root, "src", "Core"), { recursive: true });
      mkdirSync(join(root, "src", "Core.Tests"), { recursive: true });
      mkdirSync(join(root, "node_modules", "x"), { recursive: true });
      mkdirSync(join(root, "obj"), { recursive: true });
      writeFileSync(join(root, "src", "Core", "Calc.cs"), "class Calc {}");
      writeFileSync(join(root, "src", "Core", "Widget.cs"), "class Widget {}");
      writeFileSync(join(root, "src", "Core.Tests", "CalcTests.cs"), "class CalcTests {}");
      writeFileSync(join(root, "src", "Core", "readme.md"), "# not source");
      writeFileSync(join(root, "node_modules", "x", "Dep.cs"), "class Dep {}");
      writeFileSync(join(root, "obj", "Gen.cs"), "class Gen {}");

      const files = gatherHuntFiles(root, root, "stryker-net");
      assert.deepEqual(files, ["src/Core/Calc.cs", "src/Core/Widget.cs"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("honours a narrowed scope", () => {
    const root = mkdtempSync(join(tmpdir(), "mk-hunt-"));
    try {
      mkdirSync(join(root, "src", "A"), { recursive: true });
      mkdirSync(join(root, "src", "B"), { recursive: true });
      writeFileSync(join(root, "src", "A", "A.cs"), "class A {}");
      writeFileSync(join(root, "src", "B", "B.cs"), "class B {}");
      const files = gatherHuntFiles(root, join(root, "src", "A"), "stryker-net");
      assert.deepEqual(files, ["src/A/A.cs"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("computeCentrality", () => {
  it("ranks a widely-referenced file above a rarely-referenced one", () => {
    const all = ["Core.cs", "A.cs", "B.cs", "Leaf.cs"];
    const survivorFiles = ["Core.cs", "Leaf.cs"];
    const sources: Record<string, string> = {
      "Core.cs": "class Core {}",
      "A.cs": "var x = new Core();",
      "B.cs": "Core.DoThing(); Leaf.Ignored();",
      "Leaf.cs": "class Leaf {}",
    };
    const c = computeCentrality(all, survivorFiles, (f) => sources[f] ?? null);
    assert.equal(c.get("Core.cs"), 2); // referenced by A.cs and B.cs
    assert.equal(c.get("Leaf.cs"), 1); // referenced only by B.cs
  });

  it("does not count a file referencing itself", () => {
    const all = ["Solo.cs"];
    const c = computeCentrality(all, ["Solo.cs"], () => "class Solo { Solo Make() => new Solo(); }");
    assert.equal(c.get("Solo.cs"), 0);
  });

  it("matches whole words only (no 'catalog' matching 'Cat')", () => {
    const all = ["Cat.cs", "Other.cs"];
    const c = computeCentrality(all, ["Cat.cs"], (f) =>
      f === "Other.cs" ? "var c = new Catalog(); var d = Category.X;" : "class Cat {}",
    );
    assert.equal(c.get("Cat.cs"), 0);
  });
});

describe("buildHuntReport", () => {
  const readNothing = () => null;

  it("ranks real survivors by centrality, separates equivalent + no-coverage", () => {
    const survivors = [
      survivor({ file: "src/Leaf.cs", line: 3, mutator: "EqualityOperator" }),
      survivor({ file: "src/Core.cs", line: 10, mutator: "EqualityOperator" }),
      survivor({ file: "src/Log.cs", line: 5, likelyEquivalent: "logging-only: message string not asserted" }),
      survivor({ file: "src/Uncovered.cs", line: 1, status: "no_coverage", description: "no test covers this" }),
    ];
    const result = baseResult(survivors);
    const centrality: Record<string, number> = { "src/Core.cs": 9, "src/Leaf.cs": 1 };
    const report = buildHuntReport(
      result,
      ["src/Core.cs", "src/Leaf.cs", "src/Log.cs", "src/Uncovered.cs"],
      { scope: "src", filesSwept: 4 },
      // fake reader: not used because we assert on partitioning + order, which centrality drives.
      readNothing,
    );
    // centrality via readNothing = 0 for all, so order falls back to file name; assert partitioning:
    assert.equal(report.survivorsCovered, 2); // Leaf + Core (Log is equivalent, Uncovered is no-cov)
    assert.equal(report.equivalentFiltered, 1);
    assert.equal(report.noCoverage, 1);
    const survivorFindings = report.findings.filter((f) => f.tier === "survivor");
    assert.equal(survivorFindings.length, 2);
    // ranks are contiguous from 1
    assert.deepEqual(survivorFindings.map((f) => f.rank), [1, 2]);
    // equivalent + no-coverage are NOT in findings by default
    assert.equal(report.findings.some((f) => f.tier === "equivalent"), false);
    assert.equal(report.findings.some((f) => f.tier === "no-coverage"), false);
  });

  it("orders by real centrality when a reader is provided", () => {
    const survivors = [
      survivor({ file: "src/Leaf.cs", line: 3 }),
      survivor({ file: "src/Core.cs", line: 10 }),
    ];
    const sources: Record<string, string> = {
      "src/Core.cs": "class Core {}",
      "src/Leaf.cs": "class Leaf {}",
      "src/A.cs": "new Core();",
      "src/B.cs": "new Core();",
    };
    const report = buildHuntReport(
      baseResult(survivors),
      ["src/Core.cs", "src/Leaf.cs", "src/A.cs", "src/B.cs"],
      { scope: "src", filesSwept: 4 },
      (f) => sources[f] ?? null,
    );
    assert.equal(report.findings[0].file, "src/Core.cs"); // centrality 2 > Leaf 0
    assert.equal(report.findings[0].centrality, 2);
    assert.equal(report.findings[0].rank, 1);
  });

  it("caps findings with maxFindings", () => {
    const survivors = [1, 2, 3, 4].map((n) => survivor({ file: `src/F${n}.cs`, line: n }));
    const report = buildHuntReport(
      baseResult(survivors),
      survivors.map((s) => s.file),
      { scope: "src", filesSwept: 4, maxFindings: 2 },
      readNothing,
    );
    assert.equal(report.findings.filter((f) => f.tier === "survivor").length, 2);
  });

  it("appends a no-coverage tier only when requested", () => {
    const survivors = [
      survivor({ file: "src/A.cs", line: 1 }),
      survivor({ file: "src/U.cs", line: 2, status: "no_coverage" }),
    ];
    const report = buildHuntReport(baseResult(survivors), ["src/A.cs", "src/U.cs"], {
      scope: "src",
      filesSwept: 2,
      includeNoCoverage: true,
    }, readNothing);
    assert.equal(report.findings.some((f) => f.tier === "no-coverage"), true);
  });

  it("fail-closed formatting: a lane error is NOT followed by a clean-sweep reassurance", () => {
    const errored: MutationResult = { ...baseResult([]), error: "dotnet-stryker does not exist", totalMutants: 0 };
    const report = buildHuntReport(errored, [], { scope: "src", filesSwept: 3 }, readNothing);
    const text = formatHuntReport(report);
    assert.match(text, /ERROR:/);
    assert.match(text, /NOT a clean bill of health/);
    assert.doesNotMatch(text, /no real \(non-equivalent\) survivors/);
  });

  it("reports no test-debt when every survivor is equivalent", () => {
    const survivors = [
      survivor({ file: "src/Log.cs", line: 1, likelyEquivalent: "logging-only: x" }),
    ];
    const report = buildHuntReport(baseResult(survivors), ["src/Log.cs"], { scope: "src", filesSwept: 1 }, readNothing);
    assert.equal(report.survivorsCovered, 0);
    assert.equal(report.equivalentFiltered, 1);
    assert.match(formatHuntReport(report), /no real \(non-equivalent\) survivors/);
  });
});
