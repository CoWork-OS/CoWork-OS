/**
 * Regular-expression checks for "matches" trigger conditions.
 *
 * The pattern is user-authored, but the text it runs against comes from whoever can send an
 * event (channel messages, email, webhooks, connector payloads). JavaScript regexes backtrack, so
 * a pattern such as `(a+)+$` plus crafted text could run for minutes on the main-process event
 * loop and freeze the app. Two layers keep that from happening:
 *
 * - On save, `findUnsafePattern` refuses patterns the safe-regex2 checker flags (repeats inside
 *   repeats, or too many repeats).
 * - On every check, `testTriggerPattern` reads at most `MAX_MATCH_FIELD_CHARS` of the field and
 *   stops after `MATCH_TIME_LIMIT_MS`. The checker misses some slow patterns (`\d+\d+x` is
 *   cubic), and triggers saved before it existed are never re-checked, so this limit is the
 *   actual guarantee.
 *
 * A linear-time engine (re2) would remove the problem at the root, but it is a node-gyp module
 * with no Electron prebuilds and would join better-sqlite3 and node-pty in the native rebuild path.
 */

import vm from "node:vm";
import safeRegex from "safe-regex2";

/** Longest field text a "matches" condition reads; longer text is checked from its start. */
export const MAX_MATCH_FIELD_CHARS = 20_000;

/**
 * Wall-clock limit for one "matches" check. Ordinary patterns finish in well under a millisecond
 * on capped text; the margin covers a garbage-collection pause landing mid-check.
 */
export const MATCH_TIME_LIMIT_MS = 50;

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

let matchContext: vm.Context | null = null;
let matchScript: vm.Script | null = null;

/**
 * Case-insensitive `pattern.test(text)` with the length cap and time limit above. A pattern that
 * does not compile, or a check that runs out of time, counts as no match.
 */
export function testTriggerPattern(source: string, text: string): boolean {
  let pattern: RegExp;
  try {
    pattern = new RegExp(source, "i");
  } catch {
    return false;
  }

  // vm's timeout is the only way to interrupt a running regex synchronously: V8 checks for
  // termination on backtracking loop edges. The context holds no globals; it exists only to run
  // this one expression under a watchdog.
  matchContext ??= vm.createContext(Object.create(null));
  matchScript ??= new vm.Script("pattern.test(text)");
  matchContext.pattern = pattern;
  matchContext.text = text.slice(0, MAX_MATCH_FIELD_CHARS);
  try {
    return matchScript.runInContext(matchContext, { timeout: MATCH_TIME_LIMIT_MS }) === true;
  } catch {
    return false;
  } finally {
    matchContext.pattern = undefined;
    matchContext.text = undefined;
  }
}
