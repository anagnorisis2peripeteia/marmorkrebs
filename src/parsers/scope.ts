// Shared changed-line scoping for lanes whose reports carry line numbers.
// Entries look like "src/f.ts", "src/f.ts:12-40", or "src/f.ts:7"; a file may
// appear with several ranges. A file entry WITHOUT ranges means whole-file scope.

export interface ScopedTarget {
  file: string;
  /** Inclusive line ranges; empty = whole file. */
  ranges: Array<[number, number]>;
}

export function parseScopedTargets(entries: string[]): ScopedTarget[] {
  const byFile = new Map<string, { ranges: Array<[number, number]>; whole: boolean }>();
  for (const entry of entries) {
    const m = entry.match(/^(.*?):(\d+)(?:-(\d+))?$/);
    const file = m ? m[1] : entry;
    const existing = byFile.get(file) ?? { ranges: [], whole: false };
    if (m) {
      const start = parseInt(m[2], 10);
      const end = m[3] === undefined ? start : parseInt(m[3], 10);
      existing.ranges.push([start, end]);
    } else {
      existing.whole = true; // a bare entry means whole-file scope — it WINS over ranges
    }
    byFile.set(file, existing);
  }
  return [...byFile].map(([file, v]) => ({ file, ranges: v.whole ? [] : v.ranges }));
}

export function matchesScope(
  filePath: string,
  line: number,
  targets: ScopedTarget[],
): boolean {
  for (const t of targets) {
    const fileHit = filePath === t.file || filePath.endsWith(`/${t.file}`);
    if (!fileHit) continue;
    if (t.ranges.length === 0) return true; // whole-file scope
    // line 0 = "unknown line" (lane has no line info): a ranged entry still
    // matches the file so those lanes degrade to file scope, not silence.
    if (line === 0) return true;
    if (t.ranges.some(([s, e]) => line >= s && line <= e)) return true;
  }
  return false;
}
