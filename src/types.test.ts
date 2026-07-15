import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mutationScore } from "./types.js";

describe("mutationScore", () => {
  it("#25: an empty run (all zeros) scores 0, not a vacuous 1", () => {
    assert.equal(mutationScore(0, 0, 0, 0), 0);
  });

  it("a perfect score (1) implies at least one DETECTED mutant (property from einsiedlerkrebs)", () => {
    const cases: Array<[number, number, number, number]> = [
      [0, 0, 0, 0],
      [3, 0, 0, 0],
      [0, 2, 0, 0],
      [2, 1, 1, 0],
      [1, 0, 0, 3],
      [0, 0, 5, 0],
      [0, 0, 0, 4],
    ];
    for (const [k, t, s, n] of cases) {
      const score = mutationScore(k, t, s, n);
      if (score === 1) {
        assert.ok(k + t > 0, `score 1 with no detected mutants: ${JSON.stringify([k, t, s, n])}`);
      }
    }
  });

  it("scores normally when there are scorable mutants (timeout counts as detected)", () => {
    assert.equal(mutationScore(3, 0, 1, 0), 0.75);
    assert.equal(mutationScore(1, 1, 0, 0), 1); // all detected (1 killed + 1 timeout)
    assert.equal(mutationScore(0, 0, 1, 0), 0); // one survivor, nothing detected
  });
});
