/**
 * Suggested tasks: work the agent noticed outside the current request and proposed as a
 * separate task (`propose_task`). The task's transcript shows each proposal as a card row;
 * nothing runs until the person starts it, sends it to the same task ("Do it here"), or
 * dismisses it. See docs/suggested-tasks.md.
 */
import type { AccessProfileId } from "./access-profiles";
import type { LLMProviderType, LLMReasoningEffort } from "./types";

export const TASK_PROPOSAL_STATUSES = [
  "pending",
  "started",
  "done_here",
  "dismissed",
  "withdrawn",
  "expired",
] as const;
export type TaskProposalStatus = (typeof TASK_PROPOSAL_STATUSES)[number];

export interface TaskProposal {
  id: string;
  /** The task whose agent proposed it; its transcript shows the card. */
  taskId: string;
  workspaceId: string;
  /** Short name shown as the row's title. */
  title: string;
  /** One or two sentences shown under the title. */
  summary: string;
  /** The full, self-contained prompt the new task starts from. */
  brief: string;
  /** The agent's suggestion for the Worktree switch; the person decides. */
  suggestedWorktree: boolean;
  status: TaskProposalStatus;
  /** The task started from this proposal. */
  startedTaskId?: string;
  /** Why the agent withdrew it. */
  withdrawReason?: string;
  createdAt: number;
  expiresAt: number;
  decidedAt?: number;
}

/** What the person picked under Options before Start. Omitted fields keep the defaults. */
export interface TaskProposalStartOptions {
  workspaceId?: string;
  worktreeMode?: "local" | "worktree";
  providerType?: LLMProviderType;
  modelKey?: string;
  reasoningEffort?: LLMReasoningEffort;
  accessProfileId?: AccessProfileId;
}

export const TASK_PROPOSAL_LIMITS = {
  titleMaxChars: 60,
  summaryMaxChars: 280,
  briefMinChars: 80,
  briefMaxChars: 20_000,
  withdrawReasonMaxChars: 280,
  /** New proposals one turn may add. */
  perTurn: 3,
  /** Proposals still waiting on the person, per task. */
  pendingPerTask: 10,
  /** A proposal nobody acted on expires after a week. */
  ttlMs: 7 * 24 * 60 * 60 * 1000,
} as const;

/** Statuses after which a proposal no longer changes. */
const SETTLED_STATUSES = new Set<TaskProposalStatus>([
  "started",
  "done_here",
  "dismissed",
  "withdrawn",
  "expired",
]);

export function isSettledTaskProposalStatus(status: TaskProposalStatus): boolean {
  return SETTLED_STATUSES.has(status);
}

/** A pending proposal past its expiry reads as expired; nothing sweeps the table. */
export function effectiveTaskProposalStatus(
  proposal: Pick<TaskProposal, "status" | "expiresAt">,
  now: number,
): TaskProposalStatus {
  return proposal.status === "pending" && proposal.expiresAt <= now ? "expired" : proposal.status;
}

/** Compares titles for duplicates: case, punctuation and spacing do not count. */
export function normalizeTaskProposalTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Payload of the `task_proposal_created` and `task_proposal_updated` task events. */
export interface TaskProposalEventPayload {
  proposal: TaskProposal;
  /** Timeline status: the event records a finished action, never a running step. */
  status: "completed";
}
