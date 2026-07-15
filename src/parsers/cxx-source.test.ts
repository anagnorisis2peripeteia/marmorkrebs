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

  it("#24: fails closed when the mutants array shows more survivors than the top-level counts", () => {
    // Summary hides a survivor: killed:1, survived:0, score:1 — but the array carries a SURVIVED
    // mutant. The score-based verdict would PASS; the array contradiction must fail closed.
    const report = {
      total: 1,
      killed: 1,
      survived: 0,
      score: 1,
      mutants: [
        {
          mutator: "LogicalOperator",
          file: "a.cpp",
          line: 1,
          col: 1,
          original: "&&",
          mutated: "||",
          status: "SURVIVED",
          detail: "",
        },
      ],
    };
    const result = parseCxxSource(JSON.stringify(report), "stryker-cxx");
    assert.ok(result.error, "expected a fail-closed error on the summary/array contradiction");
    assert.match(result.error ?? "", /contradicts the array|survivor/i);
  });

  it("#24: a filtered SUBSET (array-count <= summary-count) still passes — no false reject", () => {
    // Under --scope-lines the array is a subset: 2 survivors reported, only 1 in the (scoped) array.
    // array-survivors(1) <= summary-survived(2) => no contradiction, must NOT fail closed.
    const report = {
      total: 5,
      killed: 3,
      survived: 2,
      score: 0.6,
      mutants: [
        { mutator: "L", file: "a.cpp", line: 1, col: 1, original: "&&", mutated: "||", status: "SURVIVED", detail: "" },
      ],
    };
    const result = parseCxxSource(JSON.stringify(report), "stryker-cxx");
    assert.equal(result.error, null);
    assert.equal(result.survived, 2);
  });

  it("#24: fails closed when the survived key is OMITTED but the array carries a survivor (bypass)", () => {
    // The parser does not derive `survived` from the array — an absent count defaults to 0
    // (cxx-source.ts:578), and the cxx verdict uses report.score (here 1). So a summary that hides a
    // survivor by DELETING the key (not lying `survived: 0`) would score a perfect 1 with a visible
    // survivor. The guard compares against the RESOLVED survived (0), so this fails closed just like
    // the explicit `survived: 0` case. (Real stryker-cxx reports always emit survived, so no valid
    // run is affected.)
    const report = {
      schemaVersion: "stryker-cxx.report.v1",
      totalMutants: 1,
      killed: 1,
      score: 1,
      // survived key intentionally absent
      mutants: [{ status: "SURVIVED", file: "a.cpp", line: 1, col: 1, mutator: "m", original: "x", mutated: "y", detail: "" }],
    };
    const result = parseCxxSource(JSON.stringify(report), "stryker-cxx");
    assert.ok(result.error, "a survivor with the survived key omitted must fail closed");
    assert.match(result.error ?? "", /contradicts the array|survivor/i);
  });

  it("#24: fails closed when the array shows more no-coverage mutants than the summary claims", () => {
    // Same fail-open class as survivors: no-coverage counts as UNDETECTED in mutationScore, so a
    // no-coverage mutant hidden from the top-level count inflates the score just like a survivor.
    const report = {
      killed: 1,
      survived: 0,
      no_coverage: 0,
      score: 1,
      mutants: [
        { mutator: "m", file: "a.cpp", line: 1, col: 1, original: "x", mutated: "y", status: "NO_COVERAGE", detail: "" },
      ],
    };
    const result = parseCxxSource(JSON.stringify(report), "stryker-cxx");
    assert.ok(result.error, "expected a fail-closed error on the no-coverage contradiction");
    assert.match(result.error ?? "", /no-coverage|uncovered/i);
  });

  it("#25 twin: a no-coverage-only report with no score field scores 0, not a vacuous 1", () => {
    // killed + survived === 0 with the `score` key omitted used to fall back to a perfect 1.0 — the
    // same "a run that detected nothing scores perfect" footgun as #25. The report is internally
    // consistent (noCoverage:2 matches the array, so both #24 guards pass), so only the fallback
    // governs the score. It must be 0.
    const report = {
      schemaVersion: "stryker-cxx.report.v1",
      totalMutants: 2,
      killed: 0,
      survived: 0,
      no_coverage: 2,
      // score key intentionally absent
      mutants: [
        { mutator: "m", file: "a.cpp", line: 1, col: 1, original: "x", mutated: "y", status: "NO_COVERAGE", detail: "" },
        { mutator: "m", file: "b.cpp", line: 2, col: 1, original: "x", mutated: "y", status: "NO_COVERAGE", detail: "" },
      ],
    };
    const result = parseCxxSource(JSON.stringify(report), "stryker-cxx");
    assert.equal(result.error, null);
    assert.equal(result.score, 0, "a run that killed nothing must not score a vacuous 1.0");
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
      artifactPath: "bazel-bin/lib/libtarget.a",
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
      since: "origin/main",
      maxMutants: 5,
      timeoutMs: 9000,
      timeoutFactor: 2,
      timeoutConstantMs: 750,
      thresholdHigh: 0.9,
      thresholdLow: 0.7,
      thresholdBreak: 0.5,
      mutationLevel: "Advanced",
      ignoreMutations: "EqualityOperator",
      mode: "clang-ast",
      executionMode: "mutant-switch",
      executionBackend: "mutant-switch",
      equivalentSuppression: "off",
      coverageFile: "coverage.json",
      coverageAnalysis: "perTest",
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
      distributionManifest: "distribution.json",
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
      dashboardUploadRetries: 2,
      dashboardUploadRetryDelayMs: 0,
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
    assert.ok(command.includes("--artifact-path 'bazel-bin/lib/libtarget.a'"));
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
    assert.ok(command.includes("--since 'origin/main'"));
    assert.ok(command.includes("--mutation-level 'Advanced'"));
    assert.ok(command.includes("--ignore-mutations 'EqualityOperator'"));
    assert.ok(command.includes("--mode 'clang-ast'"));
    assert.ok(command.includes("--execution-mode 'mutant-switch'"));
    assert.ok(command.includes("--execution-backend 'mutant-switch'"));
    assert.ok(command.includes("--equivalent-suppression 'off'"));
    assert.ok(command.includes("--coverage-file 'coverage.json'"));
    assert.ok(command.includes("--coverage-analysis 'perTest'"));
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
    assert.ok(command.includes("--distribution-manifest 'distribution.json'"));
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
    assert.ok(command.includes("--dashboard-upload-retries 2"));
    assert.ok(command.includes("--dashboard-upload-retry-delay-ms 0"));
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

  it("forwards file line-suffixes as --lines for stryker-cxx", () => {
    const command = buildCxxSourceCommand(
      ["src/foo.cpp:12", "src/foo.cpp:28-33", "src/bar.cpp:7"],
      "/repo",
      {
        tool: "stryker-cxx",
        buildCommand: "ninja -C build target",
        testCommand: "./target_test",
        base: "origin/main",
      },
    );

    assert.ok(command.includes("--files 'src/foo.cpp,src/bar.cpp'"));
    assert.ok(command.includes("--lines '12,28-33,7'"));
    assert.ok(command.includes("--base 'origin/main'"));
  });

  it("forwards --include-metal so stryker-cxx mutates .metal kernels", () => {
    const command = buildCxxSourceCommand(
      ["aten/src/ATen/native/mps/kernels/RenormKernel.metal"],
      "/repo",
      {
        tool: "stryker-cxx",
        buildCommand: "xcrun metal -o build/k.metallib src/k.metal",
        testCommand: "./hosttest",
        includeMetal: true,
      },
    );
    assert.ok(command.includes("--include-metal"), command);
    assert.ok(command.includes("RenormKernel.metal"), command);
  });

  it("omits --include-metal when Metal mutation was not requested", () => {
    const command = buildCxxSourceCommand(["src/foo.cpp"], "/repo", {
      tool: "stryker-cxx",
      buildCommand: "ninja -C build target",
      testCommand: "./target_test",
    });
    assert.ok(!command.includes("--include-metal"), command);
  });

  it("builds mull command with stryker-cxx fallback when needed", () => {
    const command = buildCxxSourceCommand(
      ["src/foo.cpp:12", "src/bar.cpp"],
      "/repo",
      {
        tool: "mull",
        buildCommand: "ninja -C build target",
        testCommand: "./target_test",
        mullBinary: "mull-cxx",
        strykerCxxBinary: "/usr/local/bin/stryker-cxx",
      },
    );

    assert.ok(command.includes("if command -v 'mull-cxx' >/dev/null 2>&1"));
    assert.ok(command.includes("'mull-cxx' run"));
    assert.ok(command.includes("'/usr/local/bin/stryker-cxx' run"));
    assert.ok(command.includes("--files 'src/foo.cpp,src/bar.cpp'"));
    assert.ok(command.includes("--lines '12'"));
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
      coverage: {
        enabled: true,
        analysis: "perTest",
        testSelectedMutants: 3,
      },
      baseline: {
        enabled: true,
        cacheHits: 1,
        cacheWrites: 2,
      },
      execution: {
        mutationLevel: "Advanced",
        enabledMutators: ["ArithmeticOperator", "EqualityOperator"],
        ignoredMutators: ["EqualityOperator"],
        since: "origin/main",
        executionMode: "mutant-switch",
        requestedExecutionMode: "mutant-switch",
        analysis: {
          sourcePrecision: {
            schemaVersion: "stryker-cxx.source-precision.v1",
            totalMutants: 5,
          },
        },
        artifactBackend: "source-overlay",
        requestedArtifactBackend: "compiled-executable",
        artifactFallback: "source-overlay",
        artifactFallbackReason:
          "--artifact-backend compiled-executable does not support --build-system meson; falling back to source-overlay",
        testScheduler: {
          schemaVersion: "stryker-cxx.test-scheduler.v1",
          sessions: 1,
        },
        mutantSwitch: {
          enabled: true,
          runtimeGuardCount: 1,
        },
        llvmSwitch: {
          enabled: true,
          implementation: "guarded-source-switch",
        },
        compilePruning: {
          strategy: "mutant-switch-prune-and-retry",
          attempts: 1,
          retryBatches: 1,
          prunedMutants: 1,
        },
        reporters: ["html", "dashboard"],
        reporterRuns: [{ name: "html", status: "passed" }],
        dashboard: {
          export: { enabled: true, path: "dashboard.json" },
          upload: { enabled: false },
        },
        resourceIsolation: {
          worktreeMode: "copy",
          environmentKeys: ["SECRET_TOKEN"],
          redaction: { enabled: true, replacement: "[REDACTED]" },
        },
        parity: { schemaVersion: "stryker-cxx.parity.v1" },
      },
      parity: { schemaVersion: "stryker-cxx.parity.v1" },
      lifecycle: { schemaVersion: "stryker-cxx.lifecycle.v1" },
      artifactPlacement: { mode: "mutant-switch" },
      projectAnalysis: {
        confidence: "high",
        buildGraph: {
          schemaVersion: "stryker-cxx.build-graph.v1",
          ownershipModel: "compile-database",
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
    assert.deepEqual(result.provider, {
      name: "stryker-cxx",
      schemaVersion: "stryker-cxx.report.v1",
      mutationLevel: "Advanced",
      enabledMutators: ["ArithmeticOperator", "EqualityOperator"],
      ignoredMutators: ["EqualityOperator"],
      since: "origin/main",
      executionMode: "mutant-switch",
      requestedExecutionMode: "mutant-switch",
      analysis: {
        sourcePrecision: {
          schemaVersion: "stryker-cxx.source-precision.v1",
          totalMutants: 5,
        },
      },
      sourcePrecision: {
        schemaVersion: "stryker-cxx.source-precision.v1",
        totalMutants: 5,
      },
      artifactBackend: "source-overlay",
      requestedArtifactBackend: "compiled-executable",
      artifactFallback: "source-overlay",
      artifactFallbackReason:
        "--artifact-backend compiled-executable does not support --build-system meson; falling back to source-overlay",
      testScheduler: {
        schemaVersion: "stryker-cxx.test-scheduler.v1",
        sessions: 1,
      },
      coverage: {
        enabled: true,
        analysis: "perTest",
        testSelectedMutants: 3,
      },
      baseline: {
        enabled: true,
        cacheHits: 1,
        cacheWrites: 2,
      },
      mutantSwitch: {
        enabled: true,
        runtimeGuardCount: 1,
      },
      llvmSwitch: {
        enabled: true,
        implementation: "guarded-source-switch",
      },
      compilePruning: {
        strategy: "mutant-switch-prune-and-retry",
        attempts: 1,
        retryBatches: 1,
        prunedMutants: 1,
      },
      reporters: ["html", "dashboard"],
      reporterRuns: [{ name: "html", status: "passed" }],
      dashboard: {
        export: { enabled: true, path: "dashboard.json" },
        upload: { enabled: false },
      },
      parity: { schemaVersion: "stryker-cxx.parity.v1" },
      lifecycle: { schemaVersion: "stryker-cxx.lifecycle.v1" },
      artifactPlacement: { mode: "mutant-switch" },
      projectAnalysis: {
        confidence: "high",
        buildGraph: {
          schemaVersion: "stryker-cxx.build-graph.v1",
          ownershipModel: "compile-database",
        },
      },
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

  it("fails closed for valid JSON that is not an object report", () => {
    // JSON.parse SUCCEEDS on all of these (found by einsiedlerkrebs's property
    // run); the parser must reject them, not degrade to a clean zero-mutant pass.
    for (const output of ["null", "[]", "[1, 2, 3]", "42", "true", '"text"']) {
      const result = parseCxxSource(output, "stryker-cxx");

      assert.equal(result.tool, "stryker-cxx");
      assert.equal(result.totalMutants, 0);
      assert.equal(result.survivingMutants.length, 0);
      assert.match(result.error ?? "", /expected a top-level JSON object/);
    }
  });

  it("fails closed when mutants is present but is not an array", () => {
    for (const output of ['{"mutants":5}', '{"mutants":"nope"}', '{"mutants":{}}']) {
      const result = parseCxxSource(output, "stryker-cxx");

      assert.equal(result.totalMutants, 0);
      assert.match(result.error ?? "", /expected mutants to be an array/);
    }
  });

  it("fails closed when a mutant entry is not an object", () => {
    // Cover each disqualifying shape so every clause of the guard is exercised:
    // null, a primitive (non-object), and an array (typeof is "object").
    for (const output of [
      '{"mutants":[null]}',
      '{"mutants":[42]}',
      '{"mutants":["text"]}',
      '{"mutants":[[1]]}',
    ]) {
      const result = parseCxxSource(output, "stryker-cxx");

      assert.equal(result.totalMutants, 0);
      assert.match(result.error ?? "", /expected every mutant to be an object/);
    }
  });

  it("fails closed when a mutant entry has no known status", () => {
    // #22 rejects non-object elements; an object-shaped element with a missing or unknown
    // status (`{}`, `{status:"CORRUPT"}`) is still corrupt evidence that would otherwise pass
    // on the trusted top-level counts (score 1.0) — the cardinal fail-open. First mutant
    // captured from a real stryker-cxx 0.1.0 run on fixtures/stryker-cxx (2026-07-14).
    const capturedKilled = {
      mutator: "EqualityOperator",
      file: "calc.cpp",
      line: 17,
      col: 26,
      original: "!=",
      mutated: "==",
      status: "KILLED",
      id: "calc.cpp:17:26:EqualityOperator:119f2d77e17f",
    };
    for (const corrupt of [{}, { mutator: "AOR" }, { status: "" }, { status: "CORRUPT" }]) {
      const output = JSON.stringify({ killed: 2, score: 1, mutants: [capturedKilled, corrupt] });
      const result = parseCxxSource(output, "stryker-cxx");
      assert.equal(result.totalMutants, 0);
      assert.match(
        result.error ?? "",
        /expected every mutant to carry a known stryker-cxx status/,
        `corrupt mutant ${JSON.stringify(corrupt)} must fail closed`,
      );
    }
  });

  it("accepts real stryker-cxx statuses case- and separator-insensitively and tallies them", () => {
    // report.v1 uppercases the vocabulary; a future casing/separator drift must not falsely
    // fail a valid report, and — crucially — an accepted non-uppercase survivor/ignored must
    // still be tallied (validation and the tallies share one canonical form).
    // `survived: 1` keeps the fixture internally consistent for the "Survived" iteration: without a
    // survived count, the #24 cross-check correctly reads a lone array survivor as contradicting an
    // (absent → 0) summary claim. This test only asserts status-string acceptance, so a matching
    // count preserves that intent without encoding a summary/array contradiction.
    for (const status of ["KILLED", "Survived", "NO_COVERAGE", "no-coverage", "Timeout", "RUNTIME_ERROR", "Pending"]) {
      const r = parseCxxSource(JSON.stringify({ killed: 1, survived: 1, mutants: [{ status }] }), "stryker-cxx");
      assert.ok(!r.error, `status ${status} must be accepted, got: ${r.error}`);
    }
    const survivor = parseCxxSource(
      JSON.stringify({
        survived: 1,
        mutants: [{ status: "Survived", file: "a.cpp", line: 1, mutator: "m", original: "x", mutated: "y" }],
      }),
      "stryker-cxx",
    );
    assert.equal(survivor.survivingMutants.length, 1, "a mixed-case Survived mutant must still be counted");
    const ign = parseCxxSource(
      JSON.stringify({ mutants: [{ status: "Ignored", file: "a.cpp", line: 1, mutator: "m", original: "x", mutated: "y" }] }),
      "stryker-cxx",
    );
    assert.equal(ign.ignored, 1, "a mixed-case Ignored mutant must still be counted");
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

  it("enforces requested stryker-cxx review parity profile", () => {
    const report = {
      schemaVersion: "stryker-cxx.report.v1",
      tool: "stryker-cxx",
      totalMutants: 0,
      killed: 0,
      survived: 0,
      buildErrors: 0,
      timeouts: 0,
      ignored: 0,
      score: 1,
      mutants: [],
      parity: {
        schemaVersion: "stryker-cxx.parity.v1",
        items: [
          { id: "coverage-scheduler", status: "missing" },
          { id: "marmorkrebs-review-ux", status: "external" },
        ],
      },
    };

    const result = parseCxxSource(JSON.stringify(report), "stryker-cxx", {
      parityProfile: "review",
    });

    assert.match(result.error ?? "", /coverage-scheduler=missing/);
    assert.deepEqual(result.provider?.parityGate, {
      profile: "review",
      status: "failed",
      failures: ["coverage-scheduler=missing"],
    });
  });

  it("allows covered and external items under strict stryker-cxx parity profile", () => {
    const report = {
      schemaVersion: "stryker-cxx.report.v1",
      tool: "stryker-cxx",
      totalMutants: 0,
      killed: 0,
      survived: 0,
      buildErrors: 0,
      timeouts: 0,
      ignored: 0,
      score: 1,
      mutants: [],
      parity: {
        schemaVersion: "stryker-cxx.parity.v1",
        items: [
          { id: "mutator-levels", status: "covered" },
          { id: "marmorkrebs-review-ux", status: "external" },
        ],
      },
    };

    const result = parseCxxSource(JSON.stringify(report), "stryker-cxx", {
      parityProfile: "strict",
    });

    assert.equal(result.error, null);
    assert.deepEqual(result.provider?.parityGate, {
      profile: "strict",
      status: "passed",
      failures: [],
    });
  });
});

describe("report chains preserve the runner exit code", () => {
  const cfg = { tool: "stryker-cxx", buildCommand: "make", testCommand: "ctest" } as any;

  it("external stryker-cxx: never `&& cat` (exit 2 must not mask the report)", () => {
    const cmd = buildCxxSourceCommand(["src/a.cpp"], "/repo", cfg);
    assert.ok(!cmd.includes('&& cat "$report"'), "&& cat drops the report on exit 2");
    assert.ok(cmd.includes('; code=$?; cat "$report"; rm -f "$report"; exit $code'));
  });

  it("mull-with-fallback: same exit-preserving shape", () => {
    const cmd = buildCxxSourceCommand(["src/a.cpp"], "/repo", { ...cfg, tool: "mull" });
    assert.ok(!cmd.includes('&& cat "$report"'));
    assert.ok(cmd.includes('; code=$?; cat "$report"; rm -f "$report"; exit $code'));
  });
});

describe("removed built-in engine branch", () => {
  it("a config reaching the old fallthrough throws instead of running unvalidated code", () => {
    assert.throws(
      () => buildCxxSourceCommand(["a.cpp"], "/repo", { tool: "gomu", buildCommand: "make", testCommand: "ctest" } as any),
      /unsupported cxx-source configuration/,
    );
  });
});
