import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import type {
  ArtifactRevision,
  ArtifactRevisionStatus,
  ConstraintLedger,
  ConstraintLedgerEntry,
  ConstraintLedgerEntryKind,
  ConstraintLedgerEntryStatus,
  EvidenceManifest,
  EvidenceManifestEntry,
  EvidenceManifestEntryStatus,
  EvidenceManifestSourceType,
  OutcomeContract,
  OutcomeContractRequirement,
  OutcomeContractRequirementKind,
  OutcomeContractRequirementStatus,
  OutcomeContractStatus,
  WaitState,
  WaitStateKind,
  WaitStateStatus,
  WorkSessionChildAggregate,
  WorkSessionChildLink,
  WorkSessionChildOutcome,
  WorkSessionChildStatus,
  WorkSessionActor,
  WorkSessionContractAggregate,
} from "../../shared/types";
import { redactWorkSessionValue } from "./WorkSessionProtocolRepository";

type DbRow = Record<string, unknown>;

const MAX_TEXT_LENGTH = 16_000;
const MAX_OBJECTIVE_LENGTH = 8_000;
const MAX_REQUIREMENTS = 100;
const MAX_CONSTRAINTS = 500;
const MAX_EVIDENCE = 1_000;
const MAX_METADATA_DEPTH = 8;

const OUTCOME_STATUSES = new Set<OutcomeContractStatus>([
  "pending",
  "satisfied",
  "partial",
  "unmet",
  "waived",
]);
const REQUIREMENT_KINDS = new Set<OutcomeContractRequirementKind>([
  "objective",
  "output",
  "verification",
  "criterion",
]);
const REQUIREMENT_STATUSES = new Set<OutcomeContractRequirementStatus>([
  "pending",
  "satisfied",
  "failed",
  "waived",
]);
const CONSTRAINT_KINDS = new Set<ConstraintLedgerEntryKind>([
  "constraint",
  "decision",
  "assumption",
  "requirement",
  "waiver",
]);
const CONSTRAINT_STATUSES = new Set<ConstraintLedgerEntryStatus>([
  "active",
  "satisfied",
  "violated",
  "superseded",
]);
const EVIDENCE_STATUSES = new Set<EvidenceManifestEntryStatus>([
  "supporting",
  "contradicting",
  "neutral",
  "stale",
]);
const ARTIFACT_STATUSES = new Set<ArtifactRevisionStatus>([
  "draft",
  "committed",
  "superseded",
  "retracted",
]);
const WAIT_KINDS = new Set<WaitStateKind>([
  "approval",
  "input",
  "reconnect",
  "paused",
  "child",
  "external",
]);
const WAIT_STATUSES = new Set<WaitStateStatus>(["pending", "resolved", "expired", "cancelled"]);
const CHILD_STATUSES = new Set<WorkSessionChildStatus>([
  "pending",
  "running",
  "completed",
  "partial",
  "failed",
  "cancelled",
]);
const CHILD_OUTCOMES = new Set<WorkSessionChildOutcome>(["complete", "partial", "failed"]);

function requiredId(value: unknown, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new Error(`${label} is required`);
  return normalized.slice(0, 256);
}

function optionalText(value: unknown, max = MAX_TEXT_LENGTH): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, max) : undefined;
}

function optionalId(value: unknown): string | undefined {
  return optionalText(value, 256);
}

function boundedNumber(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clampConfidence(value: unknown): number {
  return Math.min(1, Math.max(0, boundedNumber(value, 0.5)));
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function sanitizeMetadata(value: unknown, depth = 0): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (depth >= MAX_METADATA_DEPTH) return { value: "[depth-limited]" };
  const redacted = redactWorkSessionValue(value) as Record<string, unknown>;
  return redacted && typeof redacted === "object" && !Array.isArray(redacted)
    ? redacted
    : undefined;
}

function stableCanonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableCanonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableCanonicalize(nested)]),
    );
  }
  return value;
}

function stableChecksum(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stableCanonicalize(value)))
    .digest("hex");
}

function normalizeOutcomeStatus(value: unknown): OutcomeContractStatus {
  const status = typeof value === "string" ? value : "";
  return OUTCOME_STATUSES.has(status as OutcomeContractStatus)
    ? (status as OutcomeContractStatus)
    : "pending";
}

function normalizeRequirementKind(value: unknown): OutcomeContractRequirementKind {
  const kind = typeof value === "string" ? value : "";
  return REQUIREMENT_KINDS.has(kind as OutcomeContractRequirementKind)
    ? (kind as OutcomeContractRequirementKind)
    : "criterion";
}

function normalizeRequirementStatus(value: unknown): OutcomeContractRequirementStatus {
  const status = typeof value === "string" ? value : "";
  return REQUIREMENT_STATUSES.has(status as OutcomeContractRequirementStatus)
    ? (status as OutcomeContractRequirementStatus)
    : "pending";
}

function normalizeConstraintKind(value: unknown): ConstraintLedgerEntryKind {
  const kind = typeof value === "string" ? value : "";
  return CONSTRAINT_KINDS.has(kind as ConstraintLedgerEntryKind)
    ? (kind as ConstraintLedgerEntryKind)
    : "constraint";
}

function normalizeConstraintStatus(value: unknown): ConstraintLedgerEntryStatus {
  const status = typeof value === "string" ? value : "";
  return CONSTRAINT_STATUSES.has(status as ConstraintLedgerEntryStatus)
    ? (status as ConstraintLedgerEntryStatus)
    : "active";
}

function normalizeEvidenceStatus(value: unknown): EvidenceManifestEntryStatus {
  const status = typeof value === "string" ? value : "";
  return EVIDENCE_STATUSES.has(status as EvidenceManifestEntryStatus)
    ? (status as EvidenceManifestEntryStatus)
    : "supporting";
}

function normalizeArtifactStatus(value: unknown): ArtifactRevisionStatus {
  const status = typeof value === "string" ? value : "";
  return ARTIFACT_STATUSES.has(status as ArtifactRevisionStatus)
    ? (status as ArtifactRevisionStatus)
    : "committed";
}

function normalizeWaitKind(value: unknown): WaitStateKind {
  const kind = typeof value === "string" ? value : "";
  return WAIT_KINDS.has(kind as WaitStateKind) ? (kind as WaitStateKind) : "external";
}

function normalizeWaitStatus(value: unknown): WaitStateStatus {
  const status = typeof value === "string" ? value : "";
  return WAIT_STATUSES.has(status as WaitStateStatus) ? (status as WaitStateStatus) : "pending";
}

function normalizeChildStatus(value: unknown): WorkSessionChildStatus {
  const status = typeof value === "string" ? value : "";
  return CHILD_STATUSES.has(status as WorkSessionChildStatus)
    ? (status as WorkSessionChildStatus)
    : "pending";
}

function normalizeChildOutcome(value: unknown): WorkSessionChildOutcome | undefined {
  const outcome = typeof value === "string" ? value : "";
  return CHILD_OUTCOMES.has(outcome as WorkSessionChildOutcome)
    ? (outcome as WorkSessionChildOutcome)
    : undefined;
}

export interface OutcomeContractRequirementInput {
  id?: string;
  kind?: OutcomeContractRequirementKind;
  description: string;
  required?: boolean;
  verifier?: string;
  status?: OutcomeContractRequirementStatus;
  evidenceIds?: string[];
}

export interface CreateOutcomeContractInput {
  sessionId: string;
  taskId?: string;
  objective: string;
  requirements?: OutcomeContractRequirementInput[];
  source?: string;
  version?: number;
  idempotencyKey?: string;
}

export interface UpdateOutcomeContractInput {
  status?: OutcomeContractStatus;
  summary?: string;
  requirements?: OutcomeContractRequirement[];
  satisfiedAt?: number | null;
}

export interface ConstraintLedgerEntryInput {
  sessionId: string;
  turnId?: string;
  kind: ConstraintLedgerEntryKind;
  key: string;
  statement: string;
  status?: ConstraintLedgerEntryStatus;
  sourceItemId?: string;
  owner?: string;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface EvidenceManifestEntryInput {
  sessionId: string;
  contractId?: string;
  claim: string;
  sourceType: EvidenceManifestSourceType;
  sourceRef: string;
  snippet?: string;
  capturedAt?: number;
  freshnessExpiresAt?: number;
  confidence?: number;
  status?: EvidenceManifestEntryStatus;
  contradictionGroup?: string;
  itemId?: string;
  artifactRevisionId?: string;
  idempotencyKey?: string;
}

export interface ArtifactRevisionInput {
  sessionId: string;
  taskId: string;
  artifactId?: string;
  path: string;
  mimeType: string;
  sha256: string;
  size?: number;
  parentRevisionId?: string;
  revision?: number;
  status?: ArtifactRevisionStatus;
  createdBy?: WorkSessionActor | string;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface WaitStateInput {
  sessionId: string;
  taskId: string;
  turnId?: string;
  kind: WaitStateKind;
  requestId?: string;
  reason: string;
  resumeToken?: string;
  payload?: Record<string, unknown>;
  expiresAt?: number;
  idempotencyKey?: string;
}

export interface ChildSessionLinkInput {
  parentSessionId: string;
  childSessionId: string;
  parentTaskId: string;
  childTaskId: string;
  owner?: string;
  isolationKey?: string;
  inheritedPolicySnapshot?: Record<string, unknown>;
  status?: WorkSessionChildStatus;
}

export interface WorkSessionContractRepositoryOptions {
  now?: () => number;
}

export class WorkSessionContractRepository {
  private readonly now: () => number;

  constructor(
    private readonly db: Database.Database,
    options: WorkSessionContractRepositoryOptions = {},
  ) {
    this.now = options.now || (() => Date.now());
  }

  createOutcomeContract(input: CreateOutcomeContractInput): OutcomeContract {
    const sessionId = requiredId(input.sessionId, "sessionId");
    const version = Math.max(1, Math.floor(boundedNumber(input.version, 1)));
    const existing = input.idempotencyKey
      ? this.findOutcomeContractByIdempotency(sessionId, input.idempotencyKey)
      : undefined;
    if (existing) return existing;
    const byVersion = this.findOutcomeContract(sessionId, version);
    if (byVersion) return byVersion;

    const objective =
      optionalText(input.objective, MAX_OBJECTIVE_LENGTH) || "Work session objective";
    const requirements = this.normalizeRequirements(input.requirements);
    const id = randomUUID();
    const now = this.now();
    try {
      this.db
        .prepare(
          `
            INSERT INTO work_session_outcome_contracts (
              id, session_id, task_id, version, objective, requirements_json,
              status, source, summary, created_at, updated_at, satisfied_at, idempotency_key
            ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL, ?, ?, NULL, ?)
          `,
        )
        .run(
          id,
          sessionId,
          optionalId(input.taskId) || null,
          version,
          objective,
          JSON.stringify(requirements),
          optionalText(input.source) || null,
          now,
          now,
          optionalId(input.idempotencyKey) || null,
        );
    } catch (error) {
      const retry = input.idempotencyKey
        ? this.findOutcomeContractByIdempotency(sessionId, input.idempotencyKey)
        : this.findOutcomeContract(sessionId, version);
      if (retry) return retry;
      throw error;
    }
    return this.findOutcomeContractById(id)!;
  }

  findOutcomeContract(sessionId: string, version?: number): OutcomeContract | undefined {
    const normalizedSessionId = requiredId(sessionId, "sessionId");
    const row =
      version === undefined
        ? this.db
            .prepare(
              `SELECT * FROM work_session_outcome_contracts
             WHERE session_id = ? ORDER BY version DESC LIMIT 1`,
            )
            .get(normalizedSessionId)
        : this.db
            .prepare(
              "SELECT * FROM work_session_outcome_contracts WHERE session_id = ? AND version = ?",
            )
            .get(normalizedSessionId, Math.max(1, Math.floor(version)));
    return row ? this.mapOutcomeContract(row as DbRow) : undefined;
  }

  listOutcomeContracts(sessionId: string): OutcomeContract[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM work_session_outcome_contracts WHERE session_id = ? ORDER BY version ASC",
      )
      .all(requiredId(sessionId, "sessionId")) as DbRow[];
    return rows.map((row) => this.mapOutcomeContract(row));
  }

  updateOutcomeContract(id: string, input: UpdateOutcomeContractInput): OutcomeContract {
    const normalizedId = requiredId(id, "contractId");
    const existing = this.findOutcomeContractById(normalizedId);
    if (!existing) throw new Error(`Outcome contract not found: ${normalizedId}`);
    const nextStatus = input.status ? normalizeOutcomeStatus(input.status) : existing.status;
    const requirements = input.requirements || existing.requirements;
    const summary = input.summary === undefined ? existing.summary : optionalText(input.summary);
    const satisfiedAt =
      input.satisfiedAt === undefined
        ? existing.satisfiedAt
        : input.satisfiedAt === null
          ? undefined
          : Math.max(0, Math.floor(boundedNumber(input.satisfiedAt, this.now())));
    this.db
      .prepare(
        `UPDATE work_session_outcome_contracts
         SET requirements_json = ?, status = ?, summary = ?, updated_at = ?, satisfied_at = ?
         WHERE id = ?`,
      )
      .run(
        JSON.stringify(this.normalizeRequirements(requirements)),
        nextStatus,
        summary || null,
        this.now(),
        satisfiedAt ?? null,
        normalizedId,
      );
    return this.findOutcomeContractById(normalizedId)!;
  }

  appendConstraint(input: ConstraintLedgerEntryInput): ConstraintLedgerEntry {
    const sessionId = requiredId(input.sessionId, "sessionId");
    const idempotencyKey = optionalId(input.idempotencyKey);
    if (idempotencyKey) {
      const existing = this.findConstraintByIdempotency(sessionId, idempotencyKey);
      if (existing) return existing;
    }
    const key = optionalText(input.key, 256) || "constraint";
    const statement = optionalText(input.statement) || key;
    const now = this.now();
    const id = randomUUID();
    try {
      this.db
        .prepare(
          `
            INSERT INTO work_session_constraints (
              id, session_id, turn_id, kind, key, statement, status, source_item_id,
              owner, metadata_json, idempotency_key, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          id,
          sessionId,
          optionalId(input.turnId) || null,
          normalizeConstraintKind(input.kind),
          key,
          statement,
          normalizeConstraintStatus(input.status),
          optionalId(input.sourceItemId) || null,
          optionalText(input.owner, 256) || null,
          input.metadata ? JSON.stringify(sanitizeMetadata(input.metadata)) : null,
          idempotencyKey || null,
          now,
          now,
        );
    } catch (error) {
      if (idempotencyKey) {
        const retry = this.findConstraintByIdempotency(sessionId, idempotencyKey);
        if (retry) return retry;
      }
      throw error;
    }
    return this.findConstraintById(id)!;
  }

  updateConstraint(
    id: string,
    updates: Partial<Pick<ConstraintLedgerEntry, "status" | "statement" | "owner" | "metadata">>,
  ): ConstraintLedgerEntry {
    const normalizedId = requiredId(id, "constraintId");
    const existing = this.findConstraintById(normalizedId);
    if (!existing) throw new Error(`Constraint not found: ${normalizedId}`);
    this.db
      .prepare(
        `UPDATE work_session_constraints
         SET status = ?, statement = ?, owner = ?, metadata_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        updates.status ? normalizeConstraintStatus(updates.status) : existing.status,
        updates.statement === undefined
          ? existing.statement
          : optionalText(updates.statement) || existing.statement,
        updates.owner === undefined
          ? existing.owner || null
          : optionalText(updates.owner, 256) || null,
        updates.metadata === undefined
          ? existing.metadata
            ? JSON.stringify(sanitizeMetadata(existing.metadata))
            : null
          : JSON.stringify(sanitizeMetadata(updates.metadata)),
        this.now(),
        normalizedId,
      );
    return this.findConstraintById(normalizedId)!;
  }

  listConstraints(
    sessionId: string,
    options?: { status?: ConstraintLedgerEntryStatus },
  ): ConstraintLedgerEntry[] {
    const normalizedSessionId = requiredId(sessionId, "sessionId");
    const rows = options?.status
      ? this.db
          .prepare(
            "SELECT * FROM work_session_constraints WHERE session_id = ? AND status = ? ORDER BY created_at ASC, id ASC",
          )
          .all(normalizedSessionId, normalizeConstraintStatus(options.status))
      : this.db
          .prepare(
            "SELECT * FROM work_session_constraints WHERE session_id = ? ORDER BY created_at ASC, id ASC",
          )
          .all(normalizedSessionId);
    return (rows as DbRow[]).slice(0, MAX_CONSTRAINTS).map((row) => this.mapConstraint(row));
  }

  getConstraintLedger(sessionId: string): ConstraintLedger {
    const entries = this.listConstraints(sessionId);
    return {
      sessionId: requiredId(sessionId, "sessionId"),
      entries,
      checksum: stableChecksum(entries),
    };
  }

  appendEvidence(input: EvidenceManifestEntryInput): EvidenceManifestEntry {
    const sessionId = requiredId(input.sessionId, "sessionId");
    const idempotencyKey = optionalId(input.idempotencyKey);
    if (idempotencyKey) {
      const existing = this.findEvidenceByIdempotency(sessionId, idempotencyKey);
      if (existing) return existing;
    }
    const claim = optionalText(input.claim, 4_000) || "Evidence claim";
    const sourceRef = optionalText(input.sourceRef, 4_000) || "unknown";
    const capturedAt = Math.max(0, Math.floor(boundedNumber(input.capturedAt, this.now())));
    const freshnessExpiresAt =
      input.freshnessExpiresAt === undefined
        ? undefined
        : Math.max(0, Math.floor(boundedNumber(input.freshnessExpiresAt, capturedAt)));
    const requestedStatus = normalizeEvidenceStatus(input.status);
    const status =
      freshnessExpiresAt !== undefined && freshnessExpiresAt <= this.now()
        ? "stale"
        : requestedStatus;
    const id = randomUUID();
    try {
      this.db
        .prepare(
          `
            INSERT INTO work_session_evidence (
              id, session_id, contract_id, claim, source_type, source_ref, snippet,
              captured_at, freshness_expires_at, confidence, status, contradiction_group,
              item_id, artifact_revision_id, idempotency_key, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          id,
          sessionId,
          optionalId(input.contractId) || null,
          claim,
          optionalText(input.sourceType, 128) || "other",
          sourceRef,
          optionalText(input.snippet, 8_000) || null,
          capturedAt,
          freshnessExpiresAt ?? null,
          clampConfidence(input.confidence),
          status,
          optionalText(input.contradictionGroup, 256) || null,
          optionalId(input.itemId) || null,
          optionalId(input.artifactRevisionId) || null,
          idempotencyKey || null,
          this.now(),
        );
    } catch (error) {
      if (idempotencyKey) {
        const retry = this.findEvidenceByIdempotency(sessionId, idempotencyKey);
        if (retry) return retry;
      }
      throw error;
    }
    return this.findEvidenceById(id)!;
  }

  listEvidence(
    sessionId: string,
    options?: { contractId?: string; claim?: string },
  ): EvidenceManifestEntry[] {
    const normalizedSessionId = requiredId(sessionId, "sessionId");
    let rows: DbRow[];
    if (options?.contractId) {
      rows = this.db
        .prepare(
          "SELECT * FROM work_session_evidence WHERE session_id = ? AND contract_id = ? ORDER BY captured_at ASC, id ASC",
        )
        .all(normalizedSessionId, requiredId(options.contractId, "contractId")) as DbRow[];
    } else if (options?.claim) {
      rows = this.db
        .prepare(
          "SELECT * FROM work_session_evidence WHERE session_id = ? AND claim = ? ORDER BY captured_at ASC, id ASC",
        )
        .all(normalizedSessionId, optionalText(options.claim, 4_000) || "") as DbRow[];
    } else {
      rows = this.db
        .prepare(
          "SELECT * FROM work_session_evidence WHERE session_id = ? ORDER BY captured_at ASC, id ASC",
        )
        .all(normalizedSessionId) as DbRow[];
    }
    return rows.slice(0, MAX_EVIDENCE).map((row) => this.mapEvidence(row));
  }

  getEvidenceManifest(sessionId: string): EvidenceManifest {
    const entries = this.listEvidence(sessionId);
    return {
      sessionId: requiredId(sessionId, "sessionId"),
      entries,
      checksum: stableChecksum(entries),
    };
  }

  createArtifactRevision(input: ArtifactRevisionInput): ArtifactRevision {
    const sessionId = requiredId(input.sessionId, "sessionId");
    const taskId = requiredId(input.taskId, "taskId");
    const path = requiredId(input.path, "path");
    const idempotencyKey = optionalId(input.idempotencyKey);
    if (idempotencyKey) {
      const existing = this.findArtifactRevisionByIdempotency(sessionId, idempotencyKey);
      if (existing) return existing;
    }
    return this.db.transaction(() => {
      const latest = this.findLatestArtifactRevision(sessionId, path);
      const requestedRevision =
        input.revision === undefined
          ? (latest?.revision || 0) + 1
          : Math.max(1, Math.floor(boundedNumber(input.revision, 1)));
      const parentRevisionId = optionalId(input.parentRevisionId) || latest?.id || undefined;
      const id = randomUUID();
      const status = normalizeArtifactStatus(input.status);
      const now = this.now();
      try {
        this.db
          .prepare(
            `
              INSERT INTO work_session_artifact_revisions (
                id, session_id, task_id, artifact_id, revision, path, mime_type, sha256,
                size, parent_revision_id, status, created_by, metadata_json, idempotency_key, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
          )
          .run(
            id,
            sessionId,
            taskId,
            optionalId(input.artifactId) || null,
            requestedRevision,
            path,
            optionalText(input.mimeType, 256) || "application/octet-stream",
            optionalText(input.sha256, 256) || "",
            Math.max(0, Math.floor(boundedNumber(input.size, 0))),
            parentRevisionId || null,
            status,
            optionalText(input.createdBy, 256) || "agent",
            input.metadata ? JSON.stringify(sanitizeMetadata(input.metadata)) : null,
            idempotencyKey || null,
            now,
          );
      } catch (error) {
        if (idempotencyKey) {
          const retry = this.findArtifactRevisionByIdempotency(sessionId, idempotencyKey);
          if (retry) return retry;
        }
        throw error;
      }
      if (status === "committed") {
        this.db
          .prepare(
            `UPDATE work_session_artifact_revisions
             SET status = 'superseded'
             WHERE session_id = ? AND path = ? AND id <> ? AND status = 'committed'`,
          )
          .run(sessionId, path, id);
      }
      return this.findArtifactRevisionById(id)!;
    })();
  }

  listArtifactRevisions(
    sessionId: string,
    options?: { path?: string; taskId?: string },
  ): ArtifactRevision[] {
    const normalizedSessionId = requiredId(sessionId, "sessionId");
    let rows: DbRow[];
    if (options?.path) {
      rows = this.db
        .prepare(
          "SELECT * FROM work_session_artifact_revisions WHERE session_id = ? AND path = ? ORDER BY revision ASC",
        )
        .all(normalizedSessionId, requiredId(options.path, "path")) as DbRow[];
    } else if (options?.taskId) {
      rows = this.db
        .prepare(
          "SELECT * FROM work_session_artifact_revisions WHERE session_id = ? AND task_id = ? ORDER BY created_at ASC, id ASC",
        )
        .all(normalizedSessionId, requiredId(options.taskId, "taskId")) as DbRow[];
    } else {
      rows = this.db
        .prepare(
          "SELECT * FROM work_session_artifact_revisions WHERE session_id = ? ORDER BY created_at ASC, id ASC",
        )
        .all(normalizedSessionId) as DbRow[];
    }
    return rows.map((row) => this.mapArtifactRevision(row));
  }

  findLatestArtifactRevision(sessionId: string, path: string): ArtifactRevision | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM work_session_artifact_revisions
         WHERE session_id = ? AND path = ?
         ORDER BY revision DESC LIMIT 1`,
      )
      .get(requiredId(sessionId, "sessionId"), requiredId(path, "path")) as DbRow | undefined;
    return row ? this.mapArtifactRevision(row) : undefined;
  }

  createWaitState(input: WaitStateInput): WaitState {
    const sessionId = requiredId(input.sessionId, "sessionId");
    const taskId = requiredId(input.taskId, "taskId");
    const idempotencyKey = optionalId(input.idempotencyKey);
    const requestId = optionalId(input.requestId);
    const existing = requestId
      ? this.findWaitStateByRequest(sessionId, normalizeWaitKind(input.kind), requestId)
      : idempotencyKey
        ? this.findWaitStateByIdempotency(sessionId, idempotencyKey)
        : undefined;
    if (existing) return existing;
    const id = randomUUID();
    const now = this.now();
    try {
      this.db
        .prepare(
          `
            INSERT INTO work_session_wait_states (
              id, session_id, task_id, turn_id, kind, request_id, reason, status,
              resume_token, payload_json, idempotency_key, created_at, updated_at, resolved_at, expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, NULL, ?)
          `,
        )
        .run(
          id,
          sessionId,
          taskId,
          optionalId(input.turnId) || null,
          normalizeWaitKind(input.kind),
          requestId || null,
          optionalText(input.reason) || "Waiting for external input",
          optionalText(input.resumeToken, 512) || null,
          input.payload ? JSON.stringify(sanitizeMetadata(input.payload)) : null,
          idempotencyKey || null,
          now,
          now,
          input.expiresAt === undefined
            ? null
            : Math.max(0, Math.floor(boundedNumber(input.expiresAt, now))),
        );
    } catch (error) {
      const retry = requestId
        ? this.findWaitStateByRequest(sessionId, normalizeWaitKind(input.kind), requestId)
        : idempotencyKey
          ? this.findWaitStateByIdempotency(sessionId, idempotencyKey)
          : undefined;
      if (retry) return retry;
      throw error;
    }
    return this.findWaitStateById(id)!;
  }

  resolveWaitState(
    id: string,
    status: Extract<WaitStateStatus, "resolved" | "expired" | "cancelled">,
    payload?: Record<string, unknown>,
  ): WaitState {
    const normalizedId = requiredId(id, "waitStateId");
    const existing = this.findWaitStateById(normalizedId);
    if (!existing) throw new Error(`Wait state not found: ${normalizedId}`);
    if (existing.status !== "pending") return existing;
    const resolvedAt = this.now();
    this.db
      .prepare(
        `UPDATE work_session_wait_states
         SET status = ?, payload_json = ?, updated_at = ?, resolved_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(
        normalizeWaitStatus(status),
        payload
          ? JSON.stringify(sanitizeMetadata(payload))
          : existing.payload
            ? JSON.stringify(sanitizeMetadata(existing.payload))
            : null,
        resolvedAt,
        resolvedAt,
        normalizedId,
      );
    return this.findWaitStateById(normalizedId)!;
  }

  expireWaitStates(now = this.now()): number {
    const result = this.db
      .prepare(
        `UPDATE work_session_wait_states
         SET status = 'expired', updated_at = ?, resolved_at = ?
         WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?`,
      )
      .run(now, now, now);
    return Math.max(0, Number(result.changes || 0));
  }

  findWaitStateByRequest(
    sessionId: string,
    kind: WaitStateKind,
    requestId: string,
  ): WaitState | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM work_session_wait_states
         WHERE session_id = ? AND kind = ? AND request_id = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(
        requiredId(sessionId, "sessionId"),
        normalizeWaitKind(kind),
        requiredId(requestId, "requestId"),
      ) as DbRow | undefined;
    return row ? this.mapWaitState(row) : undefined;
  }

  listWaitStates(sessionId: string, options?: { status?: WaitStateStatus }): WaitState[] {
    const normalizedSessionId = requiredId(sessionId, "sessionId");
    const rows = options?.status
      ? this.db
          .prepare(
            "SELECT * FROM work_session_wait_states WHERE session_id = ? AND status = ? ORDER BY created_at ASC, id ASC",
          )
          .all(normalizedSessionId, normalizeWaitStatus(options.status))
      : this.db
          .prepare(
            "SELECT * FROM work_session_wait_states WHERE session_id = ? ORDER BY created_at ASC, id ASC",
          )
          .all(normalizedSessionId);
    return (rows as DbRow[]).map((row) => this.mapWaitState(row));
  }

  linkChildSession(input: ChildSessionLinkInput): WorkSessionChildLink {
    const parentSessionId = requiredId(input.parentSessionId, "parentSessionId");
    const childSessionId = requiredId(input.childSessionId, "childSessionId");
    const parentTaskId = requiredId(input.parentTaskId, "parentTaskId");
    const childTaskId = requiredId(input.childTaskId, "childTaskId");
    const existing = this.findChildSessionByTask(childTaskId);
    if (existing) {
      if (
        existing.parentSessionId !== parentSessionId ||
        existing.childSessionId !== childSessionId ||
        existing.parentTaskId !== parentTaskId
      ) {
        throw new Error(`Child task ${childTaskId} is already linked to another session`);
      }
      return existing;
    }
    const id = randomUUID();
    const now = this.now();
    try {
      this.db
        .prepare(
          `
            INSERT INTO work_session_child_links (
              id, parent_session_id, child_session_id, parent_task_id, child_task_id,
              owner, isolation_key, inherited_policy_snapshot_json, status, outcome,
              created_at, updated_at, completed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)
          `,
        )
        .run(
          id,
          parentSessionId,
          childSessionId,
          parentTaskId,
          childTaskId,
          optionalText(input.owner, 256) || null,
          optionalText(input.isolationKey, 512) || `session:${childSessionId}`,
          input.inheritedPolicySnapshot
            ? JSON.stringify(sanitizeMetadata(input.inheritedPolicySnapshot))
            : null,
          normalizeChildStatus(input.status),
          now,
          now,
        );
    } catch (error) {
      const retry = this.findChildSessionByTask(childTaskId);
      if (retry) return retry;
      throw error;
    }
    return this.findChildSessionById(id)!;
  }

  updateChildSession(
    id: string,
    updates: Partial<
      Pick<WorkSessionChildLink, "status" | "outcome" | "owner" | "inheritedPolicySnapshot">
    >,
  ): WorkSessionChildLink {
    const normalizedId = requiredId(id, "childLinkId");
    const existing = this.findChildSessionById(normalizedId);
    if (!existing) throw new Error(`Child session link not found: ${normalizedId}`);
    const status = updates.status ? normalizeChildStatus(updates.status) : existing.status;
    const outcome = updates.outcome ? normalizeChildOutcome(updates.outcome) : existing.outcome;
    const completedAt =
      outcome || ["completed", "partial", "failed", "cancelled"].includes(status)
        ? existing.completedAt || this.now()
        : undefined;
    this.db
      .prepare(
        `UPDATE work_session_child_links
         SET owner = ?, inherited_policy_snapshot_json = ?, status = ?, outcome = ?,
             updated_at = ?, completed_at = ?
         WHERE id = ?`,
      )
      .run(
        updates.owner === undefined
          ? existing.owner || null
          : optionalText(updates.owner, 256) || null,
        updates.inheritedPolicySnapshot === undefined
          ? existing.inheritedPolicySnapshot
            ? JSON.stringify(sanitizeMetadata(existing.inheritedPolicySnapshot))
            : null
          : JSON.stringify(sanitizeMetadata(updates.inheritedPolicySnapshot)),
        status,
        outcome || null,
        this.now(),
        completedAt || null,
        normalizedId,
      );
    return this.findChildSessionById(normalizedId)!;
  }

  listChildSessions(parentSessionId: string): WorkSessionChildLink[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM work_session_child_links WHERE parent_session_id = ? ORDER BY created_at ASC, id ASC",
      )
      .all(requiredId(parentSessionId, "parentSessionId")) as DbRow[];
    return rows.map((row) => this.mapChildSession(row));
  }

  findChildSessionByTask(childTaskId: string): WorkSessionChildLink | undefined {
    const row = this.db
      .prepare("SELECT * FROM work_session_child_links WHERE child_task_id = ?")
      .get(requiredId(childTaskId, "childTaskId")) as DbRow | undefined;
    return row ? this.mapChildSession(row) : undefined;
  }

  getContractAggregate(sessionId: string): WorkSessionContractAggregate {
    const normalizedSessionId = requiredId(sessionId, "sessionId");
    this.expireWaitStates(this.now());
    const contract = this.findOutcomeContract(normalizedSessionId);
    const constraints = this.listConstraints(normalizedSessionId);
    const evidence = this.listEvidence(normalizedSessionId);
    const artifactRevisions = this.listArtifactRevisions(normalizedSessionId);
    const waitStates = this.listWaitStates(normalizedSessionId);
    const children = this.listChildSessions(normalizedSessionId);
    const checksum = stableChecksum({
      contract,
      constraints,
      evidence,
      artifactRevisions,
      waitStates,
      children,
    });
    return { contract, constraints, evidence, artifactRevisions, waitStates, children, checksum };
  }

  aggregateChildOutcomes(parentSessionId: string): WorkSessionChildAggregate {
    const children = this.listChildSessions(parentSessionId);
    const counts = {
      pendingCount: 0,
      runningCount: 0,
      completedCount: 0,
      partialCount: 0,
      failedCount: 0,
    };
    for (const child of children) {
      if (child.status === "pending") counts.pendingCount += 1;
      else if (child.status === "running") counts.runningCount += 1;
      else if (child.outcome === "complete" || child.status === "completed")
        counts.completedCount += 1;
      else if (child.outcome === "partial" || child.status === "partial") counts.partialCount += 1;
      else if (
        child.outcome === "failed" ||
        child.status === "failed" ||
        child.status === "cancelled"
      ) {
        counts.failedCount += 1;
      }
    }
    const terminal = counts.pendingCount === 0 && counts.runningCount === 0;
    const outcome: WorkSessionChildOutcome | undefined =
      children.length === 0 || !terminal
        ? undefined
        : counts.failedCount === 0 && counts.partialCount === 0
          ? "complete"
          : counts.completedCount > 0 || counts.partialCount > 0
            ? "partial"
            : "failed";
    return {
      parentSessionId: requiredId(parentSessionId, "parentSessionId"),
      childCount: children.length,
      ...counts,
      outcome,
    };
  }

  private normalizeRequirements(
    requirements: OutcomeContractRequirementInput[] | OutcomeContractRequirement[] | undefined,
  ): OutcomeContractRequirement[] {
    if (!Array.isArray(requirements)) return [];
    return requirements.slice(0, MAX_REQUIREMENTS).flatMap((requirement) => {
      const description = optionalText(requirement?.description, 4_000);
      if (!description) return [];
      const evidenceIds = Array.isArray(requirement?.evidenceIds)
        ? Array.from(
            new Set(
              requirement.evidenceIds
                .map((value) => optionalId(value))
                .filter((value): value is string => Boolean(value)),
            ),
          ).slice(0, 100)
        : undefined;
      return [
        {
          id: optionalId(requirement.id) || `requirement:${randomUUID()}`,
          kind: normalizeRequirementKind(requirement.kind),
          description,
          required: requirement.required !== false,
          status: normalizeRequirementStatus(requirement.status),
          ...(optionalText(requirement.verifier, 256)
            ? { verifier: optionalText(requirement.verifier, 256) }
            : {}),
          ...(evidenceIds && evidenceIds.length > 0 ? { evidenceIds } : {}),
        },
      ];
    });
  }

  private findOutcomeContractById(id: string): OutcomeContract | undefined {
    const row = this.db
      .prepare("SELECT * FROM work_session_outcome_contracts WHERE id = ?")
      .get(id) as DbRow | undefined;
    return row ? this.mapOutcomeContract(row) : undefined;
  }

  private findOutcomeContractByIdempotency(
    sessionId: string,
    idempotencyKey: string,
  ): OutcomeContract | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM work_session_outcome_contracts WHERE session_id = ? AND idempotency_key = ?",
      )
      .get(sessionId, idempotencyKey) as DbRow | undefined;
    return row ? this.mapOutcomeContract(row) : undefined;
  }

  private findConstraintById(id: string): ConstraintLedgerEntry | undefined {
    const row = this.db.prepare("SELECT * FROM work_session_constraints WHERE id = ?").get(id) as
      | DbRow
      | undefined;
    return row ? this.mapConstraint(row) : undefined;
  }

  private findConstraintByIdempotency(
    sessionId: string,
    idempotencyKey: string,
  ): ConstraintLedgerEntry | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM work_session_constraints WHERE session_id = ? AND idempotency_key = ?",
      )
      .get(sessionId, idempotencyKey) as DbRow | undefined;
    return row ? this.mapConstraint(row) : undefined;
  }

  private findEvidenceById(id: string): EvidenceManifestEntry | undefined {
    const row = this.db.prepare("SELECT * FROM work_session_evidence WHERE id = ?").get(id) as
      | DbRow
      | undefined;
    return row ? this.mapEvidence(row) : undefined;
  }

  private findEvidenceByIdempotency(
    sessionId: string,
    idempotencyKey: string,
  ): EvidenceManifestEntry | undefined {
    const row = this.db
      .prepare("SELECT * FROM work_session_evidence WHERE session_id = ? AND idempotency_key = ?")
      .get(sessionId, idempotencyKey) as DbRow | undefined;
    return row ? this.mapEvidence(row) : undefined;
  }

  private findArtifactRevisionById(id: string): ArtifactRevision | undefined {
    const row = this.db
      .prepare("SELECT * FROM work_session_artifact_revisions WHERE id = ?")
      .get(id) as DbRow | undefined;
    return row ? this.mapArtifactRevision(row) : undefined;
  }

  private findArtifactRevisionByIdempotency(
    sessionId: string,
    idempotencyKey: string,
  ): ArtifactRevision | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM work_session_artifact_revisions WHERE session_id = ? AND idempotency_key = ?",
      )
      .get(sessionId, idempotencyKey) as DbRow | undefined;
    return row ? this.mapArtifactRevision(row) : undefined;
  }

  private findWaitStateById(id: string): WaitState | undefined {
    const row = this.db.prepare("SELECT * FROM work_session_wait_states WHERE id = ?").get(id) as
      | DbRow
      | undefined;
    return row ? this.mapWaitState(row) : undefined;
  }

  private findWaitStateByIdempotency(
    sessionId: string,
    idempotencyKey: string,
  ): WaitState | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM work_session_wait_states WHERE session_id = ? AND idempotency_key = ?",
      )
      .get(sessionId, idempotencyKey) as DbRow | undefined;
    return row ? this.mapWaitState(row) : undefined;
  }

  private findChildSessionById(id: string): WorkSessionChildLink | undefined {
    const row = this.db.prepare("SELECT * FROM work_session_child_links WHERE id = ?").get(id) as
      | DbRow
      | undefined;
    return row ? this.mapChildSession(row) : undefined;
  }

  private mapOutcomeContract(row: DbRow): OutcomeContract {
    const requirements = this.normalizeRequirements(
      parseJson<OutcomeContractRequirement[]>(row.requirements_json, []),
    );
    return {
      id: String(row.id || ""),
      sessionId: String(row.session_id || ""),
      ...(row.task_id ? { taskId: String(row.task_id) } : {}),
      version: Math.max(1, Math.floor(boundedNumber(row.version, 1))),
      objective: optionalText(row.objective, MAX_OBJECTIVE_LENGTH) || "Work session objective",
      requirements,
      status: normalizeOutcomeStatus(row.status),
      ...(optionalText(row.source) ? { source: optionalText(row.source) } : {}),
      ...(optionalText(row.summary) ? { summary: optionalText(row.summary) } : {}),
      createdAt: Math.max(0, Math.floor(boundedNumber(row.created_at))),
      updatedAt: Math.max(0, Math.floor(boundedNumber(row.updated_at))),
      ...(row.satisfied_at !== null && row.satisfied_at !== undefined
        ? { satisfiedAt: Math.max(0, Math.floor(boundedNumber(row.satisfied_at))) }
        : {}),
    };
  }

  private mapConstraint(row: DbRow): ConstraintLedgerEntry {
    const metadata = row.metadata_json
      ? sanitizeMetadata(parseJson(row.metadata_json, {}))
      : undefined;
    return {
      id: String(row.id || ""),
      sessionId: String(row.session_id || ""),
      ...(row.turn_id ? { turnId: String(row.turn_id) } : {}),
      kind: normalizeConstraintKind(row.kind),
      key: optionalText(row.key, 256) || "constraint",
      statement: optionalText(row.statement) || "",
      status: normalizeConstraintStatus(row.status),
      ...(row.source_item_id ? { sourceItemId: String(row.source_item_id) } : {}),
      ...(optionalText(row.owner, 256) ? { owner: optionalText(row.owner, 256) } : {}),
      ...(metadata ? { metadata } : {}),
      createdAt: Math.max(0, Math.floor(boundedNumber(row.created_at))),
      updatedAt: Math.max(0, Math.floor(boundedNumber(row.updated_at))),
    };
  }

  private mapEvidence(row: DbRow): EvidenceManifestEntry {
    const expiresAt =
      row.freshness_expires_at !== null && row.freshness_expires_at !== undefined
        ? Math.max(0, Math.floor(boundedNumber(row.freshness_expires_at)))
        : undefined;
    const requestedStatus = normalizeEvidenceStatus(row.status);
    return {
      id: String(row.id || ""),
      sessionId: String(row.session_id || ""),
      ...(row.contract_id ? { contractId: String(row.contract_id) } : {}),
      claim: optionalText(row.claim, 4_000) || "Evidence claim",
      sourceType: (optionalText(row.source_type, 128) || "other") as EvidenceManifestSourceType,
      sourceRef: optionalText(row.source_ref, 4_000) || "unknown",
      ...(optionalText(row.snippet, 8_000) ? { snippet: optionalText(row.snippet, 8_000) } : {}),
      capturedAt: Math.max(0, Math.floor(boundedNumber(row.captured_at))),
      ...(expiresAt !== undefined ? { freshnessExpiresAt: expiresAt } : {}),
      confidence: clampConfidence(row.confidence),
      status: expiresAt !== undefined && expiresAt <= this.now() ? "stale" : requestedStatus,
      ...(optionalText(row.contradiction_group, 256)
        ? { contradictionGroup: optionalText(row.contradiction_group, 256) }
        : {}),
      ...(row.item_id ? { itemId: String(row.item_id) } : {}),
      ...(row.artifact_revision_id ? { artifactRevisionId: String(row.artifact_revision_id) } : {}),
      createdAt: Math.max(0, Math.floor(boundedNumber(row.created_at))),
    };
  }

  private mapArtifactRevision(row: DbRow): ArtifactRevision {
    const metadata = row.metadata_json
      ? sanitizeMetadata(parseJson(row.metadata_json, {}))
      : undefined;
    return {
      id: String(row.id || ""),
      sessionId: String(row.session_id || ""),
      taskId: String(row.task_id || ""),
      ...(row.artifact_id ? { artifactId: String(row.artifact_id) } : {}),
      revision: Math.max(1, Math.floor(boundedNumber(row.revision, 1))),
      path: optionalText(row.path, 4_000) || "",
      mimeType: optionalText(row.mime_type, 256) || "application/octet-stream",
      sha256: optionalText(row.sha256, 256) || "",
      size: Math.max(0, Math.floor(boundedNumber(row.size))),
      ...(row.parent_revision_id ? { parentRevisionId: String(row.parent_revision_id) } : {}),
      status: normalizeArtifactStatus(row.status),
      createdBy: (optionalText(row.created_by, 256) || "agent") as WorkSessionActor | string,
      ...(metadata ? { metadata } : {}),
      createdAt: Math.max(0, Math.floor(boundedNumber(row.created_at))),
    };
  }

  private mapWaitState(row: DbRow): WaitState {
    const payload = row.payload_json
      ? sanitizeMetadata(parseJson(row.payload_json, {}))
      : undefined;
    return {
      id: String(row.id || ""),
      sessionId: String(row.session_id || ""),
      taskId: String(row.task_id || ""),
      ...(row.turn_id ? { turnId: String(row.turn_id) } : {}),
      kind: normalizeWaitKind(row.kind),
      ...(row.request_id ? { requestId: String(row.request_id) } : {}),
      reason: optionalText(row.reason) || "Waiting for external input",
      status: normalizeWaitStatus(row.status),
      ...(optionalText(row.resume_token, 512)
        ? { resumeToken: optionalText(row.resume_token, 512) }
        : {}),
      ...(payload ? { payload } : {}),
      createdAt: Math.max(0, Math.floor(boundedNumber(row.created_at))),
      updatedAt: Math.max(0, Math.floor(boundedNumber(row.updated_at))),
      ...(row.resolved_at !== null && row.resolved_at !== undefined
        ? { resolvedAt: Math.max(0, Math.floor(boundedNumber(row.resolved_at))) }
        : {}),
      ...(row.expires_at !== null && row.expires_at !== undefined
        ? { expiresAt: Math.max(0, Math.floor(boundedNumber(row.expires_at))) }
        : {}),
    };
  }

  private mapChildSession(row: DbRow): WorkSessionChildLink {
    const inheritedPolicySnapshot = row.inherited_policy_snapshot_json
      ? sanitizeMetadata(parseJson(row.inherited_policy_snapshot_json, {}))
      : undefined;
    return {
      id: String(row.id || ""),
      parentSessionId: String(row.parent_session_id || ""),
      childSessionId: String(row.child_session_id || ""),
      parentTaskId: String(row.parent_task_id || ""),
      childTaskId: String(row.child_task_id || ""),
      ...(optionalText(row.owner, 256) ? { owner: optionalText(row.owner, 256) } : {}),
      isolationKey: optionalText(row.isolation_key, 512) || `session:${row.child_session_id || ""}`,
      ...(inheritedPolicySnapshot ? { inheritedPolicySnapshot } : {}),
      status: normalizeChildStatus(row.status),
      ...(normalizeChildOutcome(row.outcome)
        ? { outcome: normalizeChildOutcome(row.outcome) }
        : {}),
      createdAt: Math.max(0, Math.floor(boundedNumber(row.created_at))),
      updatedAt: Math.max(0, Math.floor(boundedNumber(row.updated_at))),
      ...(row.completed_at !== null && row.completed_at !== undefined
        ? { completedAt: Math.max(0, Math.floor(boundedNumber(row.completed_at))) }
        : {}),
    };
  }
}
