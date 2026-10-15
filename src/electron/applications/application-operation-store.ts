import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import {
  ApplicationOperationRequestSchema,
  ApplicationRouteSchema,
  type ApplicationOperation,
  type ApplicationOperationRequest,
  type ApplicationRoute,
  type ApplicationAttempt,
  type ApplicationOperationEvent,
} from "../../shared/application-execution";
import { redactWorkSessionValue } from "../database/WorkSessionProtocolRepository";

export { APPLICATION_EXECUTION_SCHEMA } from "./application-execution-schema";

export function applicationDigest(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical);
    if (input && typeof input === "object")
      return Object.fromEntries(
        Object.entries(input)
          .filter(([, entry]) => entry !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, entry]) => [key, canonical(entry)]),
      );
    return input;
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

export function applicationJson(value: unknown, rejectRedaction = false): string {
  const normalized = JSON.parse(JSON.stringify(value));
  // Application JSON schemas legitimately nest properties/items/oneOf beyond
  // the transcript limit. Keep credential redaction and all size limits, but
  // admit bounded domain schemas without silently changing their semantics.
  const redacted = redactWorkSessionValue(normalized, "", 0, 16);
  if (rejectRedaction && applicationDigest(redacted) !== applicationDigest(normalized)) {
    throw new Error(
      "Application inputs must be bounded and contain connection handles rather than secrets",
    );
  }
  const json = JSON.stringify(rejectRedaction ? normalized : redacted);
  if (Buffer.byteLength(json) > 65_536) throw new Error("Application record exceeds 64 KiB");
  return json;
}

type OperationRow = {
  data: string;
  owner: string | null;
  generation: number;
  lease_until: number | null;
};
export interface ApplicationClaim {
  operation: ApplicationOperation;
  attempt: ApplicationAttempt;
  owner: string;
  generation: number;
}
export type ApplicationOperationUpdate = Pick<ApplicationOperation, "execution"> &
  Partial<
    Pick<
      ApplicationOperation,
      | "prepared"
      | "decision"
      | "externalId"
      | "result"
      | "verification"
      | "verificationResult"
      | "cancellation"
      | "error"
      | "nextPollAt"
      | "pendingAction"
    >
  >;

export function applicationDecisionBinding(operation: ApplicationOperation): string {
  return applicationDigest({
    request: operation.request,
    route: operation.route,
    prepared: operation.prepared,
  });
}

/** All mutations run as bounded transaction units, on the host or database worker. */
export class ApplicationOperationStore {
  constructor(private readonly db: Database.Database) {}

  private row(id: string): OperationRow | undefined {
    return this.db
      .prepare(
        "SELECT data, owner, generation, lease_until FROM application_operations WHERE id = ?",
      )
      .get(id) as OperationRow | undefined;
  }
  get(id: string): ApplicationOperation | undefined {
    const row = this.row(id);
    return row ? (JSON.parse(row.data) as ApplicationOperation) : undefined;
  }
  list(taskId: string, limit = 100): ApplicationOperation[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500)
      throw new Error("Invalid operation limit");
    return (
      this.db
        .prepare(
          "SELECT data FROM application_operations WHERE task_id = ? ORDER BY updated_at, id LIMIT ?",
        )
        .all(taskId, limit) as Array<{ data: string }>
    ).map((row) => JSON.parse(row.data));
  }
  recoverable(now: number, limit = 100): ApplicationOperation[] {
    return (
      this.db
        .prepare(`SELECT data FROM application_operations WHERE (execution IN ('submitting','running','unknown')
      OR (execution IN ('planned','prepared') AND json_extract(data, '$.dispatchRequested') = 1
        AND (json_extract(data, '$.decision.status') IS NULL OR json_extract(data, '$.decision.status') = 'accepted'))
      OR (execution = 'completed' AND json_extract(data, '$.verification') = 'pending'))
      AND (lease_until IS NULL OR lease_until <= ?) ORDER BY updated_at LIMIT ?`)
        .all(now, Math.min(100, Math.max(1, limit))) as Array<{ data: string }>
    ).map((row) => JSON.parse(row.data));
  }
  private event(operation: ApplicationOperation, kind: string, now: number): void {
    this.db
      .prepare(
        "INSERT INTO application_operation_events (operation_id, kind, at, revision) VALUES (?, ?, ?, ?)",
      )
      .run(operation.id, kind, now, operation.revision);
  }
  private save(operation: ApplicationOperation, kind: string, now: number): ApplicationOperation {
    const next = { ...operation, revision: operation.revision + 1, updatedAt: now };
    // Inputs were validated at admission. Redact output fields without altering durable requests.
    const safe = {
      ...next,
      result: next.result ? JSON.parse(applicationJson(next.result)) : undefined,
      verificationResult: next.verificationResult
        ? JSON.parse(applicationJson(next.verificationResult))
        : undefined,
      error: next.error ? (redactWorkSessionValue(next.error) as string) : undefined,
    };
    const data = JSON.stringify(safe);
    if (Buffer.byteLength(data) > 131_072) throw new Error("Application operation exceeds 128 KiB");
    this.db
      .prepare(
        "UPDATE application_operations SET data = ?, revision = ?, execution = ?, updated_at = ? WHERE id = ?",
      )
      .run(data, safe.revision, safe.execution, now, safe.id);
    this.event(safe, kind, now);
    return safe;
  }
  create(
    raw: ApplicationOperationRequest,
    rawRoute: ApplicationRoute,
    now: number,
  ): ApplicationOperation {
    const request = ApplicationOperationRequestSchema.parse(raw);
    const route = ApplicationRouteSchema.parse(rawRoute);
    applicationJson(request, true);
    applicationJson(route, true);
    const digest = applicationDigest({ request, route });
    const found = this.db
      .prepare(
        "SELECT data, request_digest FROM application_operations WHERE session_id = ? AND idempotency_key = ?",
      )
      .get(request.sessionId, request.idempotencyKey) as
      | { data: string; request_digest: string }
      | undefined;
    if (found) {
      if (found.request_digest !== digest)
        throw new Error("Idempotency key was already used for a different application request");
      return JSON.parse(found.data);
    }
    const task = this.db
      .prepare("SELECT workspace_id, status FROM tasks WHERE id = ?")
      .get(request.taskId) as { workspace_id: string; status: string } | undefined;
    if (task && ["completed", "failed", "cancelled"].includes(task.status))
      throw new Error("Cannot create an application operation for a terminal task");
    const session = this.db
      .prepare("SELECT workspace_id FROM work_sessions WHERE id = ?")
      .get(request.sessionId) as { workspace_id: string } | undefined;
    const bound = this.db
      .prepare("SELECT 1 FROM work_session_task_bindings WHERE task_id = ? AND session_id = ?")
      .get(request.taskId, request.sessionId);
    if (
      !task ||
      !session ||
      !bound ||
      task.workspace_id !== request.workspaceId ||
      session.workspace_id !== request.workspaceId
    )
      throw new Error(
        "Application operation must belong to the task's bound WorkSession and workspace",
      );
    for (const dependencyId of request.dependsOn) {
      const dependency = this.get(dependencyId);
      if (
        !dependency ||
        dependency.request.sessionId !== request.sessionId ||
        dependency.request.taskId !== request.taskId
      )
        throw new Error("Application dependency must belong to the same task and session");
    }
    const count = this.db
      .prepare("SELECT COUNT(*) n FROM application_operations WHERE task_id = ?")
      .get(request.taskId) as { n: number };
    if (count.n >= 500) throw new Error("Application operation limit reached for this task");
    const operation: ApplicationOperation = {
      id: randomUUID(),
      request,
      route,
      revision: 1,
      execution: "planned",
      verification: "pending",
      cancellation: "none",
      attemptCount: 0,
      dispatchRequested: false,
      createdAt: now,
      updatedAt: now,
    };
    if (request.supersedes) {
      const previous = this.get(request.supersedes);
      if (
        !previous ||
        previous.request.taskId !== request.taskId ||
        previous.request.sessionId !== request.sessionId ||
        previous.supersededBy ||
        previous.attemptCount !== 0 ||
        !["planned", "prepared", "cancelled"].includes(previous.execution) ||
        (previous.route.supports.prepare && previous.route.preparationEffect !== "read") ||
        request.planRevision <= previous.request.planRevision ||
        request.dependsOn.includes(previous.id)
      )
        throw new Error(
          "Only an unsubmitted proposal without preparation effects can be superseded by a later plan revision",
        );
      this.save(
        {
          ...previous,
          execution: "cancelled",
          cancellation: "confirmed",
          supersededBy: operation.id,
          decision: previous.decision
            ? { ...previous.decision, status: "rejected", resolvedAt: now }
            : undefined,
        },
        "proposal.superseded",
        now,
      );
      this.db
        .prepare("DELETE FROM application_resource_locks WHERE operation_id = ?")
        .run(previous.id);
    }
    this.db
      .prepare(`INSERT INTO application_operations
      (id, session_id, task_id, workspace_id, idempotency_key, request_digest, revision, execution, data, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        operation.id,
        request.sessionId,
        request.taskId,
        request.workspaceId,
        request.idempotencyKey,
        digest,
        1,
        "planned",
        JSON.stringify(operation),
        now,
      );
    this.event(operation, "created", now);
    return operation;
  }
  private scopes(operation: ApplicationOperation): string[] {
    return [
      ...new Set([
        ...(operation.request.resources.length === 0 || operation.route.effect === "unknown"
          ? [`workspace:${operation.request.workspaceId}`]
          : []),
        ...(operation.route.environment.kind === "desktop"
          ? [`desktop:${operation.route.environment.id}`]
          : []),
        ...operation.request.resources.map(
          (resource) =>
            `resource:${applicationDigest({
              system: resource.system,
              identity: resource.identity,
              accountId: resource.accountId,
              tenantId: resource.tenantId,
            })}`,
        ),
      ]),
    ].sort();
  }
  private refuseDispatch(operation: ApplicationOperation, message: string, now: number): undefined {
    this.save(
      { ...operation, execution: "failed", error: message, dispatchRequested: false },
      "dispatch.refused",
      now,
    );
    this.db
      .prepare("DELETE FROM application_resource_locks WHERE operation_id = ?")
      .run(operation.id);
    return undefined;
  }
  claim(
    id: string,
    phase: ApplicationAttempt["phase"],
    owner: string,
    now: number,
    leaseMs: number,
  ): ApplicationClaim | undefined {
    const row = this.row(id);
    if (!row) throw new Error("Application operation not found");
    if (row.lease_until && row.lease_until > now) return undefined;
    let operation = JSON.parse(row.data) as ApplicationOperation;
    if (!owner || !Number.isFinite(leaseMs) || leaseMs < 1_000 || leaseMs > 120_000)
      throw new Error("Invalid application lease");
    const eligible =
      phase === "prepare"
        ? operation.execution === "planned"
        : phase === "execute"
          ? ["planned", "prepared"].includes(operation.execution)
          : phase === "observe"
            ? ["running", "unknown", "submitting"].includes(operation.execution)
            : phase === "verify"
              ? operation.execution === "completed"
              : ["running", "unknown", "submitting"].includes(operation.execution) &&
                operation.cancellation === "requested";
    if (!eligible) return undefined;
    if (phase === "observe" || phase === "cancel") {
      const polls = (
        this.db
          .prepare(
            "SELECT COUNT(*) n FROM application_operation_attempts WHERE operation_id = ? AND json_extract(data, '$.phase') IN ('observe','cancel')",
          )
          .get(id) as { n: number }
      ).n;
      if (polls >= operation.request.constraints.maxPolls) {
        this.save(
          {
            ...operation,
            execution: "unknown",
            error: "Application observation budget exhausted; effects remain unresolved",
            nextPollAt: Number.MAX_SAFE_INTEGER,
          },
          "observation.exhausted",
          now,
        );
        return undefined;
      }
    }
    if (phase === "execute" || phase === "prepare") {
      if (operation.cancellation !== "none") return undefined;
      if (
        operation.request.constraints.deadlineAt !== undefined &&
        operation.request.constraints.deadlineAt <= now
      )
        return this.refuseDispatch(operation, "Application operation deadline exceeded", now);
      for (const dependencyId of operation.request.dependsOn) {
        const dependency = this.get(dependencyId);
        if (
          !dependency ||
          dependency.execution !== "completed" ||
          dependency.verification !== "verified" ||
          dependency.result?.unmetCriteria.length ||
          (dependency.verificationResult?.expiresAt !== undefined &&
            dependency.verificationResult.expiresAt <= now)
        )
          return undefined;
      }
    }
    if (phase === "execute") {
      if (
        operation.request.decision &&
        (!operation.decision || operation.decision.status !== "accepted")
      )
        throw new Error("Application operation requires a resolved decision");
      if (
        operation.decision &&
        (operation.decision.status !== "accepted" ||
          operation.decision.binding !== applicationDecisionBinding(operation))
      )
        throw new Error("Application decision is stale or unresolved");
      if (operation.prepared?.expiresAt !== undefined && operation.prepared.expiresAt <= now)
        throw new Error("Application preparation has expired; prepare a new request");
      const budget = operation.request.constraints;
      if (operation.attemptCount >= budget.maxAttempts)
        return this.refuseDispatch(operation, "Application attempt budget exhausted", now);
      if (
        budget.maxCost !== undefined &&
        (operation.prepared?.estimatedCost === undefined ||
          operation.prepared.currency !== budget.currency ||
          operation.prepared.estimatedCost * (operation.attemptCount + 1) > budget.maxCost)
      )
        return this.refuseDispatch(
          operation,
          "Application cost is unknown or exceeds the agreed budget",
          now,
        );
    }
    // An expired worker's dispatch may have committed. It is never made replayable here.
    if (["submitting"].includes(operation.execution))
      operation = { ...operation, execution: "unknown" };
    const workspaceScope = `workspace:${operation.request.workspaceId}`;
    const workspaceLock = this.db
      .prepare("SELECT operation_id FROM application_resource_locks WHERE scope = ?")
      .get(workspaceScope) as { operation_id: string } | undefined;
    if (workspaceLock && workspaceLock.operation_id !== id) return undefined;
    if (
      this.scopes(operation).includes(workspaceScope) &&
      this.db
        .prepare(`SELECT 1 FROM application_resource_locks locks
      JOIN application_operations ops ON ops.id = locks.operation_id WHERE ops.workspace_id = ? AND ops.id <> ? LIMIT 1`)
        .get(operation.request.workspaceId, id)
    )
      return undefined;
    for (const scope of this.scopes(operation)) {
      const lock = this.db
        .prepare("SELECT operation_id FROM application_resource_locks WHERE scope = ?")
        .get(scope) as { operation_id: string } | undefined;
      if (lock && lock.operation_id !== id) return undefined;
    }
    for (const scope of this.scopes(operation))
      this.db
        .prepare(
          "INSERT OR IGNORE INTO application_resource_locks (scope, operation_id) VALUES (?, ?)",
        )
        .run(scope, id);
    const generation = row.generation + 1;
    const attempt: ApplicationAttempt = {
      id: randomUUID(),
      operationId: id,
      number: operation.attemptCount + (phase === "execute" ? 1 : 0),
      phase,
      owner,
      generation,
      status: "started",
      startedAt: now,
    };
    this.db
      .prepare(
        "INSERT INTO application_operation_attempts (id, operation_id, generation, data) VALUES (?, ?, ?, ?)",
      )
      .run(attempt.id, id, generation, JSON.stringify(attempt));
    this.db
      .prepare(
        "UPDATE application_operations SET owner = ?, generation = ?, lease_until = ? WHERE id = ?",
      )
      .run(owner, generation, now + leaseMs, id);
    operation = this.save(
      {
        ...operation,
        pendingAction: ["prepare", "execute", "cancel"].includes(phase)
          ? (phase as "prepare" | "execute" | "cancel")
          : operation.pendingAction,
        execution: phase === "execute" || phase === "prepare" ? "submitting" : operation.execution,
        attemptCount: operation.attemptCount + (phase === "execute" ? 1 : 0),
      },
      `${phase}.started`,
      now,
    );
    return { operation, attempt, owner, generation };
  }
  renew(claim: ApplicationClaim, now: number, leaseMs: number): boolean {
    return (
      this.db
        .prepare(
          "UPDATE application_operations SET lease_until = ? WHERE id = ? AND owner = ? AND generation = ? AND lease_until > ?",
        )
        .run(now + leaseMs, claim.operation.id, claim.owner, claim.generation, now).changes === 1
    );
  }
  finish(
    claim: ApplicationClaim,
    update: ApplicationOperationUpdate,
    now: number,
  ): ApplicationOperation | undefined {
    const row = this.row(claim.operation.id);
    if (
      !row ||
      row.owner !== claim.owner ||
      row.generation !== claim.generation ||
      !row.lease_until ||
      row.lease_until <= now
    )
      return undefined;
    const current = JSON.parse(row.data) as ApplicationOperation;
    const attemptRow = this.db
      .prepare(
        "SELECT data FROM application_operation_attempts WHERE id = ? AND operation_id = ? AND generation = ?",
      )
      .get(claim.attempt.id, current.id, claim.generation) as { data: string } | undefined;
    if (!attemptRow || (JSON.parse(attemptRow.data) as ApplicationAttempt).status !== "started")
      return undefined;
    const next = this.save(
      {
        ...current,
        ...update,
        pendingAction: ["prepared", "completed", "failed", "cancelled", "planned"].includes(
          update.execution,
        )
          ? undefined
          : current.pendingAction,
        // A cancellation arriving during execution is durable and cannot be lost to a late reply.
        cancellation:
          current.cancellation === "requested" && update.cancellation === undefined
            ? "requested"
            : (update.cancellation ?? current.cancellation),
      },
      `${claim.attempt.phase}.${update.execution}`,
      now,
    );
    this.db.prepare("UPDATE application_operation_attempts SET data = ? WHERE id = ?").run(
      JSON.stringify({
        ...claim.attempt,
        status: update.execution === "unknown" ? "unknown" : "completed",
        finishedAt: now,
      }),
      claim.attempt.id,
    );
    this.db
      .prepare("UPDATE application_operations SET owner = NULL, lease_until = NULL WHERE id = ?")
      .run(current.id);
    if (["prepared", "completed", "failed", "cancelled", "planned"].includes(next.execution))
      this.db
        .prepare("DELETE FROM application_resource_locks WHERE operation_id = ?")
        .run(current.id);
    return next;
  }
  requestCancel(id: string, now: number): ApplicationOperation {
    const operation = this.get(id);
    if (!operation) throw new Error("Application operation not found");
    if (["completed", "failed", "cancelled"].includes(operation.execution)) return operation;
    const local = ["planned", "prepared"].includes(operation.execution);
    const next = this.save(
      {
        ...operation,
        nextPollAt: undefined,
        execution: local ? "cancelled" : operation.execution,
        cancellation: local
          ? "confirmed"
          : operation.route.supports.cancel
            ? "requested"
            : "unsupported",
        decision:
          operation.decision?.status === "pending"
            ? { ...operation.decision, status: "rejected", resolvedAt: now }
            : operation.decision,
      },
      "cancel.requested",
      now,
    );
    if (local)
      this.db.prepare("DELETE FROM application_resource_locks WHERE operation_id = ?").run(id);
    return next;
  }
  requestExecute(id: string, now: number): ApplicationOperation {
    const operation = this.get(id);
    if (!operation) throw new Error("Application operation not found");
    if (operation.dispatchRequested || !["planned", "prepared"].includes(operation.execution))
      return operation;
    return this.save({ ...operation, dispatchRequested: true }, "dispatch.requested", now);
  }
  resolveUnknown(
    input: {
      operationId: string;
      expectedRevision: number;
      resolutionKey: string;
      status: "applied" | "not_applied" | "stopped";
      summary: string;
    },
    now: number,
  ): ApplicationOperation {
    const operation = this.get(input.operationId);
    if (!operation) throw new Error("Application operation not found");
    const digest = applicationDigest(input);
    if (operation.manualResolution?.key === input.resolutionKey) {
      if (operation.manualResolution.digest !== digest)
        throw new Error("Manual resolution key has different content");
      return operation;
    }
    if (operation.execution !== "unknown" || operation.revision !== input.expectedRevision)
      throw new Error("Manual resolution requires the displayed unknown operation revision");
    if (
      !input.resolutionKey ||
      input.resolutionKey.length > 256 ||
      !input.summary.trim() ||
      input.summary.length > 8_000 ||
      !["applied", "not_applied", "stopped"].includes(input.status)
    )
      throw new Error("Invalid manual application resolution");
    const summary = redactWorkSessionValue(input.summary) as string;
    const next = this.save(
      {
        ...operation,
        pendingAction: undefined,
        execution:
          input.status === "applied"
            ? "completed"
            : input.status === "stopped"
              ? "cancelled"
              : "failed",
        cancellation: input.status === "stopped" ? "confirmed" : operation.cancellation,
        verification: "unavailable",
        verificationResult: {
          status: "unavailable",
          summary: "Operator reported the external state; domain verification is unavailable",
          checkedAt: now,
          evidence: [{ source: `operator:${input.resolutionKey}`, claim: summary }],
        },
        result:
          input.status === "applied"
            ? {
                kind: "application_state",
                summary,
                resources: operation.request.resources,
                unmetCriteria: [],
              }
            : operation.result,
        error: summary,
        nextPollAt: undefined,
        manualResolution: {
          key: input.resolutionKey,
          digest,
          status: input.status,
          summary,
          at: now,
        },
      },
      `operator.${input.status}`,
      now,
    );
    this.db
      .prepare(
        "UPDATE application_operations SET owner = NULL, lease_until = NULL, generation = generation + 1 WHERE id = ?",
      )
      .run(operation.id);
    this.db
      .prepare("DELETE FROM application_resource_locks WHERE operation_id = ?")
      .run(operation.id);
    return next;
  }
  resolveDecision(
    id: string,
    decisionId: string,
    binding: string,
    resolutionKey: string,
    status: "accepted" | "rejected" | "revise",
    feedback: string | undefined,
    now: number,
  ): ApplicationOperation {
    const operation = this.get(id);
    if (!operation?.decision || operation.decision.id !== decisionId)
      throw new Error("Application decision not found");
    const decision = operation.decision;
    if (decision.status !== "pending") {
      if (decision.resolutionKey === resolutionKey && decision.status === status) return operation;
      throw new Error("Application decision has already been resolved");
    }
    if (
      !resolutionKey ||
      resolutionKey.length > 256 ||
      !["accepted", "rejected", "revise"].includes(status)
    )
      throw new Error("Invalid decision response");
    if (decision.binding !== binding || binding !== applicationDecisionBinding(operation))
      throw new Error("Stale application decision");
    const expired =
      operation.prepared?.expiresAt !== undefined && operation.prepared.expiresAt <= now;
    const next = this.save(
      {
        ...operation,
        execution: status === "rejected" && !expired ? "cancelled" : operation.execution,
        cancellation: status === "rejected" && !expired ? "confirmed" : operation.cancellation,
        decision: {
          ...decision,
          status: expired ? "expired" : status,
          resolutionKey,
          feedback: feedback
            ? (redactWorkSessionValue(feedback.slice(0, 8_000)) as string)
            : undefined,
          resolvedAt: now,
        },
      },
      expired ? "decision.expired" : `decision.${status}`,
      now,
    );
    return next;
  }
  attempts(id: string): ApplicationAttempt[] {
    return (
      this.db
        .prepare(
          "SELECT data FROM application_operation_attempts WHERE operation_id = ? ORDER BY generation LIMIT 500",
        )
        .all(id) as Array<{ data: string }>
    ).map((row) => JSON.parse(row.data));
  }
  authorizesToolAttempt(
    taskId: string,
    reference: {
      operationId: string;
      attemptId: string;
      generation: number;
      phase: ApplicationAttempt["phase"];
    },
    now: number,
  ): boolean {
    const row = this.row(reference.operationId);
    if (
      !row ||
      row.generation !== reference.generation ||
      !row.owner ||
      !row.lease_until ||
      row.lease_until <= now
    )
      return false;
    const operation = JSON.parse(row.data) as ApplicationOperation;
    if (operation.request.taskId !== taskId) return false;
    const attempt = this.db
      .prepare(
        "SELECT data FROM application_operation_attempts WHERE id = ? AND operation_id = ? AND generation = ?",
      )
      .get(reference.attemptId, reference.operationId, reference.generation) as
      | { data: string }
      | undefined;
    const parsed = attempt ? (JSON.parse(attempt.data) as ApplicationAttempt) : undefined;
    return (
      parsed?.status === "started" &&
      parsed.phase === reference.phase &&
      ["prepare", "execute", "cancel"].includes(parsed.phase)
    );
  }
  events(id: string, after = 0): ApplicationOperationEvent[] {
    return this.db
      .prepare(
        "SELECT sequence, operation_id AS operationId, kind, at, revision FROM application_operation_events WHERE operation_id = ? AND sequence > ? ORDER BY sequence LIMIT 500",
      )
      .all(id, after) as ApplicationOperationEvent[];
  }
  recoverExpired(now: number): number {
    const rows = this.db
      .prepare(
        "SELECT id FROM application_operations WHERE owner IS NOT NULL AND lease_until <= ? ORDER BY updated_at LIMIT 100",
      )
      .all(now) as Array<{ id: string }>;
    for (const { id } of rows) {
      const operation = this.get(id)!;
      this.save(
        {
          ...operation,
          execution: operation.execution === "submitting" ? "unknown" : operation.execution,
        },
        "worker.expired",
        now,
      );
      const attempts = this.db
        .prepare("SELECT id, data FROM application_operation_attempts WHERE operation_id = ?")
        .all(id) as Array<{ id: string; data: string }>;
      for (const row of attempts) {
        const attempt = JSON.parse(row.data) as ApplicationAttempt;
        if (attempt.status === "started")
          this.db
            .prepare("UPDATE application_operation_attempts SET data = ? WHERE id = ?")
            .run(JSON.stringify({ ...attempt, status: "unknown", finishedAt: now }), row.id);
      }
      this.db
        .prepare("UPDATE application_operations SET owner = NULL, lease_until = NULL WHERE id = ?")
        .run(id);
    }
    return rows.length;
  }
}
