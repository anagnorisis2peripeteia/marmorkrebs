import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildCxxSourceCommand, parseCxxSource } from "./cxx-source.js";

describe("parseCxxSource", () => {
  it("parses the engine JSON report", () => {
    const report = {
      target_files: ["aten/src/Reduce.mm"],
      total: 3,
      killed: 2,
      survived: 1,
      build_error: 0,
      mutants: [
        {
          mutator: "ConditionalBoundary",
          file: "aten/src/Reduce.mm",
          line: 42,
          col: 12,
          original: "<=",
          mutated: "<",
          status: "KILLED",
          detail: "",
        },
        {
          mutator: "EqualityOperator",
          file: "aten/src/Reduce.mm",
          line: 88,
          col: 7,
          original: "==",
          mutated: "!=",
          status: "KILLED",
          detail: "",
        },
        {
          mutator: "LogicalOperator",
          file: "aten/src/Reduce.mm",
          line: 130,
          col: 20,
          original: "&&",
          mutated: "||",
          status: "SURVIVED",
          detail: "all targeted tests passed",
        },
      ],
      score: 66.66666666666667,
    };

    const result = parseCxxSource(JSON.stringify(report), "stryker-cxx");

    assert.equal(result.tool, "stryker-cxx");
    assert.equal(result.killed, 2);
    assert.equal(result.survived, 1);
    assert.equal(result.timeout, 0);
    assert.equal(result.noCoverage, 0);
    assert.equal(result.totalMutants, 3);
    assert.equal(result.score, 0.67); // 66.67% -> 0.67
    assert.equal(result.survivingMutants.length, 1);
    assert.equal(result.survivingMutants[0].file, "aten/src/Reduce.mm");
    assert.equal(result.survivingMutants[0].line, 130);
    assert.equal(result.survivingMutants[0].mutator, "LogicalOperator");
    assert.equal(result.survivingMutants[0].description, "&&->||");
    assert.equal(result.survivingMutants[0].status, "survived");
    assert.equal(result.error, null);
  });

  it("builds stryker-cxx as the external C++ mutation command", () => {
    const command = buildCxxSourceCommand(["src/foo.cpp"], "/repo", {
      tool: "stryker-cxx",
      buildCommand: "ninja -C build target",
      checkCommand: "clang++ -fsyntax-only src/foo.cpp",
      testCommand: "./target_test",
      buildSystem: "cmake",
      buildDir: "build",
      buildTarget: "target",
      artifactBackend: "compiled-object",
      artifactFallback: "source-overlay",
      xcodeWorkspace: "App.xcworkspace",
      xcodeScheme: "AppTests",
      xcodeConfiguration: "Debug",
      xcodeSdk: "iphonesimulator",
      xcodeDestination: "platform=iOS Simulator,name=iPhone 15",
      checkSystem: "clang++",
      checkArgs: "-std=c++20 -I include",
      testFilter: "Foo.*",
      testFramework: "gtest",
      testBinary: "./foo_tests",
      xctestDestination: "platform=iOS Simulator,name=iPhone 15",
      xctestOnlyTesting: ["MathFixtureTests/testAdd"],
      xctestSkipTesting: ["MathFixtureTests/testSlow"],
      base: "origin/main",
      maxMutants: 5,
      timeoutMs: 9000,
      timeoutFactor: 2,
      timeoutConstantMs: 750,
      thresholdHigh: 0.9,
      thresholdLow: 0.7,
      thresholdBreak: 0.5,
      mode: "clang-ast",
      equivalentSuppression: "off",
      coverageFile: "coverage.json",
      coverageProvider: "llvm-cov",
      coverageTestCommandTemplate: "pytest -k {tests_space}",
      coverageHelperCommandTemplate: "run-one-test {test} --coverage-out {coverage_file}",
      coverageHelperTests: ["MathFixtureTests/testAdd"],
      incremental: true,
      baselineFile: ".stryker-cxx-baseline.json",
      baselineMaxAgeDays: 7,
      baselineBranch: "feature/mps",
      writeBaseline: ".stryker-cxx-baseline.json",
      batchMutants: true,
      batchSize: 3,
      worktreeMode: "copy",
      retainWorktrees: true,
      retainWorktreesFor: ["SURVIVED", "TIMEOUT"],
      retainedWorktreeTtlHours: 24,
      workerTmpDir: "/tmp/stryker-cxx-workers",
      workerLabel: "pr-96205-proof",
      env: ["STRYKER_CXX_FLAG=yes"],
      envInherit: ["PATH"],
      envBlock: ["GITHUB_TOKEN"],
      plugins: ["plugin.json"],
      pluginDirs: ["plugins/example"],
      reporters: ["plugin-json"],
      dashboardExport: "dashboard.json",
      dashboardUploadUrl: "https://dashboard.example/upload",
      dashboardVersion: "1",
      dashboardRetentionDays: 14,
      dashboardProject: "openclaw/stryker-cxx-fixture",
      dashboardBranch: "feature/dashboard",
      dashboardCommit: "abc123",
      dashboardBuildUrl: "https://ci.example/build/123",
      dashboardAuthTokenEnv: "STRYKER_CXX_DASHBOARD_TOKEN",
      dashboardAuthHeader: "Authorization",
    });

    assert.ok(command.includes("'stryker-cxx' run"));
    assert.ok(command.includes("--repo '/repo'"));
    assert.ok(command.includes("--files 'src/foo.cpp'"));
    assert.ok(command.includes("--check-command 'clang++ -fsyntax-only src/foo.cpp'"));
    assert.ok(command.includes("--build-system 'cmake'"));
    assert.ok(command.includes("--build-dir 'build'"));
    assert.ok(command.includes("--build-target 'target'"));
    assert.ok(command.includes("--artifact-backend 'compiled-object'"));
    assert.ok(command.includes("--artifact-fallback 'source-overlay'"));
    assert.ok(command.includes("--xcode-workspace 'App.xcworkspace'"));
    assert.ok(command.includes("--xcode-scheme 'AppTests'"));
    assert.ok(command.includes("--xcode-configuration 'Debug'"));
    assert.ok(command.includes("--xcode-sdk 'iphonesimulator'"));
    assert.ok(command.includes("--xcode-destination 'platform=iOS Simulator,name=iPhone 15'"));
    assert.ok(command.includes("--check-system 'clang++'"));
    assert.ok(command.includes("--check-args '-std=c++20 -I include'"));
    assert.ok(command.includes("--test-filter 'Foo.*'"));
    assert.ok(command.includes("--test-framework 'gtest'"));
    assert.ok(command.includes("--test-binary './foo_tests'"));
    assert.ok(command.includes("--xctest-destination 'platform=iOS Simulator,name=iPhone 15'"));
    assert.ok(command.includes("--xctest-only-testing 'MathFixtureTests/testAdd'"));
    assert.ok(command.includes("--xctest-skip-testing 'MathFixtureTests/testSlow'"));
    assert.ok(command.includes("--output-format stryker-cxx"));
    assert.ok(command.includes("--timeout 9"));
    assert.ok(command.includes("--timeout-factor 2"));
    assert.ok(command.includes("--timeout-constant-ms 750"));
    assert.ok(command.includes("--threshold-high 0.9"));
    assert.ok(command.includes("--threshold-low 0.7"));
    assert.ok(command.includes("--threshold-break 0.5"));
    assert.ok(command.includes("--mode 'clang-ast'"));
    assert.ok(command.includes("--equivalent-suppression 'off'"));
    assert.ok(command.includes("--coverage-file 'coverage.json'"));
    assert.ok(command.includes("--coverage-provider 'llvm-cov'"));
    assert.ok(command.includes("--coverage-test-command-template 'pytest -k {tests_space}'"));
    assert.ok(
      command.includes(
        "--coverage-helper-command-template 'run-one-test {test} --coverage-out {coverage_file}'",
      ),
    );
    assert.ok(command.includes("--coverage-helper-tests 'MathFixtureTests/testAdd'"));
    assert.ok(command.includes("--incremental"));
    assert.ok(command.includes("--baseline-file '.stryker-cxx-baseline.json'"));
    assert.ok(command.includes("--baseline-max-age-days 7"));
    assert.ok(command.includes("--baseline-branch 'feature/mps'"));
    assert.ok(command.includes("--write-baseline '.stryker-cxx-baseline.json'"));
    assert.ok(command.includes("--batch-mutants"));
    assert.ok(command.includes("--batch-size 3"));
    assert.ok(command.includes("--worktree-mode 'copy'"));
    assert.ok(command.includes("--retain-worktrees"));
    assert.ok(command.includes("--retain-worktrees-for 'SURVIVED,TIMEOUT'"));
    assert.ok(command.includes("--retained-worktree-ttl-hours 24"));
    assert.ok(command.includes("--worker-tmp-dir '/tmp/stryker-cxx-workers'"));
    assert.ok(command.includes("--worker-label 'pr-96205-proof'"));
    assert.ok(command.includes("--env 'STRYKER_CXX_FLAG=yes'"));
    assert.ok(command.includes("--env-inherit 'PATH'"));
    assert.ok(command.includes("--env-block 'GITHUB_TOKEN'"));
    assert.ok(command.includes("--plugin 'plugin.json'"));
    assert.ok(command.includes("--plugin-dir 'plugins/example'"));
    assert.ok(command.includes("--reporter 'plugin-json'"));
    assert.ok(command.includes("--dashboard-export 'dashboard.json'"));
    assert.ok(command.includes("--dashboard-upload-url 'https://dashboard.example/upload'"));
    assert.ok(command.includes("--dashboard-version '1'"));
    assert.ok(command.includes("--dashboard-retention-days 14"));
    assert.ok(command.includes("--dashboard-project 'openclaw/stryker-cxx-fixture'"));
    assert.ok(command.includes("--dashboard-branch 'feature/dashboard'"));
    assert.ok(command.includes("--dashboard-commit 'abc123'"));
    assert.ok(command.includes("--dashboard-build-url 'https://ci.example/build/123'"));
    assert.ok(command.includes("--dashboard-auth-token-env 'STRYKER_CXX_DASHBOARD_TOKEN'"));
    assert.ok(command.includes("--dashboard-auth-header 'Authorization'"));
  });

  it("builds stryker-cxx checker-only commands without requiring a test command", () => {
    const command = buildCxxSourceCommand(["src/foo.cpp"], "/repo", {
      tool: "stryker-cxx",
      buildCommand: "ninja -C build target",
      checkCommand: "clang++ -fsyntax-only src/foo.cpp",
      skipTests: true,
    });

    assert.ok(command.includes("--skip-tests"));
    assert.ok(command.includes("--check-command 'clang++ -fsyntax-only src/foo.cpp'"));
    assert.ok(!command.includes("--test-command"));
  });

  it("parses standalone stryker-cxx report v1", () => {
    const report = {
      schemaVersion: "stryker-cxx.report.v1",
      tool: "stryker-cxx",
      targetFiles: ["aten/src/Reduce.mm"],
      totalMutants: 5,
      killed: 1,
      survived: 1,
      buildErrors: 0,
      checkErrors: 1,
      noCoverage: 2,
      timeouts: 0,
      ignored: 1,
      score: 0.5,
      thresholds: { high: 0.9, low: 0.7, break: 0.5, status: "low" },
      dryRun: { status: "PASSED" },
      execution: {
        resourceIsolation: {
          worktreeMode: "copy",
          environmentKeys: ["SECRET_TOKEN"],
          redaction: { enabled: true, replacement: "[REDACTED]" },
        },
      },
      mutants: [
        {
          id: "aten/src/Reduce.mm:42:12:ConditionalBoundary:abc123",
          mutator: "ConditionalBoundary",
          file: "aten/src/Reduce.mm",
          line: 42,
          col: 12,
          original: "<=",
          mutated: "<",
          status: "KILLED",
          detail: "",
        },
        {
          id: "aten/src/Reduce.mm:130:20:LogicalOperator:def456",
          mutator: "LogicalOperator",
          file: "aten/src/Reduce.mm",
          line: 130,
          col: 20,
          original: "&&",
          mutated: "||",
          status: "SURVIVED",
          detail: "all targeted tests passed",
        },
        {
          id: "aten/src/Reduce.mm:140:20:EqualityOperator:ignored",
          mutator: "EqualityOperator",
          file: "aten/src/Reduce.mm",
          line: 140,
          col: 20,
          original: "==",
          mutated: "!=",
          status: "IGNORED",
          detail: "equivalent generated comparison",
          ignoreReason: "equivalent generated comparison",
        },
      ],
      mutationTestingElements: {
        schemaVersion: "2.0",
        files: {},
        testFiles: {},
      },
    };

    const result = parseCxxSource(JSON.stringify(report), "stryker-cxx");

    assert.equal(result.tool, "stryker-cxx");
    assert.equal(result.killed, 1);
    assert.equal(result.survived, 1);
    assert.equal(result.timeout, 0);
    assert.equal(result.noCoverage, 3);
    assert.equal(result.ignored, 1);
    assert.equal(result.totalMutants, 5);
    assert.equal(result.score, 0.5);
    assert.deepEqual(result.thresholds, { high: 0.9, low: 0.7, break: 0.5, status: "low" });
    assert.deepEqual(result.dryRun, { status: "PASSED" });
    assert.deepEqual(result.resourceIsolation, {
      worktreeMode: "copy",
      environmentKeys: ["SECRET_TOKEN"],
      redaction: { enabled: true, replacement: "[REDACTED]" },
    });
    assert.equal(result.survivingMutants.length, 1);
    assert.equal(result.survivingMutants[0].file, "aten/src/Reduce.mm");
    assert.equal(result.survivingMutants[0].line, 130);
    assert.equal(result.survivingMutants[0].mutator, "LogicalOperator");
    assert.equal(result.survivingMutants[0].description, "&&->||");
    assert.equal(result.error, null);
  });

  it("maps build_error mutants to noCoverage", () => {
    const report = {
      target_files: ["x.cpp"],
      total: 2,
      killed: 1,
      survived: 0,
      build_error: 1,
      mutants: [
        {
          mutator: "BooleanLiteral",
          file: "x.cpp",
          line: 3,
          col: 0,
          original: "true",
          mutated: "false",
          status: "KILLED",
          detail: "",
        },
        {
          mutator: "ConditionalBoundary",
          file: "x.cpp",
          line: 9,
          col: 4,
          original: "<",
          mutated: "<=",
          status: "BUILD_ERROR",
          detail: "did not compile",
        },
      ],
      score: 100.0,
    };

    const result = parseCxxSource(JSON.stringify(report), "stryker-cxx");
    assert.equal(result.killed, 1);
    assert.equal(result.survived, 0);
    assert.equal(result.noCoverage, 1);
    assert.equal(result.ignored, 0);
    assert.equal(result.totalMutants, 2);
    assert.equal(result.score, 1); // 100% -> 1.0
    assert.equal(result.survivingMutants.length, 0);
    assert.equal(result.error, null);
  });

  it("returns error for non-JSON output", () => {
    const result = parseCxxSource("not json at all");
    assert.notEqual(result.error, null);
    assert.equal(result.tool, "stryker-cxx");
  });

  it("defaults score to 1 when nothing was scored", () => {
    const report = {
      target_files: [],
      total: 0,
      killed: 0,
      survived: 0,
      build_error: 0,
      mutants: [],
      score: 100.0,
    };
    const result = parseCxxSource(JSON.stringify(report), "stryker-cxx");
    assert.equal(result.killed, 0);
    assert.equal(result.survived, 0);
    assert.equal(result.ignored, 0);
    assert.equal(result.score, 1);
  });

  it("parses ignored stryker-cxx mutants from status when count is absent", () => {
    const report = {
      schemaVersion: "stryker-cxx.report.v1",
      totalMutants: 1,
      killed: 0,
      survived: 0,
      buildErrors: 0,
      timeouts: 0,
      score: 1,
      mutants: [
        {
          mutator: "EqualityOperator",
          file: "x.cpp",
          line: 3,
          col: 4,
          original: "==",
          mutated: "!=",
          status: "IGNORED",
          detail: "equivalent",
        },
      ],
    };

    const result = parseCxxSource(JSON.stringify(report), "stryker-cxx");
    assert.equal(result.totalMutants, 1);
    assert.equal(result.ignored, 1);
    assert.equal(result.score, 1);
    assert.equal(result.survivingMutants.length, 0);
  });

  it("treats failed stryker-cxx dry runs as infrastructure errors", () => {
    const report = {
      schemaVersion: "stryker-cxx.report.v1",
      tool: "stryker-cxx",
      targetFiles: ["x.cpp"],
      totalMutants: 1,
      killed: 0,
      survived: 0,
      buildErrors: 0,
      timeouts: 0,
      ignored: 0,
      score: 1,
      dryRun: {
        status: "FAILED",
        failureReason: "initial tests failed",
      },
      mutants: [],
    };

    const result = parseCxxSource(JSON.stringify(report), "stryker-cxx");
    assert.equal(result.error, "initial tests failed");
    assert.deepEqual(result.dryRun, { status: "FAILED", failureReason: "initial tests failed" });
  });
});
