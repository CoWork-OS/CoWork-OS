/**
 * Deterministic relevance gate for Playbook evidence.
 *
 * The thresholds are implementation defaults calibrated against a small fixture set,
 * not a quality guarantee: at least two distinctive shared terms, and a weighted
 * overlap of at least 0.35 of the smaller side. There is no zero-overlap fallback.
 */

export const PLAYBOOK_MIN_SHARED_TERMS = 2;
export const PLAYBOOK_MIN_WEIGHTED_OVERLAP = 0.35;

const STOPWORDS = new Set(
  (
    "the and for with that this from into onto your you our are was were been being have has had " +
    "not but can could should would will shall may might must its it's them they their there here " +
    "what when where which who whom why how all any each every some such than then too very just " +
    "also only about above after again against before below between both down during further off " +
    "once over under until more most other same own out via per please make made use using used " +
    "get got need want like help task tasks thing things something anything new file files one two"
  ).split(/\s+/),
);

export function distinctiveTerms(text: string): Set<string> {
  const tokens = text.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) || [];
  return new Set(tokens.filter((token) => !STOPWORDS.has(token) && !/^\d+$/.test(token)));
}

/** Longer terms carry more signal than short ones. */
function termWeight(term: string): number {
  return Math.min(2, 0.5 + term.length / 6);
}

export interface PlaybookRelevance {
  sharedTerms: string[];
  weightedOverlap: number;
  passes: boolean;
}

export function scorePlaybookRelevance(query: string, candidate: string): PlaybookRelevance {
  const left = distinctiveTerms(query);
  const right = distinctiveTerms(candidate);
  const shared = [...left].filter((term) => right.has(term));
  const weigh = (terms: Iterable<string>) => [...terms].reduce((sum, t) => sum + termWeight(t), 0);
  const denominator = Math.min(weigh(left), weigh(right));
  const weightedOverlap = denominator > 0 ? weigh(shared) / denominator : 0;
  return {
    sharedTerms: shared,
    weightedOverlap,
    passes:
      shared.length >= PLAYBOOK_MIN_SHARED_TERMS &&
      weightedOverlap >= PLAYBOOK_MIN_WEIGHTED_OVERLAP,
  };
}
