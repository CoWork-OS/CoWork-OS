import type Database from "better-sqlite3";
import type {
  Artifact,
  ArtifactRevision,
  ConstraintLedgerEntry,
  EvidenceManifestEntry,
  OutcomeContract,
  RequirementEvidenceManifest,
  Task,
  TaskEvent,
  WaitState,
  WaitStateKind,
  WaitStateStatus,
  WorkSession,
  WorkSessionChildAggregate,
  WorkSessionChildLink,
  WorkSessionContractAggregate,
  WorkSessionItem,
} from "../../shared/types";
import {
  ArtifactStore,
  ApprovalStore,
  InputRequestStore,
  TaskStore,
  WorkspaceStore,
} from "../database/repositories";
import {
  WorkSessionContractRepository,
  type ArtifactRevisionInput,
  type ChildSessionLinkInput,
  type EvidenceManifestEntryInput,
  type OutcomeContractRequirementInput,
  type WaitStateInput,
} from "../database/WorkSessionContractRepository";
import { WorkSessionProtocolService } from "./WorkSessionProtocolService";
import { WorkspaceArtifactEvidenceInspector } from "./WorkspaceArtifactEvidenceInspector";

const TERMINAL_TASK_STATUSES = new Set<Task["status"]>(["completed", "failed", "cancelled"]);
const DURABLE_BLOCKING_EVENT_KINDS: Partial<Record<string, WaitStateKind>> = {
  task_paused: "paused",
  task_interrupted: "paused",
  verification_pending_user_action: "external",
  auto_continuation_blocked: "external",
  follow_up_turn_recovery_blocked: "external",
  safety_stop_triggered: "external",
  mode_gate_blocked: "external",
  reconnect_requested: "reconnect",
  child_wait: "child",
};

function eventType(event: TaskEvent): string {
  if (typeof event.legacyType === "string" && event.legacyType.trim()) {
    return event.legacyType.trim();
  }
  const payload = event.payload;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const legacy = (payload as Record<string, unknown>).legacyType;
    if (typeof legacy === "string" && legacy.trim()) return legacy.trim();
  }
  return String(event.type || "legacy_event");
}

function payloadRecord(event: TaskEvent): Record<string, unknown> {
  if (event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)) {
    return event.payload as Record<string, unknown>;
  }
  return event.payload === undefined ? {} : { value: event.payload };
}

function text(value: unknown, max = 16_000): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function waitRequestId(payload: Record<string, unknown>): string | undefined {
  const direct = [
    payload.requestId,
    payload.waitId,
    payload.reconnectId,
    payload.childSessionId,
    payload.childTaskId,
    payload.childId,
    payload.operationId,
  ];
  for (const candidate of direct) {
    const value = text(candidate, 256);
    if (value) return value;
  }
  for (const key of ["request", "reconnect", "child"]) {
    const nested = payload[key];
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) continue;
    const value = text((nested as Record<string, unknown>).id, 256);
    if (value) return value;
  }
  return undefined;
}

function waitPayload(type: string, payload: Record<string, unknown>): Record<string, unknown> {
  return { ...payload, sourceEventType: type };
}

function waitReason(type: string, payload: Record<string, unknown>): string {
  return (
    text(payload.reason || payload.message || payload.description) ||
    {
      task_paused: "Task is paused",
      task_interrupted: "Task was interrupted and can be resumed",
      verification_pending_user_action: "Verification requires user action",
      auto_continuation_blocked: "Automatic continuation is blocked",
      follow_up_turn_recovery_blocked: "Follow-up recovery is blocked",
      safety_stop_triggered: "Execution stopped by a safety guard",
      mode_gate_blocked: "Execution is blocked by the active mode policy",
      reconnect_requested: "Reconnection is required",
      child_wait: "Waiting for a child session",
    }[type] ||
    "Task is waiting"
  );
}

function taskOutcome(
  task: Pick<Task, "status" | "terminalStatus" | "verificationVerdict" | "failureClass">,
): "complete" | "partial" | "failed" | undefined {
  if (task.verificationVerdict === "FAIL" && task.failureClass === "required_verification") {
    return "failed";
  }
  if (task.status === "completed") {
    return task.terminalStatus === "partial_success" || task.verificationVerdict === "PARTIAL"
      ? "partial"
      : "complete";
  }
  if (task.status === "failed" || task.status === "cancelled") return "failed";
  return undefined;
}

function childStatusForTask(
  task: Pick<Task, "status" | "terminalStatus" | "verificationVerdict" | "failureClass">,
): "pending" | "running" | "completed" | "partial" | "failed" | "cancelled" {
  if (task.status === "cancelled") return "cancelled";
  if (taskOutcome(task) === "partial") return "partial";
  if (taskOutcome(task) === "complete") return "completed";
  if (task.status === "failed") return "failed";
  if (
    task.status === "executing" ||
    task.status === "planning" ||
    task.status === "queued" ||
    task.status === "interrupted" ||
    task.status === "paused" ||
    task.status === "blocked"
  ) {
    return "running";
  }
  return "pending";
}

function normalizeWaitStatus(
  status: WaitStateStatus,
): Extract<WaitStateStatus, "resolved" | "expired" | "cancelled"> {
  return status === "resolved" || status === "expired" || status === "cancelled"
    ? status
    : "resolved";
}

export interface WorkSessionContractTaskResult {
  session: WorkSession;
  contract?: OutcomeContract;
  aggregate: WorkSessionContractAggregate;
}

export interface WorkSessionTaskTerminalResult {
  contract?: OutcomeContract;
  childAggregate?: WorkSessionChildAggregate;
}

export interface UserRequirementCorrection {
  requirementId: string;
  statement: string;
  criterion: { type: "file_exists"; targetPath: string } | { type: "unsupported" };
  sourceEventId?: string;
  idempotencyKey: string;
}

export class WorkSessionContractService {
  private readonly repository: WorkSessionContractRepository;
  private readonly protocol: WorkSessionProtocolService;
  private readonly taskRepo: TaskStore;
  private readonly artifactRepo: ArtifactStore;
  private readonly approvalRepo: ApprovalStore;
  private readonly inputRequestRepo: InputRequestStore;
  private readonly workspaceRepo: WorkspaceStore;
  private readonly artifactEvidenceInspector: WorkspaceArtifactEvidenceInspector;

  constructor(
    private readonly db: Database.Database,
    protocol?: WorkSessionProtocolService,
    artifactEvidenceInspector?: WorkspaceArtifactEvidenceInspector,
  ) {
    this.repository = new WorkSessionContractRepository(db);
    this.protocol = protocol || new WorkSessionProtocolService(db);
    this.taskRepo = new TaskStore(db);
    this.artifactRepo = new ArtifactStore(db);
    this.approvalRepo = new ApprovalStore(db);
    this.inputRequestRepo = new InputRequestStore(db);
    this.workspaceRepo = new WorkspaceStore(db);
    this.artifactEvidenceInspector =
      artifactEvidenceInspector || new WorkspaceArtifactEvidenceInspector();
  }

  getRepository(): WorkSessionContractRepository {
    return this.repository;
  }

  getProtocolService(): WorkSessionProtocolService {
    return this.protocol;
  }

  ensureForTask(
    task: Pick<
      Task,
      | "id"
      | "workspaceId"
      | "sessionId"
      | "status"
      | "terminalStatus"
      | "prompt"
      | "successCriteria"
      | "parentTaskId"
      | "agentConfig"
      | "assignedAgentRoleId"
      | "workerRole"
    >,
  ): WorkSessionContractTaskResult {
    if (task.parentTaskId) {
      const parent = this.taskRepo.findById(task.parentTaskId);
      const boundSessionId = this.protocol.getRepository().findSessionIdForTask(task.id);
      const parentSessionId = parent
        ? this.protocol.getRepository().findSessionIdForTask(parent.id) ||
          parent.sessionId ||
          parent.id
        : undefined;
      if (parent && (!boundSessionId || boundSessionId === parentSessionId)) {
        this.ensureChildSession(parent, task as Task);
      }
    }
    const protocolAggregate = this.protocol.ensureForTask(task);
    const session = protocolAggregate.session;
    let contract = this.repository.findOutcomeContract(session.id);
    if (!contract) {
      const requirements = this.buildRequirements(task);
      contract = this.repository.createOutcomeContract({
        sessionId: session.id,
        taskId: task.id,
        objective: task.prompt || "Complete the requested work",
        requirements,
        source: "task",
        idempotencyKey: `task:${task.id}:contract:v1`,
      });
    }
    this.seedTaskConstraints(task, session);
    this.reconcilePersistedWaits(task.id, session.id);
    if (contract) {
      contract = this.reconcileOutcomeContract(task as Task, session.id, contract);
    }
    return {
      session,
      contract,
      aggregate: this.repository.getContractAggregate(session.id),
    };
  }

  getForTask(taskId: string): WorkSessionContractTaskResult | undefined {
    const task = this.taskRepo.findById(taskId);
    if (!task) return undefined;
    return this.ensureForTask(task);
  }

  getForSession(sessionId: string): WorkSessionContractAggregate {
    const current = this.repository.findOutcomeContract(sessionId);
    const task = current?.taskId ? this.taskRepo.findById(current.taskId) : undefined;
    if (task) this.ensureForTask(task);
    return this.repository.getContractAggregate(sessionId);
  }

  /** Refresh physical proof and return only evidence linked to active requirements. */
  getRequirementEvidenceManifest(taskId: string): RequirementEvidenceManifest | undefined {
    const result = this.getForTask(taskId);
    const contract = result?.contract;
    if (!contract) return undefined;
    const ids = contract.requirements.flatMap((requirement) => requirement.evidenceIds || []);
    const evidence = this.repository.listEvidenceByIds(contract.sessionId, ids);
    const evidenceById = new Map(evidence.map((entry) => [entry.id, entry]));
    const capturedAt = Date.now();
    return {
      contractId: contract.id,
      contractVersion: contract.version,
      capturedAt,
      requirements: contract.requirements.map((requirement) => ({
        requirementId: requirement.id,
        description: requirement.description,
        required: requirement.required,
        status: requirement.status,
        ...(requirement.verifier ? { verifier: requirement.verifier } : {}),
        ...(requirement.targetPath ? { targetPath: requirement.targetPath } : {}),
        evidence: (requirement.evidenceIds || []).flatMap((id) => {
          const entry = evidenceById.get(id);
          if (!entry) return [];
          const revision = entry.artifactRevisionId
            ? this.repository.getArtifactRevisionById(entry.artifactRevisionId)
            : undefined;
          return [
            {
              id: entry.id,
              claim: entry.claim,
              status: entry.status,
              sourceType: entry.sourceType,
              sourceRef: entry.sourceRef,
              capturedAt: entry.capturedAt,
              validatedAt: capturedAt,
              ...(entry.freshnessExpiresAt ? { freshnessExpiresAt: entry.freshnessExpiresAt } : {}),
              ...(entry.artifactRevisionId ? { artifactRevisionId: entry.artifactRevisionId } : {}),
              ...(revision ? { sha256: revision.sha256, artifactStatus: revision.status } : {}),
            },
          ];
        }),
      })),
    };
  }

  /** Persist a user correction as a constraint and reopen that exact requirement. */
  recordUserRequirementCorrection(
    taskId: string,
    correction: UserRequirementCorrection,
  ): OutcomeContract | undefined {
    const result = this.getForTask(taskId);
    const contract = result?.contract;
    if (!result || !contract) return undefined;
    const requirement = contract.requirements.find(
      (candidate) => candidate.id === correction.requirementId,
    );
    if (!requirement) throw new Error(`Outcome requirement not found: ${correction.requirementId}`);
    const statement = text(correction.statement, 4_000);
    if (!statement) throw new Error("A requirement correction statement is required");
    const idempotencyKey = text(correction.idempotencyKey, 200);
    if (!idempotencyKey) throw new Error("A correction idempotency key is required");
    if (
      correction.criterion.type === "file_exists" &&
      !text(correction.criterion.targetPath, 4_000)
    ) {
      throw new Error("A file_exists correction requires an exact target path");
    }

    const existingCorrection = this.repository.findConstraintByIdempotency(
      result.session.id,
      idempotencyKey,
    );
    if (existingCorrection) {
      const sameCriterion =
        existingCorrection.metadata?.verifier === correction.criterion.type &&
        (correction.criterion.type !== "file_exists" ||
          existingCorrection.metadata?.targetPath === text(correction.criterion.targetPath, 4_000));
      if (
        existingCorrection.kind !== "requirement" ||
        existingCorrection.owner !== "user" ||
        existingCorrection.metadata?.requirementId !== requirement.id ||
        existingCorrection.statement !== statement ||
        !sameCriterion
      ) {
        throw new Error("Correction idempotency key was already used for a different correction");
      }
      return this.repository.findOutcomeContract(result.session.id) || contract;
    }

    const requirements = contract.requirements.map((candidate) =>
      candidate.id !== requirement.id
        ? candidate
        : {
            ...candidate,
            description: statement,
            status: "pending" as const,
            ...(correction.criterion.type === "file_exists"
              ? {
                  verifier: "file_exists",
                  targetPath: text(correction.criterion.targetPath, 4_000)!,
                }
              : { verifier: undefined, targetPath: undefined }),
            evidenceIds: undefined,
          },
    );
    const priorCorrections = this.repository
      .listConstraints(result.session.id, { status: "active" })
      .filter(
        (entry) =>
          entry.kind === "requirement" &&
          entry.metadata?.requirementId === requirement.id &&
          entry.owner === "user",
      );
    return this.db.transaction(() => {
      this.staleRequirementEvidence(result.session.id, requirement.evidenceIds || []);
      for (const prior of priorCorrections) {
        this.repository.updateConstraint(prior.id, { status: "superseded" });
      }
      this.repository.appendConstraint({
        sessionId: result.session.id,
        kind: "requirement",
        key: requirement.id,
        statement,
        owner: "user",
        metadata: {
          requirementId: requirement.id,
          ...(correction.sourceEventId ? { sourceEventId: correction.sourceEventId } : {}),
          ...(correction.criterion.type === "file_exists"
            ? {
                verifier: "file_exists",
                targetPath: text(correction.criterion.targetPath, 4_000),
              }
            : { verifier: "unsupported" }),
        },
        idempotencyKey,
      });
      return this.repository.createOutcomeContract({
        sessionId: contract.sessionId,
        taskId: contract.taskId,
        version: contract.version + 1,
        objective: contract.objective,
        source: "user_correction",
        idempotencyKey: `contract:${contract.sessionId}:correction:${idempotencyKey}`,
        requirements,
      });
    })();
  }

  recordConstraint(
    taskId: string,
    input: Omit<ConstraintLedgerEntry, "id" | "sessionId" | "createdAt" | "updatedAt">,
  ): ConstraintLedgerEntry | undefined {
    const result = this.getForTask(taskId);
    if (!result) return undefined;
    return this.repository.appendConstraint({
      sessionId: result.session.id,
      ...input,
    });
  }

  recordEvidence(
    taskId: string,
    input: Omit<EvidenceManifestEntryInput, "sessionId">,
  ): EvidenceManifestEntry | undefined {
    const result = this.getForTask(taskId);
    if (!result) return undefined;
    return this.repository.appendEvidence({
      sessionId: result.session.id,
      ...input,
    });
  }

  recordArtifact(
    taskId: string,
    artifact: Artifact,
    metadata?: Record<string, unknown>,
    idempotencyKey?: string,
  ): ArtifactRevision | undefined {
    const result = this.getForTask(taskId);
    if (!result) return undefined;
    return this.repository.createArtifactRevision({
      sessionId: result.session.id,
      taskId,
      artifactId: artifact.id,
      path: artifact.path,
      mimeType: artifact.mimeType,
      sha256: artifact.sha256,
      size: artifact.size,
      createdBy: "agent",
      metadata,
      idempotencyKey: idempotencyKey || `artifact:${artifact.id}`,
    });
  }

  recordArtifactByPath(
    taskId: string,
    path: string,
    metadata?: Record<string, unknown>,
    idempotencyKey?: string,
  ): ArtifactRevision | undefined {
    const artifact = this.artifactRepo
      .findByTaskId(taskId)
      .find((candidate) => candidate.path === path);
    if (!artifact) return undefined;
    return this.recordArtifact(
      taskId,
      artifact,
      {
        ...metadata,
        ...(idempotencyKey ? { sourceEventId: idempotencyKey } : {}),
      },
      idempotencyKey,
    );
  }

  beginWait(
    taskId: string,
    input: Omit<WaitStateInput, "sessionId" | "taskId">,
  ): WaitState | undefined {
    const result = this.getForTask(taskId);
    if (!result) return undefined;
    const turn = result.aggregate
      ? this.protocol.getRepository().getCurrentTurn(result.session.id)
      : undefined;
    const wait = this.repository.createWaitState({
      sessionId: result.session.id,
      taskId,
      turnId: input.turnId || turn?.id,
      ...input,
    });
    if (turn) {
      this.appendProtocolWaitItem(result.session.id, turn.id, wait, `wait:${wait.id}:item`);
    }
    return wait;
  }

  resolveWait(
    taskId: string,
    kind: WaitStateKind,
    requestId: string | undefined,
    status: Extract<WaitStateStatus, "resolved" | "expired" | "cancelled"> = "resolved",
    payload?: Record<string, unknown>,
  ): WaitState | undefined {
    const result = this.getForTask(taskId);
    if (!result) return undefined;
    const wait = requestId
      ? this.repository.findWaitStateByRequest(result.session.id, kind, requestId)
      : this.repository
          .listWaitStates(result.session.id, { status: "pending" })
          .find((candidate) => candidate.kind === kind && candidate.taskId === taskId);
    return wait
      ? this.repository.resolveWaitState(wait.id, normalizeWaitStatus(status), payload)
      : undefined;
  }

  recordTaskEvent(taskId: string, event: TaskEvent): void {
    const task = this.taskRepo.findById(taskId);
    if (!task) return;
    const type = eventType(event);
    const payload = payloadRecord(event);
    const eventKey = event.eventId || event.id || `${taskId}:${event.timestamp}:${type}`;

    if (type === "approval_requested") {
      const approval = payload.approval;
      const approvalRecord =
        approval && typeof approval === "object" ? (approval as Record<string, unknown>) : payload;
      const requestId = text(approvalRecord.id || payload.approvalId, 256);
      this.beginWait(taskId, {
        kind: "approval",
        ...(requestId ? { requestId } : {}),
        reason:
          text(approvalRecord.description || payload.reason || payload.message) ||
          "Approval required",
        payload: waitPayload(type, payload),
        idempotencyKey: `event:${eventKey}`,
      });
    } else if (type === "approval_granted" || type === "approval_denied") {
      const approval = payload.approval;
      const approvalRecord =
        approval && typeof approval === "object" && !Array.isArray(approval)
          ? (approval as Record<string, unknown>)
          : {};
      const requestId = text(payload.approvalId || approvalRecord.id, 256);
      this.resolveWait(taskId, "approval", requestId, "resolved", payload);
    } else if (type === "input_request_created") {
      const request = payload.request;
      const requestRecord =
        request && typeof request === "object" ? (request as Record<string, unknown>) : payload;
      const requestId = text(requestRecord.id || payload.requestId, 256);
      this.beginWait(taskId, {
        kind: "input",
        ...(requestId ? { requestId } : {}),
        reason: "Structured user input required",
        payload: waitPayload(type, payload),
        idempotencyKey: `event:${eventKey}`,
      });
    } else if (type === "input_request_resolved" || type === "input_request_dismissed") {
      const request = payload.request;
      const requestRecord =
        request && typeof request === "object" && !Array.isArray(request)
          ? (request as Record<string, unknown>)
          : {};
      const requestId = text(payload.requestId || payload.inputRequestId || requestRecord.id, 256);
      this.resolveWait(taskId, "input", requestId, "resolved", payload);
    } else if (DURABLE_BLOCKING_EVENT_KINDS[type]) {
      const kind = DURABLE_BLOCKING_EVENT_KINDS[type]!;
      const requestId = waitRequestId(payload);
      this.beginWait(taskId, {
        kind,
        ...(requestId ? { requestId } : {}),
        reason: waitReason(type, payload),
        payload: waitPayload(type, payload),
        idempotencyKey: `event:${eventKey}`,
      });
    } else if (type === "reconnect_succeeded" || type === "reconnect_failed") {
      this.resolveWait(
        taskId,
        "reconnect",
        waitRequestId(payload),
        type === "reconnect_succeeded" ? "resolved" : "cancelled",
        payload,
      );
    } else if (
      type === "child_completed" ||
      type === "child_session_completed" ||
      type === "child_failed" ||
      type === "child_session_failed"
    ) {
      this.resolveWait(
        taskId,
        "child",
        waitRequestId(payload),
        type.endsWith("failed") ? "cancelled" : "resolved",
        payload,
      );
    } else if (
      type === "task_resumed" ||
      type === "task_completed" ||
      type === "task_failed" ||
      type === "task_cancelled"
    ) {
      const resumeRequestId = waitRequestId(payload);
      for (const wait of this.repository.listWaitStates(this.sessionIdForTask(task), {
        status: "pending",
      })) {
        if (
          (resumeRequestId && wait.requestId !== resumeRequestId) ||
          (!resumeRequestId && (wait.kind === "approval" || wait.kind === "input"))
        ) {
          continue;
        }
        this.repository.resolveWaitState(
          wait.id,
          type === "task_resumed" ? "resolved" : "cancelled",
          {
            reason: type === "task_resumed" ? "Task resumed" : "Task reached a terminal state",
            eventId: eventKey,
          },
        );
      }
    }

    if (
      type === "citations_collected" ||
      type === "timeline_evidence_attached" ||
      type.includes("evidence")
    ) {
      this.recordEvidenceFromEvent(task, event, payload, eventKey);
    }
    if (
      type === "file_created" ||
      type === "file_modified" ||
      type === "artifact_created" ||
      type === "timeline_artifact_emitted"
    ) {
      const artifactPath = text(payload.path, 4_000);
      if (artifactPath) this.recordArtifactByPath(task.id, artifactPath, payload, eventKey);
    }
    const childLink = this.repository.findChildSessionByTask(task.id);
    if (childLink) {
      const outcome = taskOutcome(task);
      this.repository.updateChildSession(childLink.id, {
        status: childStatusForTask(task),
        ...(outcome ? { outcome } : {}),
      });
    }
    if (TERMINAL_TASK_STATUSES.has(task.status)) {
      this.recordTaskTerminal(task, event);
    }
  }

  recordTaskTerminal(
    taskOrId:
      | Pick<
          Task,
          "id" | "status" | "terminalStatus" | "verificationVerdict" | "resultSummary" | "error"
        >
      | string,
    event?: TaskEvent,
  ): WorkSessionTaskTerminalResult {
    const task = this.taskRepo.findById(typeof taskOrId === "string" ? taskOrId : taskOrId.id);
    if (!task) return {};
    const result = this.getForTask(task.id);
    if (!result) return {};
    const outcome = taskOutcome(task);
    let contract = result.contract;
    if (contract && outcome) {
      const summary = text(
        task.resultSummary || task.error || (event && payloadRecord(event).message),
      );
      contract = this.reconcileOutcomeContract(task, result.session.id, contract, summary);
      const verificationReport = event
        ? text(payloadRecord(event).verificationReport || payloadRecord(event).report, 8_000)
        : undefined;
      if (verificationReport) {
        this.repository.appendEvidence({
          sessionId: result.session.id,
          contractId: contract.id,
          claim: "Task verification report",
          sourceType: "task_event",
          sourceRef: `task:${task.id}:verification`,
          snippet: verificationReport,
          confidence:
            task.verificationVerdict === "PASS"
              ? 1
              : task.verificationVerdict === "PARTIAL"
                ? 0.6
                : 0.2,
          status: task.verificationVerdict === "FAIL" ? "contradicting" : "supporting",
          idempotencyKey: `task:${task.id}:verification`,
        });
      }
    }

    const link = this.repository.findChildSessionByTask(task.id);
    let childAggregate: WorkSessionChildAggregate | undefined;
    if (link) {
      const status = childStatusForTask(task);
      this.repository.updateChildSession(link.id, {
        status,
        ...(taskOutcome(task) ? { outcome: taskOutcome(task) } : {}),
      });
      childAggregate = this.repository.aggregateChildOutcomes(link.parentSessionId);
      if (childAggregate.outcome) {
        this.repository.appendEvidence({
          sessionId: link.parentSessionId,
          claim: "Child session aggregate outcome",
          sourceType: "child_session",
          sourceRef: link.childSessionId,
          snippet: `${childAggregate.completedCount} complete, ${childAggregate.partialCount} partial, ${childAggregate.failedCount} failed`,
          confidence: 1,
          status: childAggregate.outcome === "failed" ? "contradicting" : "supporting",
          idempotencyKey: `children:${link.parentSessionId}:aggregate:${childAggregate.outcome}`,
        });
      }
    }
    return { contract, childAggregate };
  }

  ensureChildSession(parentTask: Task, childTask: Task): WorkSessionChildLink | undefined {
    const parentResult = this.ensureForTask(parentTask);
    // Child tasks retain their legacy session_id for grouping, but their
    // canonical protocol stream is isolated and addressed by childTask.id.
    const childProtocol = this.protocol.ensureForTask({
      id: childTask.id,
      workspaceId: childTask.workspaceId,
      sessionId: childTask.id,
      status: childTask.status,
    });
    const inheritedPolicySnapshot = this.buildInheritedPolicySnapshot(parentTask, childTask);
    this.protocol.getRepository().updateTaskSessionBinding(childTask.id, {
      parentSessionId: parentResult.session.id,
      isolationKey: `child:${childProtocol.session.id}`,
      owner: childTask.assignedAgentRoleId || childTask.workerRole || "subagent",
      inheritedPolicySnapshot,
    });
    const linkInput: ChildSessionLinkInput = {
      parentSessionId: parentResult.session.id,
      childSessionId: childProtocol.session.id,
      parentTaskId: parentTask.id,
      childTaskId: childTask.id,
      owner: childTask.assignedAgentRoleId || childTask.workerRole || "subagent",
      isolationKey: `child:${childProtocol.session.id}`,
      inheritedPolicySnapshot,
      status: "pending",
    };
    const link = this.repository.linkChildSession(linkInput);
    this.ensureForTask(childTask);
    return link;
  }

  private appendProtocolWaitItem(
    sessionId: string,
    turnId: string,
    wait: WaitState,
    idempotencyKey: string,
  ): WorkSessionItem {
    return this.protocol.getRepository().appendItem({
      sessionId,
      turnId,
      kind: "wait",
      actor: "system",
      payload: {
        waitStateId: wait.id,
        kind: wait.kind,
        reason: wait.reason,
        ...(wait.requestId ? { requestId: wait.requestId } : {}),
      },
      idempotencyKey,
      status: "waiting",
    });
  }

  private sessionIdForTask(task: Pick<Task, "id" | "sessionId">): string {
    return this.protocol.getRepository().findSessionIdForTask(task.id) || task.sessionId || task.id;
  }

  private reconcileOutcomeContract(
    task: Task,
    sessionId: string,
    contract: OutcomeContract,
    summary?: string,
  ): OutcomeContract {
    let fileIndex = 0;
    const activeCorrections = this.repository
      .listConstraints(sessionId, { status: "active" })
      .filter((entry) => entry.kind === "requirement" && entry.owner === "user")
      .sort((left, right) => right.updatedAt - left.updatedAt);
    const latestCorrectionByRequirement = new Map<string, (typeof activeCorrections)[number]>();
    for (const entry of activeCorrections) {
      const requirementId =
        typeof entry.metadata?.requirementId === "string" ? entry.metadata.requirementId : "";
      if (requirementId && !latestCorrectionByRequirement.has(requirementId)) {
        latestCorrectionByRequirement.set(requirementId, entry);
      }
    }
    const requirements = contract.requirements.map(
      (original): OutcomeContract["requirements"][number] => {
        let requirement = original;
        const encodedCriteriaIndex = /successCriteria:file_exists:(\d+)$/.exec(original.id)?.[1];
        const criteriaIndex = encodedCriteriaIndex ? Number(encodedCriteriaIndex) : fileIndex;
        if (encodedCriteriaIndex || original.verifier === "file_exists") {
          fileIndex = Math.max(fileIndex, criteriaIndex + 1);
        }
        const correction = latestCorrectionByRequirement.get(requirement.id);
        if (correction) {
          const verifier = correction.metadata?.verifier;
          const targetPath =
            typeof correction.metadata?.targetPath === "string"
              ? text(correction.metadata.targetPath, 4_000)
              : undefined;
          requirement = {
            ...requirement,
            description: correction.statement,
            ...(verifier === "file_exists" && targetPath
              ? { verifier: "file_exists", targetPath }
              : { verifier: undefined, targetPath: undefined }),
          };
        }
        if (!correction && requirement.verifier === "file_exists") {
          const criteriaPath =
            task.successCriteria?.type === "file_exists"
              ? text(task.successCriteria.filePaths?.[criteriaIndex], 4_000)
              : undefined;
          const legacyPath = /^File exists:\s*(.+)$/i.exec(requirement.description)?.[1]?.trim();
          if (!requirement.targetPath && (criteriaPath || legacyPath)) {
            requirement = { ...requirement, targetPath: criteriaPath || legacyPath };
          }
        }

        // The task-level verdict describes the verification run that finished the task. A user
        // correction recorded after that run reopens the requirement, so the older FAIL must not
        // be re-applied to it on later reads.
        const verdictRecordedAt = task.completedAt ?? task.updatedAt;
        const correctedAfterVerdict =
          !!correction &&
          typeof verdictRecordedAt === "number" &&
          correction.createdAt > verdictRecordedAt;
        if (
          task.verificationVerdict === "FAIL" &&
          task.failureClass === "required_verification" &&
          requirement.required &&
          !correctedAfterVerdict
        ) {
          const sourceRef = `task:${task.id}:verification-verdict`;
          const previous = this.repository
            .listEvidenceByIds(sessionId, requirement.evidenceIds || [])
            .find(
              (entry) =>
                entry.contractId === contract.id &&
                entry.status === "contradicting" &&
                entry.sourceRef === sourceRef &&
                entry.claim === "Server recorded a verification failure",
            );
          for (const evidence of this.repository.listEvidenceByIds(
            sessionId,
            requirement.evidenceIds || [],
          )) {
            if (evidence.id !== previous?.id && evidence.status !== "stale") {
              this.repository.updateEvidenceStatus(evidence.id, "stale");
            }
          }
          const failure =
            previous ||
            this.repository.appendEvidence({
              sessionId,
              contractId: contract.id,
              claim: "Server recorded a verification failure",
              sourceType: "task_event",
              sourceRef,
              snippet: "verdict=FAIL; source=server_task_verification_state",
              confidence: 1,
              status: "contradicting",
            });
          return { ...requirement, status: "failed", evidenceIds: [failure.id] };
        }

        const reviewReady =
          TERMINAL_TASK_STATUSES.has(task.status) ||
          task.terminalStatus === "awaiting_verification";
        if (!reviewReady) {
          this.staleRequirementEvidence(sessionId, requirement.evidenceIds || []);
          return { ...requirement, status: "pending", evidenceIds: undefined };
        }
        if (requirement.verifier !== "file_exists" || !requirement.targetPath) {
          this.staleRequirementEvidence(sessionId, requirement.evidenceIds || []);
          return { ...requirement, status: "pending", evidenceIds: undefined };
        }

        const workspace = this.workspaceRepo.findById(task.workspaceId);
        if (!workspace) {
          this.staleRequirementEvidence(sessionId, requirement.evidenceIds || []);
          return { ...requirement, status: "pending", evidenceIds: undefined };
        }
        const inspection = this.artifactEvidenceInspector.inspect(
          workspace,
          requirement.targetPath,
        );
        const linkedEvidence = this.repository.listEvidenceByIds(
          sessionId,
          requirement.evidenceIds || [],
        );

        if (inspection.status === "present") {
          let revision = this.repository.findLatestArtifactRevision(sessionId, inspection.path);
          if (
            !revision ||
            revision.status !== "committed" ||
            revision.sha256 !== inspection.sha256 ||
            revision.size !== inspection.size ||
            revision.createdBy !== "system" ||
            revision.metadata?.evidenceKind !== "workspace_file_exists"
          ) {
            revision = this.repository.createArtifactRevision({
              sessionId,
              taskId: task.id,
              path: inspection.path,
              mimeType: "application/octet-stream",
              sha256: inspection.sha256,
              size: inspection.size,
              createdBy: "system",
              metadata: {
                evidenceKind: "workspace_file_exists",
                verifier: "workspace_artifact_inspector",
              },
            });
          }
          const currentProof = linkedEvidence.find(
            (entry) =>
              entry.contractId === contract.id &&
              entry.status === "supporting" &&
              entry.sourceType === "artifact_revision" &&
              entry.sourceRef === inspection.path &&
              entry.artifactRevisionId === revision?.id &&
              entry.claim === "Workspace file is present (existence only)",
          );
          for (const evidence of linkedEvidence) {
            if (evidence.id !== currentProof?.id && evidence.status !== "stale") {
              this.repository.updateEvidenceStatus(evidence.id, "stale");
            }
          }
          const proof =
            currentProof ||
            this.repository.appendEvidence({
              sessionId,
              contractId: contract.id,
              claim: "Workspace file is present (existence only)",
              sourceType: "artifact_revision",
              sourceRef: inspection.path,
              snippet: `sha256=${inspection.sha256}; size=${inspection.size}; verifier=workspace_artifact_inspector`,
              confidence: 1,
              status: "supporting",
              artifactRevisionId: revision.id,
            });
          return { ...requirement, status: "satisfied", evidenceIds: [proof.id] };
        }

        if (inspection.status === "missing") {
          const currentContradiction = linkedEvidence.find(
            (entry) =>
              entry.contractId === contract.id &&
              entry.status === "contradicting" &&
              entry.sourceType === "task_event" &&
              entry.sourceRef === inspection.path &&
              entry.claim === "Workspace file is missing (existence check only)",
          );
          for (const evidence of linkedEvidence) {
            if (evidence.id !== currentContradiction?.id && evidence.status !== "stale") {
              this.repository.updateEvidenceStatus(evidence.id, "stale");
            }
          }
          const contradiction =
            currentContradiction ||
            this.repository.appendEvidence({
              sessionId,
              contractId: contract.id,
              claim: "Workspace file is missing (existence check only)",
              sourceType: "task_event",
              sourceRef: inspection.path,
              snippet: `result=missing; verifier=workspace_artifact_inspector; requirement=${requirement.id}`,
              confidence: 1,
              status: "contradicting",
            });
          return { ...requirement, status: "failed", evidenceIds: [contradiction.id] };
        }

        this.staleRequirementEvidence(sessionId, requirement.evidenceIds || []);
        return { ...requirement, status: "pending", evidenceIds: undefined };
      },
    );

    const mandatory = requirements.filter((requirement) => requirement.required);
    const satisfiedCount = mandatory.filter(
      (requirement) => requirement.status === "satisfied" || requirement.status === "waived",
    ).length;
    const contractStatus =
      mandatory.length === 0
        ? "pending"
        : mandatory.some((requirement) => requirement.status === "failed")
          ? "unmet"
          : satisfiedCount === mandatory.length
            ? "satisfied"
            : satisfiedCount > 0
              ? "partial"
              : "pending";
    return this.repository.updateOutcomeContract(contract.id, {
      status: contractStatus,
      requirements,
      ...(summary ? { summary } : {}),
      satisfiedAt: contractStatus === "satisfied" ? (contract.satisfiedAt ?? Date.now()) : null,
    });
  }

  private staleRequirementEvidence(sessionId: string, ids: string[]): void {
    for (const evidence of this.repository.listEvidenceByIds(sessionId, ids)) {
      if (evidence.status !== "stale") this.repository.updateEvidenceStatus(evidence.id, "stale");
    }
  }

  private buildRequirements(
    task: Pick<Task, "successCriteria">,
  ): OutcomeContractRequirementInput[] {
    const criteria = task.successCriteria;
    if (!criteria) return [];
    if (criteria.type === "shell_command" && text(criteria.command, 2_000)) {
      return [
        {
          kind: "verification",
          id: "successCriteria:shell_command",
          description: `Command exits successfully: ${text(criteria.command, 2_000)}`,
          required: true,
          verifier: "shell_command",
        },
      ];
    }
    if (criteria.type === "file_exists" && Array.isArray(criteria.filePaths)) {
      return criteria.filePaths.slice(0, 100).flatMap((filePath, index) => {
        const normalized = text(filePath, 4_000);
        return normalized
          ? [
              {
                id: `successCriteria:file_exists:${index}`,
                kind: "output" as const,
                description: `File exists: ${normalized}`,
                required: true,
                verifier: "file_exists",
                targetPath: normalized,
              },
            ]
          : [];
      });
    }
    return [];
  }

  private seedTaskConstraints(task: Pick<Task, "id" | "agentConfig">, session: WorkSession): void {
    const config = task.agentConfig;
    if (!config) return;
    if (Array.isArray(config.toolRestrictions) && config.toolRestrictions.length > 0) {
      this.repository.appendConstraint({
        sessionId: session.id,
        kind: "constraint",
        key: "tool_restrictions",
        statement: config.toolRestrictions.slice(0, 100).join(", "),
        owner: "policy",
        metadata: { source: "agent_config" },
        idempotencyKey: `task:${task.id}:constraint:tool_restrictions`,
      });
    }
    if (Array.isArray(config.allowedTools) && config.allowedTools.length > 0) {
      this.repository.appendConstraint({
        sessionId: session.id,
        kind: "constraint",
        key: "allowed_tools",
        statement: config.allowedTools.slice(0, 100).join(", "),
        owner: "policy",
        metadata: { source: "agent_config" },
        idempotencyKey: `task:${task.id}:constraint:allowed_tools`,
      });
    }
  }

  /** Rehydrate waits that were persisted before a process restart. */
  private reconcilePersistedWaits(taskId: string, sessionId: string): void {
    for (const approval of this.approvalRepo.findPendingByTaskId(taskId)) {
      this.repository.createWaitState({
        sessionId,
        taskId,
        kind: "approval",
        requestId: approval.id,
        reason: approval.description || "Approval required",
        payload: approval.details,
        idempotencyKey: `approval:${approval.id}`,
      });
    }
    for (const request of this.inputRequestRepo.findPendingByTaskId(taskId)) {
      this.repository.createWaitState({
        sessionId,
        taskId,
        kind: "input",
        requestId: request.id,
        reason: "Structured user input required",
        payload: { questions: request.questions },
        idempotencyKey: `input:${request.id}`,
      });
    }
  }

  private recordEvidenceFromEvent(
    task: Task,
    event: TaskEvent,
    payload: Record<string, unknown>,
    eventKey: string,
  ): void {
    const rawEntries = Array.isArray(payload.citations)
      ? payload.citations
      : Array.isArray(payload.evidence)
        ? payload.evidence
        : [payload];
    rawEntries.slice(0, 100).forEach((entry, index) => {
      const record: Record<string, unknown> =
        entry && typeof entry === "object" ? (entry as Record<string, unknown>) : { value: entry };
      const sourceRef = text(
        record.url || record.path || record.sourceUrlOrPath || record.sourceRef,
        4_000,
      );
      if (!sourceRef) return;
      const claim =
        text(record.claim || record.title || record.label || record.snippet, 4_000) ||
        "Evidence collected";
      const canonicalItem = this.protocol
        .getRepository()
        .findItemBySourceEvent(this.sessionIdForTask(task), event.eventId || event.id);
      this.recordEvidence(task.id, {
        claim,
        sourceType: sourceRef.startsWith("http") ? "url" : "task_event",
        sourceRef,
        snippet: text(record.snippet || record.text, 8_000),
        confidence: typeof record.confidence === "number" ? record.confidence : 0.7,
        status: record.contradicting === true ? "contradicting" : "supporting",
        ...(canonicalItem ? { itemId: canonicalItem.id } : {}),
        idempotencyKey: `event:${eventKey}:evidence:${index}`,
      });
    });
  }

  private buildInheritedPolicySnapshot(parentTask: Task, childTask: Task): Record<string, unknown> {
    const parentConfig = parentTask.agentConfig || {};
    const childConfig = childTask.agentConfig || {};
    return {
      inheritedFromTaskId: parentTask.id,
      accessProfileId: parentConfig.accessProfileId,
      permissionMode: parentConfig.permissionMode,
      gatewayContext: parentConfig.gatewayContext,
      allowedTools: childConfig.allowedTools || parentConfig.allowedTools,
      toolRestrictions: childConfig.toolRestrictions || parentConfig.toolRestrictions,
      owner: childTask.assignedAgentRoleId || childTask.workerRole || "subagent",
    };
  }
}
