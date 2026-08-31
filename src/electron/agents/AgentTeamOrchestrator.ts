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
  LlmProfile,
  UpdateAgentTeamItemRequest,
  MultiLlmParticipant,
  WorkerRoleKind,
} from "../../shared/types";
import {
  IPC_CHANNELS,
  MULTI_LLM_PROVIDER_DISPLAY as _MULTI_LLM_PROVIDER_DISPLAY,
} from "../../shared/types";
import {
  resolveModelPreferenceToModelKey,
  resolvePersonalityPreference,
} from "../../shared/agent-preferences";
import { LLMProviderFactory } from "../agent/llm/provider-factory";
import type { OrchestrationGraphNodeInput } from "../agent/orchestration/OrchestrationGraphEngine";
import type { OrchestrationGraphSnapshot } from "../agent/orchestration/OrchestrationGraphRepository";
import { AgentTeamRepository } from "./AgentTeamRepository";
import { AgentTeamRunRepository } from "./AgentTeamRunRepository";
import { AgentTeamItemRepository } from "./AgentTeamItemRepository";
import { AgentTeamThoughtRepository } from "./AgentTeamThoughtRepository";
import { createLogger } from "../utils/logger";

const log = createLogger("AgentTeamOrchestrator");

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
    workerRole?: WorkerRoleKind;
    teamRunId?: string;
    teamItemId?: string;
  }) => Promise<Task>;
  cancelTask: (taskId: string) => Promise<void>;
  wrapUpTask?: (taskId: string) => Promise<void>;
  completeRootTask?: (taskId: string, status: "completed" | "failed", summary: string) => void;
  createOrchestrationGraphRun?: (params: {
    rootTaskId: string;
    workspaceId: string;
    kind: "team";
    maxParallel: number;
    metadata?: Record<string, unknown>;
    nodes: OrchestrationGraphNodeInput[];
    edges?: Array<{ fromNodeKey: string; toNodeKey: string }>;
  }) => Promise<OrchestrationGraphSnapshot | undefined>;
  appendOrchestrationGraphNodes?: (params: {
    runId: string;
    nodes: OrchestrationGraphNodeInput[];
    edges?: Array<{
      fromNodeId?: string;
      fromNodeKey?: string;
      toNodeId?: string;
      toNodeKey?: string;
    }>;
  }) => Promise<OrchestrationGraphSnapshot | undefined>;
  findOrchestrationGraphByTeamRunId?: (teamRunId: string) => OrchestrationGraphSnapshot | undefined;
};

function getAllElectronWindows(): Any[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    // oxlint-disable-next-line typescript-eslint(no-require-imports)
    const electron = require("electron") as Any;
    if (!electron || typeof electron !== "object") return [];
    const BrowserWindow = electron?.BrowserWindow;
    if (BrowserWindow?.getAllWindows) return BrowserWindow.getAllWindows();
  } catch {
    // ignore
  }
  return [];
}

function emitTeamEvent(event: Any): void {
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

const MAX_SYNTHESIS_PROMPT_CHARS = 100_000;
const SYNTHESIS_WATCHDOG_MS = 5 * 60 * 1000;

function compactTextForSynthesis(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 500) return `${text.slice(0, maxChars)}\n[... truncated for synthesis ...]`;

  const edgeBudget = Math.max(200, Math.floor((maxChars - 120) / 2));
  const head = text.slice(0, edgeBudget).trimEnd();
  const tail = text.slice(-edgeBudget).trimStart();
  const omitted = text.length - head.length - tail.length;
  return `${head}\n\n[... truncated ${Math.max(0, omitted)} chars for synthesis prompt budget ...]\n\n${tail}`;
}

function groupAndCompactThoughts(thoughts: AgentThought[], maxChars: number): string {
  const byAgent = new Map<string, string[]>();
  for (const t of thoughts) {
    const agent = t.agentRoleId || t.agentDisplayName || "unknown";
    if (!byAgent.has(agent)) byAgent.set(agent, []);
    byAgent.get(agent)!.push(t.content);
  }

  let totalChars = 0;
  for (const contents of byAgent.values()) {
    for (const c of contents) totalChars += c.length;
  }

  if (totalChars <= maxChars) {
    const sections: string[] = [];
    for (const [agent, contents] of byAgent) {
      sections.push(`## Agent: ${agent}\n${contents.join("\n\n")}`);
    }
    return sections.join("\n\n---\n\n");
  }

  const agentCount = byAgent.size;
  const perAgentBudget = Math.floor(maxChars / Math.max(agentCount, 1));
  const sections: string[] = [];
  for (const [agent, contents] of byAgent) {
    let agentText = contents.join("\n\n");
    if (agentText.length > perAgentBudget) {
      agentText = compactTextForSynthesis(agentText, perAgentBudget);
    }
    sections.push(`## Agent: ${agent}\n${agentText}`);
  }
  return sections.join("\n\n---\n\n");
}

function isTerminalItemStatus(status: AgentTeamItemStatus): boolean {
  return status === "done" || status === "failed" || status === "blocked";
}

function isTerminalTaskStatus(status: Task["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function deriveTeamItemProfile(itemTitle: string, itemDescription?: string): LlmProfile {
  const normalized = `${itemTitle || ""}\n${itemDescription || ""}`.toLowerCase();
  if (
    /\b(plan|planning|critic|critique|validator|validate|verification|verify|judge|audit|synthes(?:is|ize))\b/.test(
      normalized,
    )
  ) {
    return "strong";
  }
  return "cheap";
}

export class AgentTeamOrchestrator {
  private teamRepo: AgentTeamRepositoryLike;
  private runRepo: AgentTeamRunRepositoryLike;
  private itemRepo: AgentTeamItemRepositoryLike;
  private thoughtRepo: AgentTeamThoughtRepository;
  private runLocks = new Map<string, boolean>();
  private synthesisWatchdogTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Tracks runs where the user explicitly requested a wrap-up. */
  private wrapUpRequestedRunIds = new Set<string>();
  /** Tracks team run IDs where synthesis has already been retried after provider failover. */
  private synthesisRetried = new Set<string>();

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

  dispose(): void {
    for (const timer of this.synthesisWatchdogTimers.values()) {
      clearTimeout(timer);
    }
    this.synthesisWatchdogTimers.clear();
  }

  /**
   * Get the thought repository (used by daemon for thought capture).
   */
  getThoughtRepo(): AgentTeamThoughtRepository {
    return this.thoughtRepo;
  }

  private shouldUseProfileRouting(rootTask: Task): boolean {
    try {
      const settings = LLMProviderFactory.loadSettings();
      const providerType = rootTask.agentConfig?.providerType || settings.providerType;
      return LLMProviderFactory.getProviderRoutingSettings(settings, providerType)
        .profileRoutingEnabled;
    } catch {
      return false;
    }
  }

  private isChildAgentCollaborativeRun(rootTask: Task): boolean {
    return rootTask.agentConfig?.childAgentCollaborativeRun === true;
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
      const childAgentCollaborativeRun = this.isChildAgentCollaborativeRun(rootTask);

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
        const hasSynthesisItem = refreshedItems.some((i) => i.title === SYNTHESIS_ITEM_TITLE);
        if (
          run.collaborativeMode &&
          !childAgentCollaborativeRun &&
          currentPhase !== "complete" &&
          !hasSynthesisItem
        ) {
          // Guard: verify all sub-agent tasks are actually terminal before synthesis.
          // Synthesis must only run after every sub-agent has completed (success or failure).
          const preSynthesisItems = refreshedItems.filter((i) => i.title !== SYNTHESIS_ITEM_TITLE);
          let allSubAgentsTerminal = true;
          for (const item of preSynthesisItems) {
            if (!item.sourceTaskId) continue;
            const task = await this.deps.getTaskById(item.sourceTaskId);
            if (!task || !isTerminalTaskStatus(task.status)) {
              allSubAgentsTerminal = false;
              break;
            }
          }
          if (allSubAgentsTerminal) {
            await this.transitionToSynthesizePhase(run, team, rootTask, refreshedItems);
          }
          return;
        }

        // When wrap-up was user-initiated, only synthesis failure should mark the run
        // as failed — pre-synthesis items may have been cut short intentionally.
        const wasUserWrapUp = this.wrapUpRequestedRunIds.has(run.id);
        const hasFailures = wasUserWrapUp
          ? refreshedItems.find((i) => i.title === SYNTHESIS_ITEM_TITLE)?.status === "failed"
          : refreshedItems.some((i) => i.status === "failed");
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
        this.wrapUpRequestedRunIds.delete(run.id);
        // When a collaborative run finishes, mark the root task as completed/failed
        if (run.collaborativeMode && !childAgentCollaborativeRun && this.deps.completeRootTask) {
          this.deps.completeRootTask(
            run.rootTaskId,
            status === "failed" ? "failed" : "completed",
            summary,
          );
        }
        return;
      }

      if (childAgentCollaborativeRun) return;

      const candidates = refreshedItems
        .filter((i) => i.status === "todo" && !i.sourceTaskId)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt);
      if (candidates.length === 0) return;

      // Resolve multi-LLM participants from root task config
      const multiLlmParticipants: MultiLlmParticipant[] | undefined =
        run.multiLlmMode && rootTask.agentConfig?.multiLlmConfig?.participants
          ? rootTask.agentConfig.multiLlmConfig.participants
          : undefined;

      const toSpawn = candidates;
      const useProfileRouting = this.shouldUseProfileRouting(rootTask);
      const depth = (typeof rootTask.depth === "number" ? rootTask.depth : 0) + 1;
      const graphNodes: OrchestrationGraphNodeInput[] = [];
      for (const item of toSpawn) {
        if (run.multiLlmMode && multiLlmParticipants) {
          const participantIndex = refreshedItems
            .filter((candidate) => candidate.title !== SYNTHESIS_ITEM_TITLE)
            .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt)
            .findIndex((candidate) => candidate.id === item.id);
          const participant =
            participantIndex >= 0 ? multiLlmParticipants[participantIndex] : undefined;
          if (!participant) continue;
          graphNodes.push({
            key: item.id,
            title: `${participant.displayName} Analysis`,
            prompt: this.buildMultiLlmItemPrompt(participant, rootTask),
            kind: "team_work_item" as const,
            dispatchTarget: "native_child_task" as const,
            parentTaskId: rootTask.id,
            teamRunId: run.id,
            teamItemId: item.id,
            agentConfig: {
              retainMemory: false,
              bypassQueue: false,
              providerType: participant.providerType,
              modelKey: participant.modelKey,
              llmProfile: "cheap",
            },
            metadata: { depth },
          });
          continue;
        }

        const assignedRoleId = item.ownerAgentRoleId || team.leadAgentRoleId;
        const agentConfig: AgentConfig = {
          retainMemory: false,
          bypassQueue: false,
          llmProfile: deriveTeamItemProfile(item.title, item.description),
        };
        if (!useProfileRouting) {
          const modelKey = resolveModelPreferenceToModelKey(team.defaultModelPreference);
          if (modelKey) agentConfig.modelKey = modelKey;
        }
        const personalityId = resolvePersonalityPreference(team.defaultPersonality);
        if (personalityId) agentConfig.personalityId = personalityId;
        graphNodes.push({
          key: item.id,
          title: item.title,
          prompt: this.buildItemPrompt(
            team.name,
            rootTask,
            item.title,
            item.description,
            run.collaborativeMode,
          ),
          kind: "team_work_item" as const,
          dispatchTarget: "local_role" as const,
          parentTaskId: rootTask.id,
          assignedAgentRoleId: assignedRoleId,
          workerRole: "researcher",
          teamRunId: run.id,
          teamItemId: item.id,
          agentConfig,
          metadata: { depth },
        });
      }

      if (!this.deps.createOrchestrationGraphRun && !this.deps.appendOrchestrationGraphNodes) {
        for (const item of toSpawn) {
          const node = graphNodes.find((candidate) => candidate.teamItemId === item.id);
          if (!node) continue;
          const childTask = await this.deps.createChildTask({
            title: node.title,
            prompt: node.prompt,
            workspaceId: rootTask.workspaceId,
            parentTaskId: rootTask.id,
            agentType: "sub",
            agentConfig: node.agentConfig,
            depth,
            assignedAgentRoleId: node.assignedAgentRoleId,
            workerRole: node.workerRole,
            teamRunId: run.id,
            teamItemId: item.id,
          });
          const updatedItem = this.itemRepo.update({
            id: item.id,
            sourceTaskId: childTask.id,
            status: "in_progress",
          });
          if (updatedItem) {
            emitTeamEvent({
              type: "team_item_spawned",
              timestamp: Date.now(),
              runId: run.id,
              item: updatedItem,
              spawnedTaskId: childTask.id,
            });
          }
        }

        if (run.collaborativeMode && toSpawn.length > 0) {
          const currentPhase = run.phase || "dispatch";
          if (currentPhase === "dispatch") {
            const updated = this.runRepo.update(run.id, { phase: "execute" });
            if (updated) {
              emitTeamEvent({
                type: "team_run_updated",
                timestamp: Date.now(),
                run: updated,
                reason: "phase_transition_execute",
              });
            }
          }
        }
        return;
      }

      const existingGraph = this.deps.findOrchestrationGraphByTeamRunId?.(run.id);
      const graphSnapshot = existingGraph
        ? await this.deps.appendOrchestrationGraphNodes?.({
            runId: existingGraph.run.id,
            nodes: graphNodes,
          })
        : await this.deps.createOrchestrationGraphRun?.({
            rootTaskId: rootTask.id,
            workspaceId: rootTask.workspaceId,
            kind: "team",
            maxParallel: Math.max(1, Number(team.maxParallelAgents || 1)),
            metadata: {
              teamRunId: run.id,
              collaborativeMode: run.collaborativeMode,
              multiLlmMode: run.multiLlmMode,
            },
            nodes: graphNodes,
          });

      const effectiveNodes = graphSnapshot?.nodes || [];
      for (const item of toSpawn) {
        const node = effectiveNodes.find((candidate: Any) => candidate.teamItemId === item.id);
        const nextStatus: AgentTeamItemStatus =
          node?.status === "completed"
            ? "done"
            : node?.status === "failed"
              ? "failed"
              : node?.status === "cancelled" || node?.status === "blocked"
                ? "blocked"
                : "in_progress";
        const updatedItem = this.itemRepo.update({
          id: item.id,
          sourceTaskId: node?.taskId,
          status: nextStatus,
        });
        if (updatedItem && node?.taskId) {
          emitTeamEvent({
            type: "team_item_spawned",
            timestamp: Date.now(),
            runId: run.id,
            item: updatedItem,
            spawnedTaskId: node.taskId,
          });
        }
      }

      // In collaborative mode, transition from dispatch to execute phase
      // once we've spawned at least one item
      if (run.collaborativeMode && toSpawn.length > 0) {
        const currentPhase = run.phase || "dispatch";
        if (currentPhase === "dispatch") {
          const updated = this.runRepo.update(run.id, { phase: "execute" });
          if (updated) {
            emitTeamEvent({
              type: "team_run_updated",
              timestamp: Date.now(),
              run: updated,
              reason: "phase_transition_execute",
            });
          }
        }
      }
    } catch (error: Any) {
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

      // Compact synthesis retry on provider failover: if the synthesis item
      // failed and we haven't retried yet, re-run synthesis with a compacted prompt.
      if (
        item.title === SYNTHESIS_ITEM_TITLE &&
        nextStatus === "failed" &&
        !this.synthesisRetried.has(item.teamRunId)
      ) {
        this.synthesisRetried.add(item.teamRunId);
        const run = this.runRepo.findById(item.teamRunId);
        const rootTask = run ? await this.deps.getTaskById(run.rootTaskId) : null;
        const team = run?.teamId ? this.teamRepo.findById(run.teamId) : null;
        if (run && rootTask && team) {
          // Rename the old synthesis item so the guard in transitionToSynthesizePhase
          // does not block re-entry (it checks for items titled SYNTHESIS_ITEM_TITLE).
          this.itemRepo.update({
            id: item.id,
            title: `${SYNTHESIS_ITEM_TITLE} (failed)`,
            status: "blocked" as AgentTeamItemStatus,
            resultSummary: "Synthesis failed — retrying with compacted prompt",
          });
          const allItems = this.itemRepo.listByRun(run.id);
          await this.transitionToSynthesizePhaseCompact(run, team, rootTask, allItems);
          continue;
        }
      }

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

    // Track that this run was user-initiated wrap-up so final status reflects intent.
    this.wrapUpRequestedRunIds.add(runId);

    const team = this.teamRepo.findById(run.teamId);
    if (!team) return;

    const rootTask = await this.deps.getTaskById(run.rootTaskId);
    if (!rootTask) return;
    const childAgentCollaborativeRun = this.isChildAgentCollaborativeRun(rootTask);

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
    if (currentPhase === "dispatch" || currentPhase === "think" || currentPhase === "execute") {
      const refreshedItems = this.itemRepo.listByRun(runId);
      const stillInProgress = refreshedItems.filter((i) => i.status === "in_progress");

      if (childAgentCollaborativeRun) {
        if (stillInProgress.length === 0) {
          const status = refreshedItems.some((i) => i.status === "failed") ? "failed" : "completed";
          const updated = this.runRepo.update(run.id, {
            status,
            phase: "complete",
            summary: this.buildRunSummary(refreshedItems),
          });
          if (updated) {
            emitTeamEvent({
              type: "team_run_updated",
              timestamp: Date.now(),
              run: updated,
              reason: "child_agent_wrap_up",
            });
          }
        }
        return;
      }

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
    if (collaborativeMode && rootTask.agentConfig?.multitaskMode) {
      const parts: string[] = [];
      parts.push(`You are part of the multitask team "${teamName}".`);
      parts.push("");
      parts.push("ROOT TASK CONTEXT:");
      parts.push(`Title: ${rootTask.title}`);
      parts.push(rootTask.prompt);
      parts.push("");
      parts.push("YOUR MULTITASK LANE:");
      parts.push(`Title: ${itemTitle}`);
      if (itemDescription && itemDescription.trim().length > 0) {
        parts.push(itemDescription.trim());
      }
      parts.push("");
      parts.push(
        "Work only on this lane. Do not duplicate other lanes unless required for context.",
      );
      parts.push(
        "Report what you did or found, list changed files if any, and call out risks or blockers.",
      );
      parts.push("Your result will be synthesized with the other multitask lanes.");
      return parts.join("\n");
    }

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

  private completeRootTaskBestEffort(
    taskId: string,
    status: "completed" | "failed",
    summary: string,
  ): void {
    if (!this.deps.completeRootTask) return;
    try {
      this.deps.completeRootTask(taskId, status, summary);
    } catch (error) {
      log.error("Failed to complete collaborative root task:", error);
    }
  }

  private scheduleSynthesisWatchdog(
    runId: string,
    rootTaskId: string,
    synthesisItemId: string,
  ): void {
    const existing = this.synthesisWatchdogTimers.get(runId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.synthesisWatchdogTimers.delete(runId);
      try {
        const run = this.runRepo.findById(runId);
        if (!run || run.status !== "running") return;

        const items = this.itemRepo.listByRun(runId);
        const synthesisItem = items.find((item) => item.id === synthesisItemId);
        if (synthesisItem && isTerminalItemStatus(synthesisItem.status)) return;

        this.itemRepo.update({
          id: synthesisItemId,
          status: "blocked",
          resultSummary: "Synthesis timed out before producing a final response.",
        });
        const refreshedItems = this.itemRepo.listByRun(runId);
        const summary = `${this.buildRunSummary(refreshedItems)} Synthesis timed out; completing with available team outputs.`;
        const updated = this.runRepo.update(runId, {
          status: "completed",
          phase: "complete",
          summary,
        });
        if (updated) {
          emitTeamEvent({
            type: "team_run_updated",
            timestamp: Date.now(),
            run: updated,
            reason: "synthesis_watchdog_timeout",
          });
        }
        this.completeRootTaskBestEffort(rootTaskId, "completed", summary);
      } catch (error) {
        log.error("Synthesis watchdog failed:", error);
      }
    }, SYNTHESIS_WATCHDOG_MS);

    this.synthesisWatchdogTimers.set(runId, timer);
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
    const useProfileRouting = this.shouldUseProfileRouting(rootTask);

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
      llmProfile: rootTask.agentConfig?.llmProfileHint || "strong",
      maxTurns: 3,
    };

    if (run.multiLlmMode && rootTask.agentConfig?.multiLlmConfig) {
      // Use judge's provider/model for synthesis
      agentConfig.providerType = rootTask.agentConfig.multiLlmConfig.judgeProviderType;
      agentConfig.modelKey = rootTask.agentConfig.multiLlmConfig.judgeModelKey;
      agentConfig.llmProfile = "strong";
    } else {
      if (!useProfileRouting) {
        const modelKey = resolveModelPreferenceToModelKey(team.defaultModelPreference);
        if (modelKey) agentConfig.modelKey = modelKey;
      }
      const personalityId = resolvePersonalityPreference(team.defaultPersonality);
      if (personalityId) agentConfig.personalityId = personalityId;
    }

    const synthesisItem = this.itemRepo.create({
      teamRunId: run.id,
      title: SYNTHESIS_ITEM_TITLE,
      ownerAgentRoleId: team.leadAgentRoleId,
      status: "todo",
      sortOrder: 9999,
    });
    this.scheduleSynthesisWatchdog(run.id, rootTask.id, synthesisItem.id);

    if (!this.deps.appendOrchestrationGraphNodes || !this.deps.findOrchestrationGraphByTeamRunId) {
      const synthesisTask = await this.deps.createChildTask({
        title: SYNTHESIS_ITEM_TITLE,
        prompt: synthesisPrompt,
        workspaceId: rootTask.workspaceId,
        parentTaskId: rootTask.id,
        agentType: "sub",
        agentConfig,
        depth,
        assignedAgentRoleId: team.leadAgentRoleId,
        workerRole: "synthesizer",
      });
      this.itemRepo.update({
        id: synthesisItem.id,
        sourceTaskId: synthesisTask.id,
        status: "in_progress",
      });
      return;
    }

    const existingGraph = this.deps.findOrchestrationGraphByTeamRunId?.(run.id);
    if (!existingGraph?.run?.id || !this.deps.appendOrchestrationGraphNodes) {
      return;
    }
    const predecessorNodes = (existingGraph?.nodes || []).filter(
      (node: Any) =>
        node.teamRunId === run.id && node.teamItemId && node.teamItemId !== synthesisItem.id,
    );
    const appended = await this.deps.appendOrchestrationGraphNodes({
      runId: existingGraph.run.id,
      nodes: [
        {
          key: synthesisItem.id,
          title: SYNTHESIS_ITEM_TITLE,
          prompt: synthesisPrompt,
          kind: "synthesis",
          dispatchTarget: "local_role",
          parentTaskId: rootTask.id,
          assignedAgentRoleId: team.leadAgentRoleId,
          workerRole: "synthesizer",
          teamRunId: run.id,
          teamItemId: synthesisItem.id,
          agentConfig,
          metadata: { depth },
        },
      ],
      edges: predecessorNodes.map((node: Any) => ({
        fromNodeId: node.id,
        toNodeKey: synthesisItem.id,
      })),
    });
    const synthesisNode = appended?.nodes.find((node: Any) => node.teamItemId === synthesisItem.id);
    this.itemRepo.update({
      id: synthesisItem.id,
      sourceTaskId: synthesisNode?.taskId,
      status:
        synthesisNode?.status === "completed"
          ? "done"
          : synthesisNode?.status === "failed"
            ? "failed"
            : "in_progress",
    });
  }

  /**
   * Retry synthesis with a compacted prompt when the first synthesis task fails.
   */
  private async transitionToSynthesizePhaseCompact(
    run: AgentTeamRun,
    team: AgentTeam,
    rootTask: Task,
    _items: AgentTeamItem[],
  ): Promise<void> {
    const thoughts = this.thoughtRepo.listByRun(run.id);
    const compactBudget = Math.floor(MAX_SYNTHESIS_PROMPT_CHARS / 2);
    const synthesisPrompt = [
      `You are the LEADER of team "${team.name}".`,
      "Your team members completed their analysis. Synthesize a final answer.",
      "Respond directly in a SINGLE response. Do NOT use any tools or create sub-tasks.",
      "",
      `ORIGINAL REQUEST: ${rootTask.title}`,
      rootTask.prompt,
      "",
      "=== TEAM MEMBER ANALYSES (COMPACTED) ===",
      thoughts.length > 0
        ? groupAndCompactThoughts(thoughts, compactBudget)
        : "No team member analyses were captured.",
      "=== END OF TEAM MEMBER ANALYSES ===",
    ].join("\n");

    const depth = (typeof rootTask.depth === "number" ? rootTask.depth : 0) + 1;
    const synthesisItem = this.itemRepo.create({
      teamRunId: run.id,
      title: SYNTHESIS_ITEM_TITLE,
      ownerAgentRoleId: team.leadAgentRoleId,
      status: "todo",
      sortOrder: 9999,
    });
    this.scheduleSynthesisWatchdog(run.id, rootTask.id, synthesisItem.id);

    const synthesisTask = await this.deps.createChildTask({
      title: SYNTHESIS_ITEM_TITLE,
      prompt: synthesisPrompt,
      workspaceId: rootTask.workspaceId,
      parentTaskId: rootTask.id,
      agentType: "sub",
      agentConfig: {
        retainMemory: false,
        bypassQueue: true,
        conversationMode: "chat",
        qualityPasses: 1,
        maxTurns: 2,
        llmProfile: "strong",
      },
      depth,
      assignedAgentRoleId: team.leadAgentRoleId,
      workerRole: "synthesizer",
    });
    this.itemRepo.update({
      id: synthesisItem.id,
      sourceTaskId: synthesisTask.id,
      status: "in_progress",
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
      parts.push(groupAndCompactThoughts(thoughts, MAX_SYNTHESIS_PROMPT_CHARS));
      parts.push("");
      parts.push("=== END OF TEAM MEMBER ANALYSES ===");
      parts.push("");
    }

    parts.push("YOUR TASK:");
    parts.push(
      "Produce your synthesis in a SINGLE response. Do NOT create sub-tasks or use planning tools.",
    );
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
    if (participant.seatLabel) {
      parts.push(`Seat: ${participant.seatLabel}`);
    }
    if (participant.roleInstruction) {
      parts.push(`Role guidance: ${participant.roleInstruction}`);
    }
    if (participant.isIdeaProposer) {
      parts.push("Special instruction: you are the rotating idea proposer for this run.");
      parts.push("You must introduce at least one concrete new growth idea worth debating.");
    } else {
      parts.push(
        "Special instruction: challenge weak ideas, refine strong ones, and push toward action.",
      );
    }
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
    _items: AgentTeamItem[],
  ): string {
    if (rootTask.agentConfig?.councilMode) {
      return this.buildCouncilSynthesisPrompt(rootTask, thoughts);
    }
    const parts: string[] = [];
    parts.push("You are the JUDGE in a multi-LLM comparison.");
    parts.push("Multiple AI models have independently analyzed the same task.");
    parts.push("Your job is to synthesize their outputs into the best possible final answer.");
    parts.push("");
    parts.push("IMPORTANT INSTRUCTIONS:");
    parts.push("- ALL model outputs are provided IN FULL below. Do NOT read external files.");
    parts.push(
      "- Do NOT attempt to use any tools or read any files. Everything you need is in this prompt.",
    );
    parts.push("- Respond directly with your synthesized analysis as text.");
    parts.push("");
    parts.push("ORIGINAL REQUEST:");
    parts.push(`Title: ${rootTask.title}`);
    parts.push(rootTask.prompt);
    parts.push("");

    if (thoughts.length > 0) {
      parts.push("=== MODEL OUTPUTS (COMPLETE) ===");
      parts.push("");
      parts.push(groupAndCompactThoughts(thoughts, MAX_SYNTHESIS_PROMPT_CHARS));
      parts.push("");
      parts.push("=== END OF MODEL OUTPUTS ===");
      parts.push("");
    }

    parts.push("YOUR TASK:");
    parts.push(
      "Produce your synthesis in a SINGLE response. Do NOT create sub-tasks or use planning tools.",
    );
    parts.push("Using ONLY the model outputs provided above:");
    parts.push(
      "1. Compare and evaluate each model's response for accuracy, completeness, and quality.",
    );
    parts.push("2. Identify the strongest elements from each response.");
    parts.push("3. Synthesize the best comprehensive answer combining the strongest elements.");
    parts.push("4. Note any disagreements between models and explain which view is more accurate.");

    return parts.join("\n");
  }

  private buildCouncilSynthesisPrompt(rootTask: Task, thoughts: AgentThought[]): string {
    const parts: string[] = [];
    parts.push("You are the judge and synthesizer for an R&D Council run.");
    parts.push(
      "Multiple models debated a business/product growth question using a curated source bundle.",
    );
    parts.push("Your job is to produce a single decision memo.");
    parts.push("");
    parts.push("IMPORTANT INSTRUCTIONS:");
    parts.push("- Use ONLY the model outputs provided below plus the original council prompt.");
    parts.push("- Do NOT use tools or read external files.");
    parts.push("- Keep the memo concrete, specific, and action-oriented.");
    parts.push("- Preserve meaningful disagreements instead of flattening them away.");
    parts.push("");
    parts.push("ORIGINAL COUNCIL PROMPT:");
    parts.push(`Title: ${rootTask.title}`);
    parts.push(rootTask.prompt);
    parts.push("");

    if (thoughts.length > 0) {
      parts.push("=== MODEL OUTPUTS (COMPLETE) ===");
      parts.push("");
      parts.push(groupAndCompactThoughts(thoughts, MAX_SYNTHESIS_PROMPT_CHARS));
      parts.push("");
      parts.push("=== END OF MODEL OUTPUTS ===");
      parts.push("");
    }

    parts.push(
      "Produce your synthesis in a SINGLE response. Do NOT create sub-tasks or use planning tools.",
    );
    parts.push("");
    parts.push("Return the memo using EXACTLY these sections and headings:");
    parts.push("## Executive Summary");
    parts.push("## What We Reviewed");
    parts.push("## Best New Idea");
    parts.push("## Where The Models Agreed");
    parts.push("## Where They Disagreed");
    parts.push("## Recommended Next Actions");
    parts.push("## Experiments To Run");
    parts.push("## Risks / Missing Inputs");

    return parts.join("\n");
  }
}
