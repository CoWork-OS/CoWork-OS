import { AgentConfig, ConversationMode } from "../../../shared/types";
import { IntentRoute } from "./IntentRouter";

export interface DerivedTaskStrategy {
  conversationMode: ConversationMode;
  maxTurns: number;
  qualityPasses: 1 | 2 | 3;
  answerFirst: boolean;
  boundedResearch: boolean;
  timeoutFinalizeBias: boolean;
  preflightRequired: boolean;
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
        preflightRequired: false,
      },
      advice: {
        conversationMode: "hybrid",
        maxTurns: 30,
        qualityPasses: 2,
        answerFirst: true,
        boundedResearch: true,
        timeoutFinalizeBias: true,
        preflightRequired: false,
      },
      planning: {
        conversationMode: "hybrid",
        maxTurns: 36,
        qualityPasses: 2,
        answerFirst: true,
        boundedResearch: true,
        timeoutFinalizeBias: true,
        preflightRequired: false,
      },
      execution: {
        conversationMode: "task",
        maxTurns: 60,
        qualityPasses: 2,
        answerFirst: false,
        boundedResearch: true,
        timeoutFinalizeBias: true,
        preflightRequired: false,
      },
      mixed: {
        conversationMode: "hybrid",
        maxTurns: 42,
        qualityPasses: 2,
        answerFirst: true,
        boundedResearch: true,
        timeoutFinalizeBias: true,
        preflightRequired: false,
      },
      thinking: {
        conversationMode: "think",
        maxTurns: 20,
        qualityPasses: 1,
        answerFirst: true,
        boundedResearch: true,
        timeoutFinalizeBias: true,
        preflightRequired: false,
      },
    };

    // Enable pre-flight framing for complex execution/mixed tasks
    const preflightRequired =
      (route.intent === "execution" || route.intent === "mixed") && route.complexity === "high";

    const base = defaults[route.intent];
    return {
      conversationMode: existing?.conversationMode ?? base.conversationMode,
      maxTurns: typeof existing?.maxTurns === "number" ? existing.maxTurns : base.maxTurns,
      qualityPasses: existing?.qualityPasses ?? base.qualityPasses,
      answerFirst: base.answerFirst,
      boundedResearch: base.boundedResearch,
      timeoutFinalizeBias: base.timeoutFinalizeBias,
      preflightRequired,
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
    if (strategy.preflightRequired) {
      next.preflightRequired = true;
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
      `complexity=${route.complexity}`,
      `conversation_mode=${strategy.conversationMode}`,
      `answer_first=${strategy.answerFirst ? "true" : "false"}`,
      `bounded_research=${strategy.boundedResearch ? "true" : "false"}`,
      `timeout_finalize_bias=${strategy.timeoutFinalizeBias ? "true" : "false"}`,
    ];

    if (route.intent === "thinking") {
      // Behavioural rules live in the system prompt (buildChatOrThinkSystemPrompt).
      // The decorated prompt only marks the contract type so the executor
      // can detect think-mode from the prompt metadata.
      lines.push("thinking_contract: active");
    } else {
      lines.push(
        "execution_contract:",
        "- Directly answer the user question before any deep expansion.",
        "- Keep research/tool loops bounded; stop once the answer is supportable.",
        "- Never end silently. Always return a complete best-effort answer.",
      );
    }

    if (relationshipContext) {
      lines.push("relationship_memory:");
      lines.push(relationshipContext);
    }

    lines.push(STRATEGY_CONTEXT_CLOSE);

    return `${text}\n\n${lines.join("\n")}`;
  }
}
