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
  private static inferArtifactKindFromTaskText(text: string): "none" | "canvas" | "document" | "file" {
    if (!text) return "none";
    if (/\b(canvas|artifact)\b/.test(text)) return "canvas";
    if (/\b(docx|pdf|document|report|slide deck|presentation)\b/.test(text)) return "document";
    if (
      /\b(file|files|project|widget|source|code)\b/.test(text) ||
      /\.(xcodeproj|xcworkspace|xcscheme|pbxproj|entitlements|plist|html|swift|ts|tsx|js|jsx|css)\b/.test(
        text,
      )
    ) {
      return "file";
    }
    return "none";
  }

  private static inferRequiresMutationFromTaskText(text: string): boolean {
    if (!text) return false;
    return /\b(scaffold|bootstrap|initialize|set up|create|build|write|edit|fix|implement|modify|generate|render)\b/.test(
      text,
    );
  }

  private static isStrictConstraintArtifactTask(taskText: string): boolean {
    const text = String(taskText || "").toLowerCase();
    if (!text.trim()) return false;

    const hasStrictLengthConstraint =
      /\bexact(?:ly)?\s+\d+\s*(characters?|chars?|words?)\b/.test(text) ||
      /\b\d+\s*(characters?|chars?|words?)\s*(long|length)\b/.test(text) ||
      /\blen\s*\(\s*text\s*\)\s*==\s*\d+\b/.test(text) ||
      /\bstrict(?:ly)?\s+\d+\s*(characters?|chars?|words?)\b/.test(text);

    if (!hasStrictLengthConstraint) return false;

    const hasArtifactTarget =
      /\b(docx|word document|word file|pdf|canvas|interactive html|web app|artifact|document)\b/.test(
        text,
      );
    if (!hasArtifactTarget) return false;

    return true;
  }

  static deriveLlmProfile(
    strategy: Pick<DerivedTaskStrategy, "executionMode" | "preflightRequired">,
    taskContext: {
      intent?: IntentRoute["intent"];
      isVerificationTask?: boolean;
      strictConstraintArtifactTask?: boolean;
    } = {},
  ): LlmProfile {
    if (taskContext.isVerificationTask) {
      return "strong";
    }

    if (taskContext.strictConstraintArtifactTask) {
      return "strong";
    }

    if (strategy.preflightRequired) {
      return "strong";
    }

    // Verified mode: planning phase uses strong (handled here via preflightRequired
    // which is forced true for verified mode). Execution steps switch to cheap
    // dynamically inside the executor, not here.
    if (strategy.executionMode === "verified") {
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

  static derive(
    route: IntentRoute,
    existing?: AgentConfig,
    taskContext?: { title?: string; prompt?: string; lastProgressScore?: number },
  ): DerivedTaskStrategy {
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
        maxTurns: 100,
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
      redirect: {
        conversationMode: "task",
        maxTurns: 64,
        qualityPasses: 1,
        answerFirst: false,
        boundedResearch: false,
        timeoutFinalizeBias: false,
        preflightRequired: false,
      },
    };

    // Enable pre-flight framing for complex execution/mixed tasks, all workflows, and deep work
    let preflightRequired =
      route.intent === "workflow" ||
      route.intent === "deep_work" ||
      ((route.intent === "execution" || route.intent === "mixed") && route.complexity === "high");

    const isDeepWork = route.intent === "deep_work";
    const isWorkflowOrDeepWork = isDeepWork || route.intent === "workflow";

    const base = defaults[route.intent];
    const taskText = `${taskContext?.title || ""}\n${taskContext?.prompt || ""}`.toLowerCase();
    const executionVerbCount = (
      taskText.match(
        /\b(create|build|edit|write|fix|deploy|run|install|execute|configure|implement|update|modify|delete|remove|test|verify|research|analyze|summarize|generate|draft|prepare|export)\b/g,
      ) || []
    ).length;
    const workflowLike =
      /\b(then|after that|after this|next|and then|finally|once done|once that's done|step \d)\b/.test(
        taskText,
      ) && executionVerbCount >= 3;
    const artifactCreationSignal =
      /\b(create|build|make|implement|scaffold|generate|start building|start build)\b/.test(taskText) &&
      /\b(website|web page|webapp|frontend|landing page|app|application|project|repo|repository|codebase|distro|distribution|iso|image|artifact|file|files|workspace|requirements\.md|config)\b/.test(
        taskText,
      );
    const buildVerifyRenderArtifactRequested =
      /\b(build|create|implement|scaffold|generate)\b/.test(taskText) &&
      /\b(verify|validate|test|check)\b/.test(taskText) &&
      /\b(render|show|preview|display)\b/.test(taskText) &&
      /\b(canvas|artifact|widget|project|html|file|document)\b/.test(taskText);
    const buildRenderArtifactRequested =
      /\b(build|create|implement|scaffold|generate)\b/.test(taskText) &&
      /\b(render|show|preview|display)\b/.test(taskText) &&
      /\b(canvas|artifact|widget|project|html|file|document)\b/.test(taskText);
    const hasHardExecutionSignal = route.signals.some((signal) =>
      [
        "path-or-command",
        "needs-tool-inspection",
        "cloud-storage-file-access",
        "cloud-storage-query",
        "shell-troubleshooting",
        "terminal-transcript",
      ].includes(signal),
    );

    // Strict execute gate:
    // - Always execute for explicit execution/workflow/deep-work intents
    // - For mixed intent, require hard execution cues; otherwise keep plan mode
    const inferredExecutionMode: ExecutionMode =
      route.intent === "execution" ||
      route.intent === "workflow" ||
      route.intent === "deep_work" ||
      (route.intent === "mixed" && (hasHardExecutionSignal || artifactCreationSignal)) ||
      buildVerifyRenderArtifactRequested ||
      buildRenderArtifactRequested
        ? "execute"
        : route.intent === "chat"
          ? "analyze"
          : "plan";
    const existingExecutionMode = existing?.executionMode;
    // Verified mode is always user-selected; preserve it and force planning.
    if (existingExecutionMode === "verified") {
      preflightRequired = true;
    }
    // Keep explicit non-execute overrides (plan/analyze/verified), but do not let a
    // stale default `execute` force non-execution intents into full task mode.
    const executionMode =
      existingExecutionMode && (existingExecutionMode !== "execute" || inferredExecutionMode === "execute")
        ? existingExecutionMode
        : inferredExecutionMode;
    const taskDomain =
      existing?.taskDomain && existing.taskDomain !== "auto" ? existing.taskDomain : route.domain;
    const strictConstraintArtifactTask = this.isStrictConstraintArtifactTask(
      `${taskContext?.title || ""}\n${taskContext?.prompt || ""}`,
    );
    const inferredArtifactKind = this.inferArtifactKindFromTaskText(taskText);
    const inferredRequiresMutation =
      this.inferRequiresMutationFromTaskText(taskText) && inferredArtifactKind !== "none";
    const previousWindowLowProgress =
      typeof taskContext?.lastProgressScore === "number" && taskContext.lastProgressScore < 0.15;

    const baseLlmProfileHint = this.deriveLlmProfile(
      {
        executionMode,
        preflightRequired,
      },
      {
        intent: route.intent,
        strictConstraintArtifactTask,
      },
    );
    const llmProfileHint =
      buildVerifyRenderArtifactRequested ||
      buildRenderArtifactRequested ||
      (baseLlmProfileHint === "cheap" &&
        inferredRequiresMutation &&
        ["canvas", "document", "file"].includes(inferredArtifactKind) &&
        previousWindowLowProgress)
        ? "strong"
        : baseLlmProfileHint;
    const mixedExecutionSignal =
      route.intent === "mixed" &&
      (route.signals.includes("path-or-command") ||
        route.signals.includes("needs-tool-inspection") ||
        route.signals.includes("shell-troubleshooting") ||
        route.signals.includes("terminal-transcript") ||
        executionVerbCount >= 3);
    const mixedMaxTurns =
      route.intent !== "mixed"
        ? base.maxTurns
        : workflowLike && route.complexity === "high"
          ? 80
          : mixedExecutionSignal
            ? 60
            : base.maxTurns;
    const strategyMaxTurns = buildVerifyRenderArtifactRequested || buildRenderArtifactRequested
      ? Math.max(mixedMaxTurns, 80)
      : mixedMaxTurns;
    const configuredMaxTurns =
      typeof existing?.maxTurns === "number" ? existing.maxTurns : strategyMaxTurns;
    const maxTurns = buildVerifyRenderArtifactRequested || buildRenderArtifactRequested
      ? Math.max(configuredMaxTurns, 80)
      : configuredMaxTurns;

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
      maxTurns,
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
    const existingExecutionMode = existing?.executionMode;
    const inferredExistingExecutionModeSource =
      existing?.executionModeSource ||
      (existingExecutionMode
        ? existingExecutionMode === "execute"
          ? "strategy"
          : "user"
        : undefined);
    if (!next.conversationMode || next.conversationMode === "hybrid") {
      next.conversationMode = strategy.conversationMode;
    }
    if (!next.executionMode) {
      next.executionMode = strategy.executionMode;
      next.executionModeSource = "strategy";
    } else if (next.executionMode === "execute" && strategy.executionMode !== "execute") {
      // Downshift stale execute defaults for non-execution intents (advice/chat/planning/thinking).
      next.executionMode = strategy.executionMode;
      next.executionModeSource = "strategy";
    } else if (!next.executionModeSource && inferredExistingExecutionModeSource) {
      next.executionModeSource = inferredExistingExecutionModeSource;
    }
    if (!next.taskDomain || next.taskDomain === "auto") {
      next.taskDomain = strategy.taskDomain;
    }
    if (typeof next.maxTurns !== "number") {
      next.maxTurns = strategy.maxTurns;
    }
    if (!next.turnBudgetPolicy) {
      next.turnBudgetPolicy =
        strategy.executionMode === "execute" || strategy.executionMode === "verified"
          ? "adaptive_unbounded"
          : "hard_window";
    }
    if (!next.workspacePathAliasPolicy) {
      next.workspacePathAliasPolicy = "rewrite_and_retry";
    }
    if (!next.taskPathRootPolicy) {
      next.taskPathRootPolicy = "pin_and_rewrite";
    }
    if (typeof next.pathDriftRetryBudget !== "number") {
      next.pathDriftRetryBudget = 3;
    }
    if (typeof next.suppressToolDisableOnRecoverablePathDrift !== "boolean") {
      next.suppressToolDisableOnRecoverablePathDrift = true;
    }
    if (typeof next.mutationCheckpointRetryBudget !== "number") {
      next.mutationCheckpointRetryBudget = 1;
    }
    if (typeof next.followUpAutoRecovery !== "boolean") {
      next.followUpAutoRecovery = true;
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
        strategy.executionMode === "plan"
          ? "- You are in plan mode: provide plans/options and avoid mutating tool calls."
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
      "count_text",
      "text_metrics",
      // Scratchpad
      "scratchpad_write",
      "scratchpad_read",
      // Meta tools
      "revise_plan",
      "request_user_input",
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
      // Diagrams (lightweight UI-only, no side effects)
      "create_diagram",
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
        "generate_presentation",
        "use_skill",
        "skill_list",
        "skill_get",
      ];
      if (domain === "writing") {
        tools.push("create_document");
        tools.push("create_presentation");
        tools.push("create_spreadsheet");
      }
      return new Set(tools);
    }

    // Unknown intent — return all tools as safe default
    return new Set(["*"]);
  }
}
