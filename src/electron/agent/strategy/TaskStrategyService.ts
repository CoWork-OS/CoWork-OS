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
  /** Signals executor to enable deep work behaviors (research-retry, journaling, auto-report) */
  deepWorkMode: boolean;
  /** Generate a final markdown report on task completion */
  autoReportEnabled: boolean;
  /** Emit periodic progress journal entries for fire-and-forget visibility */
  progressJournalEnabled: boolean;
}

export const STRATEGY_CONTEXT_OPEN = "[AGENT_STRATEGY_CONTEXT_V1]";
export const STRATEGY_CONTEXT_CLOSE = "[/AGENT_STRATEGY_CONTEXT_V1]";

export class TaskStrategyService {
  static derive(route: IntentRoute, existing?: AgentConfig): DerivedTaskStrategy {
    const defaults: Record<
      IntentRoute["intent"],
      Omit<DerivedTaskStrategy, "deepWorkMode" | "autoReportEnabled" | "progressJournalEnabled">
    > = {
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
      workflow: {
        conversationMode: "task",
        maxTurns: 80,
        qualityPasses: 2,
        answerFirst: false,
        boundedResearch: false,
        timeoutFinalizeBias: false,
        preflightRequired: true,
      },
      deep_work: {
        conversationMode: "task",
        maxTurns: 250,
        qualityPasses: 3,
        answerFirst: false,
        boundedResearch: false,
        timeoutFinalizeBias: false,
        preflightRequired: true,
      },
    };

    // Enable pre-flight framing for complex execution/mixed tasks, all workflows, and deep work
    const preflightRequired =
      route.intent === "workflow" ||
      route.intent === "deep_work" ||
      ((route.intent === "execution" || route.intent === "mixed") && route.complexity === "high");

    const isDeepWork = route.intent === "deep_work";
    const isWorkflowOrDeepWork = isDeepWork || route.intent === "workflow";

    const base = defaults[route.intent];
    return {
      // Preserve explicit user-set modes (chat/task/think) but let intent-derived
      // strategy override the default "hybrid" so the daemon's IntentRouter decision
      // actually takes effect at execution time.
      conversationMode:
        existing?.conversationMode && existing.conversationMode !== "hybrid"
          ? existing.conversationMode
          : base.conversationMode,
      maxTurns: typeof existing?.maxTurns === "number" ? existing.maxTurns : base.maxTurns,
      qualityPasses: existing?.qualityPasses ?? base.qualityPasses,
      answerFirst: base.answerFirst,
      boundedResearch: base.boundedResearch,
      timeoutFinalizeBias: base.timeoutFinalizeBias,
      preflightRequired,
      deepWorkMode: isDeepWork,
      autoReportEnabled: isWorkflowOrDeepWork,
      progressJournalEnabled: isDeepWork,
    };
  }

  static applyToAgentConfig(
    existing: AgentConfig | undefined,
    strategy: DerivedTaskStrategy,
  ): AgentConfig {
    const next: AgentConfig = existing ? { ...existing } : {};
    if (!next.conversationMode || next.conversationMode === "hybrid") {
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
    if (strategy.deepWorkMode) {
      next.deepWorkMode = true;
      next.autonomousMode = true;
    }
    if (strategy.autoReportEnabled) {
      next.autoReportEnabled = true;
    }
    if (strategy.progressJournalEnabled) {
      next.progressJournalEnabled = true;
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
    } else if (route.intent === "deep_work") {
      lines.push(
        "deep_work_contract:",
        "- This is a long-running autonomous task. You have a large turn budget (250 turns).",
        "- When you encounter errors, research solutions online using web_search before retrying.",
        "- Use scratchpad_write to record progress, discovered issues, and approach decisions.",
        "- Use scratchpad_read to review your notes and maintain context during long runs.",
        "- Decompose the work into sub-tasks and use spawn_agent or orchestrate_agents for parallel work.",
        "- VERIFY YOUR WORK: After making changes, run tests, linters, or build commands to confirm correctness.",
        "  If tests fail, read the error output carefully, diagnose the root cause, fix it, and re-run.",
        "  Repeat this debug loop until tests pass. Do not move on with known failures.",
        "- Use cheaper sub-agents (model_preference='cheaper') for routine tasks like formatting, data gathering, or boilerplate.",
        "- At completion, a markdown report will be auto-generated summarizing what was done.",
        "- Emit clear progress messages so status is visible during the run.",
        "- Be tenacious: when something fails, try alternative approaches rather than giving up.",
        "  Debug systematically: reproduce the error, form a hypothesis, test the fix, confirm resolution.",
      );
    } else if (route.intent === "workflow") {
      lines.push(
        "workflow_contract:",
        "- This is a multi-phase workflow. Decompose into sequential phases.",
        "- Execute each phase completely before moving to the next.",
        "- Pass output from each phase as context to the next phase.",
        "- Report progress at each phase boundary.",
      );
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

  /**
   * Returns the set of tool names relevant for a given intent.
   * If the set contains "*", all tools should be offered.
   * For lighter intents (chat, advice, planning, thinking), a reduced set is returned
   * to cut input tokens and reduce latency.
   */
  static getRelevantToolSet(intent: string): Set<string> {
    // Core tools always available regardless of intent
    const CORE_TOOLS = [
      // File operations
      "read_file",
      "read_files",
      "write_file",
      "edit_file",
      "copy_file",
      "list_directory",
      "list_directory_with_sizes",
      "get_file_info",
      "search_files",
      "create_directory",
      "rename_file",
      "delete_file",
      // Code search
      "glob",
      "grep",
      // Scratchpad
      "scratchpad_write",
      "scratchpad_read",
      // Meta tools
      "revise_plan",
      "task_history",
      "set_personality",
      "set_agent_name",
      "set_user_name",
      "set_persona",
      "set_response_style",
      "set_quirks",
      "set_vibes",
      "update_lore",
      // Memory
      "search_memories",
      "memory_save",
      // System
      "system_info",
    ];

    // Action-heavy intents get all tools
    if (
      intent === "execution" ||
      intent === "mixed" ||
      intent === "workflow" ||
      intent === "deep_work"
    ) {
      return new Set(["*"]);
    }

    // Chat: minimal toolset — just file reading and memory
    if (intent === "chat") {
      return new Set(CORE_TOOLS);
    }

    // Thinking: core + web research
    if (intent === "thinking") {
      return new Set([...CORE_TOOLS, "web_search", "web_fetch"]);
    }

    // Advice and planning: core + web + documents
    if (intent === "advice" || intent === "planning") {
      return new Set([
        ...CORE_TOOLS,
        "web_search",
        "web_fetch",
        "generate_document",
        "generate_spreadsheet",
        "use_skill",
        "skill_list",
        "skill_get",
      ]);
    }

    // Unknown intent — return all tools as safe default
    return new Set(["*"]);
  }
}
