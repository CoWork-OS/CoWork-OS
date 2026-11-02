import { randomUUID } from "crypto";
import type { AgentDaemon } from "../agent/daemon";
import { GitService } from "../git/GitService";
import { inheritableAccessCeilings } from "../../shared/access-profiles";
import {
  TASK_PROPOSAL_LIMITS,
  effectiveTaskProposalStatus,
  normalizeTaskProposalTitle,
  type TaskProposal,
  type TaskProposalEventPayload,
  type TaskProposalStartOptions,
} from "../../shared/task-proposals";
import type { AgentConfig, Task } from "../../shared/types";
import { TaskProposalStore } from "./TaskProposalStore";

/** What the service needs from the agent daemon. */
export type TaskProposalHost = Pick<
  AgentDaemon,
  "getTask" | "getWorkspaceById" | "logEvent" | "createTask" | "sendMessage"
>;

export interface ProposeTaskInput {
  title: unknown;
  summary: unknown;
  brief: unknown;
  worktree?: unknown;
}

export type ProposeTaskResult = { ok: true; proposal: TaskProposal } | { ok: false; error: string };

function text(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+$/u, "").trim() : "";
}

/**
 * Suggested tasks: proposals an agent makes with `propose_task`, and what the person does
 * with them from the card in the task's transcript (start, do here, dismiss). The brief is
 * the agent's words, never the person's: a started task gets no prompt provenance and keeps
 * every access limit of the task that proposed it.
 */
export class TaskProposalService {
  constructor(
    private readonly host: TaskProposalHost,
    private readonly now: () => number = Date.now,
  ) {}

  async list(taskId: string): Promise<TaskProposal[]> {
    const now = this.now();
    const proposals = await TaskProposalStore.listForTask(taskId);
    return proposals.map((proposal) => ({
      ...proposal,
      status: effectiveTaskProposalStatus(proposal, now),
    }));
  }

  async propose(
    taskId: string,
    input: ProposeTaskInput,
    context: { proposalsThisTurn: number },
  ): Promise<ProposeTaskResult> {
    const task = this.host.getTask(taskId);
    if (!task) return { ok: false, error: "This task no longer exists." };
    const title = text(input.title);
    const summary = text(input.summary);
    const brief = text(input.brief);
    const limits = TASK_PROPOSAL_LIMITS;
    if (!title) return { ok: false, error: "title is required." };
    if (title.length > limits.titleMaxChars) {
      return { ok: false, error: `title must be at most ${limits.titleMaxChars} characters.` };
    }
    if (!summary) return { ok: false, error: "summary is required." };
    if (summary.length > limits.summaryMaxChars) {
      return {
        ok: false,
        error: `summary must be at most ${limits.summaryMaxChars} characters.`,
      };
    }
    if (brief.length < limits.briefMinChars) {
      return {
        ok: false,
        error:
          `brief must be at least ${limits.briefMinChars} characters: the new task sees only ` +
          "the brief, so say what to do, which files or area, and what done looks like.",
      };
    }
    if (brief.length > limits.briefMaxChars) {
      return { ok: false, error: `brief must be at most ${limits.briefMaxChars} characters.` };
    }
    if (context.proposalsThisTurn >= limits.perTurn) {
      return {
        ok: false,
        error: `At most ${limits.perTurn} tasks can be proposed in one turn. Mention any others in your reply.`,
      };
    }

    const existing = await this.list(taskId);
    const pending = existing.filter((proposal) => proposal.status === "pending");
    if (pending.length >= limits.pendingPerTask) {
      return {
        ok: false,
        error: `${limits.pendingPerTask} proposed tasks are already waiting on the user. Withdraw stale ones first.`,
      };
    }
    const normalized = normalizeTaskProposalTitle(title);
    const duplicate = existing.find(
      (proposal) =>
        (proposal.status === "pending" || proposal.status === "started") &&
        normalizeTaskProposalTitle(proposal.title) === normalized,
    );
    if (duplicate) {
      return {
        ok: false,
        error: `This task was already proposed (proposal_id ${duplicate.id}, ${duplicate.status}).`,
      };
    }

    const createdAt = this.now();
    const proposal: TaskProposal = {
      id: randomUUID(),
      taskId,
      workspaceId: task.workspaceId,
      title,
      summary,
      brief,
      suggestedWorktree: input.worktree === true,
      status: "pending",
      createdAt,
      expiresAt: createdAt + limits.ttlMs,
    };
    if (!(await TaskProposalStore.insert(proposal))) {
      return { ok: false, error: "The proposal could not be saved." };
    }
    this.emit(taskId, "task_proposal_created", proposal);
    return { ok: true, proposal };
  }

  /** The agent takes back a proposal the person has not acted on. */
  async withdraw(taskId: string, proposalId: unknown, reason: unknown): Promise<ProposeTaskResult> {
    const id = text(proposalId);
    const proposal = id ? await TaskProposalStore.get(id) : null;
    if (!proposal || proposal.taskId !== taskId) {
      return { ok: false, error: "No proposal with that proposal_id in this task." };
    }
    if (effectiveTaskProposalStatus(proposal, this.now()) !== "pending") {
      return { ok: false, error: `The proposal is already ${proposal.status}.` };
    }
    const withdrawReason = text(reason).slice(0, TASK_PROPOSAL_LIMITS.withdrawReasonMaxChars);
    const decidedAt = this.now();
    if (
      !(await TaskProposalStore.settle(
        id,
        "withdrawn",
        decidedAt,
        withdrawReason ? { withdrawReason } : {},
      ))
    ) {
      return { ok: false, error: "The user already acted on this proposal." };
    }
    const updated = {
      ...proposal,
      status: "withdrawn" as const,
      decidedAt,
      ...(withdrawReason ? { withdrawReason } : {}),
    };
    this.emit(taskId, "task_proposal_updated", updated);
    return { ok: true, proposal: updated };
  }

  /** The person clicked Start. Returns the started task. */
  async start(proposalId: string, options: TaskProposalStartOptions = {}): Promise<Task> {
    const proposal = await this.requirePending(proposalId);
    const origin = this.host.getTask(proposal.taskId);
    if (!origin) throw new Error("The task that proposed this no longer exists.");
    const workspaceId = options.workspaceId || proposal.workspaceId;
    const workspace = this.host.getWorkspaceById(workspaceId);
    if (!workspace) throw new Error("That folder is no longer available.");

    let worktreeMode = options.worktreeMode;
    if (!worktreeMode) {
      worktreeMode =
        proposal.suggestedWorktree &&
        !workspace.isTemp &&
        workspace.permissions.write &&
        (await GitService.isGitRepo(workspace.path).catch(() => false))
          ? "worktree"
          : "local";
    }

    const decidedAt = this.now();
    if (!(await TaskProposalStore.settle(proposal.id, "started", decidedAt))) {
      throw new Error("This suggestion was already handled.");
    }
    let task: Task;
    try {
      task = await this.host.createTask({
        title: proposal.title,
        prompt: proposal.brief,
        workspaceId,
        source: "suggested_task",
        agentConfig: this.startAgentConfig(origin, options, worktreeMode),
        // No promptProvenance: the agent wrote this prompt, so the admin-lane tools stay
        // locked in the new task (Task.promptProvenance).
      });
    } catch (error) {
      await TaskProposalStore.reopen(proposal.id);
      throw error;
    }
    await TaskProposalStore.setStartedTask(proposal.id, task.id);
    this.emit(proposal.taskId, "task_proposal_updated", {
      ...proposal,
      status: "started",
      startedTaskId: task.id,
      decidedAt,
    });
    return task;
  }

  /** Start all: every still-pending proposal in the list, each with its defaults. */
  async startAll(
    taskId: string,
    proposalIds: string[],
  ): Promise<Array<{ proposalId: string; taskId?: string; error?: string }>> {
    const results: Array<{ proposalId: string; taskId?: string; error?: string }> = [];
    for (const proposalId of proposalIds) {
      const proposal = await TaskProposalStore.get(proposalId);
      if (!proposal || proposal.taskId !== taskId) {
        results.push({ proposalId, error: "Not a suggestion from this task." });
        continue;
      }
      try {
        const task = await this.start(proposalId);
        results.push({ proposalId, taskId: task.id });
      } catch (error) {
        results.push({ proposalId, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return results;
  }

  /** The person clicked Do it here: the brief goes to the proposing task as a message. */
  async doHere(proposalId: string): Promise<void> {
    const proposal = await this.requirePending(proposalId);
    const decidedAt = this.now();
    if (!(await TaskProposalStore.settle(proposal.id, "done_here", decidedAt))) {
      throw new Error("This suggestion was already handled.");
    }
    try {
      await this.host.sendMessage(proposal.taskId, proposal.brief, undefined, undefined, {
        messageSource: "user",
        // The agent's brief, sent by the person's click: never typed text.
        surfaceOrigin: "suggested_task",
        returnOnAccepted: true,
      });
    } catch (error) {
      await TaskProposalStore.reopen(proposal.id);
      throw error;
    }
    this.emit(proposal.taskId, "task_proposal_updated", {
      ...proposal,
      status: "done_here",
      decidedAt,
    });
  }

  async dismiss(proposalId: string): Promise<void> {
    const proposal = await this.requirePending(proposalId);
    const decidedAt = this.now();
    if (!(await TaskProposalStore.settle(proposal.id, "dismissed", decidedAt))) return;
    this.emit(proposal.taskId, "task_proposal_updated", {
      ...proposal,
      status: "dismissed",
      decidedAt,
    });
  }

  /** The proposing task, for authorizing a person's action on one of its proposals. */
  async originTaskId(proposalId: string): Promise<string> {
    const proposal = await TaskProposalStore.get(proposalId);
    if (!proposal) throw new Error("Suggestion not found.");
    return proposal.taskId;
  }

  private async requirePending(proposalId: string): Promise<TaskProposal> {
    const proposal = await TaskProposalStore.get(proposalId);
    if (!proposal) throw new Error("Suggestion not found.");
    const status = effectiveTaskProposalStatus(proposal, this.now());
    if (status === "expired") throw new Error("This suggestion has expired.");
    if (status !== "pending") throw new Error("This suggestion was already handled.");
    return proposal;
  }

  /**
   * The started task runs under every access limit of the task that proposed it. Without a
   * pick under Options it also keeps that task's access profile and pinned model.
   */
  private startAgentConfig(
    origin: Task,
    options: TaskProposalStartOptions,
    worktreeMode: "local" | "worktree",
  ): AgentConfig {
    const originConfig = origin.agentConfig;
    const config: AgentConfig = { worktreeMode };
    if (options.accessProfileId) {
      config.accessProfileId = options.accessProfileId;
    } else if (originConfig?.accessProfileId) {
      config.accessProfileId = originConfig.accessProfileId;
    } else {
      if (originConfig?.permissionMode) config.permissionMode = originConfig.permissionMode;
      if (originConfig?.shellAccess !== undefined) config.shellAccess = originConfig.shellAccess;
    }
    const ceilings = inheritableAccessCeilings(originConfig);
    if (ceilings.length > 0) config.inheritedAccessCeilingProfileIds = ceilings;
    if (originConfig?.inheritedBotWorksOn) {
      config.inheritedBotWorksOn = originConfig.inheritedBotWorksOn;
    }
    if (options.providerType && options.modelKey) {
      config.providerType = options.providerType;
      config.modelKey = options.modelKey;
      config.modelPinned = true;
    } else if (originConfig?.modelPinned && originConfig.providerType && originConfig.modelKey) {
      config.providerType = originConfig.providerType;
      config.modelKey = originConfig.modelKey;
      config.modelPinned = true;
    }
    return config;
  }

  private emit(
    taskId: string,
    type: "task_proposal_created" | "task_proposal_updated",
    proposal: TaskProposal,
  ): void {
    const payload: TaskProposalEventPayload = { proposal, status: "completed" };
    this.host.logEvent(taskId, type, payload);
  }
}
