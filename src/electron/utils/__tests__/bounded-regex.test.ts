import { describe, expect, it } from "vitest";
import {
  createMatchTimeBudget,
  describePatternProblem,
  MATCH_TIME_LIMIT_MS,
  matchesPattern,
  matchesPatternEach,
  MatchTimeBudgetError,
} from "../bounded-regex";

const crafted = `${"a".repeat(40)}!`;

function elapsed(run: () => void): number {
  const started = performance.now();
  run();
  return performance.now() - started;
}

describe("matchesPatternEach", () => {
  it("answers each text case-insensitively", () => {
    expect(matchesPatternEach("^inv-\\d+$", ["INV-784", "inv-1", "invoice", ""])).toEqual([
      true,
      true,
      false,
      false,
    ]);
    expect(matchesPatternEach("[", ["["])).toEqual([false]);
    expect(matchesPatternEach("x", [])).toEqual([]);
  });

  it("counts only the slow texts as no match", () => {
    let results: boolean[] = [];
    const ms = elapsed(() => {
      results = matchesPatternEach("(a+)+$", ["aaa", crafted, "aaaa", crafted, "a"]);
    });
    expect(results).toEqual([true, false, true, false, true]);
    // Each slow text costs at most two turns.
    expect(ms).toBeLessThan(4 * MATCH_TIME_LIMIT_MS + 1_000);
  });

  it("does not drop a fast text that was running when a shared turn ran out", () => {
    // Each text takes a few ms (\d+\d+x is cubic in the digit run) before y$ matches, so 30 of
    // them cross several 50 ms turns. Every one must still match.
    const texts = Array.from({ length: 30 }, () => `${"1".repeat(300)}y`);
    expect(matchesPatternEach("\\d+\\d+x|y$", texts)).toEqual(texts.map(() => true));
  });

  it("throws once a shared budget is spent and stays within it", () => {
    const budget = createMatchTimeBudget(120);
    let thrown: unknown;
    const ms = elapsed(() => {
      try {
        matchesPatternEach(
          "(a+)+$",
          Array.from({ length: 20 }, () => crafted),
          budget,
        );
      } catch (error) {
        thrown = error;
      }
    });
    expect(thrown).toBeInstanceOf(MatchTimeBudgetError);
    expect((thrown as Error).message).toContain("took more than 120 ms in total");
    expect(ms).toBeLessThan(120 + MATCH_TIME_LIMIT_MS + 1_000);
    expect(() => matchesPattern("a", "a", budget)).toThrow(MatchTimeBudgetError);
  });

  it("charges ordinary checks only what they use", () => {
    const budget = createMatchTimeBudget(500);
    for (let index = 0; index < 100; index += 1) {
      expect(matchesPattern("urgent|asap", "please do this ASAP", budget)).toBe(true);
    }
    expect(budget.remainingMs).toBeGreaterThan(250);
  });
});

describe("describePatternProblem", () => {
  it("explains invalid and catastrophic patterns and passes ordinary ones", () => {
    expect(describePatternProblem("urgent(")).toBe('"urgent(" is not a valid regular expression.');
    expect(describePatternProblem("(a+)+$")).toContain("can take too long on some text");
    expect(describePatternProblem("(?<=#)\\d+")).toBeNull();
    expect(describePatternProblem("urgent|asap")).toBeNull();
  });
});
