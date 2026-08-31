import type { LLMProvider } from "../agent/llm/types";
import { recordLlmCallError, recordLlmCallSuccess } from "../agent/llm/usage-telemetry";
import {
  MULTITASK_DEFAULT_LANE_COUNT,
  MULTITASK_MAX_LANE_COUNT,
  MULTITASK_MIN_LANE_COUNT,
} from "../../shared/multitask-command";

export interface MultitaskLane {
  title: string;
  description: string;
}

export interface MultitaskLanePlannerOptions {
  requestedLaneCount?: number;
  provider?: LLMProvider;
  modelId?: string;
}

const FALLBACK_LANES: Array<{ title: string; focus: string }> = [
  {
    title: "Context and Scope",
    focus:
      "Map the current system, clarify constraints, and identify the safest execution boundaries.",
  },
  {
    title: "Implementation Path",
    focus: "Design or make the concrete code/product changes needed for the request.",
  },
  {
    title: "Risk Review",
    focus: "Look for regressions, security concerns, edge cases, and missing assumptions.",
  },
  {
    title: "Verification",
    focus: "Define and run or describe the checks needed to prove the work is complete.",
  },
  {
    title: "User Experience",
    focus: "Evaluate the request from the end-user workflow and interface behavior.",
  },
  {
    title: "Data and State",
    focus: "Inspect persistence, migrations, state transitions, and compatibility requirements.",
  },
  {
    title: "Performance",
    focus: "Assess latency, concurrency, resource usage, and scalability risks.",
  },
  {
    title: "Documentation and Handoff",
    focus: "Capture the final usage notes, limitations, and handoff details.",
  },
];

function normalizeLaneCount(value?: number): number {
  if (!Number.isFinite(value || NaN)) return MULTITASK_DEFAULT_LANE_COUNT;
  return Math.max(
    MULTITASK_MIN_LANE_COUNT,
    Math.min(MULTITASK_MAX_LANE_COUNT, Math.floor(value || MULTITASK_DEFAULT_LANE_COUNT)),
  );
}

function cleanLaneText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function parseExplicitLanes(prompt: string, laneCount: number): MultitaskLane[] | null {
  const lines = prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const lanes: MultitaskLane[] = [];
  for (const line of lines) {
    const match = line.match(/^(?:[-*•]|\d+[.)])\s+(.+)$/);
    if (!match) continue;
    const text = cleanLaneText(match[1] || "");
    if (!text) continue;
    const parts = text.split(/\s[-–—:]\s/);
    const title = cleanLaneText(parts[0] || text).slice(0, 80);
    const description = cleanLaneText(parts.slice(1).join(" - ") || text);
    lanes.push({ title, description });
  }
  return lanes.length >= 2 ? lanes.slice(0, laneCount) : null;
}

function parseJsonLanes(text: string, laneCount: number): MultitaskLane[] | null {
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return null;
  const parsed = JSON.parse(jsonMatch[0]) as Array<{
    title?: unknown;
    description?: unknown;
    prompt?: unknown;
  }>;
  if (!Array.isArray(parsed)) return null;
  const lanes = parsed
    .map((item, index) => {
      const title =
        typeof item.title === "string" && item.title.trim()
          ? item.title.trim()
          : `Lane ${index + 1}`;
      const description =
        typeof item.description === "string" && item.description.trim()
          ? item.description.trim()
          : typeof item.prompt === "string" && item.prompt.trim()
            ? item.prompt.trim()
            : title;
      return {
        title: cleanLaneText(title).slice(0, 80),
        description: cleanLaneText(description).slice(0, 2000),
      };
    })
    .filter((lane) => lane.title && lane.description)
    .slice(0, laneCount);
  return lanes.length >= 2 ? lanes : null;
}

function fallbackLanes(prompt: string, laneCount: number): MultitaskLane[] {
  return FALLBACK_LANES.slice(0, laneCount).map((lane) => ({
    title: lane.title,
    description: `${lane.focus}\n\nOriginal request: ${prompt}`,
  }));
}

export class MultitaskLanePlanner {
  static async plan(
    prompt: string,
    options: MultitaskLanePlannerOptions = {},
  ): Promise<MultitaskLane[]> {
    const laneCount = normalizeLaneCount(options.requestedLaneCount);
    const explicit = parseExplicitLanes(prompt, laneCount);
    if (explicit) return explicit;

    if (options.provider && options.modelId) {
      const llmLanes = await this.planWithLLM(prompt, laneCount, options.provider, options.modelId);
      if (llmLanes) return llmLanes;
    }

    return fallbackLanes(prompt, laneCount);
  }

  private static async planWithLLM(
    prompt: string,
    laneCount: number,
    provider: LLMProvider,
    modelId: string,
  ): Promise<MultitaskLane[] | null> {
    try {
      const response = await provider.createMessage({
        model: modelId,
        maxTokens: 900,
        system:
          "Split a user request into independent parallel work lanes for sub-agents. " +
          'Output ONLY a JSON array of objects with "title" and "description". ' +
          `Return exactly ${laneCount} lanes. Each lane must be self-contained, ` +
          "non-overlapping, and useful for parallel execution.",
        messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
      });
      recordLlmCallSuccess(
        {
          sourceKind: "multitask_lane_plan",
          providerType: provider.type,
          modelKey: modelId,
          modelId,
        },
        response.usage,
      );
      const text = (response.content || [])
        .filter(
          (block): block is { type: "text"; text: string } =>
            block.type === "text" && typeof (block as { text?: string }).text === "string",
        )
        .map((block) => block.text)
        .join("");
      return parseJsonLanes(text, laneCount);
    } catch (error) {
      recordLlmCallError(
        {
          sourceKind: "multitask_lane_plan",
          providerType: provider.type,
          modelKey: modelId,
          modelId,
        },
        error,
      );
      return null;
    }
  }
}
