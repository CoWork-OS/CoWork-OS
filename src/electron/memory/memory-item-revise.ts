/**
 * Revise one memory item through MemoryWriter: a new revision of the same record (same
 * `{store, id}` source ref), so the writer treats it as an edit and supersedes the active
 * revision, or updates it in place when the text is unchanged (confidence, provenance
 * fields such as a commitment's `dueAt`). Shared by the services that expose
 * `memory_items` through the older profile, commitment and curated APIs.
 */
import type { MemoryWriter, MemoryWriteResult } from "./MemoryWriter";
import {
  isDerivedSubjectKey,
  type MemoryItem,
  type MemoryItemKind,
  type MemoryItemSource,
} from "./memory-items-types";

export interface MemoryItemRevision {
  content?: string;
  kind?: MemoryItemKind;
  source?: MemoryItemSource;
  confidence?: number;
  pinned?: boolean;
  /** Fields merged into the item's source ref (`dueAt`, `category`, `target`, …). */
  sourceRefPatch?: Record<string, unknown>;
}

/** The record an item came from, when its source ref names one. */
export function primarySourceRef(item: Pick<MemoryItem, "sourceRef">): {
  store: string;
  id: string;
} | null {
  const { store, id } = item.sourceRef;
  return typeof store === "string" && store && typeof id === "string" && id ? { store, id } : null;
}

/**
 * Write a revision of `item`. An item without a source ref gets `{ fallbackStore, item.id }`
 * and its old revision is closed explicitly. Reactivates nothing by itself: the revision of
 * an archived item is a new active row of the same record (a reopened commitment).
 */
export async function reviseMemoryItem(
  writer: Pick<MemoryWriter, "ingest" | "setStatus">,
  item: MemoryItem,
  revision: MemoryItemRevision,
  fallbackStore: string,
): Promise<MemoryWriteResult> {
  const ref = primarySourceRef(item);
  const kind = revision.kind ?? item.kind;
  const patch = revision.sourceRefPatch ?? {};
  const result = await writer.ingest({
    content: revision.content ?? item.content,
    kind,
    scope: item.scope,
    workspaceId: item.workspaceId,
    scopeRef: item.scopeRef,
    subjectKey:
      kind === item.kind && !isDerivedSubjectKey(item.subjectKey) ? item.subjectKey : null,
    source: revision.source ?? item.source,
    sourceRef: ref
      ? { ...item.sourceRef, ...patch }
      : { ...item.sourceRef, ...patch, store: fallbackStore, id: item.id },
    confidence: revision.confidence ?? item.confidence,
    pinned: revision.pinned ?? item.pinned,
    privacy: item.privacy,
    taskId: item.taskId,
    originWorkspaceId: item.workspaceId,
    originText: revision.content ?? null,
  });
  if (
    !ref &&
    result.status === "written" &&
    result.item.id !== item.id &&
    item.status === "active"
  ) {
    await writer.setStatus(item.id, "superseded");
  }
  return result;
}

/** Plain-language reason a write was skipped, for errors shown to the user or the agent. */
export function memoryWriteSkipMessage(
  result: Extract<MemoryWriteResult, { status: "skipped" }>,
): string {
  switch (result.reason) {
    case "empty":
    case "low_salience":
      return "That text is too short or has no words to remember.";
    case "secret_only":
      return "That text looks like a secret; secrets are not stored in memory.";
    case "no_memory":
      return "The text asks not to be remembered.";
    case "memory_disabled":
      return "Memory is turned off for this workspace.";
    case "outranked":
      return "A higher-trust memory already holds this subject.";
    case "invalid_scope":
    case "third_party_scope":
      return "That memory cannot be stored in this scope.";
    default:
      return "The memory was not saved.";
  }
}
