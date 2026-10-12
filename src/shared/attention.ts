/**
 * The shared "needs you" queue: one item per decision waiting on the user, whatever produced
 * it (an approval, an agent's question, a paused session, a flow step, a due commitment or a
 * suggestion). The main process builds the snapshot (electron/attention/AttentionService);
 * every surface that shows what needs the user reads it, so their counts agree.
 *
 * Items describe and point; they never act. Every decision still goes through the surface
 * that owns it (the approval review, the session, the flow run), with its own checks.
 */
import { deriveCanonicalTaskStatus } from "./task-status";
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
  | "suggestion";

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
  | { type: "suggestion"; suggestionId: string; workspaceId: string };

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
  ref: AttentionRef;
}

export type AttentionSourceName =
  | "approvals"
  | "questions"
  | "sessions"
  | "flows"
  | "commitments"
  | "suggestions";

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
  if (status === "failed" || status === "cancelled") return null;

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

/** Names the queue needs to describe a task: agent roles by id and remote devices by node id. */
export interface AttentionTaskContext {
  agentNames?: ReadonlyMap<string, string>;
  deviceNames?: ReadonlyMap<string, string>;
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
  if (!task.targetNodeId) return { kind: "local", label: context.localLabel };
  return {
    kind: "remote",
    label: context.deviceNames?.get(task.targetNodeId) || "Another device",
    deviceId: task.targetNodeId,
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
  return {
    id: `question:${request.id}`,
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

/** A task waiting on the user that has no approval or question record of its own. */
export function attentionFromTask(task: Task, context: AttentionTaskContext): AttentionItem | null {
  const activity = classifyTaskActivity(task);
  if (activity?.category !== "needs-you") return null;
  return {
    id: `session:${task.id}`,
    kind: "session",
    state: activity.label,
    title: taskName(task),
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

const KIND_RANK: Record<AttentionKind, number> = {
  approval: 0,
  question: 0,
  flow_approval: 0,
  session: 1,
  commitment: 2,
  suggestion: 3,
};

/**
 * Drops a session item when an approval or question already stands for the same task, then
 * orders the rest: blocked work first, then waiting sessions, due commitments (soonest first),
 * urgent suggestions and finally offers. Within a group the newest comes first.
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
  const rank = (item: AttentionItem) =>
    KIND_RANK[item.kind] + (item.kind === "suggestion" && !item.urgent ? 1 : 0);
  return kept.sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    if (a.kind === "commitment" && b.kind === "commitment") {
      return (a.dueAt ?? 0) - (b.dueAt ?? 0);
    }
    return b.createdAt - a.createdAt;
  });
}
