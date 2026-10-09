import type Database from "better-sqlite3";
import {
  AgentTeamItemRepository,
  AgentTeamRepository,
  AgentTeamRunRepository,
  AgentTeamThoughtRepository,
} from "./agent-repository-facades";
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
  WorkerRoleKind,
} from "../../shared/types";
import { IPC_CHANNELS } from "../../shared/types";
import {
  resolveModelPreferenceToModelKey,
  resolvePersonalityPreference,
} from "../../shared/agent-preferences";
import { LLMProviderFactory } from "../agent/llm/provider-factory";
import type { OrchestrationGraphNodeInput } from "../agent/orchestration/OrchestrationGraphEngine";
import type { OrchestrationGraphSnapshot } from "../agent/orchestration/OrchestrationGraphRepository";

import { createLogger } from "../utils/logger";
import { SUPERSEDED_SYNTHESIS_ITEM_TITLE } from "../../shared/synthesis-agent-detection";

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
  getDatabase: () => Database.Database;
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
  completeRootTask?: (
    taskId: string,
    status: "completed" | "failed",
    summary: string,
    metadata?: {
      terminalStatus?: Task["terminalStatus"];
      terminalStatusReason?: string;
      /**
       * For a failed run: why it failed, without the deliverable. `summary`
       * still carries the deliverable so it is not lost.
       */
      failureReason?: string;
    },
  ) => void;
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
  findOrchestrationGraphByTeamRunId?: (
    teamRunId: string,
  ) => Promise<OrchestrationGraphSnapshot | undefined>;
  /** User follow-up messages sent to the root task after its original request. */
  listRootUserUpdates?: (rootTaskId: string) => Promise<string[]> | string[];
};

/**
 * Append user updates sent after the original request. They supersede
 * conflicting values in the request and in team analyses written before them.
 */
export function appendUserUpdatesToPrompt(prompt: string, updates: string[]): string {
  if (updates.length === 0) return prompt;
  return [
    prompt,
    "",
    "USER UPDATES (sent after the original request; they SUPERSEDE any conflicting value in the ORIGINAL REQUEST and in every team analysis):",
    ...updates.map((update, index) => `${index + 1}. ${update}`),
    "",
    "Team analyses may predate these updates. Recompute or adapt their numbers, schedules and budgets to the updated constraints, never present a superseded value as the plan, and keep every original requirement the updates do not change (for example risks and open decisions).",
  ].join("\n");
}

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
/** Title of a synthesis attempt that failed and was replaced by a retry. */
const SUPERSEDED_SYNTHESIS_TITLE = SUPERSEDED_SYNTHESIS_ITEM_TITLE;
const MAX_FAILURE_REASON_CHARS = 240;

type TeamItemOutcomeLike = {
  title: string;
  status: AgentTeamItemStatus;
  createdAt?: number;
};

function isSynthesisAttempt(item: Pick<TeamItemOutcomeLike, "title">): boolean {
  return item.title === SYNTHESIS_ITEM_TITLE || item.title === SUPERSEDED_SYNTHESIS_TITLE;
}

/**
 * Every synthesis attempt (the original and its retry) is one logical work
 * item. The latest attempt is authoritative; earlier attempts are superseded
 * and stay in the checklist as history. A superseded attempt that failed is
 * recovered when the authoritative attempt succeeded, so it no longer
 * decides the run's outcome. Items without a retry are their own logical item.
 */
export function resolveTeamItemAttempts<T extends TeamItemOutcomeLike>(
  items: T[],
): { effective: T[]; superseded: T[]; recovered: T[]; synthesis?: T } {
  const attempts = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => isSynthesisAttempt(item))
    .sort((a, b) => (a.item.createdAt ?? 0) - (b.item.createdAt ?? 0) || a.index - b.index);
  if (attempts.length === 0) return { effective: items, superseded: [], recovered: [] };
  const synthesis = attempts[attempts.length - 1].item;
  const superseded = attempts.slice(0, -1).map(({ item }) => item);
  if (superseded.length === 0) {
    return { effective: items, superseded: [], recovered: [], synthesis };
  }
  const supersededSet = new Set<T>(superseded);
  const recovered =
    synthesis.status === "done"
      ? superseded.filter((item) => item.status === "failed" || item.status === "blocked")
      : [];
  return {
    effective: items.filter((item) => !supersededSet.has(item)),
    superseded,
    recovered,
    synthesis,
  };
}

function summarizeFailureReason(text: string | null | undefined): string {
  const firstLine =
    String(text || "")
      .replace(/^error:\s*/i, "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) || "";
  if (!firstLine) return "";
  return firstLine.length > MAX_FAILURE_REASON_CHARS
    ? `${firstLine.slice(0, MAX_FAILURE_REASON_CHARS - 1).trimEnd()}…`
    : firstLine;
}

const MAX_SYNTHESIS_PROMPT_CHARS = 100_000;
const SYNTHESIS_WATCHDOG_MS = 5 * 60 * 1000;
/**
 * A synthesis task that is still executing when the watchdog fires gets this
 * many extra windows before the run is closed with the lane outputs only.
 * Synthesis reads every lane's full report, so five minutes is often not
 * enough for a strong model; the cap keeps a hung task from blocking forever.
 */
const SYNTHESIS_WATCHDOG_MAX_EXTENSIONS = 3;

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
  /** Runs whose synthesis retry is being created; the run must not finalize meanwhile. */
  private synthesisRetryPending = new Set<string>();

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
      const run = await this.runRepo.findById(runId);
      if (!run) return;
      if (run.status !== "running") return;

      const team = await this.teamRepo.findById(run.teamId);
      if (!team) return;

      const rootTask = await this.deps.getTaskById(run.rootTaskId);
      if (!rootTask) {
        const updated = await this.runRepo.update(run.id, {
          status: "failed",
          error: `Root task not found: ${run.rootTaskId}`,
        });
        if (updated) {
          emitTeamEvent({ type: "team_run_updated", timestamp: Date.now(), run: updated, reason });
        }
        return;
      }
      const childAgentCollaborativeRun = this.isChildAgentCollaborativeRun(rootTask);

      const items = await this.itemRepo.listByRun(run.id);

      // Reconcile any in-progress items whose tasks are already terminal.
      for (const item of items) {
        if (item.status !== "in_progress") continue;
        if (!item.sourceTaskId) continue;
        const task = await this.deps.getTaskById(item.sourceTaskId);
        if (!task) continue;
        if (!isTerminalTaskStatus(task.status)) continue;
        await this.onTaskTerminal(item.sourceTaskId);
      }

      const refreshedItems = await this.itemRepo.listByRun(run.id);
      const inProgress = refreshedItems.filter((i) => i.status === "in_progress");

      // If everything is terminal, complete or transition the run.
      const nonTerminal = refreshedItems.filter((i) => !isTerminalItemStatus(i.status));
      if (nonTerminal.length === 0) {
        // A failed synthesis is being replaced; its retry decides the outcome.
        if (this.synthesisRetryPending.has(run.id)) return;
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

        const attempts = resolveTeamItemAttempts(refreshedItems);
        // A synthesis whose failure was recorded before its retry was started
        // (the graph notification and the task-terminal hook race) still gets
        // its one retry instead of ending the run.
        if (
          run.collaborativeMode &&
          !childAgentCollaborativeRun &&
          attempts.synthesis?.title === SYNTHESIS_ITEM_TITLE &&
          attempts.synthesis.status === "failed" &&
          !this.synthesisRetried.has(run.id)
        ) {
          const failedTask = attempts.synthesis.sourceTaskId
            ? await this.deps.getTaskById(attempts.synthesis.sourceTaskId)
            : undefined;
          if (await this.retryFailedSynthesis(attempts.synthesis, failedTask?.error)) return;
        }

        // Outcome is decided by logical work items: a failed attempt whose
        // retry succeeded is recovered, while its row stays visible as history.
        const effectiveItems = attempts.effective;
        // When wrap-up was user-initiated, only synthesis failure should mark the run
        // as failed — pre-synthesis items may have been cut short intentionally.
        const wasUserWrapUp = this.wrapUpRequestedRunIds.has(run.id);
        const hasFailures = wasUserWrapUp
          ? attempts.synthesis?.status === "failed"
          : effectiveItems.some((i) => i.status === "failed");
        const status = hasFailures ? "failed" : "completed";
        const needsReviewTitles = await this.listItemsNeedingReview(effectiveItems);
        const summary = this.buildRunSummary(refreshedItems, needsReviewTitles);
        const failureReason = hasFailures
          ? await this.describeUnrecoveredFailures(
              wasUserWrapUp && attempts.synthesis ? [attempts.synthesis] : effectiveItems,
            )
          : undefined;
        const completedPhase = run.collaborativeMode ? "complete" : undefined;
        const updated = await this.runRepo.update(run.id, {
          status,
          summary,
          ...(failureReason ? { error: failureReason } : {}),
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
          // The root task's result is what the user reads in the parent chat:
          // lead with the synthesized deliverable rather than only item counts,
          // and do not report "ok" when a lane finished with warnings.
          const synthesisText =
            attempts.synthesis?.status === "done"
              ? attempts.synthesis.resultSummary?.trim()
              : undefined;
          const deliverableSummary = synthesisText
            ? `${synthesisText}\n\n---\n${summary}`
            : summary;
          if (status === "failed") {
            // Lead with what failed so the task error explains the failure
            // instead of opening with a plan that reads as a success.
            const reason = failureReason || "A team work item failed.";
            this.deps.completeRootTask(
              run.rootTaskId,
              "failed",
              `${reason}\n\n---\n${deliverableSummary}`,
              { failureReason: reason },
            );
          } else if (needsReviewTitles.length > 0) {
            this.deps.completeRootTask(run.rootTaskId, "completed", deliverableSummary, {
              terminalStatus: "partial_success",
              terminalStatusReason: `Needs review: ${needsReviewTitles.join(", ")}`,
            });
          } else {
            this.deps.completeRootTask(run.rootTaskId, "completed", deliverableSummary);
          }
        }
        return;
      }

      if (childAgentCollaborativeRun) return;

      const candidates = refreshedItems
        .filter((i) => i.status === "todo" && !i.sourceTaskId)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt);
      if (candidates.length === 0) return;

      const toSpawn = candidates;
      const useProfileRouting = this.shouldUseProfileRouting(rootTask);
      const depth = (typeof rootTask.depth === "number" ? rootTask.depth : 0) + 1;
      const graphNodes: OrchestrationGraphNodeInput[] = [];
      for (const item of toSpawn) {
        const assignedRoleId = item.ownerAgentRoleId || team.leadAgentRoleId;
        const agentConfig: AgentConfig = {
          retainMemory: false,
          bypassQueue: false,
          llmProfile: deriveTeamItemProfile(item.title, item.description),
          // Team lanes are user-planned work, not delegated read-only helpers.
          // Keep the researcher denylist (no writes/spawning) but not the
          // delegated researcher's plan/no-network/no-shell boundary.
          teamWorkItemLane: true,
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
          const updatedItem = await this.itemRepo.update({
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
            const updated = await this.runRepo.update(run.id, { phase: "execute" });
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

      const existingGraph = await this.deps.findOrchestrationGraphByTeamRunId?.(run.id);
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
        const updatedItem = await this.itemRepo.update({
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
          const updated = await this.runRepo.update(run.id, { phase: "execute" });
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
    const items = await this.itemRepo.listBySourceTaskId(taskId);
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
        !this.synthesisRetried.has(item.teamRunId) &&
        (await this.retryFailedSynthesis(item, task.error))
      ) {
        continue;
      }

      const updated = await this.itemRepo.update({
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
    const run = await this.runRepo.findById(runId);
    if (!run) return;

    const updatedRun = await this.runRepo.update(runId, { status: "cancelled" });
    if (updatedRun) {
      emitTeamEvent({
        type: "team_run_updated",
        timestamp: Date.now(),
        run: updatedRun,
        reason: "cancel",
      });
    }

    const items = await this.itemRepo.listByRun(runId);
    for (const item of items) {
      if (item.status === "in_progress" && item.sourceTaskId) {
        await this.deps.cancelTask(item.sourceTaskId).catch(() => {});
      }

      if (!isTerminalItemStatus(item.status)) {
        const updated = await this.itemRepo.update({
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
    const run = await this.runRepo.findById(runId);
    if (!run || run.status !== "running") return;

    // Track that this run was user-initiated wrap-up so final status reflects intent.
    this.wrapUpRequestedRunIds.add(runId);

    const team = await this.teamRepo.findById(run.teamId);
    if (!team) return;

    const rootTask = await this.deps.getTaskById(run.rootTaskId);
    if (!rootTask) return;
    const childAgentCollaborativeRun = this.isChildAgentCollaborativeRun(rootTask);

    const items = await this.itemRepo.listByRun(runId);

    // 1. Block all "todo" items so no new tasks are dispatched
    for (const item of items) {
      if (item.status === "todo") {
        const updated = await this.itemRepo.update({
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
      const refreshedItems = await this.itemRepo.listByRun(runId);
      const stillInProgress = refreshedItems.filter((i) => i.status === "in_progress");

      if (childAgentCollaborativeRun) {
        if (stillInProgress.length === 0) {
          const status = resolveTeamItemAttempts(refreshedItems).effective.some(
            (i) => i.status === "failed",
          )
            ? "failed"
            : "completed";
          const updated = await this.runRepo.update(run.id, {
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
        const updated = await this.runRepo.update(run.id, {
          phase: "synthesize" as AgentTeamRunPhase,
        });
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

  private buildRunSummary(
    allItems: TeamItemOutcomeLike[],
    needsReviewTitles: string[] = [],
  ): string {
    // Counts are per logical work item: a synthesis retry replaces its failed
    // attempt rather than adding a second item.
    const { effective: items, recovered } = resolveTeamItemAttempts(allItems);
    // "done" means the lane's task lifecycle finished; a lane that completed
    // with partial_success is counted separately so the summary does not read
    // as every requested piece of work succeeding.
    const needsReview = new Set(needsReviewTitles);
    const done = items.filter((i) => i.status === "done" && !needsReview.has(i.title)).length;
    const reviewCount = items.filter((i) => i.status === "done" && needsReview.has(i.title)).length;
    const failed = items.filter((i) => i.status === "failed").length;
    const blocked = items.filter((i) => i.status === "blocked").length;
    const total = items.length;
    const reviewPart = reviewCount > 0 ? `, ${reviewCount} need review` : "";
    const lines = [
      `Items: ${done} done${reviewPart}, ${failed} failed, ${blocked} blocked (total: ${total})`,
    ];
    if (recovered.length > 0) {
      lines.push(
        recovered.length === 1
          ? "1 failed synthesis attempt was recovered by a successful retry."
          : `${recovered.length} failed synthesis attempts were recovered by a successful retry.`,
      );
    }
    return lines.join("\n");
  }

  /** One sentence naming each unrecovered failed item and its recorded error. */
  private async describeUnrecoveredFailures(
    items: Array<
      TeamItemOutcomeLike & { sourceTaskId?: string; resultSummary?: string | undefined }
    >,
  ): Promise<string> {
    const failed = items.filter((item) => item.status === "failed");
    if (failed.length === 0) return "";
    const parts: string[] = [];
    for (const item of failed) {
      const task = item.sourceTaskId ? await this.deps.getTaskById(item.sourceTaskId) : undefined;
      // Prefer the task's own error. A failed item's result summary can be the
      // full deliverable the failing guard rejected, which is not a reason.
      const fromSummary = /^error:/i.test(String(item.resultSummary || "").trim())
        ? item.resultSummary
        : "";
      const reason = summarizeFailureReason(task?.error || fromSummary);
      parts.push(`${item.title} (${reason || "no error details were recorded"})`);
    }
    const label = failed.length === 1 ? "work item" : "work items";
    return `Team run failed: ${failed.length} ${label} failed without recovery: ${parts.join("; ")}.`;
  }

  /**
   * Replace a failed synthesis attempt with one compacted retry. The failed
   * attempt keeps its row (renamed) as history and is superseded by the retry.
   */
  private async retryFailedSynthesis(
    item: AgentTeamItem,
    failureError?: string | null,
  ): Promise<boolean> {
    if (this.synthesisRetried.has(item.teamRunId)) return false;
    this.synthesisRetried.add(item.teamRunId);
    const run = await this.runRepo.findById(item.teamRunId);
    if (!run || run.status !== "running") return false;
    const rootTask = await this.deps.getTaskById(run.rootTaskId);
    const team = run.teamId ? await this.teamRepo.findById(run.teamId) : undefined;
    if (!rootTask || !team) return false;

    this.synthesisRetryPending.add(run.id);
    try {
      const reason = summarizeFailureReason(failureError);
      // Rename the old synthesis item so the guard in transitionToSynthesizePhase
      // does not block re-entry (it checks for items titled SYNTHESIS_ITEM_TITLE).
      const updated = await this.itemRepo.update({
        id: item.id,
        title: SUPERSEDED_SYNTHESIS_TITLE,
        status: "failed",
        resultSummary: `Synthesis attempt failed and was retried with a compacted prompt.${
          reason ? ` Reason: ${reason}` : ""
        }`,
      });
      if (updated) {
        emitTeamEvent({
          type: "team_item_updated",
          timestamp: Date.now(),
          teamRunId: updated.teamRunId,
          item: updated,
        });
      }
      const allItems = await this.itemRepo.listByRun(run.id);
      await this.transitionToSynthesizePhaseCompact(run, team, rootTask, allItems);
      return true;
    } catch (error) {
      log.error("Failed to start the synthesis retry:", error);
      return false;
    } finally {
      this.synthesisRetryPending.delete(run.id);
    }
  }

  /** Titles of done items whose task finished with a non-ok terminal status. */
  private async listItemsNeedingReview(
    items: Array<{ status: AgentTeamItemStatus; title: string; sourceTaskId?: string }>,
  ): Promise<string[]> {
    const titles: string[] = [];
    for (const item of items) {
      if (item.status !== "done" || !item.sourceTaskId) continue;
      const task = await this.deps.getTaskById(item.sourceTaskId);
      const terminalStatus = task?.terminalStatus;
      if (terminalStatus && terminalStatus !== "ok") titles.push(item.title);
    }
    return titles;
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
    extensionsUsed = 0,
  ): void {
    const existing = this.synthesisWatchdogTimers.get(runId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.synthesisWatchdogTimers.delete(runId);
      void this.runSynthesisWatchdog(runId, synthesisItemId, rootTaskId, extensionsUsed);
    }, SYNTHESIS_WATCHDOG_MS);

    this.synthesisWatchdogTimers.set(runId, timer);
  }

  /** The synthesis watchdog's timeout work; it reads and writes through the async facades. */
  private async runSynthesisWatchdog(
    runId: string,
    synthesisItemId: string,
    rootTaskId: string,
    extensionsUsed = 0,
  ): Promise<void> {
    try {
      const run = await this.runRepo.findById(runId);
      if (!run || run.status !== "running") return;

      const items = await this.itemRepo.listByRun(runId);
      const synthesisItem = items.find((item) => item.id === synthesisItemId);
      if (synthesisItem && isTerminalItemStatus(synthesisItem.status)) return;

      // The synthesis task exists and is still working: give it more time
      // (bounded) instead of discarding a response that is about to land.
      if (synthesisItem?.sourceTaskId && extensionsUsed < SYNTHESIS_WATCHDOG_MAX_EXTENSIONS) {
        const synthesisTask = await this.deps.getTaskById(synthesisItem.sourceTaskId);
        if (synthesisTask && !isTerminalTaskStatus(synthesisTask.status)) {
          log.warn(
            `Synthesis for team run ${runId} still executing after ${SYNTHESIS_WATCHDOG_MS}ms; extending (${extensionsUsed + 1}/${SYNTHESIS_WATCHDOG_MAX_EXTENSIONS})`,
          );
          this.scheduleSynthesisWatchdog(runId, rootTaskId, synthesisItemId, extensionsUsed + 1);
          return;
        }
      }

      await this.itemRepo.update({
        id: synthesisItemId,
        status: "blocked",
        resultSummary: synthesisItem?.sourceTaskId
          ? "Synthesis timed out before producing a final response."
          : "Synthesis task was never started; completing with the team outputs only.",
      });
      const refreshedItems = await this.itemRepo.listByRun(runId);
      const summary = `${this.buildRunSummary(refreshedItems)} Synthesis timed out; completing with available team outputs.`;
      const updated = await this.runRepo.update(runId, {
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
    const existingItems = await this.itemRepo.listByRun(run.id);
    if (existingItems.some((i) => i.title === SYNTHESIS_ITEM_TITLE)) return;

    // Update phase to synthesize
    const updated = await this.runRepo.update(run.id, { phase: "synthesize" });
    if (updated) {
      emitTeamEvent({
        type: "team_run_updated",
        timestamp: Date.now(),
        run: updated,
        reason: "phase_transition_synthesize",
      });
    }

    // Collect all thoughts from the run
    const thoughts = await this.thoughtRepo.listByRun(run.id);
    const useProfileRouting = this.shouldUseProfileRouting(rootTask);

    // Build synthesis prompt with all member thoughts
    const synthesisPrompt = appendUserUpdatesToPrompt(
      this.buildSynthesisPrompt(team.name, rootTask, thoughts, items),
      await this.listRootUserUpdates(rootTask.id),
    );

    // Spawn a synthesis task assigned to the leader
    const depth = (typeof rootTask.depth === "number" ? rootTask.depth : 0) + 1;
    const agentConfig: AgentConfig = {
      retainMemory: false,
      bypassQueue: true,
      conversationMode: "chat", // Skip planning/steps — single-turn text synthesis
      qualityPasses: 1,
      llmProfile: rootTask.agentConfig?.llmProfileHint || "strong",
      maxTurns: 3,
    };

    if (!useProfileRouting) {
      const modelKey = resolveModelPreferenceToModelKey(team.defaultModelPreference);
      if (modelKey) agentConfig.modelKey = modelKey;
    }
    const personalityId = resolvePersonalityPreference(team.defaultPersonality);
    if (personalityId) agentConfig.personalityId = personalityId;

    const synthesisItem = await this.itemRepo.create({
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
      await this.itemRepo.update({
        id: synthesisItem.id,
        sourceTaskId: synthesisTask.id,
        status: "in_progress",
      });
      return;
    }

    const spawnSynthesisDirectly = async (): Promise<void> => {
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
      await this.itemRepo.update({
        id: synthesisItem.id,
        sourceTaskId: synthesisTask.id,
        status: "in_progress",
      });
    };

    const existingGraph = await this.deps.findOrchestrationGraphByTeamRunId?.(run.id);
    if (!existingGraph?.run?.id || !this.deps.appendOrchestrationGraphNodes) {
      // No graph run backs this team run; spawn the synthesis task directly
      // rather than leaving the item waiting on a node that will never exist.
      await spawnSynthesisDirectly();
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
    if (!synthesisNode && appended?.run?.status === "cancelled") {
      await this.itemRepo.update({
        id: synthesisItem.id,
        status: "blocked",
        resultSummary: "Synthesis skipped: the orchestration run was cancelled.",
      });
      return;
    }
    if (!synthesisNode) {
      // The engine refused the append (for example a run it had already
      // closed). The lanes are done and their thoughts are collected, so the
      // synthesis still has everything it needs: run it as a plain child task.
      log.warn(
        `Synthesis node for team run ${run.id} was not appended to graph run ${existingGraph.run.id}; spawning synthesis task directly`,
      );
      await spawnSynthesisDirectly();
      return;
    }
    await this.itemRepo.update({
      id: synthesisItem.id,
      sourceTaskId: synthesisNode.taskId,
      status:
        synthesisNode.status === "completed"
          ? "done"
          : synthesisNode.status === "failed"
            ? "failed"
            : "in_progress",
    });
  }

  /**
   * Retry synthesis with a compacted prompt when the first synthesis task fails.
   */
  private async listRootUserUpdates(rootTaskId: string): Promise<string[]> {
    if (!this.deps.listRootUserUpdates) return [];
    try {
      const updates = await this.deps.listRootUserUpdates(rootTaskId);
      return (Array.isArray(updates) ? updates : [])
        .map((update) => String(update || "").trim())
        .filter((update) => update.length > 0);
    } catch {
      return [];
    }
  }

  private async transitionToSynthesizePhaseCompact(
    run: AgentTeamRun,
    team: AgentTeam,
    rootTask: Task,
    _items: AgentTeamItem[],
  ): Promise<void> {
    const thoughts = await this.thoughtRepo.listByRun(run.id);
    const compactBudget = Math.floor(MAX_SYNTHESIS_PROMPT_CHARS / 2);
    const userUpdates = await this.listRootUserUpdates(rootTask.id);
    const synthesisPrompt = appendUserUpdatesToPrompt(
      [
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
      ].join("\n"),
      userUpdates,
    );

    const depth = (typeof rootTask.depth === "number" ? rootTask.depth : 0) + 1;
    const synthesisItem = await this.itemRepo.create({
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
    await this.itemRepo.update({
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
}
