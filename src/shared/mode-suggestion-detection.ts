/**
 * Mode Suggestion Detection
 *
 * Analyzes user prompt text in real-time and suggests relevant execution modes
 * based on keyword matching with confidence scoring. Pure module — no React/DOM.
 */

export interface ModeSuggestion {
  mode: "plan" | "analyze" | "verified" | "execute" | "debug" | "collaborative";
  label: string;
  description: string;
  confidence: number;
}

interface ModeConfig {
  mode: ModeSuggestion["mode"];
  label: string;
  description: string;
  patterns: RegExp[];
}

const MODE_CONFIGS: ModeConfig[] = [
  {
    mode: "plan",
    label: "Plan Mode",
    description: "Planning mode — no mutating tools",
    patterns: [
      /\bplan\b/i,
      /\bdesign\b/i,
      /\barchitect\b/i,
      /\bstrategy\b/i,
      /\boutline\b/i,
      /\broadmap\b/i,
      /\bapproach\b/i,
      /\bpropose\b/i,
    ],
  },
  {
    mode: "analyze",
    label: "Analyze Mode",
    description: "Read-only analysis mode",
    patterns: [
      /\banalyz[ei]\b/i,
      /\banalyse\b/i,
      /\binvestigat/i,
      /\bexamine\b/i,
      /\breview\b/i,
      /\baudit\b/i,
      /\binspect\b/i,
      /\bunderstand\b/i,
      /\bexplain\b/i,
      /\blook into\b/i,
    ],
  },
  {
    mode: "verified",
    label: "Verified Mode",
    description: "Execute with verification after each step",
    patterns: [
      /\bdeploy\b/i,
      /\bproduction\b/i,
      /\bcritical\b/i,
      /\bcareful\b/i,
      /\bverif[yi]/i,
      /\bsafe\b/i,
      /\bsensitive\b/i,
    ],
  },
  {
    mode: "collaborative",
    label: "Collab Mode",
    description: "Multi-agent team collaboration",
    patterns: [
      /\bteam\b/i,
      /\bcollaborat/i,
      /\bmultiple agents\b/i,
      /\bdifferent perspectives\b/i,
      /\bbrainstorm\b/i,
      /\bparallel\b/i,
    ],
  },
  {
    mode: "execute",
    label: "Execute Mode",
    description: "Full tool execution allowed",
    patterns: [
      /\bbuild\b/i,
      /\bimplement\b/i,
      /\bcreate\b/i,
      /\bfix\b/i,
      /\bwrite code\b/i,
      /\brefactor\b/i,
      /\bmigrat/i,
      /\bset up\b/i,
      /\binstall\b/i,
    ],
  },
  {
    mode: "debug",
    label: "Debug Mode",
    description: "Hypotheses, runtime evidence, targeted fix",
    patterns: [
      /\bbug\b/i,
      /\bbugs\b/i,
      /\bstack trace\b/i,
      /\breproduc/i,
      /\brac(e|ing) condition\b/i,
      /\bintermittent\b/i,
      /\broot cause\b/i,
      /\bregression\b/i,
      /\bflaky\b/i,
      /\bthrows?\b/i,
      /\bcrash(es|ed|ing)?\b/i,
    ],
  },
];

function scoreText(text: string, patterns: RegExp[]): number {
  let score = 0;
  let matchCount = 0;
  for (const pattern of patterns) {
    if (pattern.test(text)) {
      matchCount++;
      if (matchCount === 1) score += 0.3;
      else if (matchCount === 2) score += 0.15;
      else score += 0.1;
    }
  }
  return Math.min(score, 1.0);
}

export interface DetectOptions {
  excludeModes?: string[];
  maxResults?: number;
  threshold?: number;
}

/**
 * Detects which execution modes are most relevant for the given prompt text.
 * Returns suggestions sorted by confidence, filtered by threshold.
 */
export function detectModeSuggestions(text: string, options?: DetectOptions): ModeSuggestion[] {
  if (!text || typeof text !== "string") return [];
  const trimmed = text.trim();
  if (!trimmed) return [];

  const excludeModes = new Set(options?.excludeModes ?? []);
  const maxResults = options?.maxResults ?? 2;
  const threshold = options?.threshold ?? 0.3;

  const suggestions: ModeSuggestion[] = [];

  for (const config of MODE_CONFIGS) {
    if (excludeModes.has(config.mode)) continue;

    const confidence = scoreText(trimmed, config.patterns);
    if (confidence >= threshold) {
      suggestions.push({
        mode: config.mode,
        label: config.label,
        description: config.description,
        confidence,
      });
    }
  }

  suggestions.sort((a, b) => b.confidence - a.confidence);
  return suggestions.slice(0, maxResults);
}
