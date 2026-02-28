import {
  AgentConfig,
  ConversationMode,
  ExecutionMode,
  LlmProfile,
  TaskDomain,
} from "../../../shared/types";
import { IntentRoute } from "./IntentRouter";

export interface DerivedTaskStrategy {
  conversationMode: ConversationMode;
  executionMode: ExecutionMode;
  taskDomain: TaskDomain;
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
  /** Strategy-derived model routing hint */
  llmProfileHint: LlmProfile;
}

export const STRATEGY_CONTEXT_OPEN = "[AGENT_STRATEGY_CONTEXT_V1]";
export const STRATEGY_CONTEXT_CLOSE = "[/AGENT_STRATEGY_CONTEXT_V1]";

export class TaskStrategyService {
  static deriveLlmProfile(
    strategy: Pick<DerivedTaskStrategy, "executionMode" | "preflightRequired">,
    taskContext: {
      intent?: IntentRoute["intent"];
      isVerificationTask?: boolean;
    } = {},
  ): LlmProfile {
    if (taskContext.isVerificationTask) {
      return "strong";
    }

    if (strategy.preflightRequired) {
      return "strong";
    }

    if (strategy.executionMode !== "execute") {
      return "strong";
    }

    if (taskContext.intent === "planning") {
      return "strong";
    }

    return "cheap";
  }

  static derive(route: IntentRoute, existing?: AgentConfig): DerivedTaskStrategy {
    const defaults: Record<
      IntentRoute["intent"],
      Omit<
        DerivedTaskStrategy,
        | "executionMode"
        | "taskDomain"
        | "deepWorkMode"
        | "autoReportEnabled"
        | "progressJournalEnabled"
        | "llmProfileHint"
      >
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
        qualityPasses: 2,
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
    const inferredExecutionMode: ExecutionMode =
      route.intent === "execution" ||
      route.intent === "workflow" ||
      route.intent === "deep_work" ||
      route.intent === "mixed"
        ? "execute"
        : route.intent === "chat"
          ? "analyze"
          : "propose";
    const executionMode = existing?.executionMode ?? inferredExecutionMode;
    const taskDomain =
      existing?.taskDomain && existing.taskDomain !== "auto" ? existing.taskDomain : route.domain;
    const llmProfileHint = this.deriveLlmProfile(
      {
        executionMode,
        preflightRequired,
      },
      {
        intent: route.intent,
      },
    );

    return {
      // Preserve explicit user-set modes (chat/task/think) but let intent-derived
      // strategy override the default "hybrid" so the daemon's IntentRouter decision
      // actually takes effect at execution time.
      conversationMode:
        existing?.conversationMode && existing.conversationMode !== "hybrid"
          ? existing.conversationMode
          : base.conversationMode,
      executionMode,
      taskDomain,
      maxTurns: typeof existing?.maxTurns === "number" ? existing.maxTurns : base.maxTurns,
      qualityPasses: existing?.qualityPasses ?? base.qualityPasses,
      answerFirst: base.answerFirst,
      boundedResearch: base.boundedResearch,
      timeoutFinalizeBias: base.timeoutFinalizeBias,
      preflightRequired,
      deepWorkMode: isDeepWork,
      autoReportEnabled: isWorkflowOrDeepWork,
      progressJournalEnabled: isDeepWork,
      llmProfileHint,
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
    if (!next.executionMode) {
      next.executionMode = strategy.executionMode;
    }
    if (!next.taskDomain || next.taskDomain === "auto") {
      next.taskDomain = strategy.taskDomain;
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
      if (typeof next.autonomousMode !== "boolean") {
        next.autonomousMode = true;
      }
    }
    if (strategy.autoReportEnabled) {
      next.autoReportEnabled = true;
    }
    if (strategy.progressJournalEnabled) {
      next.progressJournalEnabled = true;
    }
    if (!next.modelKey) {
      next.llmProfileHint = strategy.llmProfileHint;
    } else {
      delete next.llmProfileHint;
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
      `execution_mode=${strategy.executionMode}`,
      `task_domain=${strategy.taskDomain}`,
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
      const deepWorkHeader = ["deep_work_contract:"];
      const universal = [
        "- This is a long-running autonomous task. You have a large turn budget (250 turns).",
        "- When you encounter errors, research alternatives using available tools before retrying.",
        "- Use scratchpad_write to record progress, blockers, and decisions.",
        "- Use scratchpad_read to preserve continuity across long runs.",
        "- Decompose work into sub-tasks and parallelize only when it improves delivery.",
        "- Emit clear progress messages so status is visible during the run.",
        "- At completion, include a concrete outcome summary and explicit blockers.",
      ];
      const technical =
        strategy.taskDomain === "code" || strategy.taskDomain === "operations"
          ? [
              "- VERIFY YOUR WORK: run tests/lint/build checks before claiming completion.",
              "  If checks fail, diagnose root cause, fix, and re-run until resolved.",
            ]
          : [
              "- Validate deliverables against the request before finishing.",
              "- Prefer concise user-facing outputs over implementation detail unless requested.",
            ];
      lines.push(...deepWorkHeader, ...universal, ...technical);
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

    if (strategy.executionMode !== "execute") {
      lines.push(
        "mode_contract:",
        strategy.executionMode === "propose"
          ? "- You are in propose mode: provide plans/options and avoid mutating tool calls."
          : "- You are in analyze mode: stay read-only and provide analysis from available evidence.",
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
  static getRelevantToolSet(intent: string, domain: TaskDomain = "auto"): Set<string> {
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
      const tools = [
        ...CORE_TOOLS,
        "web_search",
        "web_fetch",
        "generate_document",
        "generate_spreadsheet",
        "use_skill",
        "skill_list",
        "skill_get",
      ];
      if (domain === "writing") {
        tools.push("create_document");
      }
      return new Set(tools);
    }

    // Unknown intent — return all tools as safe default
    return new Set(["*"]);
  }
}
