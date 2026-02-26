/**
 * WorkflowDecomposer — detects multi-phase workflow patterns in a single
 * user prompt and decomposes them into ordered phases.
 *
 * Example: "Research competitors, then create a presentation, then email team"
 * → [{ research }, { create presentation }, { email }]
 *
 * Returns null if the prompt is not a multi-phase workflow.
 */

import { IntentRoute } from "./IntentRouter";
import type { LLMProvider } from "../llm/types";

export interface WorkflowPhase {
  id: string;
  order: number;
  title: string;
  prompt: string;
  phaseType: "research" | "create" | "deliver" | "analyze" | "general";
  dependsOn: string[];
  status: "pending" | "running" | "completed" | "failed";
  taskId?: string;
  output?: string;
}

/**
 * Connective patterns that indicate phase boundaries.
 * Ordered by specificity (most specific first).
 */
const PHASE_SPLITTERS = [
  /\bthen\s+/i,
  /\bafter\s+that\s*,?\s*/i,
  /\bnext\s*,?\s*/i,
  /\bfinally\s*,?\s*/i,
  /\band\s+then\s+/i,
  /\bonce\s+(?:that'?s?\s+)?done\s*,?\s*/i,
  /\s→\s*/,
  /\s->\s*/,
  /\bstep\s+\d+:?\s*/i,
  /\bphase\s+\d+:?\s*/i,
  /;\s+then\s+/i,
];

/**
 * Phase type detection patterns (matched against the phase text).
 */
const PHASE_TYPE_PATTERNS: Array<[RegExp, WorkflowPhase["phaseType"]]> = [
  [/\b(research|search|find|look up|investigate|gather|discover|explore)\b/i, "research"],
  [/\b(create|write|generate|build|make|draft|compose|design|produce)\b/i, "create"],
  [/\b(send|email|deliver|share|publish|post|notify|message|forward)\b/i, "deliver"],
  [/\b(analyze|compare|evaluate|assess|review|summarize|audit|benchmark)\b/i, "analyze"],
];

export class WorkflowDecomposer {
  /**
   * Attempt to decompose a prompt into ordered workflow phases.
   * Returns null if the prompt doesn't contain multi-phase patterns.
   */
  static decompose(prompt: string, _route: IntentRoute): WorkflowPhase[] | null {
    if (!prompt || prompt.length < 30) return null;

    // Only decompose execution-heavy prompts with multiple action verbs
    const lower = prompt.toLowerCase();
    const actionVerbs =
      lower.match(
        /\b(research|search|create|write|generate|build|send|email|analyze|compare|find|make|deploy|publish|share|draft|design|review|test|fix|implement)\b/g,
      ) || [];

    // Need at least 2 distinct phases signaled by connectives + verbs
    if (actionVerbs.length < 2) return null;

    const hasConnectives = PHASE_SPLITTERS.some((re) => re.test(prompt));
    if (!hasConnectives) return null;

    // Split into phases
    const rawPhases = splitIntoPhases(prompt);
    if (rawPhases.length < 2) return null;

    // Build ordered phases
    const phases: WorkflowPhase[] = rawPhases.map((text, i) => {
      const id = `phase-${i + 1}`;
      return {
        id,
        order: i + 1,
        title: generatePhaseTitle(text, i + 1),
        prompt: text.trim(),
        phaseType: detectPhaseType(text),
        dependsOn: i > 0 ? [`phase-${i}`] : [],
        status: "pending",
      };
    });

    return phases;
  }

  /**
   * LLM-powered decomposition fallback for complex prompts where regex fails.
   * Returns null if the LLM call fails or output can't be parsed.
   */
  static async decomposeWithLLM(
    prompt: string,
    provider: LLMProvider,
    modelId: string,
  ): Promise<WorkflowPhase[] | null> {
    try {
      const systemPrompt =
        "You decompose complex user prompts into sequential workflow phases. " +
        'Output ONLY a JSON array of objects with keys: "title" (string), "prompt" (string), "phaseType" (one of: research, create, deliver, analyze, general). ' +
        "Each phase should be a self-contained task. Output 2-8 phases. No explanation, just valid JSON.";

      const response = await provider.createMessage({
        model: modelId,
        maxTokens: 1024,
        system: systemPrompt,
        messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
      });

      // Extract text from response
      const text = (response.content || [])
        .filter((b: Any) => b.type === "text")
        .map((b: Any) => b.text)
        .join("");

      // Parse JSON — try to extract array from response
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return null;

      const parsed = JSON.parse(jsonMatch[0]) as Array<{
        title: string;
        prompt: string;
        phaseType?: string;
      }>;

      if (!Array.isArray(parsed) || parsed.length < 2) return null;

      const validPhaseTypes = new Set(["research", "create", "deliver", "analyze", "general"]);

      return parsed.slice(0, 8).map((item, i) => ({
        id: `phase-${i + 1}`,
        order: i + 1,
        title: item.title || `Phase ${i + 1}`,
        prompt: item.prompt || "",
        phaseType: (validPhaseTypes.has(item.phaseType || "")
          ? item.phaseType
          : "general") as WorkflowPhase["phaseType"],
        dependsOn: i > 0 ? [`phase-${i}`] : [],
        status: "pending" as const,
      }));
    } catch {
      return null;
    }
  }
}

/**
 * Split the prompt into phase segments using connective patterns.
 */
function splitIntoPhases(prompt: string): string[] {
  // Build a combined regex from all splitters
  const patterns = PHASE_SPLITTERS.map((re) => re.source);
  const combined = new RegExp(`(?:${patterns.join("|")})`, "gi");

  const segments = prompt
    .split(combined)
    .map((s) => s.trim())
    .filter((s) => s.length > 5);

  return segments;
}

/**
 * Generate a concise title for a phase from its text.
 */
function generatePhaseTitle(text: string, order: number): string {
  // Take first 60 chars, trim to last word boundary
  const trimmed = text.slice(0, 60);
  const lastSpace = trimmed.lastIndexOf(" ");
  const title = lastSpace > 20 ? trimmed.slice(0, lastSpace) : trimmed;
  return `Phase ${order}: ${title}${title.length < text.length ? "..." : ""}`;
}

/**
 * Detect the type of a phase from its content.
 */
function detectPhaseType(text: string): WorkflowPhase["phaseType"] {
  for (const [pattern, type] of PHASE_TYPE_PATTERNS) {
    if (pattern.test(text)) return type;
  }
  return "general";
}
