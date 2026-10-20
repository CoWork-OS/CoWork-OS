/** Pure production skill routing shared by the runtime and its offline evaluator. */
import type { CustomSkill } from "../types";

type RoutingIntentCue = "review" | "fix";
export interface RankedSkillMatch {
  skill: CustomSkill;
  score: number;
}
export interface SkillInvocationContext {
  availableToolNames?: Set<string>;
  includePrereqBlockedSkills?: boolean;
}

export function rankModelInvocableSkillsForQuery(
  skills: CustomSkill[],
  query: string,
  options: SkillInvocationContext & { limit?: number } = {},
): RankedSkillMatch[] {
  const eligible = skills.filter(
    (skill) => isModelInvocableSkill(skill, options) && matchesSkillRoutingQuery(skill, query),
  );
  const ranked = rankSkillsForQuery(eligible, query);
  const limit =
    typeof options.limit === "number" && Number.isFinite(options.limit)
      ? Math.max(Math.floor(options.limit), 0)
      : ranked.length;
  return ranked.slice(0, limit);
}

// Plain-language requests rarely score above 0.7 even when one skill clearly wins
// (e.g. 0.61 vs 0.45), so a hint depends on the lead's margin, not on the score alone.
// Below 0.7 the lexical scores can't tell a right lead from an off-domain one that
// shares a rare word ("voice chat app for remote teams" vs a game voice-chat skill),
// so those hints are tentative: the planner is told they may not apply.
// Calibrated on the bundled catalog plus installed packs; see docs/plugin-packs.md.
export const SKILL_PLANNING_HINT_FLOOR = 0.5;
export const SKILL_PLANNING_HINT_MARGIN = 0.1;
export const SKILL_PLANNING_HINT_STRONG_SCORE = 0.7;
const SKILL_PLANNING_HINT_LIMIT = 3;

export type SkillPlanningHintReason = "clear_lead" | "strong_lead" | "below_floor" | "contested";
export type SkillPlanningHintStrength = "strong" | "tentative" | "none";
export interface SkillPlanningHintSelection {
  hints: RankedSkillMatch[];
  reason: SkillPlanningHintReason;
  /** Strong hints ask the planner for a Skill step; tentative ones only suggest it. */
  strength: SkillPlanningHintStrength;
}

/**
 * Choose which ranked skills to suggest in the planning prompt.
 * `ranked` must be the full descending ranking, so every contender is visible.
 */
export function selectSkillPlanningHints(ranked: RankedSkillMatch[]): SkillPlanningHintSelection {
  const [lead, ...rest] = ranked;
  if (!lead || lead.score < SKILL_PLANNING_HINT_FLOOR)
    return { hints: [], reason: "below_floor", strength: "none" };
  const contenders = rest.filter(({ score }) => lead.score - score < SKILL_PLANNING_HINT_MARGIN);
  const strong = lead.score >= SKILL_PLANNING_HINT_STRONG_SCORE;
  if (contenders.length === 0)
    return { hints: [lead], reason: "clear_lead", strength: strong ? "strong" : "tentative" };
  // Below the strong bar any close contender makes the request ambiguous, even one
  // from the lead's own pack: same-pack siblings also lead off-domain requests that
  // merely share the pack's vocabulary ("my phone's audio is too quiet").
  if (!strong) return { hints: [], reason: "contested", strength: "none" };
  return {
    hints: [lead, ...contenders].slice(0, SKILL_PLANNING_HINT_LIMIT),
    reason: "strong_lead",
    strength: "strong",
  };
}

export function isModelInvocableSkill(
  skill: CustomSkill,
  options: SkillInvocationContext = {},
): boolean {
  if (
    skill.type === "guideline" ||
    skill.enabled === false ||
    skill.invocation?.disableModelInvocation === true
  )
    return false;
  const availableToolNames = options.availableToolNames;
  if (!availableToolNames) return true;
  const requiredTools = Array.isArray(skill.requires?.tools)
    ? skill.requires.tools.filter(
        (tool): tool is string => typeof tool === "string" && tool.trim().length > 0,
      )
    : [];
  if (requiredTools.some((tool) => !availableToolNames.has(tool))) return false;
  const hasBinaryRequirements =
    (Array.isArray(skill.requires?.bins) && skill.requires.bins.length > 0) ||
    (Array.isArray(skill.requires?.anyBins) && skill.requires.anyBins.length > 0);
  return !(
    hasBinaryRequirements &&
    options.includePrereqBlockedSkills !== true &&
    !availableToolNames.has("run_command")
  );
}

const ROUTING_INTENT_CUE_PATTERNS: Record<RoutingIntentCue, RegExp[]> = {
  review: [/\bpull request\b/i, /\bpr\b/i, /\breview\b/i, /\bfeedback\b/i, /\bmerge\b/i],
  fix: [
    /\bfix(?:ing)?\b/i,
    /\bbug\b/i,
    // "issue" is intentionally narrowed to require a technical co-signal to avoid
    // false positives on "issue an invoice", "issue tracking", etc.
    /\b(?:bug\s+issue|issue\s+(?:with|in|on)|known\s+issue)\b/i,
    /\berror\b/i,
    /\bbroken\b/i,
    /\brepair\b/i,
  ],
};

const EXPLICIT_SKILL_ACTIVATION_CUE =
  "(?:use|run|call|invoke|activate|apply|launch|start|enable|turn\\s+on|work\\s+on|help\\s+with|help\\s+me\\s+with)";

function isSkillInvocationDescription(prefix: string): boolean {
  // A later independent command is outside the earlier explanation's scope.
  const context = prefix.split(/,\s*and\s+/i).at(-1) || "";
  return (
    /\b(?:use|apply|invoke)\s+(?:only\s+)?when\b[^,.;!?\n]*$/i.test(context) ||
    /\b(?:explain|describe|document|discuss|clarify|show|tell|learn|understand)\b[^.;!?\n]*\b(?:when|how|why|whether)\b/i.test(
      context,
    ) ||
    /\b(?:when|if)\b[^,.;!?\n]*\b(?:(?:the|a)\s+user|users|someone)\s+(?:asks?|requests?|wants?|needs?)\b[^,.;!?\n]*$/i.test(
      context,
    )
  );
}

export function matchesExplicitSkillInvocationPhrase(
  normalizedQuery: string,
  normalizedPhrase: string,
  escapeSegment: (segment: string) => string,
  exclusionPhrases: readonly string[] = [normalizedPhrase],
): boolean {
  if (!normalizedQuery || !normalizedPhrase) {
    return false;
  }

  const phrasePattern = normalizedPhrase
    .split(" ")
    .filter(Boolean)
    .map((segment) => escapeSegment(segment))
    .join("\\s+");
  if (!phrasePattern) {
    return false;
  }

  const quotedPhrase = `(?:["'“”‘’])?${phrasePattern}(?:["'“”‘’])?`;
  const commandTarget = `${quotedPhrase}(?:\\s+cli)?`;
  // Following command/subskill words are part of the task, not this shorter name.
  const endOfTarget = `(?=\\s*(?:$|[.,;:!?]|--?[a-z0-9]|\\b(?:to|for|on|with|and|please|now|in|without|as|using|under|while|from|against|after|before|via|during)\\b))`;
  const activationPatterns = [
    `(?:^|[^a-z0-9])${EXPLICIT_SKILL_ACTIVATION_CUE}\\s+(?:the\\s+)?${commandTarget}(?:\\s+skill)?${endOfTarget}`,
    `(?:^|[^a-z0-9])${EXPLICIT_SKILL_ACTIVATION_CUE}\\s+(?:the\\s+)?skill\\s+${commandTarget}${endOfTarget}`,
  ];
  const nounPatterns = [
    `(?:^|[^a-z0-9])${quotedPhrase}\\s+skill(?:$|[^a-z0-9])`,
    `(?:^|[^a-z0-9])skill\\s+${quotedPhrase}(?:$|[^a-z0-9])`,
  ];
  // A descriptive mention cannot override an exclusion of this skill or an alias.
  // A later affirmative activation cue can still request a different task.
  const patterns = exclusionPhrases.some((phrase) =>
    isRoutingPhraseExcluded(sanitizeRoutingQuery(normalizedQuery), phrase),
  )
    ? activationPatterns
    : [...activationPatterns, ...nounPatterns];

  return patterns.some((pattern) => {
    for (const match of normalizedQuery.matchAll(new RegExp(pattern, "gi"))) {
      const prefix = normalizedQuery.slice(0, match.index + 1);
      const boundaries = [...prefix.matchAll(/[.;!?\n]|\b(?:but|instead|however|then)\b/gi)];
      const boundary = boundaries.at(-1);
      const start = boundary ? boundary.index + boundary[0].length : 0;
      if (isSkillInvocationDescription(normalizedQuery.slice(start, match.index + 1))) continue;
      const clause = normalizedQuery.slice(start, match.index + match[0].length);
      if (isRoutingPhraseExcluded(clause, normalizedPhrase)) continue;
      // A later instruction can withdraw an earlier activation; a still-later
      // affirmative occurrence is evaluated independently on the next iteration.
      const remainingQuery = sanitizeRoutingQuery(
        normalizedQuery.slice(match.index + match[0].length),
      );
      if (!exclusionPhrases.some((phrase) => isRoutingPhraseExcluded(remainingQuery, phrase)))
        return true;
    }
    return false;
  });
}

/** Normalize skill IDs while retaining command flags and instruction boundaries. */
export function normalizeSkillInvocationText(text: string): string {
  return String(text || "")
    .toLowerCase()
    .split(/(\s+)/)
    .map((token) => (/^--?[a-z0-9]/i.test(token) ? token : token.replace(/[-_]+/g, " ")))
    .join("")
    .replace(/[^\S\n]+/g, " ")
    .trim();
}

function tokenizeForRouting(text: string): Set<string> {
  const tokens = String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9_]+/g)
    .map((token) => token.trim())
    .filter(
      (token) =>
        token.length >= 2 &&
        ![
          "to",
          "of",
          "in",
          "on",
          "at",
          "by",
          "an",
          "as",
          "is",
          "it",
          "my",
          "me",
          "we",
          "us",
          "be",
          "or",
          "do",
          "no",
        ].includes(token),
    );
  return new Set(tokens);
}

function buildRoutingHaystack(texts: string[]): string {
  return texts
    .filter((text) => typeof text === "string" && text.trim().length > 0)
    .join(" ")
    .toLowerCase()
    .trim();
}

function normalizeRoutingPhrase(text: string): string {
  return String(text || "")
    .toLowerCase()
    .replace(/[-_\s]+/g, " ")
    .trim();
}

export function sanitizeRoutingQuery(query: string): string {
  return String(query || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/(^|\n)\s*>\s.*$/gm, " ")
    .replace(/\b(?:[A-Za-z]:)?(?:\/|\.\/|\.\.\/)?[\w.-]+(?:\/[\w.-]+)+\b/g, " ")
    .replace(
      /\b[\w.-]+\.(?:ts|tsx|js|jsx|json|md|txt|html|css|scss|py|rb|go|rs|java|c|cpp|h|hpp|docx?|pdf|xlsx?|pptx?|ya?ml)\b/gi,
      " ",
    )
    .replace(
      /"[^"\n]{1,160}"|“[^”\n]{1,160}”|(?<![a-z0-9])'[^'\n]{1,160}'(?![a-z0-9])|(?<![a-z0-9])‘[^’\n]{1,160}’(?![a-z0-9])/gi,
      " ",
    );
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRoutingPhraseExcluded(query: string, phrase: string): boolean {
  const phrasePattern = normalizeRoutingPhrase(phrase)
    .split(" ")
    .filter(Boolean)
    .map(escapeRegExp)
    .join("\\s+");
  if (!phrasePattern) return false;
  const normalized = normalizeRoutingPhrase(query);
  const target = `(?:the\\s+)?(?:skill\\s+)?${phrasePattern}(?:\\s+skill)?`;
  const modifiers = `(?:(?:ever|even|just|still|yet|always|again|[a-z]+ly)\\s+)*`;
  return [
    `(?:do\\s+not|don['’]t|never|avoid)\\s+${modifiers}(?:(?:${EXPLICIT_SKILL_ACTIVATION_CUE}|using|running|calling|invoking|activating|applying)\\s+)?${target}`,
    `outside\\s+${target}(?:['’]s)?\\s+(?:scope|domain)`,
    `outside\\s+(?:the\\s+)?(?:scope|domain)\\s+of\\s+${target}`,
  ].some((pattern) => new RegExp(`(?:^|[^a-z0-9])${pattern}(?:$|[^a-z0-9])`, "i").test(normalized));
}

function canonicalRoutingExample(text: string): string {
  return normalizeRoutingPhrase(sanitizeRoutingQuery(text))
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function queryContainsRoutingPhrase(query: string, phrase: string): boolean {
  const normalizedQuery = normalizeRoutingPhrase(query);
  const normalizedPhrase = normalizeRoutingPhrase(phrase);
  if (!normalizedQuery || !normalizedPhrase) return false;

  const escapedPhrasePattern = normalizedPhrase
    .split(" ")
    .filter(Boolean)
    .map((segment) => escapeRegExp(segment))
    .join("\\s+");

  if (!escapedPhrasePattern) return false;

  if (
    new RegExp(`(?:^|[^a-z0-9])${escapedPhrasePattern}(?:$|[^a-z0-9])`, "i").test(normalizedQuery)
  )
    return true;
  const phraseTokens = tokenizeForRouting(normalizedPhrase);
  const queryTokens = tokenizeForRouting(normalizedQuery);
  // Multi-word topics can be reordered or separated by descriptive words.
  return phraseTokens.size >= 2 && [...phraseTokens].every((token) => queryTokens.has(token));
}

function requiresExplicitSkillInvocation(skill: CustomSkill): boolean {
  return skill.id === "codex-cli" || skill.id === "gemini";
}

function matchesExplicitSkillInvocationTarget(
  query: string,
  phrase: string,
  exclusionPhrases: readonly string[] = [phrase],
): boolean {
  const normalizedQuery = normalizeSkillInvocationText(sanitizeRoutingQuery(query));
  const normalizedPhrase = normalizeRoutingPhrase(phrase);
  return matchesExplicitSkillInvocationPhrase(
    normalizedQuery,
    normalizedPhrase,
    (segment) => escapeRegExp(segment),
    exclusionPhrases,
  );
}

function matchesExplicitSkillInvocation(skill: CustomSkill, query: string): boolean {
  const skillId = String(skill.id || "").trim();
  const skillName = String(skill.name || "").trim();
  const exclusionPhrases = [skillId, skillName];

  return (
    (skillId.length > 0 &&
      matchesExplicitSkillInvocationTarget(query, skillId, exclusionPhrases)) ||
    (skillName.length > 0 &&
      matchesExplicitSkillInvocationTarget(query, skillName, exclusionPhrases))
  );
}

function explicitInvocationSpecificity(skill: CustomSkill, query: string): number {
  return Math.max(
    0,
    ...[skill.id, skill.name]
      .filter(
        (phrase) =>
          phrase &&
          (matchesExplicitSkillInvocationTarget(query, phrase, [skill.id, skill.name]) ||
            new RegExp(
              `^${normalizeRoutingPhrase(phrase).split(" ").map(escapeRegExp).join("\\s+")}\\s*:`,
              "i",
            ).test(normalizeRoutingPhrase(query))),
      )
      .map((phrase) => normalizeRoutingPhrase(phrase).length),
  );
}

export function matchesSkillRoutingQuery(skill: CustomSkill, query: string): boolean {
  const sanitized = sanitizeRoutingQuery(query);
  const explicitMatch = matchesExplicitSkillInvocation(skill, query);
  if (
    !explicitMatch &&
    [skill.id, skill.name].some((phrase) => phrase && isRoutingPhraseExcluded(sanitized, phrase))
  )
    return false;
  const canonicalQuery = canonicalRoutingExample(query);
  if (
    canonicalQuery &&
    getRoutingExamples(skill, "negative").some(
      (example) => canonicalRoutingExample(example) === canonicalQuery,
    )
  )
    return false;
  if (requiresExplicitSkillInvocation(skill)) {
    return explicitMatch;
  }

  if (explicitMatch) {
    return true;
  }

  // Authored task examples are also admission signals. A strong match can express
  // the supported task without repeating a literal keyword (e.g. a paraphrase).
  if (
    getBestExampleOverlap(tokenizeForRouting(sanitized), getRoutingExamples(skill, "positive")) >=
    0.8
  ) {
    return true;
  }

  const routing = skill.metadata?.routing;
  const hasRoutingMetadata =
    Boolean(routing?.useWhen) ||
    Boolean(routing?.dontUseWhen) ||
    Boolean(routing?.outputs) ||
    Boolean(routing?.successCriteria) ||
    (Array.isArray(routing?.expectedArtifacts) && routing.expectedArtifacts.length > 0) ||
    (Array.isArray(routing?.keywords) && routing.keywords.length > 0) ||
    (Array.isArray(routing?.examples?.positive) && routing.examples.positive.length > 0) ||
    (Array.isArray(routing?.examples?.negative) && routing.examples.negative.length > 0);
  if (!hasRoutingMetadata) {
    return true;
  }

  const keywords = routing?.keywords;
  if (!Array.isArray(keywords) || keywords.length === 0) return true;

  const normalizedQuery = normalizeRoutingPhrase(sanitizeRoutingQuery(query));
  if (!normalizedQuery) return false;

  const matched = keywords.some(
    (keyword) =>
      typeof keyword === "string" && queryContainsRoutingPhrase(normalizedQuery, keyword),
  );
  return matched;
}

function scoreTextOverlap(queryTokens: Set<string>, texts: string[]): number {
  const haystack = buildRoutingHaystack(texts);
  if (!haystack || queryTokens.size === 0) return 0;

  let overlap = 0;
  for (const token of queryTokens) {
    if (haystack.includes(token)) overlap += 1;
  }
  return overlap / Math.max(queryTokens.size, 1);
}

function getIntentCueCount(texts: string[], cue: RoutingIntentCue): number {
  const haystack = buildRoutingHaystack(texts);
  if (!haystack) return 0;
  return ROUTING_INTENT_CUE_PATTERNS[cue].reduce((count, pattern) => {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    const globalPattern = new RegExp(pattern.source, flags);
    const matches = Array.from(haystack.matchAll(globalPattern)).length;
    return count + matches;
  }, 0);
}

function inferDominantIntentCue(texts: string[]): RoutingIntentCue | null {
  const reviewCount = getIntentCueCount(texts, "review");
  const fixCount = getIntentCueCount(texts, "fix");
  if (reviewCount === 0 && fixCount === 0) return null;
  if (reviewCount === fixCount) return null;
  return reviewCount > fixCount ? "review" : "fix";
}

function getRoutingExamples(skill: CustomSkill, polarity: "positive" | "negative"): string[] {
  const examples = skill.metadata?.routing?.examples;
  const raw = polarity === "positive" ? examples?.positive : examples?.negative;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (example): example is string => typeof example === "string" && example.trim().length > 0,
  );
}

function getBestExampleOverlap(queryTokens: Set<string>, examples: string[]): number {
  let best = 0;
  for (const example of examples) {
    const exampleTokens = tokenizeForRouting(sanitizeRoutingQuery(example));
    let overlap = 0;
    for (const token of queryTokens) if (exampleTokens.has(token)) overlap += 1;
    const total = queryTokens.size + exampleTokens.size;
    // Symmetric overlap distinguishes a specific supported example from a long
    // metadata field that happens to contain every word in a short query.
    best = Math.max(best, total === 0 ? 0 : (2 * overlap) / total);
  }
  return best;
}

export function rankSkillsForQuery(skills: CustomSkill[], query: string): RankedSkillMatch[] {
  const normalizedQuery = sanitizeRoutingQuery(String(query || "")).trim();
  if (!normalizedQuery) {
    return skills.map((skill) => ({ skill, score: 1 }));
  }

  const queryTokens = tokenizeForRouting(normalizedQuery);
  if (queryTokens.size === 0) {
    return skills.map((skill) => ({ skill, score: 0 }));
  }

  // Rare domain words carry more evidence than catalogue-wide boilerplate.
  const documents = skills.map((skill) =>
    tokenizeForRouting(
      [skill.id, skill.name, skill.description, skill.metadata?.routing?.useWhen]
        .filter(Boolean)
        .join(" "),
    ),
  );
  const weights = new Map(
    [...queryTokens].map((token) => {
      const frequency = documents.filter((tokens) => tokens.has(token)).length;
      return [token, Math.log(1 + (skills.length + 0.5) / (frequency + 0.5))];
    }),
  );
  const totalWeight = [...weights.values()].reduce((sum, weight) => sum + weight, 0);
  const weightedCoverage = (tokens: Set<string>) =>
    [...weights].reduce((sum, [token, weight]) => sum + (tokens.has(token) ? weight : 0), 0) /
    Math.max(totalWeight, 1);
  const titlePrecision = (skill: CustomSkill) => {
    const tokens = tokenizeForRouting(`${skill.id} ${skill.name}`);
    const matched = [...tokens].filter((token) => queryTokens.has(token)).length;
    return matched / Math.max(tokens.size, 1);
  };
  const ranked = skills
    .map((skill) => ({
      skill,
      score:
        scoreSkillForQuery(skill, normalizedQuery, queryTokens) +
        2 * weightedCoverage(tokenizeForRouting(`${skill.id} ${skill.name}`)) +
        0.5 * titlePrecision(skill) +
        weightedCoverage(
          tokenizeForRouting(
            `${skill.description || ""} ${skill.metadata?.routing?.useWhen || ""}`,
          ),
        ),
      explicit: explicitInvocationSpecificity(skill, normalizedQuery),
      example: getBestExampleOverlap(queryTokens, getRoutingExamples(skill, "positive")),
    }))
    .sort(
      (a, b) =>
        b.explicit - a.explicit ||
        (b.example >= 0.8 ? b.example : 0) - (a.example >= 0.8 ? a.example : 0) ||
        b.score - a.score ||
        a.skill.id.localeCompare(b.skill.id),
    );
  // Soft saturation retains relevance differences instead of collapsing strong
  // matches to 1. Explicit/example priorities must retain their order in the
  // public confidence too; machine epsilon is enough to distinguish a tie.
  let nextConfidence = 0;
  const result: RankedSkillMatch[] = [];
  for (let index = ranked.length - 1; index >= 0; index -= 1) {
    const { skill, score } = ranked[index];
    const confidence = Math.min(1, Math.max(score / (1 + score), nextConfidence + Number.EPSILON));
    result[index] = { skill, score: confidence };
    nextConfidence = confidence;
  }
  return result;
}

function scoreSkillForQuery(skill: CustomSkill, query: string, queryTokens: Set<string>): number {
  if (!query || queryTokens.size === 0) return 0;

  const positiveExamples = getRoutingExamples(skill, "positive");
  const negativeExamples = getRoutingExamples(skill, "negative");
  const positiveTexts = [
    skill.id || "",
    skill.name || "",
    skill.description || "",
    skill.category || "",
    skill.metadata?.routing?.useWhen || "",
    skill.metadata?.routing?.outputs || "",
    skill.metadata?.routing?.successCriteria || "",
    ...positiveExamples,
  ].filter((text) => typeof text === "string" && text.trim().length > 0);
  if (positiveTexts.length === 0) return 0;

  const overlapScore = scoreTextOverlap(queryTokens, positiveTexts);
  const positiveExampleBoost = Math.min(
    0.45,
    getBestExampleOverlap(queryTokens, positiveExamples) * 0.6,
  );
  const negativeOverlap = getBestExampleOverlap(queryTokens, [
    skill.metadata?.routing?.dontUseWhen || "",
    ...negativeExamples,
  ]);
  const negativePenalty = Math.min(0.65, negativeOverlap * 0.85);

  const dominantQueryIntent = inferDominantIntentCue([query]);
  const dominantSkillIntent = inferDominantIntentCue(positiveTexts);
  let intentAlignmentBoost = 0;
  let intentMismatchPenalty = 0;
  if (dominantQueryIntent && dominantSkillIntent) {
    if (dominantQueryIntent === dominantSkillIntent) {
      intentAlignmentBoost = 0.2;
    } else {
      intentMismatchPenalty = 0.3;
    }
  } else if (dominantQueryIntent && getIntentCueCount(positiveTexts, dominantQueryIntent) > 0) {
    intentAlignmentBoost = 0.1;
  }

  const exactIdHit = query.toLowerCase().includes((skill.id || "").toLowerCase()) ? 0.35 : 0;
  const exactNameHit = query.toLowerCase().includes((skill.name || "").toLowerCase()) ? 0.2 : 0;
  const routingBoost = skill.metadata?.routing?.useWhen ? 0.05 : 0;

  // Explicit keyword triggers: any keyword match gives a guaranteed strong routing signal
  const routingKeywords = skill.metadata?.routing?.keywords ?? [];
  const keywordHit = routingKeywords.some(
    (kw) => kw && query.toLowerCase().includes(kw.toLowerCase()),
  )
    ? 0.5
    : 0;

  // Rank before capping confidence: capping here collapses strong and weak matches
  // to identical scores and lets alphabetical IDs decide instead of relevance.
  return Math.max(
    0,
    overlapScore +
      positiveExampleBoost +
      intentAlignmentBoost +
      exactIdHit +
      exactNameHit +
      routingBoost +
      keywordHit -
      negativePenalty -
      intentMismatchPenalty,
  );
}
