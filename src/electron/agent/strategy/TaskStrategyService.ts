import { AgentConfig, ConversationMode } from "../../../shared/types";
import { IntentRoute } from "./IntentRouter";

export interface DerivedTaskStrategy {
  conversationMode: ConversationMode;
  maxTurns: number;
  qualityPasses: 1 | 2 | 3;
  answerFirst: boolean;
  boundedResearch: boolean;
  timeoutFinalizeBias: boolean;
}

export const STRATEGY_CONTEXT_OPEN = "[AGENT_STRATEGY_CONTEXT_V1]";
export const STRATEGY_CONTEXT_CLOSE = "[/AGENT_STRATEGY_CONTEXT_V1]";

export class TaskStrategyService {
  static derive(route: IntentRoute, existing?: AgentConfig): DerivedTaskStrategy {
    const defaults: Record<IntentRoute["intent"], DerivedTaskStrategy> = {
      chat: {
        conversationMode: "chat",
        maxTurns: 16,
        qualityPasses: 1,
        answerFirst: true,
        boundedResearch: true,
        timeoutFinalizeBias: true,
      },
      advice: {
        conversationMode: "hybrid",
        maxTurns: 30,
        qualityPasses: 2,
        answerFirst: true,
        boundedResearch: true,
        timeoutFinalizeBias: true,
      },
      planning: {
        conversationMode: "hybrid",
        maxTurns: 36,
        qualityPasses: 2,
        answerFirst: true,
        boundedResearch: true,
        timeoutFinalizeBias: true,
      },
      execution: {
        conversationMode: "task",
        maxTurns: 60,
        qualityPasses: 2,
        answerFirst: false,
        boundedResearch: true,
        timeoutFinalizeBias: true,
      },
      mixed: {
        conversationMode: "hybrid",
        maxTurns: 42,
        qualityPasses: 2,
        answerFirst: true,
        boundedResearch: true,
        timeoutFinalizeBias: true,
      },
    };

    const base = defaults[route.intent];
    return {
      conversationMode: existing?.conversationMode ?? base.conversationMode,
      maxTurns: typeof existing?.maxTurns === "number" ? existing.maxTurns : base.maxTurns,
      qualityPasses: existing?.qualityPasses ?? base.qualityPasses,
      answerFirst: base.answerFirst,
      boundedResearch: base.boundedResearch,
      timeoutFinalizeBias: base.timeoutFinalizeBias,
    };
  }

  static applyToAgentConfig(
    existing: AgentConfig | undefined,
    strategy: DerivedTaskStrategy,
  ): AgentConfig {
    const next: AgentConfig = existing ? { ...existing } : {};
    if (!next.conversationMode) {
      next.conversationMode = strategy.conversationMode;
    }
    if (typeof next.maxTurns !== "number") {
      next.maxTurns = strategy.maxTurns;
    }
    if (!next.qualityPasses) {
      next.qualityPasses = strategy.qualityPasses;
    }
    return next;
  }

  static decoratePrompt(
    prompt: string,
    route: IntentRoute,
    strategy: DerivedTaskStrategy,
    relationshipContext: string,
  ): string {
    const text = String(prompt || "").trim();
    if (!text) return text;
    if (text.includes(STRATEGY_CONTEXT_OPEN)) return text;

    const lines = [
      STRATEGY_CONTEXT_OPEN,
      `intent=${route.intent}`,
      `confidence=${route.confidence.toFixed(2)}`,
      `conversation_mode=${strategy.conversationMode}`,
      `answer_first=${strategy.answerFirst ? "true" : "false"}`,
      `bounded_research=${strategy.boundedResearch ? "true" : "false"}`,
      `timeout_finalize_bias=${strategy.timeoutFinalizeBias ? "true" : "false"}`,
      "execution_contract:",
      "- Directly answer the user question before any deep expansion.",
      "- Keep research/tool loops bounded; stop once the answer is supportable.",
      "- Never end silently. Always return a complete best-effort answer.",
    ];

    if (relationshipContext) {
      lines.push("relationship_memory:");
      lines.push(relationshipContext);
    }

    lines.push(STRATEGY_CONTEXT_CLOSE);

    return `${text}\n\n${lines.join("\n")}`;
  }
}
