/**
 * Regular-expression checks for user-authored "matches" conditions (event triggers, routine
 * workflow conditions and filters).
 *
 * The pattern is user-authored, but the text it runs against comes from whoever can send an
 * event or shape a payload (channel messages, email, webhooks, connector output). JavaScript
 * regexes backtrack, so a pattern such as `(a+)+$` plus crafted text could run for minutes on the
 * main-process event loop and freeze the app. Two layers keep that from happening:
 *
 * - On save, `describePatternProblem` refuses patterns that do not compile and patterns the
 *   safe-regex2 checker flags (repeats inside repeats, or too many repeats).
 * - On every check, `matchesPattern` / `matchesPatternEach` read at most `MAX_MATCH_FIELD_CHARS`
 *   of each text and give each text at most `MATCH_TIME_LIMIT_MS`. A caller that runs many checks
 *   in one go (a routine run) also passes a `MatchTimeBudget` that caps their total. The checker
 *   misses some slow patterns (`\d+\d+x` is cubic), patterns saved before it existed are never
 *   re-checked, and a routine can take its pattern from run data, so these limits are the actual
 *   guarantee.
 *
 * A linear-time engine (re2) would remove the problem at the root, but it is a node-gyp module
 * with no Electron prebuilds and would join better-sqlite3 and node-pty in the native rebuild path.
 */

import vm from "node:vm";
import safeRegex from "safe-regex2";

/** Longest text a "matches" check reads; longer text is checked from its start. */
export const MAX_MATCH_FIELD_CHARS = 20_000;

/**
 * Wall-clock limit for one "matches" check. Ordinary patterns finish in well under a millisecond
 * on capped text; the margin covers a garbage-collection pause landing mid-check.
 */
export const MATCH_TIME_LIMIT_MS = 50;

/** Time a series of checks may spend together; each check subtracts what it used. */
export interface MatchTimeBudget {
  readonly totalMs: number;
  remainingMs: number;
}

export function createMatchTimeBudget(totalMs: number): MatchTimeBudget {
  return { totalMs, remainingMs: totalMs };
}

/** Thrown when a `MatchTimeBudget` runs out while texts are still waiting to be checked. */
export class MatchTimeBudgetError extends Error {
  constructor(totalMs: number) {
    super(
      `"matches" checks took more than ${totalMs} ms in total, so they were stopped. Simplify the pattern.`,
    );
    this.name = "MatchTimeBudgetError";
  }
}

/**
 * safe-regex2 parses patterns with `ret`, which cannot read lookbehind or inline modifier groups
 * and would report them as unsafe. Both nest like a plain group, so reading them as `(?:` keeps the
 * repeat structure the checker looks at.
 */
const CHECKER_UNREADABLE_GROUP = /\(\?(?:<[=!]|[a-zA-Z]*-?[a-zA-Z]*:)/g;

/** True when the checker flags the pattern as one that can backtrack catastrophically. */
export function findUnsafePattern(source: string): boolean {
  return !safeRegex(source.replace(CHECKER_UNREADABLE_GROUP, "(?:"));
}

/**
 * Why a "matches" pattern should be refused on save, or null when it is fine: it does not compile
 * (the check would read it as "no match" forever), or it could backtrack catastrophically.
 */
export function describePatternProblem(source: string): string | null {
  const shown = source.slice(0, 80);
  try {
    new RegExp(source, "i");
  } catch {
    return `"${shown}" is not a valid regular expression.`;
  }
  if (findUnsafePattern(source)) {
    return `"${shown}" can take too long on some text. Simplify it, for example avoid repeats inside repeats like (a+)+.`;
  }
  return null;
}

let matchContext: vm.Context | null = null;
let matchScript: vm.Script | null = null;

/** Case-insensitive `pattern.test(text)` under the limits above; see `matchesPatternEach`. */
export function matchesPattern(source: string, text: string, budget?: MatchTimeBudget): boolean {
  return matchesPatternEach(source, [text], budget)[0];
}

/**
 * Case-insensitive `pattern.test(text)` for each text. A pattern that does not compile, or a text
 * whose check runs out of time, counts as no match. Throws `MatchTimeBudgetError` when `budget`
 * runs out before every text has been checked.
 */
export function matchesPatternEach(
  source: string,
  texts: readonly string[],
  budget?: MatchTimeBudget,
): boolean[] {
  const results = texts.map(() => false);
  if (texts.length === 0) return results;
  let pattern: RegExp;
  try {
    pattern = new RegExp(source, "i");
  } catch {
    return results;
  }

  // vm's timeout is the only way to interrupt a running regex synchronously: V8 checks for
  // termination on backtracking loop edges. The context holds no globals; it exists only to run
  // this loop under a watchdog. One run covers many texts, so a long list costs one watchdog, not
  // one per text.
  const context = (matchContext ??= vm.createContext(Object.create(null)));
  matchScript ??= new vm.Script(
    "for (; index < texts.length; index++) results[index] = pattern.test(texts[index]);",
  );
  context.pattern = pattern;
  context.texts = texts.map((text) => text.slice(0, MAX_MATCH_FIELD_CHARS));
  context.results = results;
  try {
    let start = 0;
    while (start < texts.length) {
      if (budget && budget.remainingMs <= 0) throw new MatchTimeBudgetError(budget.totalMs);
      const limitMs = Math.min(MATCH_TIME_LIMIT_MS, budget?.remainingMs ?? MATCH_TIME_LIMIT_MS);
      context.index = start;
      const startedAt = performance.now();
      let finished = false;
      try {
        matchScript.runInContext(context, { timeout: Math.max(1, Math.ceil(limitMs)) });
        finished = true;
      } catch {
        // Out of time (or the engine gave up) while checking texts[context.index].
      }
      if (budget) budget.remainingMs -= performance.now() - startedAt;
      if (finished) break;
      if (budget && budget.remainingMs <= 0) throw new MatchTimeBudgetError(budget.totalMs);
      const stopped = context.index as number;
      // When earlier texts used part of the turn, the stopped text gets a full turn of its own.
      // When it had the whole turn to itself, it is too slow: no match, move past it.
      start = stopped > start ? stopped : stopped + 1;
    }
  } finally {
    context.pattern = undefined;
    context.texts = undefined;
    context.results = undefined;
    context.index = undefined;
  }
  return results;
}
