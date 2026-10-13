/**
 * The shared "needs you" queue: one item per decision waiting on the user, whatever produced
 * it (an approval, an agent's question, a paused session, a flow step, a due commitment or a
 * suggestion). The main process builds the snapshot (electron/attention/AttentionService);
 * every surface that shows what needs the user reads it, so their counts agree.
 *
 * Items describe and point; they never act. Every decision still goes through the surface
 * that owns it (the approval review, the session, the flow run), with its own checks.
 */
import { isApprovalDecisionQuestionId } from "./approval-draft-presentation";
import type { CalendarProposal } from "./calendar-proposals";
import type { MailReplyDraftCard } from "./mail-reply-drafts";
import type { MemoryCurationChange } from "./memory-review-types";
import { deriveCanonicalTaskStatus } from "./task-status";
import { LOCAL_MANAGED_DEVICE_NODE_ID } from "./types";
import type {
  ApprovalRequest,
  ApprovalType,
  InputRequest,
  ProactiveSuggestion,
  SuggestionType,
  Task,
} from "./types";

export type AttentionKind =
  | "approval"
  | "question"
  | "session"
  | "flow_approval"
  | "commitment"
  | "suggestion"
  /** A commitment memory closed on its own, kept for a while so it can be undone. */
  | "memory_change"
  /** Something on the user's calendar to decide: a conflict, a focus hold, meeting prep. */
  | "calendar"
  /** A reply CoWork drafted to mail that needs one, or the offer to draft them. */
  | "mail_reply";

/** Who is asking. */
export interface AttentionActor {
  kind: "you" | "agent" | "bot" | "background" | "schedule" | "flow";
  name: string;
}

/** What started the work. */
export interface AttentionOrigin {
  kind: "you" | "schedule" | "event" | "api" | "agent" | "background" | "flow" | "memory";
  label: string;
}

/** Where the work runs. */
export interface AttentionPlace {
  kind: "local" | "remote";
  label: string;
  /** The remote node the task is routed to. */
  deviceId?: string;
}

/** The record an item stands for, so a surface can open it. */
export type AttentionRef =
  | { type: "approval"; approvalId: string; taskId: string }
  | { type: "input_request"; requestId: string; taskId: string }
  | { type: "task"; taskId: string }
  | { type: "workflow_step"; routineId: string; runId: string; stepId: string }
  | { type: "commitment"; commitmentId: string }
  | { type: "suggestion"; suggestionId: string; workspaceId: string }
  | { type: "memory_change"; changeId: string; workspaceId: string }
  | { type: "calendar_proposal"; proposalId: string }
  | { type: "mail_draft"; draftId: string }
  | { type: "mail_offer" };

export interface AttentionItem {
  /** Stable across snapshots: `${kind}:${source id}`. */
  id: string;
  kind: AttentionKind;
  /** Where it stands, e.g. "Approval needed", "Question", "Overdue". */
  state: string;
  title: string;
  /** One line on why it is here. */
  detail?: string;
  /** The exact prompt that starting it runs (suggestions only). */
  prompt?: string;
  /** What kind of suggestion it is (suggestions only). */
  suggestionType?: SuggestionType;
  /**
   * A single question that can be answered by picking one of its options (questions only).
   * Approval decisions in question form, and questions that show content to review, never
   * get choices: they are answered where their full review is shown.
   */
  choices?: { questionId: string; options: Array<{ label: string; description?: string }> };
  /** The calendar proposal itself (calendar items only), for the card to describe. */
  calendar?: CalendarProposal;
  /** A free stretch the user can hold for a suggestion that is about making time. */
  calendarHold?: { start: number; end: number };
  /** The drafted reply itself (mail_reply items only), for the card to show before sending. */
  mailDraft?: MailReplyDraftCard;
  createdAt: number;
  dueAt?: number;
  /** Wants a decision soon; non-urgent items are offers, not requests. */
  urgent: boolean;
  /** Set only when the action is known to be destructive, exporting or credential-bearing. */
  risk?: "high";
  actor: AttentionActor;
  origin: AttentionOrigin;
  place: AttentionPlace;
  workspaceId?: string;
  taskId?: string;
  /**
   * Agent roles the work belongs to, nearest first: the session's own assignee, then the
   * assignees of the sessions that delegated it, within the same workspace. Bots and Team
   * count an item for every role listed, as the bot work view lists delegated work.
   */
  ownerAgentRoleIds?: string[];
  ref: AttentionRef;
}

export type AttentionSourceName =
  | "approvals"
  | "questions"
  | "sessions"
  | "flows"
  | "commitments"
  | "suggestions"
  | "memory"
  | "calendar"
  | "mail";

export interface AttentionSnapshot {
  generatedAt: number;
  /** Most pressing first. */
  items: AttentionItem[];
  /** Sources that could not be read this time; their items are missing, not resolved. */
  failedSources: AttentionSourceName[];
}

export type TaskActivityCategory = "running" | "needs-you";

export interface TaskActivity {
  category: TaskActivityCategory | null;
  label: string;
}

/**
 * Whether a task is running, waiting on the user, or neither, with the short reason.
 * The sidebar rows, its "Needs you" filter and the attention queue all use this.
 */
export function classifyTaskActivity(task: Task): TaskActivity | null {
  const status = deriveCanonicalTaskStatus(task);
  // A finished run waits on no one. A run that stopped short because an approval was denied
  // or timed out is finalized as completed with a "needs user action" outcome, but nothing is
  // pending any more: its approval is closed, and going on means starting a follow-up. Work
  // that really waits is never completed: the daemon sets it to blocked or paused and clears
  // its completion time.
  if (status === "failed" || status === "cancelled" || status === "completed") return null;

  if (task.terminalStatus === "awaiting_approval") {
    return { category: "needs-you", label: "Approval needed" };
  }
  if (task.terminalStatus === "awaiting_verification") {
    return { category: "running", label: "Verifying" };
  }
  if (task.terminalStatus === "needs_user_action") {
    return { category: "needs-you", label: "Response needed" };
  }
  if (status === "interrupted" || task.terminalStatus === "resume_available") {
    return { category: "needs-you", label: "Resume available" };
  }
  if (status === "blocked") return { category: "needs-you", label: "Action needed" };
  if (status === "paused") {
    const waitingForInput =
      task.stopReasons?.includes("awaiting_user_input") || task.awaitingUserInputReasonCode;
    return { category: "needs-you", label: waitingForInput ? "Response needed" : "Paused" };
  }
  if (status === "planning") return { category: "running", label: "Planning" };
  if (status === "executing") return { category: "running", label: "Running" };
  if (status === "pending" || status === "queued") return { category: null, label: "Queued" };
  return null;
}

/** A remote device the app manages, as the queue needs it. */
export interface AttentionDevice {
  id: string;
  name: string;
  /** The node id tasks routed to it carry; "remote-gateway:<id>" when not set. */
  taskNodeId?: string | null;
  /** The gateway client id, which older tasks can carry instead. */
  clientId?: string;
}

/** A remote device's id and name. */
export interface AttentionDeviceRef {
  id: string;
  name: string;
}

/** Whether a task's target node is this machine: no node, or the local device's node id. */
export function isLocalTaskNode(nodeId: string | null | undefined): boolean {
  return !nodeId || nodeId === LOCAL_MANAGED_DEVICE_NODE_ID;
}

/**
 * Remote devices by every node id a task routed to them can carry. Tasks carry the device's
 * task node id (by default "remote-gateway:<device id>"), not the device id, so a lookup by
 * device id alone misses them.
 */
export function indexDevicesByNode(
  devices: readonly AttentionDevice[],
): Map<string, AttentionDeviceRef> {
  const byNode = new Map<string, AttentionDeviceRef>();
  for (const device of devices) {
    if (!device?.id || isLocalTaskNode(device.id)) continue;
    const ref = { id: device.id, name: device.name || "Another device" };
    for (const nodeId of [
      device.taskNodeId,
      `remote-gateway:${device.id}`,
      device.id,
      device.clientId,
    ]) {
      if (nodeId && !byNode.has(nodeId)) byNode.set(nodeId, ref);
    }
  }
  return byNode;
}

/** Names the queue needs to describe a task: agent roles by id and remote devices by node id. */
export interface AttentionTaskContext {
  agentNames?: ReadonlyMap<string, string>;
  /** Remote devices by the node ids their tasks carry (see indexDevicesByNode). */
  devicesByNode?: ReadonlyMap<string, AttentionDeviceRef>;
  /** What this machine is called in the UI, e.g. "This Mac". */
  localLabel: string;
}

function isBotConversation(task: Task): boolean {
  return Boolean(task.agentConfig?.botConversation);
}

export function attentionActorForTask(task: Task, context: AttentionTaskContext): AttentionActor {
  const roleName = task.assignedAgentRoleId
    ? context.agentNames?.get(task.assignedAgentRoleId)
    : undefined;
  if (roleName) return { kind: isBotConversation(task) ? "bot" : "agent", name: roleName };
  if (task.heartbeatRunId) return { kind: "background", name: "Heartbeat" };
  if (task.source === "cron") return { kind: "schedule", name: "Scheduled task" };
  if (task.source === "improvement" || task.source === "subconscious") {
    return { kind: "background", name: "Self-improvement" };
  }
  if (task.parentTaskId) return { kind: "agent", name: "Sub-agent" };
  return { kind: "you", name: "You" };
}

export function attentionOriginForTask(task: Task): AttentionOrigin {
  if (task.parentTaskId) return { kind: "agent", label: "Started by another agent" };
  if (task.heartbeatRunId) return { kind: "background", label: "Started by Heartbeat" };
  switch (task.source) {
    case "cron":
      return { kind: "schedule", label: "Started by a schedule" };
    case "hook":
      return { kind: "event", label: "Started by an event" };
    case "api":
      return { kind: "api", label: "Started from the API" };
    case "improvement":
    case "subconscious":
      return { kind: "background", label: "Started in the background" };
    case "symphony":
    case "managed_agent_panel":
      return { kind: "agent", label: "Started by an agent" };
    default:
      return { kind: "you", label: "You started it" };
  }
}

export function attentionPlaceForTask(task: Task, context: AttentionTaskContext): AttentionPlace {
  const nodeId = task.targetNodeId;
  if (!nodeId || isLocalTaskNode(nodeId)) return { kind: "local", label: context.localLabel };
  const device = context.devicesByNode?.get(nodeId);
  return {
    kind: "remote",
    label: device?.name || "Another device",
    // The managed device's id, so a surface can match it against the device list.
    deviceId: device?.id ?? nodeId,
  };
}

/** Approval types whose action deletes, exports, hands over credentials or drives the screen. */
const HIGH_RISK_APPROVALS = new Set<ApprovalType>([
  "delete_file",
  "delete_multiple",
  "memory_delete",
  "data_export",
  "protected_credential",
  "computer_use",
  "risk_gate",
]);

function clip(text: string | undefined, max: number): string {
  const clean = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

function taskName(task: Task | undefined): string {
  return clip(task?.title, 120) || "A session";
}

function taskFields(task: Task | undefined, taskId: string, context: AttentionTaskContext) {
  if (!task) {
    return {
      actor: { kind: "agent", name: "Agent" } as AttentionActor,
      origin: { kind: "you", label: "You started it" } as AttentionOrigin,
      place: { kind: "local", label: context.localLabel } as AttentionPlace,
      taskId,
    };
  }
  return {
    actor: attentionActorForTask(task, context),
    origin: attentionOriginForTask(task),
    place: attentionPlaceForTask(task, context),
    workspaceId: task.workspaceId,
    taskId,
  };
}

export function attentionFromApproval(
  approval: ApprovalRequest,
  task: Task | undefined,
  context: AttentionTaskContext,
): AttentionItem {
  return {
    id: `approval:${approval.id}`,
    kind: "approval",
    state: "Approval needed",
    title: clip(approval.description, 200) || "An action needs your OK",
    detail: `${taskName(task)} is paused until you decide.`,
    createdAt: approval.requestedAt,
    urgent: true,
    ...(HIGH_RISK_APPROVALS.has(approval.type) ? { risk: "high" as const } : {}),
    ...taskFields(task, approval.taskId, context),
    ref: { type: "approval", approvalId: approval.id, taskId: approval.taskId },
  };
}

export function attentionFromInputRequest(
  request: InputRequest,
  task: Task | undefined,
  context: AttentionTaskContext,
): AttentionItem {
  const first = request.questions[0];
  const count = request.questions.length;
  const options = (first?.options ?? []).filter(
    (option) => typeof option?.label === "string" && option.label.trim(),
  );
  const answerable =
    count === 1 &&
    first &&
    !first.preview &&
    !isApprovalDecisionQuestionId(first.id) &&
    options.length >= 2 &&
    options.length <= 4;
  return {
    id: `question:${request.id}`,
    ...(answerable
      ? {
          choices: {
            questionId: first.id,
            options: options.map((option) => ({
              // Sent back as the answer, so it must stay exactly as the agent wrote it.
              label: option.label,
              ...(option.description ? { description: clip(option.description, 160) } : {}),
            })),
          },
        }
      : {}),
    kind: "question",
    state: count > 1 ? `${count} questions` : "Question",
    title: clip(first?.question, 200) || "An agent has a question for you",
    detail: `${taskName(task)} is waiting for your answer.`,
    createdAt: request.requestedAt,
    urgent: true,
    ...taskFields(task, request.taskId, context),
    ref: { type: "input_request", requestId: request.id, taskId: request.taskId },
  };
}

/** What each pause reason the executor records asks of the user. */
const WAIT_REASONS: Record<string, string> = {
  required_decision: "It needs a decision from you before it can go on.",
  required_decision_followup: "It needs a decision from you before it can go on.",
  // The output check holds a reply that asks for a decision, so it reads the same.
  jev_output_guardrail: "It needs a decision from you before it can go on.",
  skill_parameters: "It needs a few details from you before it can go on.",
  missing_required_workspace_artifact: "It can't find a file it needs from you.",
  verification_failed: "It couldn't verify its work and needs you to check it.",
  step_stopped_by_user: "You stopped a step, so it's waiting to hear how to go on.",
  access_profile_unavailable: "Its access profile isn't available, so it can't go on.",
  queued_attachment_unavailable: "A file you attached is no longer available.",
};

/**
 * Why a waiting session stopped, in one sentence, when the task records it: the executor's
 * pause reason, or a timed-out approval. Without a record there is no reason to give, and
 * surfaces fall back to their own wording, which must not claim a question.
 */
export function sessionWaitReason(task: Task): string | undefined {
  const code = task.awaitingUserInputReasonCode?.trim();
  if (code) {
    if (WAIT_REASONS[code]) return WAIT_REASONS[code];
    if (code.startsWith("user_action_required")) {
      return "It needs you to do something before it can go on.";
    }
    return "It's waiting for your input before it can go on.";
  }
  // The approval itself is closed (denied on timeout), so the session only waits to be told
  // to go on.
  if (
    task.terminalStatus === "needs_user_action" &&
    /approval request timed out/i.test(task.error ?? "")
  ) {
    return "Its approval request timed out, so it stopped before that step.";
  }
  return undefined;
}

/** A task waiting on the user that has no approval or question record of its own. */
export function attentionFromTask(task: Task, context: AttentionTaskContext): AttentionItem | null {
  const activity = classifyTaskActivity(task);
  if (activity?.category !== "needs-you") return null;
  // Other states (resuming, blocked, paused) say what they need in their own words.
  const reason = activity.label === "Response needed" ? sessionWaitReason(task) : undefined;
  return {
    id: `session:${task.id}`,
    kind: "session",
    state: activity.label,
    title: taskName(task),
    ...(reason ? { detail: reason } : {}),
    createdAt: task.updatedAt || task.createdAt,
    urgent: true,
    ...taskFields(task, task.id, context),
    ref: { type: "task", taskId: task.id },
  };
}

export interface AttentionFlowStep {
  routineId: string;
  routineName: string;
  runId: string;
  stepId: string;
  /** Why the step waits, as the flow engine recorded it. */
  message?: string;
  waitingSince: number;
}

export function attentionFromFlowStep(
  step: AttentionFlowStep,
  context: AttentionTaskContext,
): AttentionItem {
  const name = clip(step.routineName, 120) || "An automation";
  return {
    id: `flow_approval:${step.stepId}`,
    kind: "flow_approval",
    state: "Approval needed",
    title: `${name} is waiting for your approval`,
    detail: clip(step.message, 200) || "A step is paused until you review it.",
    createdAt: step.waitingSince,
    urgent: true,
    actor: { kind: "flow", name },
    origin: { kind: "flow", label: "Automation" },
    place: { kind: "local", label: context.localLabel },
    ref: {
      type: "workflow_step",
      routineId: step.routineId,
      runId: step.runId,
      stepId: step.stepId,
    },
  };
}

export interface AttentionCommitment {
  id: string;
  text: string;
  dueAt?: number;
  createdAt?: number;
}

export function attentionFromCommitment(
  commitment: AttentionCommitment,
  now: number,
  context: AttentionTaskContext,
): AttentionItem | null {
  const text = clip(commitment.text, 160);
  if (!text || typeof commitment.dueAt !== "number") return null;
  const overdue = commitment.dueAt < now;
  return {
    id: `commitment:${commitment.id}`,
    kind: "commitment",
    state: overdue ? "Overdue" : "Due soon",
    title: text,
    createdAt: commitment.createdAt ?? commitment.dueAt,
    dueAt: commitment.dueAt,
    urgent: true,
    actor: { kind: "you", name: "You" },
    origin: { kind: "memory", label: "Something you said you'd do" },
    place: { kind: "local", label: context.localLabel },
    ref: { type: "commitment", commitmentId: commitment.id },
  };
}

/** Only suggestions with something to run become items: the others have no decision. */
export function attentionFromSuggestion(
  suggestion: ProactiveSuggestion,
  workspaceId: string,
  context: AttentionTaskContext,
): AttentionItem | null {
  const prompt = suggestion.actionPrompt?.trim();
  const title = clip(suggestion.title, 140);
  if (!prompt || !title) return null;
  const urgent = suggestion.urgency === "high" || suggestion.recommendedDelivery === "nudge";
  return {
    id: `suggestion:${suggestion.id}`,
    kind: "suggestion",
    state: urgent ? "Needs you" : "Suggested",
    title,
    detail: clip(suggestion.description, 200) || undefined,
    prompt,
    suggestionType: suggestion.type,
    createdAt: suggestion.createdAt,
    urgent,
    actor: { kind: "background", name: "Heartbeat" },
    origin: { kind: "background", label: "Suggested by Heartbeat" },
    place: { kind: "local", label: context.localLabel },
    workspaceId,
    ref: { type: "suggestion", suggestionId: suggestion.id, workspaceId },
  };
}

/**
 * A calendar card. A conflict needs a decision; a focus hold or meeting prep is an offer,
 * so it is not urgent and no "needs you" count includes it.
 */
export function attentionFromCalendarProposal(
  proposal: CalendarProposal,
  context: AttentionTaskContext,
): AttentionItem {
  const base = {
    id: `calendar:${proposal.id}`,
    kind: "calendar" as const,
    actor: { kind: "background" as const, name: "Calendar" },
    origin: { kind: "event" as const, label: "From your calendar" },
    place: { kind: "local" as const, label: context.localLabel },
    ref: { type: "calendar_proposal" as const, proposalId: proposal.id },
    calendar: proposal,
  };
  if (proposal.kind === "conflict") {
    return {
      ...base,
      state: "Conflict",
      title: clip(`${proposal.first.title} overlaps ${proposal.second.title}`, 200),
      createdAt: proposal.first.start,
      urgent: true,
    };
  }
  if (proposal.kind === "focus_hold") {
    return {
      ...base,
      state: "Suggested hold",
      title: clip(proposal.title, 160),
      createdAt: proposal.start,
      dueAt: proposal.dueAt,
      urgent: false,
    };
  }
  return {
    ...base,
    state: "Meeting soon",
    title: clip(proposal.event.title, 160),
    createdAt: proposal.event.start,
    urgent: false,
  };
}

/** A drafted reply waiting on Send: the thread needs a reply, so it counts as needing you. */
export function attentionFromMailReplyDraft(
  draft: MailReplyDraftCard,
  context: AttentionTaskContext,
): AttentionItem {
  return {
    // A failed send is a new decision, so it doesn't stay hidden as already acted on.
    id: `mail_reply:${draft.draftId}${draft.failed ? ":failed" : ""}`,
    kind: "mail_reply",
    state: draft.failed ? "Not sent" : "Reply drafted",
    title: clip(draft.subject, 200),
    detail: draft.failed
      ? `It couldn't be sent: ${clip(draft.failed, 160)}`
      : `${clip(draft.sender, 80)} is waiting on a reply.`,
    createdAt: draft.createdAt,
    urgent: true,
    actor: { kind: "background", name: "Mail" },
    origin: { kind: "event", label: "From your inbox" },
    place: { kind: "local", label: context.localLabel },
    ref: { type: "mail_draft", draftId: draft.draftId },
    mailDraft: draft,
  };
}

/** The offer to start drafting replies: an offer, so never urgent. */
export function attentionMailReplyOffer(now: number, context: AttentionTaskContext): AttentionItem {
  return {
    id: "mail_reply:offer",
    kind: "mail_reply",
    state: "Suggested",
    title: "Draft replies to mail that needs you?",
    detail:
      "CoWork can draft up to 3 replies a day to threads waiting on you, using your AI model. " +
      "Nothing is sent until you press Send.",
    createdAt: now,
    urgent: false,
    actor: { kind: "background", name: "Mail" },
    origin: { kind: "event", label: "From your inbox" },
    place: { kind: "local", label: context.localLabel },
    ref: { type: "mail_offer" },
  };
}

/** Suggestions about making time, which a calendar hold can answer. */
const TIME_BLOCK_PATTERN =
  /\b(focus (time|block|session)|block (out |off )?(some )?time|time block|hold (some )?time|deep work|set aside time)\b/i;

export function suggestsCalendarHold(item: Pick<AttentionItem, "title" | "prompt">): boolean {
  return TIME_BLOCK_PATTERN.test(`${item.title} ${item.prompt ?? ""}`);
}

/**
 * A commitment that memory upkeep closed because it looked done. It is not a decision: it is
 * handled work the user can undo while undo is still possible, so it is never urgent.
 */
export function attentionFromMemoryChange(
  change: MemoryCurationChange,
  workspaceId: string,
  context: AttentionTaskContext,
): AttentionItem | null {
  if (change.op !== "expire_commitment" || change.undoneAt !== null || !change.canUndo) {
    return null;
  }
  const title = clip(change.items[0]?.content || change.summary, 160);
  if (!title) return null;
  return {
    id: `memory_change:${change.id}`,
    kind: "memory_change",
    state: "Closed for you",
    title,
    detail: clip(change.summary, 200) || undefined,
    createdAt: change.appliedAt,
    urgent: false,
    actor: { kind: "background", name: "Memory" },
    origin: { kind: "memory", label: "Closed because it looked done" },
    place: { kind: "local", label: context.localLabel },
    workspaceId,
    ref: { type: "memory_change", changeId: change.id, workspaceId },
  };
}

/**
 * Sessions the queue says wait on the user, by task id, with the reason to show. An
 * approval or question outranks the plain waiting-session reason for the same task.
 */
export function attentionWaitingByTask(items: readonly AttentionItem[]): Map<string, string> {
  const waiting = new Map<string, string>();
  for (const item of items) {
    if (!item.taskId) continue;
    if (item.kind === "approval" || item.kind === "question") {
      waiting.set(item.taskId, item.kind === "approval" ? "Approval needed" : "Response needed");
    } else if (item.kind === "session" && !waiting.has(item.taskId)) {
      waiting.set(item.taskId, item.state);
    }
  }
  return waiting;
}

const KIND_RANK: Record<AttentionKind, number> = {
  approval: 0,
  question: 0,
  flow_approval: 0,
  session: 1,
  commitment: 2,
  suggestion: 3,
  memory_change: 4,
  calendar: 2,
  mail_reply: 2,
};

/**
 * Drops a session item when an approval or question already stands for the same task, then
 * orders the rest: blocked work first, then waiting sessions, due commitments (soonest first)
 * and calendar conflicts, urgent suggestions, and finally offers (a suggested hold or meeting
 * prep, then other suggestions). Within a group the newest comes first, except calendar
 * items, soonest first.
 */
export function rankAttention(items: readonly AttentionItem[]): AttentionItem[] {
  const decided = new Set(
    items
      .filter((item) => item.kind === "approval" || item.kind === "question")
      .map((item) => item.taskId),
  );
  const seen = new Set<string>();
  const kept = items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return !(item.kind === "session" && decided.has(item.taskId));
  });
  const offset = (item: AttentionItem) => {
    if (item.urgent) return 0;
    if (item.kind === "suggestion") return 1;
    // Calendar and mail offers come after urgent suggestions, with the other offers.
    return item.kind === "calendar" || item.kind === "mail_reply" ? 2 : 0;
  };
  const rank = (item: AttentionItem) => KIND_RANK[item.kind] + offset(item);
  return kept.sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    if (a.kind === "commitment" && b.kind === "commitment") {
      return (a.dueAt ?? 0) - (b.dueAt ?? 0);
    }
    // A calendar item's time is when it happens, so the soonest comes first.
    if (a.kind === "calendar" && b.kind === "calendar") return a.createdAt - b.createdAt;
    return b.createdAt - a.createdAt;
  });
}
