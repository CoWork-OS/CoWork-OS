/**
 * One FTS5 query builder for every lexical search lane (audit RECALL-9, §8.2
 * "MemoryRecall"): conversation index, memory FTS worker, knowledge graph.
 *
 * - Unicode-aware: terms are runs of letters, digits and combining marks in any script
 *   (Turkish, German, accented Latin, Cyrillic, CJK...). Nothing is ASCII-folded or
 *   stripped here; case and diacritics are folded by the `unicode61` tokenizer.
 * - File names and identifiers stay one term: `executor.ts`, `task-id_123`,
 *   `src/app.ts:42` keep their joiners, and are emitted as a quoted phrase, which the
 *   tokenizer splits into adjacent tokens (`"executor.ts"` matches `executor ts`).
 * - Operator-safe: every term is double-quoted, so user text can never form FTS5 syntax
 *   (`AND`/`OR`/`NOT`/`NEAR`, `*`, `^`, `:`, parentheses, column filters). Bare
 *   operator words are dropped instead of searched for.
 * - Bounded: input length, term length and term count are capped.
 *
 * Also hosts the LIKE escaping helpers and a keyword extractor used to turn a long
 * prompt into a short query. Free of Electron imports so the database and FTS workers
 * can load it.
 */

export type FtsQueryMode = "all" | "any";

export interface FtsQueryOptions {
  /** `all` joins terms with AND (precision), `any` with OR (recall, bm25 ranks overlap). */
  mode?: FtsQueryMode;
  /** Append `*` so each term also matches longer tokens (`deploy` → `deployment`). */
  prefix?: boolean;
  /** Maximum number of terms kept, in input order after de-duplication. */
  maxTerms?: number;
  /** Terms longer than this are cut (in code points). */
  maxTermLength?: number;
  /** Terms shorter than this (in code points) are dropped. */
  minTermLength?: number;
}

export const FTS_DEFAULT_MAX_TERMS = 12;
export const FTS_MAX_TERM_LENGTH = 64;
/** Only this much of the input is scanned for terms. */
export const FTS_MAX_INPUT_CHARS = 4000;

const FTS_OPERATOR_WORDS = new Set(["and", "or", "not", "near"]);

/**
 * A term: letters, digits and marks, optionally joined by `.`, `_`, `-`, `/`, `:`, `'`,
 * `’` or `@` when both sides are word characters (file names, identifiers, e-mail-like
 * handles, contractions). Joiners at the edges are not part of the term.
 */
const TERM_PATTERN = /[\p{L}\p{N}\p{M}]+(?:[._\-/:'’@][\p{L}\p{N}\p{M}]+)*/gu;

function codePointLength(value: string): number {
  let count = 0;
  for (const _char of value) count += 1;
  return count;
}

function cutCodePoints(value: string, max: number): string {
  if (value.length <= max) return value;
  return Array.from(value).slice(0, max).join("");
}

/** Case- and accent-insensitive key, for de-duplication and JS-side matching. */
export function foldForMatch(text: string): string {
  return String(text || "")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();
}

/**
 * Extract the search terms of `text`: Unicode word runs (with in-word joiners kept),
 * de-duplicated case- and accent-insensitively, bare FTS operator words removed
 * (unless they are the only term), capped in length and count.
 */
export function extractFtsTerms(text: string, options: FtsQueryOptions = {}): string[] {
  const maxTerms = Math.max(1, Math.floor(options.maxTerms ?? FTS_DEFAULT_MAX_TERMS));
  const maxTermLength = Math.max(1, Math.floor(options.maxTermLength ?? FTS_MAX_TERM_LENGTH));
  const minTermLength = Math.max(1, Math.floor(options.minTermLength ?? 1));
  const input = String(text || "")
    .slice(0, FTS_MAX_INPUT_CHARS)
    .normalize("NFC");
  const seen = new Set<string>();
  const terms: string[] = [];
  const operators: string[] = [];
  for (const match of input.matchAll(TERM_PATTERN)) {
    const term = cutCodePoints(match[0], maxTermLength);
    if (codePointLength(term) < minTermLength) continue;
    const key = foldForMatch(term);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (FTS_OPERATOR_WORDS.has(key)) {
      operators.push(term);
      continue;
    }
    terms.push(term);
    if (terms.length >= maxTerms) break;
  }
  // "not" alone is a legitimate (quoted) search; operators only drop next to real terms.
  return terms.length > 0 ? terms : operators.slice(0, 1);
}

/** Quote one term as an FTS5 string literal (terms never contain `"`, but stay safe). */
export function quoteFtsTerm(term: string, prefix = false): string {
  const literal = `"${String(term).replace(/"/g, '""')}"`;
  return prefix ? `${literal}*` : literal;
}

/**
 * Build an FTS5 MATCH expression from free text, or null when the text has no terms.
 * The result only contains quoted terms, optional `*` prefix markers and AND/OR.
 */
export function buildFtsMatchQuery(text: string, options: FtsQueryOptions = {}): string | null {
  const terms = extractFtsTerms(text, options);
  if (terms.length === 0) return null;
  const joiner = options.mode === "any" ? " OR " : " AND ";
  return terms.map((term) => quoteFtsTerm(term, options.prefix === true)).join(joiner);
}

/**
 * FTS5 phrase for an exact marker such as `[suggestion-feedback:acted_on]`: all of its
 * terms as one quoted phrase, or null when nothing searchable remains.
 */
export function buildFtsPhraseQuery(
  text: string,
  options: { minTermLength?: number } = {},
): string | null {
  const terms = extractFtsTerms(text, {
    maxTerms: FTS_DEFAULT_MAX_TERMS,
    minTermLength: options.minTermLength,
  });
  if (terms.length === 0) return null;
  const phrase = terms.join(" ");
  if (terms.length === 1 && FTS_OPERATOR_WORDS.has(foldForMatch(phrase))) return null;
  return quoteFtsTerm(phrase);
}

// ---------------------------------------------------------------------------
// LIKE helpers
// ---------------------------------------------------------------------------

/** The ESCAPE clause matching `escapeLikePattern`. */
export const LIKE_ESCAPE_CLAUSE = "ESCAPE '\\'";

/** Escape `\`, `%` and `_` so user text matches literally in `LIKE ... ESCAPE '\'`. */
export function escapeLikePattern(text: string): string {
  return String(text || "").replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** `%text%` with the text escaped; use with `LIKE_ESCAPE_CLAUSE`. */
export function likeContainsPattern(text: string): string {
  return `%${escapeLikePattern(String(text || "").trim())}%`;
}

// ---------------------------------------------------------------------------
// Keyword extraction (long prompt → short query)
// ---------------------------------------------------------------------------

const STOPWORDS = new Set(
  [
    // English
    "a an the and or not but if then else of to in on at by for from with without into onto",
    "is are was were be been being am do does did done doing have has had having can could",
    "will would shall should may might must this that these those it its it's i me my mine we",
    "us our you your he him his she her they them their there here what which who whom whose",
    "when where why how all any each every some such no nor only own same so than too very",
    "just also again about above below after before between through during up down out off",
    "over under more most other into until while as because please thanks thank hi hello",
    "let let's make use using used want need like get got go going via etc ok okay yes",
    "one two new now then via per",
    // German
    "der die das den dem des ein eine einer eines einem einen und oder nicht ist sind war",
    "mit für von zu zum zur im in auf aus bei nach über unter wie was wer wo auch noch",
    "bitte ich du er sie es wir ihr mich mir dich dir uns euch kann können soll sollen",
    // Turkish
    "ve veya ile bir bu şu o için gibi da de ki mi mı mu mü ne ama fakat çok daha en",
    "olarak olan ise ya hem lütfen bana beni sen ben biz siz onlar",
    // French / Spanish (common accents)
    "le la les un une des et ou est sont avec pour dans sur pas que qui el los las y o es",
    "con por para en del al lo",
  ]
    .join(" ")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => foldForMatch(word)),
);

/**
 * The most distinctive terms of a long text, at most `maxTerms` (≤ 12 by default):
 * stopwords and very short words removed, ranked by frequency and length, identifiers
 * and file names (terms with digits or joiners) preferred, ties in order of appearance.
 */
export function extractKeywords(text: string, maxTerms = FTS_DEFAULT_MAX_TERMS): string[] {
  const candidates = extractFtsTerms(text, {
    maxTerms: 400,
    minTermLength: 1,
  });
  // extractFtsTerms de-duplicates; count occurrences separately for frequency.
  const counts = new Map<string, number>();
  for (const match of String(text || "")
    .slice(0, FTS_MAX_INPUT_CHARS)
    .normalize("NFC")
    .matchAll(TERM_PATTERN)) {
    const key = foldForMatch(match[0]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const scored = candidates
    .map((term, index) => {
      const key = foldForMatch(term);
      const length = codePointLength(term);
      const identifier = /[._\-/:@]/.test(term) || /\p{N}/u.test(term);
      return { term, key, index, length, identifier, count: counts.get(key) ?? 1 };
    })
    .filter(
      (entry) =>
        !STOPWORDS.has(entry.key) &&
        !FTS_OPERATOR_WORDS.has(entry.key) &&
        (entry.length >= 3 || entry.identifier || /[^\p{Script=Latin}\p{N}]/u.test(entry.term)),
    )
    .map((entry) => ({
      ...entry,
      score:
        Math.min(entry.count, 4) * (1 + Math.log(Math.min(entry.length, 24))) +
        (entry.identifier ? 2 : 0),
    }));
  return scored
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, Math.max(1, Math.floor(maxTerms)))
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.term);
}

/**
 * Share of query terms present in `text`, case- and accent-insensitive, as a number in
 * [0, 1]. Used by lanes that filter rows in JS (no FTS index) instead of a whole-query
 * substring match.
 */
export function termCoverage(text: string, queryOrTerms: string | string[]): number {
  const terms = Array.isArray(queryOrTerms)
    ? queryOrTerms
    : extractFtsTerms(queryOrTerms, { maxTerms: 24 });
  if (terms.length === 0) return 0;
  const haystack = foldForMatch(text);
  if (!haystack) return 0;
  let hits = 0;
  for (const term of terms) {
    if (haystack.includes(foldForMatch(term))) hits += 1;
  }
  return hits / terms.length;
}
