/**
 * Builds the shared "needs you" snapshot (shared/attention.ts) from every source that can
 * wait on the user. Sources are injected, so the service has no storage of its own and tests
 * drive it with plain functions. A source that fails is reported in `failedSources` and the
 * rest of the snapshot still comes back.
 */
import {
  classifyTaskActivity,
  attentionFromApproval,
  attentionFromCommitment,
  attentionFromFlowStep,
  attentionFromInputRequest,
  attentionFromSuggestion,
  attentionFromTask,
  rankAttention,
  type AttentionCommitment,
  type AttentionFlowStep,
  type AttentionItem,
  type AttentionSnapshot,
  type AttentionSourceName,
  type AttentionTaskContext,
} from "../../shared/attention";
import type { ApprovalRequest, InputRequest, ProactiveSuggestion, Task } from "../../shared/types";

export interface AttentionSources {
  listPendingApprovals: () => Promise<ApprovalRequest[]>;
  listPendingInputRequests: () => Promise<InputRequest[]>;
  /** Recent sessions, newest first. Waiting root sessions are taken from these. */
  listRecentTasks: () => Promise<Task[]>;
  findTask: (taskId: string) => Promise<Task | undefined>;
  /** Agent role display names by id. */
  listAgentNames: () => Promise<ReadonlyMap<string, string>>;
  listWaitingFlowSteps: () => Promise<AttentionFlowStep[]>;
  listDueCommitments: () => Promise<AttentionCommitment[]>;
  listSuggestions: () => Promise<Array<{ workspaceId: string; suggestion: ProactiveSuggestion }>>;
  /** What this machine is called in the UI, e.g. "This Mac". */
  localLabel: string;
  now?: () => number;
  log?: (message: string, error: unknown) => void;
}

/** Caps per source, so one noisy producer cannot crowd out the rest. */
const LIMITS = {
  approvals: 50,
  questions: 50,
  sessions: 20,
  flows: 20,
  commitments: 20,
  suggestions: 20,
  /** Task lookups for approvals and questions whose session is not among the recent ones. */
  taskLookups: 50,
  /** Parent lookups while finding the agent roles an item's work belongs to. */
  ownerLookups: 50,
  /** How far up a chain of delegated sessions to look for owners. */
  ownerDepth: 8,
  total: 100,
} as const;

export class AttentionService {
  constructor(private readonly sources: AttentionSources) {}

  async snapshot(): Promise<AttentionSnapshot> {
    const now = this.sources.now?.() ?? Date.now();
    const failedSources: AttentionSourceName[] = [];
    const read = async <T>(name: AttentionSourceName, load: () => Promise<T>, empty: T) => {
      try {
        return await load();
      } catch (error) {
        failedSources.push(name);
        this.sources.log?.(`[Attention] Could not read ${name}`, error);
        return empty;
      }
    };

    const [approvals, questions, recentTasks, agentNames, flowSteps, commitments, suggestions] =
      await Promise.all([
        read("approvals", this.sources.listPendingApprovals, [] as ApprovalRequest[]),
        read("questions", this.sources.listPendingInputRequests, [] as InputRequest[]),
        read("sessions", this.sources.listRecentTasks, [] as Task[]),
        // Names only decorate items; without them items still show, so this is not a source.
        this.sources.listAgentNames().catch(() => new Map<string, string>()),
        read("flows", this.sources.listWaitingFlowSteps, [] as AttentionFlowStep[]),
        read("commitments", this.sources.listDueCommitments, [] as AttentionCommitment[]),
        read(
          "suggestions",
          this.sources.listSuggestions,
          [] as Array<{ workspaceId: string; suggestion: ProactiveSuggestion }>,
        ),
      ]);

    const newestFirst = <T extends { requestedAt: number }>(rows: T[]) =>
      [...rows].sort((a, b) => b.requestedAt - a.requestedAt);
    const openApprovals = newestFirst(approvals.filter((row) => row.status === "pending")).slice(
      0,
      LIMITS.approvals,
    );
    const openQuestions = newestFirst(questions.filter((row) => row.status === "pending")).slice(
      0,
      LIMITS.questions,
    );
    const tasks = await this.tasksFor(recentTasks, [
      ...openApprovals.map((approval) => approval.taskId),
      ...openQuestions.map((request) => request.taskId),
    ]);
    // A pending row whose session has finished, failed or disappeared (for example after a
    // crash) no longer blocks anything, so it is not shown.
    const live = (taskId: string) => {
      const task = tasks.get(taskId);
      return Boolean(task && classifyTaskActivity(task)?.category);
    };
    const pendingApprovals = openApprovals.filter((approval) => live(approval.taskId));
    const pendingQuestions = openQuestions.filter((request) => live(request.taskId));
    const context: AttentionTaskContext = { agentNames, localLabel: this.sources.localLabel };
    const waitingSessions = await this.withWaitDetails(
      recentTasks
        // A waiting sub-agent is represented by its parent session, as in the sidebar.
        .filter(
          (task) => !task.parentTaskId && classifyTaskActivity(task)?.category === "needs-you",
        )
        .slice(0, LIMITS.sessions),
    );

    const items: AttentionItem[] = [
      ...pendingApprovals.map((approval) =>
        attentionFromApproval(approval, tasks.get(approval.taskId), context),
      ),
      ...pendingQuestions.map((request) =>
        attentionFromInputRequest(request, tasks.get(request.taskId), context),
      ),
      ...waitingSessions
        .map((task) => attentionFromTask(task, context))
        .filter((item): item is AttentionItem => item !== null),
      ...flowSteps.slice(0, LIMITS.flows).map((step) => attentionFromFlowStep(step, context)),
      ...commitments
        .map((commitment) => attentionFromCommitment(commitment, now, context))
        .filter((item): item is AttentionItem => item !== null)
        .slice(0, LIMITS.commitments),
      ...suggestions
        .map(({ workspaceId, suggestion }) =>
          attentionFromSuggestion(suggestion, workspaceId, context),
        )
        .filter((item): item is AttentionItem => item !== null)
        .slice(0, LIMITS.suggestions),
    ];

    const ranked = rankAttention(items).slice(0, LIMITS.total);
    const owners = await this.ownersFor(
      tasks,
      ranked.flatMap((item) => (item.taskId ? [item.taskId] : [])),
    );
    return {
      generatedAt: now,
      items: ranked.map((item) => {
        const ownerAgentRoleIds = item.taskId ? owners.get(item.taskId) : undefined;
        return ownerAgentRoleIds ? { ...item, ownerAgentRoleIds } : item;
      }),
      failedSources,
    };
  }

  /**
   * The agent roles each session's work belongs to, nearest first: its own assignee, then
   * those of the sessions above it (sub-agents and orchestrated steps point at the session that
   * started them). The walk stays in the session's workspace, as the bot work view does.
   */
  private async ownersFor(
    tasks: Map<string, Task>,
    taskIds: string[],
  ): Promise<Map<string, string[]>> {
    let lookups = 0;
    const load = async (taskId: string) => {
      const known = tasks.get(taskId);
      if (known || lookups >= LIMITS.ownerLookups) return known;
      lookups += 1;
      const found = await this.sources.findTask(taskId).catch(() => undefined);
      if (found) tasks.set(found.id, found);
      return found;
    };
    const owners = new Map<string, string[]>();
    for (const taskId of new Set(taskIds)) {
      const start = tasks.get(taskId);
      const roles: string[] = [];
      const seen = new Set<string>();
      let task = start;
      while (task && !seen.has(task.id) && seen.size < LIMITS.ownerDepth) {
        seen.add(task.id);
        if (task.workspaceId !== start?.workspaceId) break;
        const role = task.assignedAgentRoleId;
        if (role && !roles.includes(role)) roles.push(role);
        task = task.parentTaskId ? await load(task.parentTaskId) : undefined;
      }
      if (roles.length > 0) owners.set(taskId, roles);
    }
    return owners;
  }

  /**
   * Recent sessions are summaries without the error text, which is the only record of why a
   * session stopped when no pause reason was saved (for example a timed-out approval). Those
   * few are read in full; any that cannot be read keep their summary.
   */
  private async withWaitDetails(sessions: Task[]): Promise<Task[]> {
    return Promise.all(
      sessions.map(async (task) => {
        if (task.terminalStatus !== "needs_user_action" || task.awaitingUserInputReasonCode) {
          return task;
        }
        if (task.error) return task;
        const full = await this.sources.findTask(task.id).catch(() => undefined);
        return full ?? task;
      }),
    );
  }

  /** The recent sessions by id, plus any session an approval or question belongs to. */
  private async tasksFor(recent: Task[], taskIds: string[]): Promise<Map<string, Task>> {
    const tasks = new Map(recent.map((task) => [task.id, task]));
    const missing = [...new Set(taskIds)]
      .filter((taskId) => !tasks.has(taskId))
      .slice(0, LIMITS.taskLookups);
    const found = await Promise.all(
      missing.map((taskId) => this.sources.findTask(taskId).catch(() => undefined)),
    );
    for (const task of found) if (task) tasks.set(task.id, task);
    return tasks;
  }
}

/**
 * Coalesces bursts of changes into one call after `delayMs` of quiet. Returns the trigger and
 * a dispose function that cancels a pending call.
 */
export function createDebouncedSignal(
  emit: () => void,
  delayMs = 400,
): { trigger: () => void; dispose: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    trigger: () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        emit();
      }, delayMs);
    },
    dispose: () => {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
