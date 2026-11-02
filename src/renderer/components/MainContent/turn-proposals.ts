import type { TaskEvent } from "../../../shared/types";
import {
  TASK_PROPOSAL_STATUSES,
  isSettledTaskProposalStatus,
  type TaskProposal,
} from "../../../shared/task-proposals";
import { getEffectiveTaskEventType } from "../../utils/task-event-compat";

/** The tasks one finished turn proposed, shown as one card at the end of the turn. */
export interface TurnProposalGroup {
  /** Stable for the turn: the id of the event that opened it. */
  key: string;
  proposalIds: string[];
  /** Event-stream index range [startIndex, endIndex] the turn covers. */
  startIndex: number;
  endIndex: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The proposal a `task_proposal_created` / `task_proposal_updated` event carries. */
export function getTaskProposalFromEvent(event: TaskEvent): TaskProposal | null {
  const effectiveType = getEffectiveTaskEventType(event);
  if (effectiveType !== "task_proposal_created" && effectiveType !== "task_proposal_updated") {
    return null;
  }
  const proposal = isRecord(event.payload) ? event.payload.proposal : undefined;
  if (
    !isRecord(proposal) ||
    typeof proposal.id !== "string" ||
    typeof proposal.taskId !== "string" ||
    typeof proposal.title !== "string" ||
    typeof proposal.summary !== "string" ||
    typeof proposal.brief !== "string" ||
    typeof proposal.createdAt !== "number" ||
    typeof proposal.expiresAt !== "number" ||
    !(TASK_PROPOSAL_STATUSES as readonly unknown[]).includes(proposal.status)
  ) {
    return null;
  }
  return proposal as unknown as TaskProposal;
}

/**
 * One group per finished turn that proposed tasks (a user message opens a turn; the task
 * prompt opens the first). The turn still running has none, so the card never jumps while
 * the agent keeps working.
 */
export function collectTurnProposalGroups(
  events: TaskEvent[],
  options: { isTaskWorking: boolean },
): TurnProposalGroup[] {
  if (!Array.isArray(events) || events.length === 0) return [];
  const turnStarts: number[] = [0];
  events.forEach((event, index) => {
    if (index > 0 && getEffectiveTaskEventType(event) === "user_message") turnStarts.push(index);
  });
  const groups: TurnProposalGroup[] = [];
  turnStarts.forEach((startIndex, turnIndex) => {
    const isLastTurn = turnIndex === turnStarts.length - 1;
    if (isLastTurn && options.isTaskWorking) return;
    const endIndex = isLastTurn ? events.length - 1 : turnStarts[turnIndex + 1] - 1;
    const proposalIds: string[] = [];
    for (let index = startIndex; index <= endIndex; index += 1) {
      const event = events[index];
      if (getEffectiveTaskEventType(event) !== "task_proposal_created") continue;
      const proposal = getTaskProposalFromEvent(event);
      if (proposal && !proposalIds.includes(proposal.id)) proposalIds.push(proposal.id);
    }
    if (proposalIds.length === 0) return;
    groups.push({
      key: events[startIndex]?.id || `index:${startIndex}`,
      proposalIds,
      startIndex,
      endIndex,
    });
  });
  return groups;
}

/**
 * Merges newer knowledge of proposals into what is known: a decision (started, dismissed,
 * ...) is never undone by an older pending copy, and of two decisions the later one wins.
 */
export function mergeTaskProposals(
  current: ReadonlyMap<string, TaskProposal>,
  incoming: Iterable<TaskProposal>,
): Map<string, TaskProposal> {
  const next = new Map(current);
  for (const proposal of incoming) {
    const known = next.get(proposal.id);
    if (!known) {
      next.set(proposal.id, proposal);
      continue;
    }
    const knownSettled = isSettledTaskProposalStatus(known.status);
    const incomingSettled = isSettledTaskProposalStatus(proposal.status);
    if (knownSettled && !incomingSettled) continue;
    if (incomingSettled && knownSettled && (proposal.decidedAt ?? 0) < (known.decidedAt ?? 0)) {
      continue;
    }
    next.set(proposal.id, { ...known, ...proposal });
  }
  return next;
}
