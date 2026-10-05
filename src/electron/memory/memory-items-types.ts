/**
 * Memory items: the semantic fact store of the memory engine (docs/memory-engine.md).
 *
 * Types, vocabularies and pure helpers shared by the store (memory-items-sql.ts, which the
 * database worker loads), its units, the repository and MemoryWriter. No runtime imports
 * besides `crypto`, so the worker bundle stays free of Electron and service code.
 */
import { createHash } from "crypto";

export const MEMORY_ITEM_KINDS = [
  "preference",
  "identity",
  "rule",
  "project_fact",
  "decision",
  "commitment",
  "correction",
  "insight",
  "outcome",
] as const;
export type MemoryItemKind = (typeof MEMORY_ITEM_KINDS)[number];

export const MEMORY_ITEM_SCOPES = ["global", "workspace", "contact", "task"] as const;
export type MemoryItemScope = (typeof MEMORY_ITEM_SCOPES)[number];

export const MEMORY_ITEM_SOURCES = [
  "user_stated",
  "user_confirmed",
  "curated",
  "inferred",
  "third_party",
  "import",
  "system",
] as const;
export type MemoryItemSource = (typeof MEMORY_ITEM_SOURCES)[number];

export const MEMORY_ITEM_STATUSES = ["active", "superseded", "archived", "deleted"] as const;
export type MemoryItemStatus = (typeof MEMORY_ITEM_STATUSES)[number];

export const MEMORY_ITEM_PRIVACY = ["normal", "private"] as const;
export type MemoryItemPrivacy = (typeof MEMORY_ITEM_PRIVACY)[number];

/**
 * Trust by provenance (audit §8.1 principle 4). A newer value for a subject supersedes the
 * active one only when its trust is at least as high, so an inference never overrides
 * what the user said.
 */
export const MEMORY_ITEM_TRUST: Readonly<Record<MemoryItemSource, number>> = {
  user_stated: 1,
  user_confirmed: 0.9,
  curated: 0.85,
  system: 0.7,
  import: 0.6,
  inferred: 0.5,
  third_party: 0.3,
};

/**
 * Where an item came from, for provenance, idempotent migration and edits of a record.
 * `store` + `id` name the record in a legacy store (curated entry, profile fact,
 * relationship item, awareness belief) or the producer; other fields are informational.
 */
export interface MemorySourceRef {
  store?: string;
  id?: string;
  taskId?: string;
  [key: string]: unknown;
}

export interface MemoryItem {
  id: string;
  workspaceId: string | null;
  scope: MemoryItemScope;
  scopeRef: string | null;
  kind: MemoryItemKind;
  subjectKey: string;
  content: string;
  source: MemoryItemSource;
  sourceRef: MemorySourceRef;
  trust: number;
  confidence: number;
  status: MemoryItemStatus;
  pinned: boolean;
  reinforcedCount: number;
  lastUsedAt: number | null;
  supersedesId: string | null;
  contentHash: string;
  privacy: MemoryItemPrivacy;
  taskId: string | null;
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** The (workspace, scope, scope_ref) triple that bounds dedupe and supersession. */
export interface MemoryScopeKey {
  workspaceId: string | null;
  scope: MemoryItemScope;
  scopeRef: string | null;
}

/**
 * A fully prepared write, after MemoryWriter's salience, redaction and policy steps: the
 * store's ingest unit only dedupes, supersedes and persists it, atomically.
 */
export interface PreparedMemoryItemWrite extends MemoryScopeKey {
  kind: MemoryItemKind;
  subjectKey: string;
  /** True when the subject key was derived from the content hash (not a named subject). */
  derivedSubject: boolean;
  content: string;
  contentHash: string;
  source: MemoryItemSource;
  sourceRef: MemorySourceRef;
  trust: number;
  confidence: number;
  pinned: boolean;
  privacy: MemoryItemPrivacy;
  taskId: string | null;
  expiresAt: number | null;
  /** Initial status; `archived` records a closed item (for example a done commitment). */
  status: "active" | "archived";
  /**
   * `migration`: skip when any row already carries this `sourceRef` (store + id), so a
   * repeated migration adds nothing. `live`: an active row with the same `sourceRef` is
   * the record being edited and is superseded by a changed value.
   */
  mode: "live" | "migration";
  now: number;
  /** Creation time to record (migration keeps the legacy record's timestamps). */
  createdAt?: number;
}

export type MemoryItemIngestAction = "inserted" | "reinforced" | "superseded" | "updated";

export type MemoryItemIngestOutcome =
  | {
      action: MemoryItemIngestAction;
      item: MemoryItem;
      /** Rows moved to `superseded` by this write. */
      supersededIds: string[];
    }
  | { action: "skipped"; reason: "outranked" | "already_migrated"; holderId?: string };

export interface ListMemoryItemsRequest {
  workspaceId?: string | null;
  /** Include global items next to the workspace's (only with `workspaceId`). */
  includeGlobal?: boolean;
  scope?: MemoryItemScope;
  scopeRef?: string;
  kinds?: MemoryItemKind[];
  statuses?: MemoryItemStatus[];
  subjectKey?: string;
  sourceStore?: string;
  pinnedOnly?: boolean;
  includePrivate?: boolean;
  limit?: number;
}

/**
 * A page of items for the Memory Hub: one workspace's items plus global items (and
 * contact items that carry no workspace). Private items are included; the Hub shows them
 * to their owner with a badge. `query` is a case-insensitive substring match.
 */
export interface MemoryItemsPageRequest {
  workspaceId: string;
  kinds?: MemoryItemKind[];
  scopes?: MemoryItemScope[];
  statuses?: MemoryItemStatus[];
  sources?: MemoryItemSource[];
  query?: string;
  pinnedOnly?: boolean;
  limit?: number;
  offset?: number;
}

export interface MemoryItemsPage {
  items: MemoryItem[];
  total: number;
}

const WHITESPACE = /\s+/g;

/** Collapse whitespace; the stored form of item content. */
export function normalizeMemoryItemContent(value: string): string {
  return String(value || "")
    .replace(WHITESPACE, " ")
    .trim();
}

/**
 * Content hash for dedupe: case, whitespace and trailing punctuation do not make two
 * facts different.
 */
export function hashMemoryItemContent(content: string): string {
  const key = normalizeMemoryItemContent(content)
    .toLowerCase()
    .replace(/[\s.!?;:,]+$/u, "");
  return createHash("sha256").update(key).digest("hex");
}

/** Lower-case `[a-z0-9_:.-]` subject keys, at most 120 characters. */
export function normalizeSubjectKey(value: string | null | undefined): string | null {
  const key = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_:.-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
  return key || null;
}

/** The subject key of a multi-valued fact: one per distinct content within a kind. */
export function derivedSubjectKey(kind: MemoryItemKind, contentHash: string): string {
  return `${kind}:${contentHash.slice(0, 16)}`;
}

export function isDerivedSubjectKey(subjectKey: string): boolean {
  return /^[a-z_]+:[0-9a-f]{16}$/.test(subjectKey);
}

/**
 * Named, single-valued subjects. At most one active item holds a subject in a scope; a new
 * value supersedes the old one. Producers pass these explicitly; MemoryWriter also
 * recognizes `Preferred name: …` content.
 */
export const SINGLE_VALUED_SUBJECTS = [
  "preferred_name",
  "response_style",
  "response_length",
  "timezone",
  "primary_language",
] as const;

export function memoryScopeKeyOf(item: MemoryScopeKey): MemoryScopeKey {
  return { workspaceId: item.workspaceId, scope: item.scope, scopeRef: item.scopeRef };
}
