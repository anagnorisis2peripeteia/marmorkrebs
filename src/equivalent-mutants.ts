// Equivalent-mutant classification (issue #31).
//
// A surviving mutant is "equivalent" when the mutation cannot change any OBSERVABLE
// behaviour, so no test could ever kill it — counting it as a survivor is reviewer noise,
// not a real test gap. This module recognises the concrete, reliable classes called out in
// #31 (learnings from the Stryker.NET PR stryker-mutator/stryker-net#3715):
//
//   1. Logging-only mutations — mutating/removing an `ILogger`/`ILog`-style call whose result
//      is discarded (the message text is not asserted). Emptying the message string or removing
//      the call changes nothing an unmocked test can see.
//   2. Compile-constant / attribute context — a mutation on an attribute (or other
//      DoNotMutate-adjacent construct) that carries no runtime behaviour. Stryker's
//      DoNotMutateOrchestrator already blocks most of these (they come back Ignored, not
//      Survived), so this is a narrow safety net for the ones that slip through.
//
// It is deliberately NOT a Roslyn/AST analysis — that belongs in the Stryker.NET fork itself.
// Here we classify from the mutation-report's own data: the mutator name plus the mutated
// SOURCE SPAN (mutation-testing-elements reports carry each file's `source`, so no disk read
// is needed). That keeps the classifier lane-agnostic, self-contained, and unit-testable.
//
// Risk posture (marmorkrebs is fail-closed): a HEURISTIC guess must never silently inflate a
// score. So the heuristic classes only ever *annotate* by default; they are removed from the
// threshold denominator only under the explicit `suppress` mode. A `// marmorkrebs-ok` comment
// is a HUMAN directive — authoritative, so it suppresses in every mode except `off`.

/** How the runner treats classified survivors. */
export type EquivalentMode = "off" | "annotate" | "suppress";

export const EQUIVALENT_MODES: ReadonlySet<string> = new Set(["off", "annotate", "suppress"]);

export const DEFAULT_EQUIVALENT_MODE: EquivalentMode = "annotate";

export interface MutantSpan {
  /** Mutator name from the report (e.g. "StringLiteral", "BlockStatement"). */
  mutator: string;
  /** 1-based first source line the mutation covers. */
  startLine: number;
  /** 1-based last source line (defaults to startLine for single-line mutants). */
  endLine?: number;
}

export interface EquivalentClassification {
  /** True when the mutant is (very likely) equivalent — no observable behaviour change. */
  equivalent: boolean;
  /** Human-readable reason (`logging-only: …`, `manual-suppression: …`), or null. */
  reason: string | null;
  /**
   * True only for an in-source `// marmorkrebs-ok` directive. A manual directive is
   * authoritative and suppresses regardless of mode (except `off`); a heuristic match
   * (manual=false) only suppresses under `suppress` mode.
   */
  manual: boolean;
}

const NOT_EQUIVALENT: EquivalentClassification = { equivalent: false, reason: null, manual: false };

// `// marmorkrebs-ok` (optionally `// marmorkrebs-ok: why`) — the reviewer-controlled escape hatch.
const MANUAL_DIRECTIVE = /\/\/\s*marmorkrebs-ok\b\s*:?\s*(.*)$/i;

// A logger call: <receiver>.<LogLevel>( … ). The receiver is captured and validated separately
// (isLoggerReceiver) so "catalog.Write(", "dialog.Show(" etc. — identifiers that merely END in
// "log" — are NOT misread as loggers. `\??\.` allows the null-conditional `logger?.LogX(`.
const LOGGER_CALL =
  /(^|[^\w.])((?:[A-Za-z_]\w*\s*\??\.\s*)*[A-Za-z_]\w*)\s*\??\.\s*(Log[A-Za-z]*|Information|Info|Debug|Trace|Verbose|Warn(?:ing)?|Error|Critical|Fatal|WriteLine|Write)\s*\(/;

// Attribute-only line, e.g. `[Obsolete("x")]` — mutating an attribute argument has no runtime
// effect (attributes are metadata). Stryker usually blocks these, hence "safety net".
const ATTRIBUTE_ONLY_LINE = /^\s*\[[^\]]*\]\s*$/;

/** The receiver of a call is logger-shaped: its final identifier segment names a logger. */
function isLoggerReceiver(receiver: string): boolean {
  const seg = receiver.split(".").map((s) => s.trim()).filter(Boolean).pop() ?? receiver.trim();
  // Exact logger names, with optional leading underscores, an `s_` static prefix, or an `I`
  // interface prefix: log, logger, _logger, s_logger, ilogger, ilog.
  if (/^_*(?:s_)?i?log(?:ger)?$/i.test(seg)) return true;
  // camelCase / PascalCase suffix with a capital-L boundary: appLogger, _myLog, RequestLog.
  // The capital L is what separates a real "…Log(ger)" from "catalog"/"dialog"/"backlog".
  if (/[a-z0-9]Log(?:ger)?$/.test(seg)) return true;
  return false;
}

// String-message mutators (emptying/altering the log text) and call-removal mutators (deleting
// the log statement). These are the mutations that leave a logger call behaviour-neutral. An
// arithmetic/equality/etc. mutation is deliberately EXCLUDED — the mutated value could have a
// side effect or be consumed elsewhere, so it is never auto-classified as logging-only.
const STRING_MESSAGE_MUTATOR = /string|literal|interpolat|regex/i;
const CALL_REMOVAL_MUTATOR = /block|statement|removal|remove|method|void/i;

/**
 * Classify one surviving mutant from its mutator name and the file's source lines.
 * `sourceLines` is the file split on newlines (0-based array; line N is sourceLines[N-1]).
 * Returns NOT_EQUIVALENT when there is no source to inspect or nothing matches.
 */
export function classifyEquivalentMutant(
  span: MutantSpan,
  sourceLines: readonly string[],
): EquivalentClassification {
  if (!sourceLines || sourceLines.length === 0) return NOT_EQUIVALENT;
  const start = Math.max(1, span.startLine || 1);
  const end = Math.max(start, span.endLine ?? start);
  const spanLines: string[] = [];
  for (let n = start; n <= end; n++) {
    const line = sourceLines[n - 1];
    if (typeof line === "string") spanLines.push(line);
  }
  if (spanLines.length === 0) return NOT_EQUIVALENT;

  // 1. Manual directive — authoritative, wins over everything.
  for (const line of spanLines) {
    const m = MANUAL_DIRECTIVE.exec(line);
    if (m) {
      const why = m[1]?.trim();
      return { equivalent: true, reason: why ? `manual-suppression: ${why}` : "manual-suppression", manual: true };
    }
  }

  // 2. Logging-only — a string/removal mutation on a bare, result-discarded logger call.
  const mutator = span.mutator ?? "";
  const stringMut = STRING_MESSAGE_MUTATOR.test(mutator);
  const removalMut = CALL_REMOVAL_MUTATOR.test(mutator);
  if (stringMut || removalMut) {
    for (const line of spanLines) {
      const call = LOGGER_CALL.exec(line);
      if (!call) continue;
      const receiver = call[2];
      if (!isLoggerReceiver(receiver)) continue;
      // Result-not-consumed: the call must be its own statement. Everything before the receiver
      // on this line, once a leading `await` is dropped, must be empty or a statement boundary
      // (`;`, `{`, `}`). A leading `=`, `return`, `(`, `,` etc. means the value is consumed and
      // the mutation could matter — do NOT classify.
      const receiverStart = call.index + call[1].length;
      const prefix = line.slice(0, receiverStart).replace(/\bawait\s*$/, "").trim();
      const bareStatement = prefix === "" || /[;{}]$/.test(prefix);
      if (!bareStatement) continue;
      const kind = stringMut ? "message string not asserted" : "call removed, no observable effect";
      return { equivalent: true, reason: `logging-only: ${kind}`, manual: false };
    }
  }

  // 3. Attribute context — a mutation on an attribute line carries no runtime behaviour.
  if (spanLines.every((l) => ATTRIBUTE_ONLY_LINE.test(l))) {
    return { equivalent: true, reason: "compile-constant-context: attribute mutation, no runtime effect", manual: false };
  }

  return NOT_EQUIVALENT;
}

/**
 * Decide whether a classified mutant is REMOVED from the score (suppressed) vs merely annotated.
 * - `off`: never (no classification runs at all upstream).
 * - manual directive: suppressed in `annotate` and `suppress` (human said so — authoritative).
 * - heuristic match: suppressed only under `suppress`; under `annotate` it is kept + annotated.
 */
export function shouldSuppress(c: EquivalentClassification, mode: EquivalentMode): boolean {
  if (mode === "off" || !c.equivalent) return false;
  if (c.manual) return true;
  return mode === "suppress";
}

/** Normalise a CLI/config string to a valid mode, defaulting when absent/invalid is rejected upstream. */
export function normalizeEquivalentMode(value: string | undefined): EquivalentMode {
  if (value && EQUIVALENT_MODES.has(value)) return value as EquivalentMode;
  return DEFAULT_EQUIVALENT_MODE;
}
