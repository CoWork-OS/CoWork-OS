import type Database from "better-sqlite3";
import type { Task, TaskStatus } from "../../shared/types";
import type {
  BrowserGitMutationIntent,
  BrowserGitMutationReceipt,
  BrowserGitMutationResult,
} from "../../shared/host-api/git";
import { TaskEventRepository, TaskStore } from "./repositories";

/**
 * Browser-host stores (async SQLite migration plan, DB7): idempotent task admission and the
 * durable receipts for browser task cancellation and selected-file Git mutations. They run
 * only as storage-domain units behind the async facades in `repository-facades.ts`: in the
 * database worker when storage is routed there, in one host transaction otherwise.
 */
export type TaskAdmissionInput = Omit<
  Task,
  "id" | "createdAt" | "updatedAt" | "status" | "resumeStrategy"
> & { resumeStrategy: NonNullable<Task["resumeStrategy"]> };

export interface TaskAdmissionMediaMetadata {
  taskId: string;
  messageId: string;
  queuedAttachmentRefs: Array<{
    key: string;
    mimeType: string;
    filename?: string;
    sizeBytes: number;
  }>;
}

export type TaskAdmissionStoreOutcome =
  | { kind: "created" | "replayed"; task: Task; createdAt: number }
  | { kind: "payload_conflict" | "task_missing"; taskId: string; createdAt: number };

export interface TaskAdmissionReceiptLookup {
  operationKey: string;
  payloadHash: string;
  taskId: string;
  createdAt: number;
  task: Task | null;
}

/**
 * Atomically creates a recoverable queued task and its idempotency receipt. This store
 * runs only inside a storage transaction unit, on either the host connection or worker.
 */
export class TaskAdmissionStore {
  private readonly taskStore: TaskStore;

  constructor(private readonly db: Database.Database) {
    this.taskStore = new TaskStore(db);
  }

  admit(
    operationKey: string,
    payloadHash: string,
    input: TaskAdmissionInput,
    media?: TaskAdmissionMediaMetadata,
  ): TaskAdmissionStoreOutcome {
    const normalizedOperationKey = this.requireOperationKey(operationKey);
    const normalizedPayloadHash = this.requirePayloadHash(payloadHash);
    const receipt = this.db
      .prepare(
        `SELECT operation_key, payload_hash, task_id, created_at
         FROM task_admission_receipts WHERE operation_key = ?`,
      )
      .get(normalizedOperationKey) as Any;

    if (receipt) {
      const taskId = String(receipt.task_id ?? "");
      const createdAt = Number(receipt.created_at ?? 0);
      if (receipt.payload_hash !== normalizedPayloadHash) {
        return { kind: "payload_conflict", taskId, createdAt };
      }
      const task = this.taskStore.findById(taskId);
      if (!task) return { kind: "task_missing", taskId, createdAt };
      return { kind: "replayed", task, createdAt };
    }

    const normalizedMedia = media === undefined ? undefined : this.validateMedia(media);
    const createdTask = this.taskStore.create({
      ...input,
      status: "queued",
      ...(normalizedMedia ? { id: normalizedMedia.taskId } : {}),
    });
    const sessionId =
      typeof input.sessionId === "string" && input.sessionId.trim()
        ? input.sessionId.trim()
        : createdTask.id;
    const lineage: Partial<Task> = {
      sessionId,
      resumeStrategy: input.resumeStrategy,
      ...(input.boardColumn !== undefined ? { boardColumn: input.boardColumn } : {}),
    };
    if (input.branchFromTaskId !== undefined) lineage.branchFromTaskId = input.branchFromTaskId;
    if (input.branchFromEventId !== undefined) lineage.branchFromEventId = input.branchFromEventId;
    if (input.branchLabel !== undefined) lineage.branchLabel = input.branchLabel;

    // TaskStore.create does not include session lineage columns in its initial INSERT.
    // Persist lineage before inserting the receipt, in this same transaction, so queued
    // startup recovery sees the complete task record after any crash boundary.
    // TaskStore's usage-projector hooks only invalidate caches and schedule asynchronous
    // refresh/backfill work. The host transaction unit commits before that work can read;
    // worker execution has no initialized host projector. The projection remains derived
    // and is rebuilt from committed task rows, rather than being part of this receipt.
    this.taskStore.update(createdTask.id, lineage);
    const task = this.taskStore.findById(createdTask.id);
    if (!task) throw new Error("admitted task disappeared before its receipt was written");

    if (normalizedMedia) {
      new TaskEventRepository(this.db).create({
        taskId: task.id,
        timestamp: Date.now(),
        type: "task_created",
        payload: {
          task,
          browserInitialAttachmentMessageId: normalizedMedia.messageId,
          queuedAttachmentRefs: normalizedMedia.queuedAttachmentRefs,
        },
        schemaVersion: 2,
        actor: "system",
      });
    }

    this.db
      .prepare(
        `INSERT INTO task_admission_receipts (operation_key, payload_hash, task_id, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(normalizedOperationKey, normalizedPayloadHash, task.id, task.createdAt);

    return { kind: "created", task, createdAt: task.createdAt };
  }

  private requireTaskId(value: string): string {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)
    ) {
      throw new Error("Task admission media task id is invalid.");
    }
    return normalized;
  }

  private validateMedia(media: TaskAdmissionMediaMetadata): TaskAdmissionMediaMetadata {
    const taskId = this.requireTaskId(media.taskId);
    const messageId = typeof media.messageId === "string" ? media.messageId.trim() : "";
    if (!messageId || messageId.length > 200) {
      throw new Error("Task admission media message id is invalid.");
    }
    if (
      !Array.isArray(media.queuedAttachmentRefs) ||
      media.queuedAttachmentRefs.length < 1 ||
      media.queuedAttachmentRefs.length > 5
    ) {
      throw new Error("Task admission attachment references are invalid.");
    }
    const allowedMimeTypes = new Set([
      "image/jpeg",
      "image/png",
      "image/gif",
      "image/webp",
      "video/mp4",
      "video/quicktime",
      "video/webm",
    ]);
    const queuedAttachmentRefs = media.queuedAttachmentRefs.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error("Task admission attachment reference is invalid.");
      }
      const record = entry as Record<string, unknown>;
      const allowedKeys = new Set(["key", "mimeType", "filename", "sizeBytes"]);
      if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
        throw new Error("Task admission attachment reference has unsupported fields.");
      }
      if (
        typeof record.key !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.key)
      ) {
        throw new Error("Task admission attachment key is invalid.");
      }
      if (typeof record.mimeType !== "string" || !allowedMimeTypes.has(record.mimeType)) {
        throw new Error("Task admission attachment type is invalid.");
      }
      if (
        typeof record.sizeBytes !== "number" ||
        !Number.isSafeInteger(record.sizeBytes) ||
        record.sizeBytes <= 0 ||
        record.sizeBytes > 500 * 1024 * 1024
      ) {
        throw new Error("Task admission attachment size is invalid.");
      }
      if (
        record.filename !== undefined &&
        (typeof record.filename !== "string" ||
          record.filename.length < 1 ||
          record.filename.length > 255 ||
          /[\\/\0]/.test(record.filename))
      ) {
        throw new Error("Task admission attachment filename is invalid.");
      }
      return {
        key: record.key,
        mimeType: record.mimeType,
        ...(typeof record.filename === "string" ? { filename: record.filename } : {}),
        sizeBytes: record.sizeBytes,
      };
    });
    return { taskId, messageId, queuedAttachmentRefs };
  }

  findByOperationKey(operationKey: string): TaskAdmissionReceiptLookup | undefined {
    const normalizedOperationKey = this.requireOperationKey(operationKey);
    const receipt = this.db
      .prepare(
        `SELECT operation_key, payload_hash, task_id, created_at
         FROM task_admission_receipts WHERE operation_key = ?`,
      )
      .get(normalizedOperationKey) as Any;
    if (!receipt) return undefined;

    const taskId = String(receipt.task_id ?? "");
    return {
      operationKey: String(receipt.operation_key ?? normalizedOperationKey),
      payloadHash: String(receipt.payload_hash ?? ""),
      taskId,
      createdAt: Number(receipt.created_at ?? 0),
      task: this.taskStore.findById(taskId) ?? null,
    };
  }

  private requireOperationKey(value: string): string {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (!normalized || normalized.length > 200) {
      throw new Error("operationKey must contain 1..200 characters");
    }
    return normalized;
  }

  private requirePayloadHash(value: string): string {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) {
      throw new Error("payloadHash must be a SHA-256 hex digest");
    }
    return value.toLowerCase();
  }
}

export interface BrowserTaskCancelReceipt {
  fingerprint: string;
  taskId: string;
  workspaceId: string;
  expectedStatus: TaskStatus;
  expectedUpdatedAt: number;
  state: "pending" | "completed";
  result?: {
    taskId: string;
    workspaceId: string;
    operationKey: string;
    outcome: "observed_terminal" | "pending";
    status: TaskStatus;
    updatedAt: number;
  };
}

/** A small durable intent/result store for browser task cancellation. */
export class BrowserTaskCancelReceiptStore {
  constructor(private readonly db: Database.Database) {}

  reserve(
    scopedKey: string,
    fingerprint: string,
    taskId: string,
    workspaceId: string,
    expectedStatus: TaskStatus,
    expectedUpdatedAt: number,
  ): { created: boolean; receipt: BrowserTaskCancelReceipt } {
    this.validateKey(scopedKey);
    this.validateKey(fingerprint);
    if (!taskId || taskId.length > 128 || !workspaceId || workspaceId.length > 128) {
      throw new Error("Invalid browser cancellation scope");
    }
    if (!Number.isSafeInteger(expectedUpdatedAt) || expectedUpdatedAt < 0) {
      throw new Error("Invalid browser cancellation revision");
    }
    const existing = this.get(scopedKey);
    if (existing) return { created: false, receipt: existing };
    const now = Date.now();
    const inserted = this.db
      .prepare(
        `INSERT OR IGNORE INTO browser_task_cancel_receipts
         (scoped_key, fingerprint, task_id, workspace_id, expected_status, expected_updated_at, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        scopedKey,
        fingerprint,
        taskId,
        workspaceId,
        expectedStatus,
        expectedUpdatedAt,
        now,
        now,
      );
    const receipt = this.get(scopedKey);
    if (!receipt) throw new Error("Browser cancellation receipt was not reserved");
    return {
      created: inserted.changes === 1,
      receipt,
    };
  }

  complete(scopedKey: string, result: NonNullable<BrowserTaskCancelReceipt["result"]>): void {
    this.validateKey(scopedKey);
    if (!result || JSON.stringify(result).length > 2_048) {
      throw new Error("Invalid browser cancellation result");
    }
    const receipt = this.get(scopedKey);
    if (!receipt) throw new Error("Browser cancellation receipt is missing");
    if (receipt.state === "completed") return;
    if (receipt.taskId !== result.taskId || receipt.workspaceId !== result.workspaceId) {
      throw new Error("Browser cancellation result scope mismatch");
    }
    const updated = this.db
      .prepare(
        `UPDATE browser_task_cancel_receipts
         SET state = 'completed', result_json = ?, updated_at = ?
         WHERE scoped_key = ? AND state = 'pending'`,
      )
      .run(JSON.stringify(result), Date.now(), scopedKey);
    if (updated.changes !== 1 && this.get(scopedKey)?.state !== "completed") {
      throw new Error("Browser cancellation receipt was not completed");
    }
  }

  get(scopedKey: string): BrowserTaskCancelReceipt | null {
    this.validateKey(scopedKey);
    const row = this.db
      .prepare(
        `SELECT fingerprint, task_id, workspace_id, expected_status, expected_updated_at, state, result_json
         FROM browser_task_cancel_receipts WHERE scoped_key = ?`,
      )
      .get(scopedKey) as Any;
    if (!row) return null;
    return {
      fingerprint: String(row.fingerprint),
      taskId: String(row.task_id),
      workspaceId: String(row.workspace_id),
      expectedStatus: row.expected_status as TaskStatus,
      expectedUpdatedAt: Number(row.expected_updated_at),
      state: row.state as "pending" | "completed",
      ...(row.result_json
        ? { result: JSON.parse(String(row.result_json)) as BrowserTaskCancelReceipt["result"] }
        : {}),
    };
  }

  private validateKey(value: string): void {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) {
      throw new Error("Browser cancellation key must be a SHA-256 digest");
    }
  }
}

/** Durable operation-key receipts for selected-file browser Git mutations. */
export class BrowserGitMutationReceiptStore {
  constructor(private readonly db: Database.Database) {}

  reserve(
    scopedKey: string,
    fingerprint: string,
    intent: BrowserGitMutationIntent,
  ): { created: boolean; receipt: BrowserGitMutationReceipt } {
    this.validateDigest(scopedKey, "scope key");
    this.validateDigest(fingerprint, "fingerprint");
    if (!intent || JSON.stringify(intent).length > 16_384) {
      throw new Error("Invalid browser Git mutation intent");
    }
    if (!intent.workspaceId || intent.workspaceId.length > 128) {
      throw new Error("Invalid browser Git workspace");
    }
    if (!/^[a-f0-9]{64}$/i.test(intent.expectedRevision)) {
      throw new Error("Invalid browser Git revision");
    }
    if (intent.expectedHead !== null && !/^[a-f0-9]{40,64}$/i.test(intent.expectedHead)) {
      throw new Error("Invalid browser Git HEAD");
    }
    if (intent.expectedTree && !/^[a-f0-9]{40,64}$/i.test(intent.expectedTree)) {
      throw new Error("Invalid browser Git tree");
    }
    const now = Date.now();
    const inserted = this.db
      .prepare(
        `INSERT OR IGNORE INTO browser_git_mutation_receipts
         (scoped_key, fingerprint, intent_json, state, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', ?, ?)`,
      )
      .run(scopedKey, fingerprint.toLowerCase(), JSON.stringify(intent), now, now);
    const receipt = this.get(scopedKey);
    if (!receipt) throw new Error("Browser Git mutation receipt was not reserved");
    return { created: inserted.changes === 1, receipt };
  }

  complete(scopedKey: string, result: BrowserGitMutationResult): void {
    this.validateDigest(scopedKey, "scope key");
    if (!result || JSON.stringify(result).length > 4_096) {
      throw new Error("Invalid browser Git mutation result");
    }
    const receipt = this.get(scopedKey);
    if (!receipt) throw new Error("Browser Git mutation receipt is missing");
    if (receipt.state === "completed") return;
    if (
      receipt.intent.workspaceId !== result.workspaceId ||
      receipt.intent.action !== result.action
    ) {
      throw new Error("Browser Git mutation result scope mismatch");
    }
    const updated = this.db
      .prepare(
        `UPDATE browser_git_mutation_receipts
         SET state = 'completed', result_json = ?, updated_at = ?
         WHERE scoped_key = ? AND state = 'pending'`,
      )
      .run(JSON.stringify(result), Date.now(), scopedKey);
    if (updated.changes !== 1 && this.get(scopedKey)?.state !== "completed") {
      throw new Error("Browser Git mutation receipt was not completed");
    }
  }

  get(scopedKey: string): BrowserGitMutationReceipt | null {
    this.validateDigest(scopedKey, "scope key");
    const row = this.db
      .prepare(
        `SELECT fingerprint, intent_json, state, result_json
         FROM browser_git_mutation_receipts WHERE scoped_key = ?`,
      )
      .get(scopedKey) as Any;
    if (!row) return null;
    return {
      fingerprint: String(row.fingerprint),
      intent: JSON.parse(String(row.intent_json)) as BrowserGitMutationIntent,
      state: row.state as "pending" | "completed",
      ...(row.result_json
        ? { result: JSON.parse(String(row.result_json)) as BrowserGitMutationResult }
        : {}),
    };
  }

  private validateDigest(value: string, label: string): void {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) {
      throw new Error(`Browser Git ${label} must be a SHA-256 digest`);
    }
  }
}
