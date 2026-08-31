import type Database from "better-sqlite3";
import {
  ApprovalType,
  Artifact,
  InputRequest,
  SessionProgressApproval,
  SessionProgressArtifact,
  SessionProgressInputRequest,
  SessionProgressState,
  SessionProgressStep,
  Task,
  TaskEvent,
} from "../../shared/types";
import { isTerminalTaskStatus } from "../../shared/task-status";
import {
  ApprovalRepository,
  ArtifactRepository,
  InputRequestRepository,
  TaskEventRepository,
  TaskRepository,
} from "../database/repositories";

const MAX_HEADLINE_LENGTH = 240;
const MAX_WAITING_REASON_LENGTH = 300;
const STRUCTURAL_EVENT_TYPES = new Set([
  "task_created",
  "task_completed",
  "plan_created",
  "plan_revised",
  "step_started",
  "step_completed",
  "step_failed",
  "step_skipped",
  "executing",
  "assistant_message",
  "approval_requested",
  "approval_granted",
  "approval_denied",
  "input_request_created",
  "input_request_resolved",
  "input_request_dismissed",
  "file_created",
  "artifact_created",
  "error",
  "task_cancelled",
  "task_paused",
  "task_resumed",
  "task_interrupted",
  "task_status",
  "task_queued",
  "task_dequeued",
]);

type ProgressRow = {
  task_id?: string;
  state_json?: string;
  updated_at?: number;
};

function boundedText(value: unknown, maxLength = MAX_HEADLINE_LENGTH): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 1).trimEnd()}…`
    : normalized;
}

function eventType(event: TaskEvent): string {
  const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
  return typeof event.legacyType === "string" && event.legacyType.trim()
    ? event.legacyType.trim()
    : typeof payload.legacyType === "string" && payload.legacyType.trim()
      ? payload.legacyType.trim()
      : String(event.type || "");
}

function payloadRecord(event: TaskEvent): Record<string, unknown> {
  return event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? (event.payload as Record<string, unknown>)
    : {};
}

function stepFromPayload(payload: Record<string, unknown>): SessionProgressStep | undefined {
  const rawStep = payload.step;
  if (!rawStep || typeof rawStep !== "object" || Array.isArray(rawStep)) return undefined;
  const step = rawStep as Record<string, unknown>;
  const id = typeof step.id === "string" ? step.id.trim() : "";
  const description = boundedText(step.description || step.title, 240);
  if (!id || !description) return undefined;
  const status =
    step.status === "completed" ||
    step.status === "in_progress" ||
    step.status === "failed" ||
    step.status === "skipped"
      ? step.status
      : "pending";
  return { id, description, status };
}

function extractEventHeadline(event: TaskEvent): string | undefined {
  const payload = payloadRecord(event);
  const type = eventType(event);
  const step = stepFromPayload(payload);
  if (type === "step_started" && step) return `Working on ${step.description}`;
  if (type === "step_completed" && step) return `Completed ${step.description}`;
  if (type === "step_failed" && step) return `Blocked on ${step.description}`;
  if (type === "approval_requested") {
    return boundedText(payload.description || payload.message, MAX_HEADLINE_LENGTH);
  }
  if (type === "input_request_created") {
    const questions = Array.isArray(payload.questions) ? payload.questions : [];
    const question = questions[0];
    if (question && typeof question === "object") {
      return boundedText((question as Record<string, unknown>).question, MAX_HEADLINE_LENGTH);
    }
  }
  return boundedText(payload.summary || payload.message || payload.content || payload.text);
}

function mapArtifact(artifact: Artifact | undefined): SessionProgressArtifact | undefined {
  if (!artifact) return undefined;
  return {
    id: artifact.id,
    path: artifact.path,
    mimeType: artifact.mimeType,
    createdAt: artifact.createdAt,
  };
}

function mapApproval(approval: {
  id: string;
  type: ApprovalType;
  description: string;
  requestedAt: number;
}): SessionProgressApproval {
  return {
    id: approval.id,
    type: approval.type,
    description:
      boundedText(approval.description, MAX_WAITING_REASON_LENGTH) || "Approval required",
    requestedAt: approval.requestedAt,
  };
}

function mapInputRequest(request: InputRequest): SessionProgressInputRequest {
  return {
    id: request.id,
    question:
      boundedText(request.questions[0]?.question, MAX_WAITING_REASON_LENGTH) ||
      "Additional input required",
    requestedAt: request.requestedAt,
  };
}

function defaultHeadline(task: Task): string {
  switch (task.status) {
    case "queued":
      return "Queued to start";
    case "planning":
      return "Planning the work";
    case "executing":
      return "Working on this task";
    case "paused":
      return "Paused — ready to resume";
    case "blocked":
      return "Blocked — action needed";
    case "interrupted":
      return "Interrupted — reconnect or resume";
    case "completed":
      return task.resultSummary || "Work completed";
    case "failed":
      return task.error || "Work failed";
    case "cancelled":
      return "Cancelled";
    default:
      return "Waiting to start";
  }
}

export class SessionProgressService {
  private readonly taskRepo: TaskRepository;
  private readonly eventRepo: TaskEventRepository;
  private readonly approvalRepo: ApprovalRepository;
  private readonly inputRequestRepo: InputRequestRepository;
  private readonly artifactRepo: ArtifactRepository;

  constructor(private readonly db: Database.Database) {
    this.taskRepo = new TaskRepository(db);
    this.eventRepo = new TaskEventRepository(db);
    this.approvalRepo = new ApprovalRepository(db);
    this.inputRequestRepo = new InputRequestRepository(db);
    this.artifactRepo = new ArtifactRepository(db);
  }

  get(taskId: string): SessionProgressState | undefined {
    const task = this.taskRepo.findById(taskId);
    if (!task) return undefined;

    const row = this.db
      .prepare("SELECT task_id, state_json, updated_at FROM session_progress WHERE task_id = ?")
      .get(taskId) as ProgressRow | undefined;
    if (row?.state_json) {
      try {
        const state = JSON.parse(row.state_json) as SessionProgressState;
        if (state?.schemaVersion === 1 && state.taskId === taskId && state.status === task.status) {
          return state;
        }
      } catch {
        // Rebuild below when a partially written or older projection is encountered.
      }
    }

    return this.rebuild(taskId);
  }

  rebuild(taskId: string): SessionProgressState | undefined {
    const task = this.taskRepo.findById(taskId);
    if (!task) return undefined;
    const events = this.eventRepo.findByTaskId(taskId);
    const state = this.derive(task, events);
    this.persist(state);
    return state;
  }

  updateFromEvent(event: TaskEvent): SessionProgressState | undefined {
    const type = eventType(event);
    if (!STRUCTURAL_EVENT_TYPES.has(type)) return undefined;
    return this.rebuild(event.taskId);
  }

  search(
    query: string,
    options?: { workspaceId?: string; limit?: number },
  ): Array<{
    task: Task;
    progress: SessionProgressState;
  }> {
    return this.taskRepo
      .search(query, {
        workspaceId: options?.workspaceId,
        limit: options?.limit,
      })
      .flatMap((task) => {
        const progress = this.get(task.id);
        return progress ? [{ task, progress }] : [];
      });
  }

  private derive(task: Task, events: TaskEvent[]): SessionProgressState {
    const planSteps = new Map<string, SessionProgressStep>();
    let headline = boundedText(task.resultSummary || task.error) || defaultHeadline(task);
    let latestEvent: TaskEvent | undefined;

    for (const event of events) {
      latestEvent = event;
      const type = eventType(event);
      const payload = payloadRecord(event);
      if (type === "plan_created" || type === "plan_revised") {
        const rawSteps =
          payload.plan && typeof payload.plan === "object"
            ? (payload.plan as Record<string, unknown>).steps
            : undefined;
        if (Array.isArray(rawSteps)) {
          planSteps.clear();
          for (const rawStep of rawSteps) {
            if (!rawStep || typeof rawStep !== "object") continue;
            const step = rawStep as Record<string, unknown>;
            const id = typeof step.id === "string" ? step.id.trim() : "";
            const description = boundedText(step.description || step.title, 240);
            if (!id || !description) continue;
            const status =
              step.status === "completed" ||
              step.status === "in_progress" ||
              step.status === "failed" ||
              step.status === "skipped"
                ? step.status
                : "pending";
            planSteps.set(id, { id, description, status });
          }
        }
      }

      const eventStep = stepFromPayload(payload);
      const eventStepId = eventStep?.id || (typeof event.stepId === "string" ? event.stepId : "");
      if (eventStepId && planSteps.has(eventStepId)) {
        const existing = planSteps.get(eventStepId)!;
        const status =
          type === "step_started"
            ? "in_progress"
            : type === "step_completed"
              ? "completed"
              : type === "step_failed"
                ? "failed"
                : type === "step_skipped"
                  ? "skipped"
                  : eventStep?.status || existing.status;
        planSteps.set(eventStepId, { ...existing, status });
      }

      const eventHeadline = extractEventHeadline(event);
      if (eventHeadline) headline = eventHeadline;
    }

    const steps = [...planSteps.values()];
    const currentStep =
      steps.find((step) => step.status === "in_progress") ||
      steps.find((step) => step.status === "pending") ||
      steps.find((step) => step.status === "failed");
    const completedSteps = steps.filter(
      (step) => step.status === "completed" || step.status === "skipped",
    ).length;
    const pendingApprovals = this.approvalRepo
      .findPendingByTaskId(task.id)
      .map(mapApproval)
      .slice(0, 5);
    const pendingInputRequests = this.inputRequestRepo
      .findPendingByTaskId(task.id)
      .map(mapInputRequest)
      .slice(0, 5);
    const waiting = this.deriveWaiting(task, pendingApprovals, pendingInputRequests);
    const children = this.taskRepo.findByParent(task.id);
    const activeAgentCount =
      children.filter((child) => !isTerminalTaskStatus(child.status)).length +
      (task.status === "planning" || task.status === "executing" ? 1 : 0);
    const latestArtifact = mapArtifact(this.artifactRepo.findByTaskId(task.id)[0]);
    const latestSnapshot = this.eventRepo.findLatestConversationSnapshot(task.id);
    const lastEventId = latestEvent?.eventId || latestEvent?.id;

    const statusPhase: SessionProgressState["phase"] =
      task.status === "interrupted" ? "stale" : task.status === "pending" ? "queued" : task.status;
    const phase = waiting
      ? waiting.kind === "reconnect"
        ? "stale"
        : waiting.kind === "paused"
          ? "paused"
          : waiting.kind === "blocked"
            ? "blocked"
            : "waiting"
      : statusPhase;

    return {
      schemaVersion: 1,
      taskId: task.id,
      status: task.status,
      phase,
      headline: boundedText(waiting?.reason || headline) || defaultHeadline(task),
      ...(currentStep ? { currentStep } : {}),
      completedSteps,
      totalSteps: steps.length,
      ...(waiting ? { waiting } : {}),
      activeAgentCount,
      ...(latestArtifact ? { latestArtifact } : {}),
      pendingApprovals,
      pendingInputRequests,
      ...(lastEventId ? { lastEventId } : {}),
      ...(typeof latestEvent?.seq === "number" ? { lastEventSeq: latestEvent.seq } : {}),
      ...(latestSnapshot?.id || lastEventId
        ? { resumeFromEventId: latestSnapshot?.id || lastEventId }
        : {}),
      connectionState: task.status === "interrupted" ? "stale" : "connected",
      updatedAt: Math.max(task.updatedAt, latestEvent?.timestamp || 0, Date.now()),
    };
  }

  private deriveWaiting(
    task: Task,
    approvals: SessionProgressApproval[],
    inputRequests: SessionProgressInputRequest[],
  ): SessionProgressState["waiting"] {
    const approval = approvals[0];
    if (approval) {
      return {
        kind: "approval",
        reason: approval.description,
        requestId: approval.id,
        requestedAt: approval.requestedAt,
      };
    }
    const input = inputRequests[0];
    if (input) {
      return {
        kind: "input",
        reason: input.question,
        requestId: input.id,
        requestedAt: input.requestedAt,
      };
    }
    if (task.status === "interrupted") {
      return {
        kind: "reconnect",
        reason: "The session needs to reconnect before it can continue.",
      };
    }
    if (task.status === "paused") {
      return { kind: "paused", reason: "The session is paused and can be resumed." };
    }
    if (task.status === "blocked") {
      return {
        kind: "blocked",
        reason:
          boundedText(task.error || task.autoContinueBlockReason, MAX_WAITING_REASON_LENGTH) ||
          "The session is blocked and needs your attention.",
      };
    }
    return undefined;
  }

  private persist(state: SessionProgressState): void {
    this.db
      .prepare(
        `INSERT INTO session_progress (task_id, state_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET
           state_json = excluded.state_json,
           updated_at = excluded.updated_at`,
      )
      .run(state.taskId, JSON.stringify(state), state.updatedAt);
  }
}
