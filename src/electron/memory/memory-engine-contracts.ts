/**
 * Read-side contracts of the memory engine (docs/memory-engine.md, "Read side"). Signatures
 * only: MemoryRecall, MemoryContextBuilder and MemoryInjectionPolicy are implemented in a
 * later wave against these types, so producers and consumers can be built in parallel.
 */
import type {
  MemoryItem,
  MemoryItemKind,
  MemoryItemScope,
  MemoryItemSource,
} from "./memory-items-types";

/**
 * Lanes recall can fuse; `memory` is memory_items, `repo` the memory repo's markdown entries
 * (docs/memory-repo-phase1-design.md §6.3), the others are existing stores.
 */
export type MemoryRecallLane = "memory" | "repo" | "archive" | "conversations" | "knowledge";

/** Where a request comes from; drives privacy and channel rules in the injection policy. */
export type MemorySurface =
  | "plan"
  | "step"
  | "follow_up"
  | "chat"
  | "channel_private"
  | "channel_group"
  | "tool"
  | "memory_hub";

export interface MemoryRecallQuery {
  /** Free text; empty means "no text filter" (L0 and listing use cases). */
  text: string;
  workspaceId: string | null;
  /** Active task, for task-scoped items and conversation recall. */
  taskId?: string;
  /** Contact scope (mailbox, channel sender), only when the surface handles that contact. */
  contactRef?: string;
  lanes?: MemoryRecallLane[];
  kinds?: MemoryItemKind[];
  scopes?: MemoryItemScope[];
  /** Lowest provenance admitted, by trust (default: everything but `third_party`). */
  minSource?: MemoryItemSource;
  surface: MemorySurface;
  /** Trusted persisted sender authority. A private-channel transport alone is insufficient. */
  gatewaySenderIsOwner?: boolean;
  /** `index`: ids, titles and scores; `full`: content. */
  detail?: "index" | "full";
  ids?: string[];
  limit?: number;
  /** Access context for file-backed lanes (MemoryRecall.ts). */
  policy?: MemoryRecallPolicy;
}

/**
 * What a recall caller may reach beyond the database. Lanes that need something not given
 * here are skipped: no workspace path → no markdown/topic files.
 */
export interface MemoryRecallPolicy {
  /** Workspace root, for the markdown index and topic packs. */
  workspacePath?: string;
  /** Read guard of the caller's access profile; files it refuses are never read. */
  readGuard?: (absolutePath: string) => boolean;
  /** Include `private` memory items (owner surfaces such as the Memory Hub only). */
  includePrivate?: boolean;
  /** Leave the active task out of the conversation lane (context_recall covers it). */
  excludeActiveTaskConversation?: boolean;
  /** Restrict the conversation lane to one task of the workspace. */
  conversationTaskId?: string;
}

export interface MemoryRecallHit {
  lane: MemoryRecallLane;
  /** Lane-qualified id (`memory:<uuid>`, `archive:<id>`, `event:<rowid>`, …). */
  ref: string;
  /** Present for the `memory` lane. */
  item?: MemoryItem;
  title: string;
  content?: string;
  /** Reciprocal-rank-fusion score across lanes. */
  score: number;
  /** Per-lane ranks before fusion, for diagnostics. */
  laneRanks: Partial<Record<MemoryRecallLane, number>>;
  source: MemoryItemSource | "event" | "document";
  createdAt: number;
  /** Short text for an index listing (always set by MemoryRecall). */
  snippet?: string;
  /** Normalized relevance in [0, 1] (the best hit of the list is 1). */
  relevance?: number;
  /** Estimated tokens of the full content, so callers can budget an expansion. */
  tokenEstimate?: number;
  /** Item kind, archive memory type, conversation role, entity type, … */
  kind?: string;
  /** Where the hit came from (store, task, path, entity, provider), for attribution. */
  provenance?: Record<string, unknown>;
}

export interface MemoryRecall {
  /**
   * One query builder (Unicode, prefix-aware) per lane, reciprocal-rank fusion across lanes,
   * privacy and scope filters applied once. Does not count a use: call `markUsed` for hits
   * that were actually injected or quoted.
   */
  query(request: MemoryRecallQuery): Promise<MemoryRecallHit[]>;
  markUsed(refs: string[]): Promise<void>;
}

export interface MemoryInjectionDecision {
  allowed: boolean;
  /** Why not, for diagnostics and the "memory used" view. */
  reason?:
    | "memory_off"
    | "read_only_denied"
    | "no_memory_directive"
    | "group_channel"
    | "private_item"
    | "third_party_item"
    | "scope_mismatch";
}

export interface MemoryInjectionContext {
  workspaceId: string | null;
  taskId?: string;
  surface: MemorySurface;
  /** Trusted persisted sender authority. A private-channel transport alone is insufficient. */
  gatewaySenderIsOwner?: boolean;
  /** The task or message opted out with `<no-memory>`. */
  noMemory?: boolean;
  /** Contact the surface is handling, when any (allows that contact's items). */
  contactRef?: string;
}

export interface MemoryInjectionPolicy {
  /** Whether any memory may be injected on this surface at all. */
  surfaceAllowed(context: MemoryInjectionContext): Promise<MemoryInjectionDecision>;
  /** Whether one item may be injected; private and third-party items are refused by default. */
  itemAllowed(item: MemoryItem, context: MemoryInjectionContext): MemoryInjectionDecision;
}

export interface MemoryContextBlock {
  /** `l0`: identity, rules, pinned preferences; `l1`: task-relevant recall. */
  layer: "l0" | "l1";
  /** Rendered text, trust-tagged and tag-escaped. */
  text: string;
  /** Items (and other lane refs) rendered into the block, for "memory used" attribution. */
  refs: string[];
  tokens: number;
  truncated: boolean;
}

export interface MemoryContextRequest extends MemoryInjectionContext {
  /** Text the step is about (task prompt, step description, user message). */
  focus: string;
  /** One budget for all memory sections on this surface. */
  budgetTokens: number;
  include?: { l0?: boolean; l1?: boolean };
}

export interface MemoryContextBuilder {
  /**
   * L0 is cached per session and rebuilt when the hot-memory version changes; L1 runs
   * recall per step. Cross-source dedupe by content hash; one budget owner.
   */
  build(request: MemoryContextRequest): Promise<MemoryContextBlock[]>;
  /** Drop cached L0 blocks (called on hot-memory version bumps). */
  invalidate(workspaceId?: string | null): void;
}
