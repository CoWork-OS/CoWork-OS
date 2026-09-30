import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { Task } from "../../shared/types";
import {
  TaskAdmissionRepository,
  type TaskAdmissionRepository as TaskAdmissionRepositoryPort,
} from "../database/repository-facades";
import type {
  TaskAdmissionInput,
  TaskAdmissionMediaMetadata,
  TaskAdmissionReceiptLookup,
  TaskAdmissionStoreOutcome,
} from "../database/repositories";

const MAX_OPERATION_KEY_LENGTH = 200;
const MAX_CANONICAL_PAYLOAD_LENGTH = 4_000_000;

export interface TaskAdmissionResult {
  task: Task;
  replayed: boolean;
}

export type TaskAdmissionStatus =
  | { found: false }
  | {
      found: true;
      operationKey: string;
      taskId: string;
      createdAt: number;
      task: Task | null;
    };

export interface TaskAdmissionRepositoryPortLike {
  admit: TaskAdmissionRepositoryPort["admit"];
  findByOperationKey: TaskAdmissionRepositoryPort["findByOperationKey"];
}

export class TaskAdmissionInputError extends Error {
  readonly code = "invalid_task_admission";

  constructor(message: string) {
    super(message);
    this.name = "TaskAdmissionInputError";
  }
}

export class TaskAdmissionConflictError extends Error {
  readonly code = "task_admission_conflict";

  constructor(
    readonly operationKey: string,
    readonly existingTaskId: string,
  ) {
    super(`operationKey '${operationKey}' was already used for a different task payload`);
    this.name = "TaskAdmissionConflictError";
  }
}

export class TaskAdmissionReceiptUnavailableError extends Error {
  readonly code = "task_admission_receipt_unavailable";

  constructor(
    readonly operationKey: string,
    readonly taskId: string,
  ) {
    super(`task admission receipt '${operationKey}' exists, but task '${taskId}' is unavailable`);
    this.name = "TaskAdmissionReceiptUnavailableError";
  }
}

/**
 * Idempotent task creation over the storage transaction unit. A worker reply may be
 * lost after SQLite commits; the service reconciles by the same operation key before
 * attempting one same-key retry. Callers must retain their operation key across timeouts.
 */
export class TaskAdmissionService {
  private readonly repository: TaskAdmissionRepositoryPortLike;

  constructor(
    db: Database.Database,
    repository: TaskAdmissionRepositoryPortLike = new TaskAdmissionRepository(db),
  ) {
    this.repository = repository;
  }

  async admit(
    operationKey: string,
    task: TaskAdmissionInput,
    requestIdentity?: unknown,
    media?: TaskAdmissionMediaMetadata,
  ): Promise<TaskAdmissionResult> {
    const key = normalizeOperationKey(operationKey);
    const { input, preparedPayloadHash } = normalizeTaskInput(task);
    const payloadHash =
      requestIdentity === undefined
        ? preparedPayloadHash
        : hashCanonicalPayload(requestIdentity, "request identity");
    try {
      return this.resolveOutcome(
        key,
        media === undefined
          ? await this.repository.admit(key, payloadHash, input)
          : await this.repository.admit(key, payloadHash, input, media),
      );
    } catch (firstError) {
      if (isFinalAdmissionError(firstError)) throw firstError;

      // A worker can commit and then exit before its response reaches the host. Check the
      // durable receipt using the same key before deciding whether to retry admission.
      try {
        const receipt = await this.repository.findByOperationKey(key);
        if (receipt) return this.resolveReceipt(key, payloadHash, receipt);
      } catch (reconciliationError) {
        if (isFinalAdmissionError(reconciliationError)) throw reconciliationError;
        // The worker may be unavailable for the read too. A same-key retry remains safe.
      }

      try {
        return this.resolveOutcome(
          key,
          media === undefined
            ? await this.repository.admit(key, payloadHash, input)
            : await this.repository.admit(key, payloadHash, input, media),
        );
      } catch (retryError) {
        if (isFinalAdmissionError(retryError)) throw retryError;
        // Keep the original failure visible. A caller can use getByOperationKey(key) to
        // reconcile later; this service never manufactures a replacement key.
        throw firstError;
      }
    }
  }

  async getByOperationKey(operationKey: string): Promise<TaskAdmissionStatus> {
    const key = normalizeOperationKey(operationKey);
    const receipt = await this.repository.findByOperationKey(key);
    if (!receipt) return { found: false };
    return {
      found: true,
      operationKey: receipt.operationKey,
      taskId: receipt.taskId,
      createdAt: receipt.createdAt,
      task: receipt.task,
    };
  }

  /**
   * Resolve an existing receipt before task preparation. This lets a retry return
   * the original admitted task even if mutable routing or memory context changed.
   */
  async findReplayByRequestIdentity(
    operationKey: string,
    requestIdentity: unknown,
  ): Promise<TaskAdmissionResult | undefined> {
    const key = normalizeOperationKey(operationKey);
    const payloadHash = hashCanonicalPayload(requestIdentity, "request identity");
    const receipt = await this.repository.findByOperationKey(key);
    if (!receipt) return undefined;
    return this.resolveReceipt(key, payloadHash, receipt);
  }

  private resolveOutcome(
    operationKey: string,
    outcome: TaskAdmissionStoreOutcome,
  ): TaskAdmissionResult {
    switch (outcome.kind) {
      case "payload_conflict":
        throw new TaskAdmissionConflictError(operationKey, outcome.taskId);
      case "task_missing":
        throw new TaskAdmissionReceiptUnavailableError(operationKey, outcome.taskId);
      case "created":
      case "replayed":
        return { task: outcome.task, replayed: outcome.kind === "replayed" };
    }
  }

  private resolveReceipt(
    operationKey: string,
    payloadHash: string,
    receipt: TaskAdmissionReceiptLookup,
  ): TaskAdmissionResult {
    if (receipt.payloadHash !== payloadHash) {
      throw new TaskAdmissionConflictError(operationKey, receipt.taskId);
    }
    if (!receipt.task) {
      throw new TaskAdmissionReceiptUnavailableError(operationKey, receipt.taskId);
    }
    return { task: receipt.task, replayed: true };
  }
}

function normalizeOperationKey(operationKey: string): string {
  const normalized = typeof operationKey === "string" ? operationKey.trim() : "";
  if (!normalized || normalized.length > MAX_OPERATION_KEY_LENGTH) {
    throw new TaskAdmissionInputError(
      `operationKey must contain 1..${MAX_OPERATION_KEY_LENGTH} characters`,
    );
  }
  return normalized;
}

function isFinalAdmissionError(
  error: unknown,
): error is TaskAdmissionConflictError | TaskAdmissionReceiptUnavailableError {
  return (
    error instanceof TaskAdmissionConflictError ||
    error instanceof TaskAdmissionReceiptUnavailableError
  );
}

function normalizeTaskInput(task: TaskAdmissionInput): {
  input: TaskAdmissionInput;
  preparedPayloadHash: string;
} {
  if (!task || typeof task !== "object" || Array.isArray(task)) {
    throw new TaskAdmissionInputError("task must be an object");
  }
  if (
    typeof task.title !== "string" ||
    typeof task.prompt !== "string" ||
    typeof task.workspaceId !== "string" ||
    !["snapshot", "checkpoint", "transcript"].includes(String(task.resumeStrategy))
  ) {
    throw new TaskAdmissionInputError(
      "task needs string title, prompt and workspaceId fields plus a prepared resumeStrategy",
    );
  }

  // At runtime callers can still pass fields excluded by the TypeScript input type.
  // These are generated or forced by the admission transaction and must not affect its
  // payload identity.
  const {
    id: _id,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    status: _status,
    ...rest
  } = task as TaskAdmissionInput & Partial<Pick<Task, "id" | "createdAt" | "updatedAt" | "status">>;
  void _id;
  void _createdAt;
  void _updatedAt;
  void _status;

  const canonical = canonicalJson(rest, "task");

  const input = JSON.parse(canonical) as TaskAdmissionInput;
  const preparedPayloadHash = createHash("sha256").update(canonical, "utf8").digest("hex");
  return { input, preparedPayloadHash };
}

function hashCanonicalPayload(value: unknown, label: string): string {
  const canonical = canonicalJson(value, label);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function canonicalJson(value: unknown, label: string): string {
  let canonical: string | undefined;
  try {
    canonical = JSON.stringify(canonicalize(value, new Set()));
  } catch (error) {
    throw new TaskAdmissionInputError(
      error instanceof Error ? error.message : `${label} must contain JSON-compatible values`,
    );
  }
  if (typeof canonical !== "string") {
    throw new TaskAdmissionInputError(`${label} must contain JSON-compatible values`);
  }
  if (canonical.length > MAX_CANONICAL_PAYLOAD_LENGTH) {
    throw new TaskAdmissionInputError(`${label} is too large`);
  }
  return canonical;
}

function canonicalize(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("task numbers must be finite");
    return value;
  }
  if (value === undefined) return undefined;
  if (typeof value !== "object") {
    throw new Error("task must contain only JSON-compatible values");
  }
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error("task contains an invalid date");
    return value.toJSON();
  }
  if (ancestors.has(value)) throw new Error("task must not contain cyclic values");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => {
        if (entry === undefined) return null;
        return canonicalize(entry, ancestors);
      });
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("task must contain plain objects");
    }
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry === undefined) continue;
      sorted[key] = canonicalize(entry, ancestors);
    }
    return sorted;
  } finally {
    ancestors.delete(value);
  }
}
