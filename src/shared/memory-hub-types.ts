/**
 * Memory Hub "What CoWork knows" contract: the renderer-facing view of `memory_items`
 * (docs/memory-engine.md). The vocabularies mirror `src/electron/memory/memory-items-types.ts`;
 * `MemoryItemsHubService` checks at compile time that the two stay assignable.
 */

export const MEMORY_HUB_KINDS = [
  "identity",
  "preference",
  "rule",
  "project_fact",
  "commitment",
  "correction",
  "decision",
  "insight",
  "outcome",
] as const;
export type MemoryHubKind = (typeof MEMORY_HUB_KINDS)[number];

export const MEMORY_HUB_SCOPES = ["global", "workspace", "contact", "task"] as const;
export type MemoryHubScope = (typeof MEMORY_HUB_SCOPES)[number];

export const MEMORY_HUB_SOURCES = [
  "user_stated",
  "user_confirmed",
  "curated",
  "inferred",
  "third_party",
  "import",
  "system",
] as const;
export type MemoryHubSource = (typeof MEMORY_HUB_SOURCES)[number];

export const MEMORY_HUB_STATUSES = ["active", "superseded", "archived", "deleted"] as const;
export type MemoryHubStatus = (typeof MEMORY_HUB_STATUSES)[number];

/** Kinds a user can add from the Hub (outcomes are episodic and are not added by hand). */
export const MEMORY_HUB_ADDABLE_KINDS = [
  "identity",
  "preference",
  "rule",
  "project_fact",
  "commitment",
  "correction",
  "decision",
  "insight",
] as const satisfies readonly MemoryHubKind[];
export type MemoryHubAddableKind = (typeof MEMORY_HUB_ADDABLE_KINDS)[number];

export interface MemoryHubItem {
  id: string;
  workspaceId: string | null;
  scope: MemoryHubScope;
  /** Contact id for contact scope, task id for task scope. */
  scopeRef: string | null;
  kind: MemoryHubKind;
  subjectKey: string;
  content: string;
  source: MemoryHubSource;
  trust: number;
  confidence: number;
  status: MemoryHubStatus;
  pinned: boolean;
  private: boolean;
  reinforcedCount: number;
  lastUsedAt: number | null;
  supersedesId: string | null;
  taskId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryHubListRequest {
  workspaceId: string;
  kinds?: MemoryHubKind[];
  scopes?: MemoryHubScope[];
  statuses?: MemoryHubStatus[];
  sources?: MemoryHubSource[];
  query?: string;
  pinnedOnly?: boolean;
  limit?: number;
  offset?: number;
}

export interface MemoryHubListResult {
  items: MemoryHubItem[];
  total: number;
  offset: number;
  hasMore: boolean;
}

export interface MemoryHubItemDetail {
  item: MemoryHubItem;
  /** Older revisions, newest first (the supersession chain). */
  previous: MemoryHubItem[];
  /** The revision that replaced this one, when it is no longer active. */
  supersededBy: MemoryHubItem | null;
}

export interface MemoryHubWhy {
  itemId: string;
  source: MemoryHubSource;
  /** Plain-language origin, for example "You added this in the Memory Hub". */
  summary: string;
  /** Where the record came from (`user_profile`, `curated`, `kit_file`, `memory_hub`, …). */
  store: string | null;
  /** Whitelisted provenance details (lane, file, layer, reason). */
  details: Record<string, string | number>;
  /** Number of other records merged into this item by dedupe. */
  mergedRecords: number;
  task: { id: string; title: string | null; available: boolean } | null;
  trust: number;
  confidence: number;
  reinforcedCount: number;
  lastUsedAt: number | null;
  createdAt: number;
  updatedAt: number;
  revisionCount: number;
}

export type MemoryHubMutationResult =
  | {
      success: true;
      item: MemoryHubItem | null;
      action?: string;
      /** The memory folder line written (`repo:<path>#L<n>`) when the fact went there. */
      ref?: string;
    }
  | { success: false; error: string; reason?: string };
