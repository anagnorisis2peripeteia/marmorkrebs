import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_EQUIVALENT_MODE,
  classifyEquivalentMutant,
  normalizeEquivalentMode,
  shouldSuppress,
} from "./equivalent-mutants.js";

const lines = (src: string) => src.replace(/^\n/, "").split("\n");

describe("classifyEquivalentMutant — logging-only", () => {
  const src = lines(`
public void DoThing() {
    _logger.LogInformation("starting thing");
    Compute();
}
`);

  it("flags a StringLiteral mutation on a bare logger call as logging-only", () => {
    const c = classifyEquivalentMutant({ mutator: "StringLiteral", startLine: 2 }, src);
    assert.equal(c.equivalent, true);
    assert.equal(c.manual, false);
    assert.match(c.reason ?? "", /^logging-only:/);
  });

  it("flags removal of a logger call (BlockStatement) as logging-only", () => {
    const c = classifyEquivalentMutant({ mutator: "BlockStatement", startLine: 2 }, src);
    assert.equal(c.equivalent, true);
    assert.match(c.reason ?? "", /call removed/);
  });

  it("recognises the Serilog static `Log.Information(...)` receiver", () => {
    const s = lines(`
void M() {
    Log.Information("hello {0}", x);
}
`);
    const c = classifyEquivalentMutant({ mutator: "StringLiteral", startLine: 2 }, s);
    assert.equal(c.equivalent, true);
  });

  it("recognises a multi-line logger statement (call opens on the span's first line)", () => {
    const s = lines(`
void M() {
    _logger.LogWarning(
        "msg {0}", value);
}
`);
    const c = classifyEquivalentMutant({ mutator: "StringLiteral", startLine: 2, endLine: 3 }, s);
    assert.equal(c.equivalent, true);
  });
});

describe("classifyEquivalentMutant — NOT equivalent (guards)", () => {
  it("does not classify a string mutation on a non-logger call", () => {
    const s = lines(`
void M() {
    service.Process("payload");
}
`);
    assert.equal(classifyEquivalentMutant({ mutator: "StringLiteral", startLine: 2 }, s).equivalent, false);
  });

  it("does not classify when an identifier merely ends in 'log' (catalog/dialog/backlog)", () => {
    for (const recv of ["catalog", "dialog", "backlog"]) {
      const s = lines(`
void M() {
    ${recv}.WriteLine("x");
}
`);
      assert.equal(
        classifyEquivalentMutant({ mutator: "StringLiteral", startLine: 2 }, s).equivalent,
        false,
        `${recv} should not be treated as a logger`,
      );
    }
  });

  it("does not classify when the logger call's result is consumed (assignment)", () => {
    const s = lines(`
void M() {
    bool ok = _logger.LogAndCheck("x");
}
`);
    assert.equal(classifyEquivalentMutant({ mutator: "StringLiteral", startLine: 2 }, s).equivalent, false);
  });

  it("does not classify when the logger call is used as a condition", () => {
    const s = lines(`
void M() {
    if (_logger.LogIf("x")) { return; }
}
`);
    assert.equal(classifyEquivalentMutant({ mutator: "StringLiteral", startLine: 2 }, s).equivalent, false);
  });

  it("does not classify an arithmetic/equality mutation inside a logger call (value may have side effects)", () => {
    const s = lines(`
void M() {
    _logger.LogInformation("n={0}", count + 1);
}
`);
    assert.equal(classifyEquivalentMutant({ mutator: "ArithmeticOperator", startLine: 2 }, s).equivalent, false);
  });

  it("returns not-equivalent when there is no source to inspect", () => {
    assert.equal(classifyEquivalentMutant({ mutator: "StringLiteral", startLine: 2 }, []).equivalent, false);
  });

  it("returns not-equivalent when the span line is out of range", () => {
    const s = lines(`
void M() {}
`);
    assert.equal(classifyEquivalentMutant({ mutator: "StringLiteral", startLine: 99 }, s).equivalent, false);
  });
});

describe("classifyEquivalentMutant — manual directive & attributes", () => {
  it("treats a `// marmorkrebs-ok` comment as authoritative (manual=true) with its reason", () => {
    const s = lines(`
void M() {
    Compute(); // marmorkrebs-ok: proven equivalent by review
}
`);
    const c = classifyEquivalentMutant({ mutator: "ArithmeticOperator", startLine: 2 }, s);
    assert.equal(c.equivalent, true);
    assert.equal(c.manual, true);
    assert.match(c.reason ?? "", /proven equivalent by review/);
  });

  it("handles a bare `// marmorkrebs-ok` with no reason", () => {
    const s = lines(`
void M() {
    x = y; // marmorkrebs-ok
}
`);
    const c = classifyEquivalentMutant({ mutator: "AssignmentOperator", startLine: 2 }, s);
    assert.equal(c.manual, true);
    assert.equal(c.reason, "manual-suppression");
  });

  it("flags an attribute-only line as compile-constant context", () => {
    const s = lines(`
[Obsolete("use B instead")]
public void A() {}
`);
    const c = classifyEquivalentMutant({ mutator: "StringLiteral", startLine: 1 }, s);
    assert.equal(c.equivalent, true);
    assert.match(c.reason ?? "", /compile-constant-context/);
  });
});

describe("shouldSuppress", () => {
  const manual = { equivalent: true, reason: "manual-suppression", manual: true };
  const heuristic = { equivalent: true, reason: "logging-only: x", manual: false };
  const none = { equivalent: false, reason: null, manual: false };

  it("never suppresses in off mode", () => {
    assert.equal(shouldSuppress(manual, "off"), false);
    assert.equal(shouldSuppress(heuristic, "off"), false);
  });

  it("suppresses a manual directive in annotate and suppress modes", () => {
    assert.equal(shouldSuppress(manual, "annotate"), true);
    assert.equal(shouldSuppress(manual, "suppress"), true);
  });

  it("suppresses a heuristic match only in suppress mode", () => {
    assert.equal(shouldSuppress(heuristic, "annotate"), false);
    assert.equal(shouldSuppress(heuristic, "suppress"), true);
  });

  it("never suppresses a non-equivalent mutant", () => {
    assert.equal(shouldSuppress(none, "suppress"), false);
  });
});

describe("normalizeEquivalentMode", () => {
  it("defaults to annotate for undefined or invalid input", () => {
    assert.equal(normalizeEquivalentMode(undefined), DEFAULT_EQUIVALENT_MODE);
    assert.equal(normalizeEquivalentMode("annotate"), "annotate");
    assert.equal(normalizeEquivalentMode("bogus"), "annotate");
  });

  it("passes through valid modes", () => {
    assert.equal(normalizeEquivalentMode("off"), "off");
    assert.equal(normalizeEquivalentMode("suppress"), "suppress");
  });
});
