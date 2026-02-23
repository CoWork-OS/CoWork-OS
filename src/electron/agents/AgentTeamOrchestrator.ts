import type {
  AgentConfig,
  Task,
  AgentTeam,
  AgentTeamItem,
  AgentTeamRun,
  AgentTeamRunStatus,
  AgentTeamRunPhase,
  AgentTeamItemStatus,
  AgentThought,
  UpdateAgentTeamItemRequest,
  MultiLlmParticipant,
} from "../../shared/types";
import { IPC_CHANNELS, MULTI_LLM_PROVIDER_DISPLAY } from "../../shared/types";
import {
  resolveModelPreferenceToModelKey,
  resolvePersonalityPreference,
} from "../../shared/agent-preferences";
import { AgentTeamRepository } from "./AgentTeamRepository";
import { AgentTeamRunRepository } from "./AgentTeamRunRepository";
import { AgentTeamItemRepository } from "./AgentTeamItemRepository";
import { AgentTeamThoughtRepository } from "./AgentTeamThoughtRepository";

type AgentTeamRepositoryLike =
  | Pick<AgentTeamRepository, "findById">
  | { findById: (id: string) => AgentTeam | undefined };
type AgentTeamRunRepositoryLike =
  | Pick<AgentTeamRunRepository, "findById" | "update">
  | {
      findById: (id: string) => AgentTeamRun | undefined;
      update: (
        id: string,
        updates: {
          status?: AgentTeamRunStatus;
          completedAt?: number | null;
          error?: string | null;
          summary?: string | null;
          phase?: AgentTeamRunPhase;
        },
      ) => AgentTeamRun | undefined;
    };
type AgentTeamItemRepositoryLike =
  | Pick<AgentTeamItemRepository, "listByRun" | "listBySourceTaskId" | "update" | "create">
  | {
      listByRun: (teamRunId: string) => AgentTeamItem[];
      listBySourceTaskId: (sourceTaskId: string) => AgentTeamItem[];
      update: (request: UpdateAgentTeamItemRequest) => AgentTeamItem | undefined;
      create: (request: import("../../shared/types").CreateAgentTeamItemRequest) => AgentTeamItem;
    };

export type AgentTeamOrchestratorDeps = {
  getDatabase: () => import("better-sqlite3").Database;
  getTaskById: (taskId: string) => Promise<Task | undefined>;
  createChildTask: (params: {
    title: string;
    prompt: string;
    workspaceId: string;
    parentTaskId: string;
    agentType: "sub" | "parallel";
    agentConfig?: AgentConfig;
    depth?: number;
    assignedAgentRoleId?: string;
  }) => Promise<Task>;
  cancelTask: (taskId: string) => Promise<void>;
  wrapUpTask?: (taskId: string) => Promise<void>;
  completeRootTask?: (taskId: string, status: "completed" | "failed", summary: string) => void;
};

function getAllElectronWindows(): any[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require("electron") as any;
    if (!electron || typeof electron !== "object") return [];
    const BrowserWindow = electron?.BrowserWindow;
    if (BrowserWindow?.getAllWindows) return BrowserWindow.getAllWindows();
  } catch {
    // ignore
  }
  return [];
}

function emitTeamEvent(event: any): void {
  const windows = getAllElectronWindows();
  windows.forEach((window) => {
    try {
      if (!window.isDestroyed() && window.webContents && !window.webContents.isDestroyed()) {
        window.webContents.send(IPC_CHANNELS.TEAM_RUN_EVENT, event);
      }
    } catch {
      // ignore
    }
  });
}

/** Sentinel title used to identify the synthesis item created by transitionToSynthesizePhase. */
const SYNTHESIS_ITEM_TITLE = "Synthesis";

function isTerminalItemStatus(status: AgentTeamItemStatus): boolean {
  return status === "done" || status === "failed" || status === "blocked";
}

function isTerminalTaskStatus(status: Task["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export class AgentTeamOrchestrator {
  private teamRepo: AgentTeamRepositoryLike;
  private runRepo: AgentTeamRunRepositoryLike;
  private itemRepo: AgentTeamItemRepositoryLike;
  private thoughtRepo: AgentTeamThoughtRepository;
  private runLocks = new Map<string, boolean>();

  constructor(
    private deps: AgentTeamOrchestratorDeps,
    repos?: {
      teamRepo?: AgentTeamRepositoryLike;
      runRepo?: AgentTeamRunRepositoryLike;
      itemRepo?: AgentTeamItemRepositoryLike;
    },
  ) {
    const db = deps.getDatabase();
    this.thoughtRepo = new AgentTeamThoughtRepository(db);

    if (repos?.teamRepo && repos?.runRepo && repos?.itemRepo) {
      this.teamRepo = repos.teamRepo;
      this.runRepo = repos.runRepo;
      this.itemRepo = repos.itemRepo;
      return;
    }

    this.teamRepo = new AgentTeamRepository(db);
    this.runRepo = new AgentTeamRunRepository(db);
    this.itemRepo = new AgentTeamItemRepository(db);
  }

  /**
   * Get the thought repository (used by daemon for thought capture).
   */
  getThoughtRepo(): AgentTeamThoughtRepository {
    return this.thoughtRepo;
  }

  async tickRun(runId: string, reason: string = "tick"): Promise<void> {
    if (this.runLocks.get(runId)) return;
    this.runLocks.set(runId, true);
    try {
      const run = this.runRepo.findById(runId);
      if (!run) return;
      if (run.status !== "running") return;

      const team = this.teamRepo.findById(run.teamId);
      if (!team) return;

      const rootTask = await this.deps.getTaskById(run.rootTaskId);
      if (!rootTask) {
        const updated = this.runRepo.update(run.id, {
          status: "failed",
          error: `Root task not found: ${run.rootTaskId}`,
        });
        if (updated) {
          emitTeamEvent({ type: "team_run_updated", timestamp: Date.now(), run: updated, reason });
        }
        return;
      }

      const items = this.itemRepo.listByRun(run.id);

      // Reconcile any in-progress items whose tasks are already terminal.
      for (const item of items) {
        if (item.status !== "in_progress") continue;
        if (!item.sourceTaskId) continue;
        const task = await this.deps.getTaskById(item.sourceTaskId);
        if (!task) continue;
        if (!isTerminalTaskStatus(task.status)) continue;
        await this.onTaskTerminal(item.sourceTaskId);
      }

      const refreshedItems = this.itemRepo.listByRun(run.id);
      const inProgress = refreshedItems.filter((i) => i.status === "in_progress");

      // If everything is terminal, complete or transition the run.
      const nonTerminal = refreshedItems.filter((i) => !isTerminalItemStatus(i.status));
      if (nonTerminal.length === 0) {
        // In collaborative mode, transition to synthesis phase instead of completing.
        // This also handles the wrap-up path where phase was set to "synthesize"
        // before the synthesis task was actually spawned.
        const currentPhase = run.phase || "dispatch";
        const hasSynthesisItem = refreshedItems.some(
          (i) => i.title === SYNTHESIS_ITEM_TITLE,
        );
        if (run.collaborativeMode && currentPhase !== "complete" && !hasSynthesisItem) {
          await this.transitionToSynthesizePhase(run, team, rootTask, refreshedItems);
          return;
        }

        const hasFailures = refreshedItems.some((i) => i.status === "failed");
        const status = hasFailures ? "failed" : "completed";
        const summary = this.buildRunSummary(refreshedItems);
        const completedPhase = run.collaborativeMode ? "complete" : undefined;
        const updated = this.runRepo.update(run.id, {
          status,
          summary,
          ...(completedPhase ? { phase: completedPhase } : {}),
        });
        if (updated) {
          emitTeamEvent({
            type: "team_run_updated",
            timestamp: Date.now(),
            run: updated,
            reason: "all_items_terminal",
          });
        }
        // When a collaborative run finishes, mark the root task as completed/failed
        if (run.collaborativeMode && this.deps.completeRootTask) {
          this.deps.completeRootTask(
            run.rootTaskId,
            status === "failed" ? "failed" : "completed",
            summary,
          );
        }
        return;
      }

      const maxParallel = Math.max(1, Number(team.maxParallelAgents || 1));
      const slots = Math.max(0, maxParallel - inProgress.length);
      if (slots <= 0) return;

      const candidates = refreshedItems
        .filter((i) => i.status === "todo" && !i.sourceTaskId)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt);

      // Resolve multi-LLM participants from root task config
      const multiLlmParticipants: MultiLlmParticipant[] | undefined =
        run.multiLlmMode && rootTask.agentConfig?.multiLlmConfig?.participants
          ? rootTask.agentConfig.multiLlmConfig.participants
          : undefined;

      const toSpawn = candidates.slice(0, slots);
      for (let spawnIdx = 0; spawnIdx < toSpawn.length; spawnIdx++) {
        const item = toSpawn[spawnIdx];
        const depth = (typeof rootTask.depth === "number" ? rootTask.depth : 0) + 1;

        // Multi-LLM mode: override provider/model per child task
        if (run.multiLlmMode && multiLlmParticipants) {
          const participant = multiLlmParticipants[spawnIdx];
          if (!participant) continue;

          const childPrompt = this.buildMultiLlmItemPrompt(participant, rootTask);
          const agentConfig: AgentConfig = {
            retainMemory: false,
            bypassQueue: false,
            providerType: participant.providerType,
            modelKey: participant.modelKey,
          };

          const child = await this.deps.createChildTask({
            title: `${participant.displayName} Analysis`,
            prompt: childPrompt,
            workspaceId: rootTask.workspaceId,
            parentTaskId: rootTask.id,
            agentType: "sub",
            agentConfig,
            depth,
          });

          this.itemRepo.update({
            id: item.id,
            sourceTaskId: child.id,
            status: "in_progress",
          });

          emitTeamEvent({
            type: "team_item_spawned",
            timestamp: Date.now(),
            runId: run.id,
            item: this.itemRepo.listBySourceTaskId(child.id)[0] || item,
            spawnedTaskId: child.id,
          });
          continue;
        }

        // Standard collaborative/team mode
        const childTitle = item.title;
        const childPrompt = this.buildItemPrompt(
          team.name,
          rootTask,
          item.title,
          item.description,
          run.collaborativeMode,
        );
        const assignedRoleId = item.ownerAgentRoleId || team.leadAgentRoleId;

        const agentConfig: AgentConfig = {
          retainMemory: false,
          bypassQueue: false,
        };
        const modelKey = resolveModelPreferenceToModelKey(team.defaultModelPreference);
        if (modelKey) agentConfig.modelKey = modelKey;
        const personalityId = resolvePersonalityPreference(team.defaultPersonality);
        if (personalityId) agentConfig.personalityId = personalityId;

        const child = await this.deps.createChildTask({
          title: childTitle,
          prompt: childPrompt,
          workspaceId: rootTask.workspaceId,
          parentTaskId: rootTask.id,
          agentType: "sub",
          agentConfig,
          depth,
          assignedAgentRoleId: assignedRoleId,
        });

        const updatedItem = this.itemRepo.update({
          id: item.id,
          sourceTaskId: child.id,
          status: "in_progress",
        });

        if (updatedItem) {
          emitTeamEvent({
            type: "team_item_spawned",
            timestamp: Date.now(),
            runId: run.id,
            item: updatedItem,
            spawnedTaskId: child.id,
          });
        }
      }

      // In collaborative mode, transition from dispatch to think phase
      // once we've spawned at least one item
      if (run.collaborativeMode && toSpawn.length > 0) {
        const currentPhase = run.phase || "dispatch";
        if (currentPhase === "dispatch") {
          const updated = this.runRepo.update(run.id, { phase: "think" });
          if (updated) {
            emitTeamEvent({
              type: "team_run_updated",
              timestamp: Date.now(),
              run: updated,
              reason: "phase_transition_think",
            });
          }
        }
      }
    } catch (error: any) {
      emitTeamEvent({
        type: "team_run_event_error",
        timestamp: Date.now(),
        runId,
        error: error?.message || String(error),
      });
    } finally {
      this.runLocks.set(runId, false);
    }
  }

  async onTaskTerminal(taskId: string): Promise<void> {
    const items = this.itemRepo.listBySourceTaskId(taskId);
    if (items.length === 0) return;

    const task = await this.deps.getTaskById(taskId);
    if (!task) return;

    const nextStatus: AgentTeamItemStatus | null = (() => {
      if (task.status === "completed") return "done";
      if (task.status === "failed") return "failed";
      if (task.status === "cancelled") return "blocked";
      return null;
    })();

    if (!nextStatus) return;

    for (const item of items) {
      const resultSummary =
        typeof task.resultSummary === "string" && task.resultSummary.trim().length > 0
          ? task.resultSummary.trim()
          : typeof task.error === "string" && task.error.trim().length > 0
            ? `Error: ${task.error.trim()}`
            : null;

      const updated = this.itemRepo.update({
        id: item.id,
        status: nextStatus,
        resultSummary,
      });
      if (updated) {
        emitTeamEvent({
          type: "team_item_updated",
          timestamp: Date.now(),
          teamRunId: updated.teamRunId,
          item: updated,
        });
        await this.tickRun(updated.teamRunId, "task_terminal");
      }
    }
  }

  async cancelRun(runId: string): Promise<void> {
    const run = this.runRepo.findById(runId);
    if (!run) return;

    const updatedRun = this.runRepo.update(runId, { status: "cancelled" });
    if (updatedRun) {
      emitTeamEvent({
        type: "team_run_updated",
        timestamp: Date.now(),
        run: updatedRun,
        reason: "cancel",
      });
    }

    const items = this.itemRepo.listByRun(runId);
    for (const item of items) {
      if (item.status === "in_progress" && item.sourceTaskId) {
        await this.deps.cancelTask(item.sourceTaskId).catch(() => {});
      }

      if (!isTerminalItemStatus(item.status)) {
        const updated = this.itemRepo.update({
          id: item.id,
          status: "blocked",
          resultSummary: item.resultSummary || "Cancelled by user",
        });
        if (updated) {
          emitTeamEvent({
            type: "team_item_updated",
            timestamp: Date.now(),
            teamRunId: updated.teamRunId,
            item: updated,
          });
        }
      }
    }
  }

  /**
   * Wrap up a collaborative run gracefully - skip remaining todo items,
   * signal in-progress agents to wrap up, and fast-forward to synthesis.
   */
  async wrapUpRun(runId: string): Promise<void> {
    const run = this.runRepo.findById(runId);
    if (!run || run.status !== "running") return;

    const team = this.teamRepo.findById(run.teamId);
    if (!team) return;

    const rootTask = await this.deps.getTaskById(run.rootTaskId);
    if (!rootTask) return;

    const items = this.itemRepo.listByRun(runId);

    // 1. Block all "todo" items so no new tasks are dispatched
    for (const item of items) {
      if (item.status === "todo") {
        const updated = this.itemRepo.update({
          id: item.id,
          status: "blocked",
          resultSummary: "Skipped — user requested wrap-up",
        });
        if (updated) {
          emitTeamEvent({
            type: "team_item_updated",
            timestamp: Date.now(),
            teamRunId: updated.teamRunId,
            item: updated,
          });
        }
      }
    }

    // 2. Send wrap-up signal to in-progress child task executors
    for (const item of items) {
      if (item.status === "in_progress" && item.sourceTaskId) {
        try {
          await this.deps.wrapUpTask?.(item.sourceTaskId);
        } catch {
          // Fall through; items will eventually complete on their own
        }
      }
    }

    // 3. Fast-forward to synthesize phase if currently in dispatch/think
    const currentPhase = run.phase || "dispatch";
    if (currentPhase === "dispatch" || currentPhase === "think") {
      const refreshedItems = this.itemRepo.listByRun(runId);
      const stillInProgress = refreshedItems.filter((i) => i.status === "in_progress");

      if (stillInProgress.length === 0) {
        // All items terminal — transition immediately
        await this.transitionToSynthesizePhase(run, team, rootTask, refreshedItems);
      } else {
        // Some items still running — update phase; onTaskTerminal will finish transition
        const updated = this.runRepo.update(run.id, { phase: "synthesize" as AgentTeamRunPhase });
        if (updated) {
          emitTeamEvent({
            type: "team_run_updated",
            timestamp: Date.now(),
            run: updated,
            reason: "wrap_up_requested",
          });
        }
      }
    }
  }

  private buildItemPrompt(
    teamName: string,
    rootTask: Task,
    itemTitle: string,
    itemDescription?: string,
    collaborativeMode?: boolean,
  ): string {
    if (collaborativeMode) {
      const parts: string[] = [];
      parts.push(`You are part of the team "${teamName}".`);
      parts.push("");
      parts.push("TASK FOR INDEPENDENT ANALYSIS:");
      parts.push(`Title: ${rootTask.title}`);
      parts.push(rootTask.prompt);
      parts.push("");
      parts.push("Analyze this task from your area of expertise.");
      parts.push("Provide thorough, independent analysis and recommendations.");
      parts.push("Focus on aspects matching your specialization.");
      parts.push("Your thoughts will be shared with the team and synthesized by the leader.");
      return parts.join("\n");
    }

    const parts: string[] = [];
    parts.push(`You are working as part of the team "${teamName}".`);
    parts.push("");
    parts.push("ROOT TASK CONTEXT:");
    parts.push(`- Title: ${rootTask.title}`);
    parts.push("Request:");
    parts.push(rootTask.prompt);
    parts.push("");
    parts.push("YOUR CHECKLIST ITEM:");
    parts.push(`- Title: ${itemTitle}`);
    if (itemDescription && itemDescription.trim().length > 0) {
      parts.push(`- Details: ${itemDescription.trim()}`);
    }
    parts.push("");
    parts.push("DELIVERABLES:");
    parts.push("- Provide a concise summary of what you did and what you found.");
    parts.push("- If you created or modified files, list the file paths.");
    parts.push("- Call out risks or open questions.");
    return parts.join("\n");
  }

  private buildRunSummary(items: Array<{ status: AgentTeamItemStatus; title: string }>): string {
    const done = items.filter((i) => i.status === "done").length;
    const failed = items.filter((i) => i.status === "failed").length;
    const blocked = items.filter((i) => i.status === "blocked").length;
    const total = items.length;
    const lines = [`Items: ${done} done, ${failed} failed, ${blocked} blocked (total: ${total})`];
    return lines.join("\n");
  }

  /**
   * Transition a collaborative run to the synthesize phase.
   * Collects all member thoughts and spawns a synthesis task for the leader.
   */
  private async transitionToSynthesizePhase(
    run: AgentTeamRun,
    team: AgentTeam,
    rootTask: Task,
    items: AgentTeamItem[],
  ): Promise<void> {
    // Guard against double-entry (wrapUpRun and tickRun can race at await boundaries)
    const existingItems = this.itemRepo.listByRun(run.id);
    if (existingItems.some((i) => i.title === SYNTHESIS_ITEM_TITLE)) return;

    // Update phase to synthesize
    const updated = this.runRepo.update(run.id, { phase: "synthesize" });
    if (updated) {
      emitTeamEvent({
        type: "team_run_updated",
        timestamp: Date.now(),
        run: updated,
        reason: "phase_transition_synthesize",
      });
    }

    // Collect all thoughts from the run
    const thoughts = this.thoughtRepo.listByRun(run.id);

    // Build synthesis prompt with all member thoughts
    const synthesisPrompt = run.multiLlmMode
      ? this.buildMultiLlmSynthesisPrompt(rootTask, thoughts, items)
      : this.buildSynthesisPrompt(team.name, rootTask, thoughts, items);

    // Spawn a synthesis task assigned to the leader (or judge in multi-LLM mode)
    const depth = (typeof rootTask.depth === "number" ? rootTask.depth : 0) + 1;
    const agentConfig: AgentConfig = {
      retainMemory: false,
      bypassQueue: true,
      conversationMode: "chat", // Skip planning/steps — single-turn text synthesis
      qualityPasses: 1,
    };

    if (run.multiLlmMode && rootTask.agentConfig?.multiLlmConfig) {
      // Use judge's provider/model for synthesis
      agentConfig.providerType = rootTask.agentConfig.multiLlmConfig.judgeProviderType;
      agentConfig.modelKey = rootTask.agentConfig.multiLlmConfig.judgeModelKey;
    } else {
      const modelKey = resolveModelPreferenceToModelKey(team.defaultModelPreference);
      if (modelKey) agentConfig.modelKey = modelKey;
      const personalityId = resolvePersonalityPreference(team.defaultPersonality);
      if (personalityId) agentConfig.personalityId = personalityId;
    }

    const child = await this.deps.createChildTask({
      title: SYNTHESIS_ITEM_TITLE,
      prompt: synthesisPrompt,
      workspaceId: rootTask.workspaceId,
      parentTaskId: rootTask.id,
      agentType: "sub",
      agentConfig,
      depth,
      assignedAgentRoleId: team.leadAgentRoleId,
    });

    // Create a team item linked to the synthesis task so onTaskTerminal
    // can find it and transition the run to "complete" when synthesis finishes.
    this.itemRepo.create({
      teamRunId: run.id,
      title: SYNTHESIS_ITEM_TITLE,
      ownerAgentRoleId: team.leadAgentRoleId,
      sourceTaskId: child.id,
      status: "in_progress",
      sortOrder: 9999,
    });
  }

  /**
   * Build the prompt for the leader's synthesis phase.
   * Includes all member thoughts grouped by agent.
   */
  private buildSynthesisPrompt(
    teamName: string,
    rootTask: Task,
    thoughts: AgentThought[],
    items: AgentTeamItem[],
  ): string {
    const parts: string[] = [];
    parts.push(`You are the LEADER of team "${teamName}".`);
    parts.push("Your team members have completed their independent analysis.");
    parts.push("Your job is to synthesize their findings into a comprehensive final answer.");
    parts.push("");
    parts.push("IMPORTANT INSTRUCTIONS:");
    parts.push(
      "- ALL team member analyses are provided IN FULL below. Do NOT read external files.",
    );
    parts.push(
      "- Do NOT attempt to use any tools or read any files. Everything you need is in this prompt.",
    );
    parts.push("- Respond directly with your synthesized analysis as text.");
    parts.push("");
    parts.push("ORIGINAL REQUEST:");
    parts.push(`Title: ${rootTask.title}`);
    parts.push(rootTask.prompt);
    parts.push("");

    // Include item status (without file path references that might trigger read attempts)
    const terminalItems = items.filter(
      (i) => i.status === "done" || i.status === "failed" || i.status === "blocked",
    );
    if (terminalItems.length > 0) {
      parts.push("TEAM WORK ITEM STATUS:");
      for (const item of terminalItems) {
        const statusIcon =
          item.status === "done" ? "DONE" : item.status === "failed" ? "FAILED" : "SKIPPED";
        parts.push(`- [${statusIcon}] ${item.title}`);
      }
      parts.push("");
    }

    // Include thoughts grouped by agent — this is the primary content
    if (thoughts.length > 0) {
      parts.push("=== TEAM MEMBER ANALYSES (COMPLETE) ===");
      parts.push("");

      const byAgent = new Map<string, AgentThought[]>();
      for (const thought of thoughts) {
        const existing = byAgent.get(thought.agentRoleId) || [];
        existing.push(thought);
        byAgent.set(thought.agentRoleId, existing);
      }

      for (const [, agentThoughts] of byAgent) {
        const first = agentThoughts[0];
        parts.push(`### ${first.agentIcon} ${first.agentDisplayName}`);
        for (const t of agentThoughts) {
          parts.push(t.content);
        }
        parts.push("");
      }

      parts.push("=== END OF TEAM MEMBER ANALYSES ===");
      parts.push("");
    }

    parts.push("YOUR TASK:");
    parts.push("Using ONLY the team member analyses provided above:");
    parts.push("1. Identify agreements, conflicts, and key insights across the analyses.");
    parts.push("2. Synthesize a comprehensive final answer that addresses the original request.");
    parts.push("3. Credit specific team members for their key contributions.");
    parts.push("");
    parts.push("Respond directly with your synthesized answer. Do NOT use any tools.");

    return parts.join("\n");
  }

  /**
   * Build prompt for a multi-LLM participant. Each LLM gets the same task
   * with a simple instruction to analyze it from their perspective.
   */
  private buildMultiLlmItemPrompt(participant: MultiLlmParticipant, rootTask: Task): string {
    const parts: string[] = [];
    parts.push("Analyze the following task thoroughly and provide your best response.");
    parts.push("");
    parts.push("TASK:");
    parts.push(`Title: ${rootTask.title}`);
    parts.push(rootTask.prompt);
    parts.push("");
    parts.push("Provide a thorough, well-structured analysis and response.");
    parts.push("Your output will be compared with other AI models and synthesized by a judge.");
    return parts.join("\n");
  }

  /**
   * Build the synthesis prompt for the judge in multi-LLM mode.
   * Groups outputs by LLM provider/model.
   */
  private buildMultiLlmSynthesisPrompt(
    rootTask: Task,
    thoughts: AgentThought[],
    items: AgentTeamItem[],
  ): string {
    const parts: string[] = [];
    parts.push("You are the JUDGE in a multi-LLM comparison.");
    parts.push("Multiple AI models have independently analyzed the same task.");
    parts.push("Your job is to synthesize their outputs into the best possible final answer.");
    parts.push("");
    parts.push("IMPORTANT INSTRUCTIONS:");
    parts.push("- ALL model outputs are provided IN FULL below. Do NOT read external files.");
    parts.push("- Do NOT attempt to use any tools or read any files. Everything you need is in this prompt.");
    parts.push("- Respond directly with your synthesized analysis as text.");
    parts.push("");
    parts.push("ORIGINAL REQUEST:");
    parts.push(`Title: ${rootTask.title}`);
    parts.push(rootTask.prompt);
    parts.push("");

    if (thoughts.length > 0) {
      parts.push("=== MODEL OUTPUTS (COMPLETE) ===");
      parts.push("");

      const byModel = new Map<string, AgentThought[]>();
      for (const thought of thoughts) {
        const existing = byModel.get(thought.agentRoleId) || [];
        existing.push(thought);
        byModel.set(thought.agentRoleId, existing);
      }

      for (const [, modelThoughts] of byModel) {
        const first = modelThoughts[0];
        parts.push(`### ${first.agentIcon} ${first.agentDisplayName}`);
        for (const t of modelThoughts) {
          parts.push(t.content);
        }
        parts.push("");
      }

      parts.push("=== END OF MODEL OUTPUTS ===");
      parts.push("");
    }

    parts.push("YOUR TASK:");
    parts.push("Using ONLY the model outputs provided above:");
    parts.push("1. Compare and evaluate each model's response for accuracy, completeness, and quality.");
    parts.push("2. Identify the strongest elements from each response.");
    parts.push("3. Synthesize the best comprehensive answer combining the strongest elements.");
    parts.push("4. Note any disagreements between models and explain which view is more accurate.");

    return parts.join("\n");
  }
}
