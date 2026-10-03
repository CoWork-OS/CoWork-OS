/**
 * Memory `excludedPatterns` are user-supplied regular expressions compiled in the main
 * process and run against every captured memory (SEC-11). A catastrophic-backtracking
 * pattern would freeze the main process, so patterns are bounded and screened with a
 * conservative heuristic before they are stored, and again before they are run (stored
 * settings may predate this check or arrive through another entry point).
 *
 * The heuristic rejects the constructs behind practically all ReDoS reports:
 * - a quantified group that itself contains a quantifier or an alternation
 *   (`(a+)+`, `(a*)*`, `(a|aa)+`, `(\w+\s?)*`);
 * - backreferences and lookarounds (not needed for exclusion filters);
 * - more than two unbounded quantifiers (`.*a.*b.*c`, polynomial blow-up).
 * Simple patterns (`password`, `api[_-]?key`, `secret.*token`, `\d{16}`) still pass.
 */

export const MAX_EXCLUDED_PATTERNS = 50;
export const MAX_EXCLUDED_PATTERN_LENGTH = 200;
const MAX_UNBOUNDED_QUANTIFIERS = 2;

/** Replace escapes and character classes with a neutral atom so only structure remains. */
function stripAtoms(pattern: string): string {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") {
      i++;
      out += "x";
      continue;
    }
    if (ch === "[") {
      i++;
      if (pattern[i] === "^") i++;
      if (pattern[i] === "]") i++;
      while (i < pattern.length && pattern[i] !== "]") {
        if (pattern[i] === "\\") i++;
        i++;
      }
      out += "x";
      continue;
    }
    out += ch;
  }
  return out;
}

/** The quantifier starting at `text[index]` (`*`, `+`, `?`, `{n}`, `{n,}`, `{n,m}`), if any. */
function quantifierAt(text: string, index: number): { max: number; length: number } | null {
  const ch = text[index];
  let quantifier: { max: number; length: number } | null = null;
  if (ch === "*" || ch === "+") quantifier = { max: Number.POSITIVE_INFINITY, length: 1 };
  else if (ch === "?") quantifier = { max: 1, length: 1 };
  else if (ch === "{") {
    const match = /^\{(\d+)(,(\d*))?\}/.exec(text.slice(index));
    if (!match) return null;
    const max =
      match[2] === undefined
        ? Number(match[1])
        : match[3] === ""
          ? Number.POSITIVE_INFINITY
          : Number(match[3]);
    quantifier = { max, length: match[0].length };
  }
  // A lazy suffix (`*?`, `{2,}?`) belongs to the same quantifier.
  if (quantifier && text[index + quantifier.length] === "?") quantifier.length++;
  return quantifier;
}

/** Explain why `pattern` is unsafe, or return null when it passes the heuristic. */
export function findExcludedPatternRisk(pattern: string): string | null {
  if (/\\[1-9]|\\k</.test(pattern)) return "backreferences are not allowed";
  if (/\(\?<?[=!]/.test(pattern)) return "lookarounds are not allowed";

  const text = stripAtoms(pattern);
  let unbounded = 0;
  // Each open group records whether its body holds a quantifier or an alternation.
  const stack: Array<{ risky: boolean }> = [];
  const markParent = () => {
    if (stack.length > 0) stack[stack.length - 1].risky = true;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") {
      stack.push({ risky: false });
      if (text[i + 1] === "?") {
        // Skip the group prefix: `(?:`, `(?<name>`.
        const close = text[i + 2] === "<" ? text.indexOf(">", i) : i + 2;
        i = close > i ? close : i + 1;
      }
      continue;
    }
    if (ch === "|") {
      markParent();
      continue;
    }
    if (ch === ")") {
      const group = stack.pop();
      const quantifier = quantifierAt(text, i + 1);
      if (quantifier) {
        if (quantifier.max > 1 && group?.risky) {
          return "nested or alternated quantifiers are not allowed";
        }
        if (quantifier.max === Number.POSITIVE_INFINITY) unbounded++;
        markParent();
        i += quantifier.length;
      } else if (group?.risky) {
        markParent();
      }
      continue;
    }
    const quantifier = i > 0 ? quantifierAt(text, i) : null;
    if (quantifier) {
      if (quantifier.max === Number.POSITIVE_INFINITY) unbounded++;
      markParent();
      i += quantifier.length - 1;
    }
  }
  if (unbounded > MAX_UNBOUNDED_QUANTIFIERS) {
    return `at most ${MAX_UNBOUNDED_QUANTIFIERS} unbounded quantifiers are allowed`;
  }
  return null;
}

/** Throw a descriptive error unless `pattern` is a bounded, compilable, low-risk regex. */
export function assertSafeExcludedPattern(pattern: string): void {
  if (pattern.length === 0) throw new Error("Excluded pattern must not be empty");
  if (pattern.length > MAX_EXCLUDED_PATTERN_LENGTH) {
    throw new Error(`Excluded pattern exceeds ${MAX_EXCLUDED_PATTERN_LENGTH} characters`);
  }
  try {
    new RegExp(pattern, "i");
  } catch {
    throw new Error(`Excluded pattern is not a valid regular expression: ${pattern}`);
  }
  const risk = findExcludedPatternRisk(pattern);
  if (risk) throw new Error(`Excluded pattern rejected (${risk}): ${pattern}`);
}

export function isSafeExcludedPattern(pattern: unknown): pattern is string {
  if (typeof pattern !== "string") return false;
  try {
    assertSafeExcludedPattern(pattern);
    return true;
  } catch {
    return false;
  }
}

/** Validate a full `excludedPatterns` list from an untrusted caller; returns trimmed copies. */
export function validateExcludedPatterns(patterns: unknown): string[] {
  if (!Array.isArray(patterns)) throw new Error("excludedPatterns must be an array of strings");
  if (patterns.length > MAX_EXCLUDED_PATTERNS) {
    throw new Error(`At most ${MAX_EXCLUDED_PATTERNS} excluded patterns are allowed`);
  }
  return patterns.map((pattern) => {
    if (typeof pattern !== "string")
      throw new Error("excludedPatterns must be an array of strings");
    const trimmed = pattern.trim();
    assertSafeExcludedPattern(trimmed);
    return trimmed;
  });
}
