/**
 * MemoryWriter — the one write path into `memory_items` (docs/memory-engine.md).
 *
 * `ingest(candidate)` runs, in order:
 *   1. salience: empty, symbol-only, tiny or raw-telemetry text is dropped;
 *   2. redaction: secret values are replaced (sensitive-content.ts); text that was only a
 *      secret is dropped;
 *   3. policy: scope shape, third-party confinement, `<no-memory>`, workspace memory
 *      settings (off / strict privacy);
 *   4–6. dedupe by content hash (reinforce), supersede by subject, persist — atomically, in
 *      one memory-domain unit (memory-items-sql.ts `MemoryItemsStore.ingest`);
 *   7. bump the hot-memory version, so cached L0 prompt blocks are rebuilt;
 *   8. notify change listeners.
 *
 * Writes are serialized per writer, so a fire-and-forget dual write from a synchronous
 * legacy service lands in call order.
 */
import type Database from "better-sqlite3";
import { createLogger } from "../utils/logger";
import { bumpHotMemoryVersion } from "./hot-memory-version";
import { MemoryItemsRepository } from "./MemoryItemsRepository";
import type { MemoryStatementPort } from "./memory-statement-port";
import {
  MEMORY_ITEM_TRUST,
  derivedSubjectKey,
  hashMemoryItemContent,
  normalizeMemoryItemContent,
  normalizeSubjectKey,
  type MemoryItem,
  type MemoryItemIngestAction,
  type MemoryItemKind,
  type MemoryItemPrivacy,
  type MemoryItemScope,
  type MemoryItemSource,
  type MemoryItemStatus,
  type MemorySourceRef,
  type PreparedMemoryItemWrite,
} from "./memory-items-types";
import { containsNoMemoryDirective } from "./no-memory-directive";
import { REDACTED_SECRET, redactSecrets } from "./sensitive-content";

const logger = createLogger("MemoryWriter");

/** Longest item stored; longer text is cut at a word boundary. */
export const MEMORY_ITEM_MAX_CHARS = 1000;
const MIN_SALIENT_CHARS = 3;

const RAW_TELEMETRY =
  /^(?:Tool called:|Tool result for |Step started:|Step completed:|Plan (?:created|revised):\s*\{|\{\s*"(?:stepId|taskId|groupId)")/;

const PREFERRED_NAME_LINE = /^Preferred name:\s*\S/i;

/** Sources that record an explicit user act; memory-off settings do not block them. */
const EXPLICIT_SOURCES: ReadonlySet<MemoryItemSource> = new Set([
  "user_stated",
  "user_confirmed",
  "curated",
]);

export interface MemoryCandidate {
  content: string;
  kind: MemoryItemKind;
  scope: MemoryItemScope;
  /** Required for workspace and task scope; null for global. */
  workspaceId?: string | null;
  /** Contact id for contact scope, task id for task scope. */
  scopeRef?: string | null;
  /** A named subject (`preferred_name`, `response_style`, …); derived when omitted. */
  subjectKey?: string | null;
  source: MemoryItemSource;
  sourceRef?: MemorySourceRef;
  confidence?: number;
  pinned?: boolean;
  privacy?: MemoryItemPrivacy;
  /** Task the item was learned in (provenance; task delete purges derived items). */
  taskId?: string | null;
  expiresAt?: number | null;
  /** `archived` records a closed item (a done commitment) without making it active. */
  status?: "active" | "archived";
  /** Workspace whose memory settings govern the write; defaults to `workspaceId`. */
  originWorkspaceId?: string | null;
  /** The message or prompt the candidate came from, checked for `<no-memory>`. */
  originText?: string | null;
  /** The caller already knows the conversation opted out of memory. */
  noMemory?: boolean;
  /** `migration`: one-time import of a legacy record (idempotent by `sourceRef`). */
  mode?: "live" | "migration";
  /** Creation time of the legacy record, for migration. */
  createdAt?: number;
}

export type MemoryWriteSkipReason =
  | "empty"
  | "low_salience"
  | "secret_only"
  | "invalid_scope"
  | "third_party_scope"
  | "no_memory"
  | "memory_disabled"
  | "outranked"
  | "already_migrated";

export type MemoryWriteResult =
  | {
      status: "written";
      action: MemoryItemIngestAction;
      item: MemoryItem;
      supersededIds: string[];
      redactions: number;
    }
  | { status: "skipped"; reason: MemoryWriteSkipReason; holderId?: string };

export interface MemoryWorkspacePolicy {
  enabled: boolean;
  privacyMode?: "normal" | "strict" | "disabled";
}

export interface MemoryItemsChange {
  kind: "written" | "status";
  itemIds: string[];
  workspaceId: string | null;
  scope?: MemoryItemScope;
}

type ChangeListener = (change: MemoryItemsChange) => void;

export type MemoryItemsRepositoryPort = Pick<
  MemoryItemsRepository,
  | "ingest"
  | "setStatus"
  | "list"
  | "listForView"
  | "findBySourceRef"
  | "isLaneMigrationComplete"
  | "listCuratedForMigration"
  | "recordLaneMigration"
  | "findById"
  | "listPage"
  | "revisions"
  | "setPinned"
  | "purgeGlobal"
  | "getKitRenderState"
  | "setKitRenderState"
>;

export interface MemoryWriterDeps {
  repository: MemoryItemsRepositoryPort;
  /** Workspace memory settings; null or a throw means "no settings" (allowed). */
  getWorkspacePolicy?: (workspaceId: string) => Promise<MemoryWorkspacePolicy | null>;
  now?: () => number;
  /** Defaults to the process-wide hot-memory version. */
  bumpHotMemoryVersion?: () => void;
}

const listeners = new Set<ChangeListener>();

function emit(change: MemoryItemsChange): void {
  for (const listener of listeners) {
    try {
      listener(change);
    } catch (error) {
      logger.warn("Memory items change listener failed:", error);
    }
  }
}

function truncateAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function clampConfidence(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed : null;
}

export class MemoryWriter {
  private static instance: MemoryWriter | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: MemoryWriterDeps) {}

  /**
   * Create the process-wide writer (idempotent) over the profile database or the memory
   * domain's statement port.
   */
  static initialize(
    source: Database.Database | MemoryStatementPort,
    options: Omit<MemoryWriterDeps, "repository"> = {},
  ): MemoryWriter {
    if (!this.instance) {
      this.instance = new MemoryWriter({
        ...options,
        repository: new MemoryItemsRepository(source),
      });
    }
    return this.instance;
  }

  /** The process-wide writer, or null before initialization (CLI paths, unit tests). */
  static get(): MemoryWriter | null {
    return this.instance;
  }

  /** Install a writer (tests) or clear it with null. */
  static setInstance(writer: MemoryWriter | null): void {
    this.instance = writer;
  }

  static onChange(listener: ChangeListener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  /**
   * Fire-and-forget write for legacy services that are still the system of record and
   * have a synchronous API. No-op before initialization; failures are logged only.
   */
  static dualWrite(candidate: MemoryCandidate | null | undefined, label: string): void {
    const writer = this.instance;
    if (!writer || !candidate) return;
    writer.ingest(candidate).catch((error) => {
      logger.warn(`Memory item dual write (${label}) failed:`, error);
    });
  }

  /** Fire-and-forget status change by legacy source ref (delete, archive). */
  static dualWriteStatus(
    store: string,
    sourceId: string,
    status: Exclude<MemoryItemStatus, "active">,
    label: string,
  ): void {
    const writer = this.instance;
    if (!writer) return;
    writer.setStatusBySourceRef(store, sourceId, status).catch((error) => {
      logger.warn(`Memory item dual write (${label}) failed:`, error);
    });
  }

  get repository(): MemoryItemsRepositoryPort {
    return this.deps.repository;
  }

  /** Run `ingest` for one candidate; see the file comment for the pipeline. */
  ingest(candidate: MemoryCandidate): Promise<MemoryWriteResult> {
    return this.serialize(() => this.ingestNow(candidate));
  }

  /** Close the items of a legacy record (all of its revisions). */
  setStatusBySourceRef(
    store: string,
    sourceId: string,
    status: Exclude<MemoryItemStatus, "active">,
  ): Promise<string[]> {
    return this.serialize(async () => {
      const changed = await this.deps.repository.setStatus({ store, sourceId }, status, this.now());
      if (changed.length > 0)
        this.afterChange({ kind: "status", itemIds: changed, workspaceId: null });
      return changed;
    });
  }

  /** Close one item by id: `deleted` scrubs its content (a real forget). */
  setStatus(id: string, status: Exclude<MemoryItemStatus, "active">): Promise<string[]> {
    return this.serialize(async () => {
      const changed = await this.deps.repository.setStatus({ id }, status, this.now());
      if (changed.length > 0)
        this.afterChange({ kind: "status", itemIds: changed, workspaceId: null });
      return changed;
    });
  }

  /** Pin or unpin an active item (Memory Hub); pinned items are L0 candidates. */
  setPinned(id: string, pinned: boolean): Promise<boolean> {
    return this.serialize(async () => {
      const changed = await this.deps.repository.setPinned(id, pinned, this.now());
      if (changed) this.afterChange({ kind: "status", itemIds: [id], workspaceId: null });
      return changed;
    });
  }

  /**
   * "Clear global memory" (Memory Hub): hard-delete every global item and revision.
   * Workspace, contact and task items are untouched. Returns the number of rows removed.
   */
  purgeGlobal(): Promise<number> {
    return this.serialize(async () => {
      const removed = await this.deps.repository.purgeGlobal();
      if (removed > 0) this.afterChange({ kind: "status", itemIds: [], workspaceId: null });
      return removed;
    });
  }

  /** Wait until every queued write has finished (tests, shutdown). */
  async flush(): Promise<void> {
    await this.queue.catch(() => undefined);
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.catch(() => undefined).then(operation);
    this.queue = run;
    return run;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private async ingestNow(candidate: MemoryCandidate): Promise<MemoryWriteResult> {
    // 1. Salience.
    let content = normalizeMemoryItemContent(candidate.content);
    if (!content) return { status: "skipped", reason: "empty" };
    if (
      content.length < MIN_SALIENT_CHARS ||
      !/[\p{L}\p{N}]/u.test(content) ||
      RAW_TELEMETRY.test(content)
    ) {
      return { status: "skipped", reason: "low_salience" };
    }

    // 2. Redaction.
    const redaction = redactSecrets(content);
    content = truncateAtWord(normalizeMemoryItemContent(redaction.text), MEMORY_ITEM_MAX_CHARS);
    if (redaction.count > 0) {
      const remainder = content
        .split(REDACTED_SECRET)
        .join(" ")
        .replace(/[^\p{L}\p{N}]+/gu, "");
      if (remainder.length < MIN_SALIENT_CHARS) return { status: "skipped", reason: "secret_only" };
    }

    // 3. Policy.
    const scope = this.resolveScope(candidate);
    if (!scope) return { status: "skipped", reason: "invalid_scope" };
    if (candidate.source === "third_party" && scope.scope !== "contact" && scope.scope !== "task") {
      // Third-party text (mail, screen, other people) never becomes a fact about the user.
      return { status: "skipped", reason: "third_party_scope" };
    }
    if (candidate.noMemory || containsNoMemoryDirective(candidate.originText)) {
      return { status: "skipped", reason: "no_memory" };
    }
    const mode = candidate.mode ?? "live";
    let privacy: MemoryItemPrivacy =
      candidate.privacy ?? (candidate.source === "third_party" ? "private" : "normal");
    const governingWorkspace = nonEmpty(candidate.originWorkspaceId) ?? scope.workspaceId;
    if (governingWorkspace && mode === "live") {
      const policy = await this.workspacePolicy(governingWorkspace);
      if (policy) {
        const disabled = !policy.enabled || policy.privacyMode === "disabled";
        if (disabled && !EXPLICIT_SOURCES.has(candidate.source)) {
          return { status: "skipped", reason: "memory_disabled" };
        }
        if (policy.privacyMode === "strict") privacy = "private";
      }
    }

    // 4–6. Dedupe, supersede and persist, atomically.
    const contentHash = hashMemoryItemContent(content);
    const named = normalizeSubjectKey(candidate.subjectKey);
    const inferredName =
      !named && candidate.kind === "identity" && PREFERRED_NAME_LINE.test(content)
        ? "preferred_name"
        : null;
    const subjectKey = named ?? inferredName ?? derivedSubjectKey(candidate.kind, contentHash);
    const now = this.now();
    const sourceRef: MemorySourceRef = {
      ...candidate.sourceRef,
      ...(redaction.count > 0 ? { redactions: redaction.count } : {}),
    };
    const write: PreparedMemoryItemWrite = {
      ...scope,
      kind: candidate.kind,
      subjectKey,
      derivedSubject: !named && !inferredName,
      content,
      contentHash,
      source: candidate.source,
      sourceRef,
      trust: MEMORY_ITEM_TRUST[candidate.source],
      confidence: clampConfidence(candidate.confidence, 0.7),
      pinned: candidate.pinned === true,
      privacy,
      taskId: nonEmpty(candidate.taskId) ?? null,
      expiresAt:
        typeof candidate.expiresAt === "number" && Number.isFinite(candidate.expiresAt)
          ? Math.floor(candidate.expiresAt)
          : null,
      status: candidate.status ?? "active",
      mode,
      now,
      ...(typeof candidate.createdAt === "number" && Number.isFinite(candidate.createdAt)
        ? { createdAt: Math.floor(candidate.createdAt) }
        : {}),
    };
    const outcome = await this.deps.repository.ingest(write);
    if (outcome.action === "skipped") {
      return { status: "skipped", reason: outcome.reason, holderId: outcome.holderId };
    }

    // 7–8. Invalidate caches and notify.
    this.afterChange({
      kind: "written",
      itemIds: [outcome.item.id, ...outcome.supersededIds],
      workspaceId: outcome.item.workspaceId,
      scope: outcome.item.scope,
    });
    return {
      status: "written",
      action: outcome.action,
      item: outcome.item,
      supersededIds: outcome.supersededIds,
      redactions: redaction.count,
    };
  }

  private resolveScope(
    candidate: MemoryCandidate,
  ): Pick<PreparedMemoryItemWrite, "workspaceId" | "scope" | "scopeRef"> | null {
    const workspaceId = nonEmpty(candidate.workspaceId);
    const scopeRef = nonEmpty(candidate.scopeRef);
    switch (candidate.scope) {
      case "global":
        return { workspaceId: null, scope: "global", scopeRef: null };
      case "workspace":
        return workspaceId ? { workspaceId, scope: "workspace", scopeRef: null } : null;
      case "contact":
        return scopeRef ? { workspaceId, scope: "contact", scopeRef } : null;
      case "task":
        return workspaceId && scopeRef ? { workspaceId, scope: "task", scopeRef } : null;
      default:
        return null;
    }
  }

  private async workspacePolicy(workspaceId: string): Promise<MemoryWorkspacePolicy | null> {
    if (!this.deps.getWorkspacePolicy) return null;
    try {
      return await this.deps.getWorkspacePolicy(workspaceId);
    } catch {
      return null;
    }
  }

  private afterChange(change: MemoryItemsChange): void {
    try {
      (this.deps.bumpHotMemoryVersion ?? bumpHotMemoryVersion)();
    } catch {
      // A cache bump must never fail a committed write.
    }
    emit(change);
  }
}
