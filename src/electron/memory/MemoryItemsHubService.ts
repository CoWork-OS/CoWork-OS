/**
 * Memory Hub operations over `memory_items` ("What CoWork knows", audit §8.4): list, get
 * with the supersession chain, add, edit, pin, delete, "why", and clearing global items.
 *
 * Every write goes through MemoryWriter. Callers pass the workspace the Hub is showing;
 * an item is visible and editable only when it belongs to that workspace or is not bound
 * to any workspace (global items, workspace-less contact items).
 *
 * Legacy lanes are still read by some prompt paths this wave, so edits, pins and deletes
 * are also applied to the legacy record an item mirrors (best effort, `legacy` port), and
 * workspace changes re-render the `.cowork/USER.md` / `MEMORY.md` views (`syncKitFiles`).
 */
import { randomUUID } from "crypto";
import type {
  MemoryHubItem,
  MemoryHubItemDetail,
  MemoryHubListRequest,
  MemoryHubListResult,
  MemoryHubMutationResult,
  MemoryHubWhy,
} from "../../shared/memory-hub-types";
import { createLogger } from "../utils/logger";
import type { MemoryWriter, MemoryWriteResult } from "./MemoryWriter";
import {
  hashMemoryItemContent,
  isDerivedSubjectKey,
  normalizeMemoryItemContent,
  type MemoryItem,
  type MemoryItemKind,
  type MemoryItemSource,
  type MemorySourceRef,
} from "./memory-items-types";

const logger = createLogger("MemoryItemsHub");

/** Source ref store of items added or edited in the Memory Hub. */
export const MEMORY_HUB_STORE = "memory_hub";
/** Source ref store of items written back from a hand edit of a kit file. */
export const KIT_FILE_STORE = "kit_file";

const MAX_REVISIONS = 20;
/** Upper bound of revisions scrubbed by one delete. */
const MAX_DELETE_CHAIN = 100;

/** Compile-time check: the shared Hub vocabulary is the engine's vocabulary. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const VOCABULARIES_MATCH: [
  Same<MemoryHubItem["kind"], MemoryItem["kind"]>,
  Same<MemoryHubItem["scope"], MemoryItem["scope"]>,
  Same<MemoryHubItem["source"], MemoryItem["source"]>,
  Same<MemoryHubItem["status"], MemoryItem["status"]>,
] = [true, true, true, true];
void VOCABULARIES_MATCH;

/**
 * The legacy record an item mirrors (profile fact, relationship item, curated entry).
 * Implementations apply the change to that store without re-rendering kit files.
 */
export interface MemoryItemsLegacyMirror {
  edit(ref: { store: string; id: string }, content: string, item: MemoryItem): Promise<void>;
  remove(
    ref: { store: string; id: string },
    mode: "deleted" | "archived",
    item: MemoryItem,
  ): Promise<void>;
  setPinned?(ref: { store: string; id: string }, pinned: boolean): Promise<void>;
}

export interface MemoryItemsHubDeps {
  /** The process-wide writer (null before the memory engine starts). */
  getWriter: () => MemoryWriter | null;
  legacy?: MemoryItemsLegacyMirror;
  /** Task title for the "why" link; the title is shown only for the Hub's workspace. */
  getTask?: (
    taskId: string,
  ) => Promise<{ id: string; title?: string | null; workspaceId?: string | null } | undefined>;
  /** Re-render `.cowork/USER.md` / `MEMORY.md` for a workspace after a change. */
  syncKitFiles?: (workspaceId: string) => Promise<void>;
}

export class MemoryHubError extends Error {
  constructor(
    message: string,
    readonly code: "unavailable" | "not_found" | "invalid",
  ) {
    super(message);
    this.name = "MemoryHubError";
  }
}

/** An item is visible in a workspace's Hub when it is bound to it or to no workspace. */
export function isMemoryItemVisibleIn(
  item: Pick<MemoryItem, "workspaceId">,
  workspaceId: string,
): boolean {
  return item.workspaceId === null || item.workspaceId === workspaceId;
}

export function toMemoryHubItem(item: MemoryItem): MemoryHubItem {
  return {
    id: item.id,
    workspaceId: item.workspaceId,
    scope: item.scope,
    scopeRef: item.scopeRef,
    kind: item.kind,
    subjectKey: item.subjectKey,
    content: item.content,
    source: item.source,
    trust: item.trust,
    confidence: item.confidence,
    status: item.status,
    pinned: item.pinned,
    private: item.privacy === "private",
    reinforcedCount: item.reinforcedCount,
    lastUsedAt: item.lastUsedAt,
    supersedesId: item.supersedesId,
    taskId: item.taskId,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function primaryRef(ref: MemorySourceRef): { store: string; id: string } | null {
  return typeof ref.store === "string" && ref.store && typeof ref.id === "string" && ref.id
    ? { store: ref.store, id: ref.id }
    : null;
}

/** Primary ref plus the `store:id` aliases of records merged into the item by dedupe. */
function legacyRefs(ref: MemorySourceRef): Array<{ store: string; id: string }> {
  const refs: Array<{ store: string; id: string }> = [];
  const primary = primaryRef(ref);
  if (primary) refs.push(primary);
  if (Array.isArray(ref.aliases)) {
    for (const alias of ref.aliases) {
      if (typeof alias !== "string") continue;
      const split = alias.indexOf(":");
      if (split <= 0 || split === alias.length - 1) continue;
      refs.push({ store: alias.slice(0, split), id: alias.slice(split + 1) });
    }
  }
  return refs;
}

const WHY_DETAIL_KEYS = [
  "target",
  "curatedKind",
  "layer",
  "beliefType",
  "subject",
  "reason",
  "file",
  "category",
  "redactions",
  "editedVia",
] as const;

function whySummary(item: MemoryItem): string {
  const ref = item.sourceRef;
  if (ref.editedVia === MEMORY_HUB_STORE) return "You edited this in the Memory Hub.";
  if (ref.editedVia === KIT_FILE_STORE || ref.store === KIT_FILE_STORE) {
    const file = typeof ref.file === "string" ? ref.file : "a workspace kit file";
    return `You wrote this in ${file}.`;
  }
  switch (ref.store) {
    case MEMORY_HUB_STORE:
      return "You added this in the Memory Hub.";
    case "user_profile":
      return item.source === "user_stated"
        ? "You added this as a profile fact."
        : item.source === "user_confirmed"
          ? "You confirmed this through feedback."
          : "Inferred from a conversation and saved as a profile fact.";
    case "curated":
      return ref.target === "user"
        ? "Curated into .cowork/USER.md."
        : "Curated into .cowork/MEMORY.md.";
    case "relationship":
      return item.source === "third_party"
        ? "Taken from a message someone else sent you."
        : "Learned while working with you (relationship memory).";
    case "awareness":
      return "Inferred by ambient awareness.";
    case "adaptive_style":
      return "Adapted from how you respond to answers.";
    case "personality":
      return "Set as your name in personality settings.";
    default:
      break;
  }
  const bySource: Record<MemoryItemSource, string> = {
    user_stated: "You said this.",
    user_confirmed: "You confirmed this.",
    curated: "Curated by the agent.",
    inferred: "Inferred by CoWork.",
    third_party: "Taken from someone else's message.",
    import: "Imported.",
    system: "Recorded by CoWork.",
  };
  return bySource[item.source];
}

function skipMessage(result: Extract<MemoryWriteResult, { status: "skipped" }>): string {
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
    default:
      return "The memory was not saved.";
  }
}

export class MemoryItemsHubService {
  constructor(private readonly deps: MemoryItemsHubDeps) {}

  private writer(): MemoryWriter {
    const writer = this.deps.getWriter();
    if (!writer) throw new MemoryHubError("Memory is not available yet.", "unavailable");
    return writer;
  }

  /** The item, if it exists and is visible in the workspace; otherwise not found. */
  private async owned(workspaceId: string, id: string): Promise<MemoryItem> {
    const item = await this.writer().repository.findById(id);
    // A foreign item is reported exactly like a missing one, so ids cannot be probed.
    if (!item || !isMemoryItemVisibleIn(item, workspaceId)) {
      throw new MemoryHubError("Memory item not found.", "not_found");
    }
    return item;
  }

  async list(request: MemoryHubListRequest): Promise<MemoryHubListResult> {
    const limit = Math.max(1, Math.min(200, Math.floor(request.limit ?? 100)));
    const offset = Math.max(0, Math.floor(request.offset ?? 0));
    const page = await this.writer().repository.listPage({
      workspaceId: request.workspaceId,
      kinds: request.kinds,
      scopes: request.scopes,
      statuses: request.statuses,
      sources: request.sources,
      query: request.query?.trim() || undefined,
      pinnedOnly: request.pinnedOnly,
      limit,
      offset,
    });
    const items = page.items
      .filter((item) => isMemoryItemVisibleIn(item, request.workspaceId))
      .map(toMemoryHubItem);
    return { items, total: page.total, offset, hasMore: offset + page.items.length < page.total };
  }

  async get(workspaceId: string, id: string): Promise<MemoryHubItemDetail> {
    const item = await this.owned(workspaceId, id);
    const chain = await this.writer().repository.revisions(id, MAX_REVISIONS);
    return {
      item: toMemoryHubItem(item),
      previous: chain.previous
        .filter((entry) => isMemoryItemVisibleIn(entry, workspaceId))
        .map(toMemoryHubItem),
      supersededBy:
        chain.supersededBy && isMemoryItemVisibleIn(chain.supersededBy, workspaceId)
          ? toMemoryHubItem(chain.supersededBy)
          : null,
    };
  }

  async why(workspaceId: string, id: string): Promise<MemoryHubWhy> {
    const item = await this.owned(workspaceId, id);
    const chain = await this.writer().repository.revisions(id, MAX_REVISIONS);
    const details: Record<string, string | number> = {};
    for (const key of WHY_DETAIL_KEYS) {
      const value = item.sourceRef[key];
      if (typeof value === "string" && value.length <= 200) details[key] = value;
      else if (typeof value === "number" && Number.isFinite(value)) details[key] = value;
    }
    let task: MemoryHubWhy["task"] = null;
    if (item.taskId) {
      let found: Awaited<ReturnType<NonNullable<MemoryItemsHubDeps["getTask"]>>>;
      try {
        found = await this.deps.getTask?.(item.taskId);
      } catch {
        found = undefined;
      }
      // Another workspace's task title is not revealed through a global item.
      const sameWorkspace = Boolean(found) && found?.workspaceId === workspaceId;
      task = {
        id: item.taskId,
        title: sameWorkspace ? (found?.title ?? null) : null,
        available: sameWorkspace,
      };
    }
    return {
      itemId: item.id,
      source: item.source,
      summary: whySummary(item),
      store: typeof item.sourceRef.store === "string" ? item.sourceRef.store : null,
      details,
      mergedRecords: Array.isArray(item.sourceRef.aliases) ? item.sourceRef.aliases.length : 0,
      task,
      trust: item.trust,
      confidence: item.confidence,
      reinforcedCount: item.reinforcedCount,
      lastUsedAt: item.lastUsedAt,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      revisionCount: chain.previous.length,
    };
  }

  /** A fact the user typed: `user_stated`, global or in the Hub's workspace. */
  async add(request: {
    workspaceId: string;
    content: string;
    kind: MemoryItemKind;
    scope: "global" | "workspace";
    pinned?: boolean;
  }): Promise<MemoryHubMutationResult> {
    const result = await this.writer().ingest({
      content: request.content,
      kind: request.kind,
      scope: request.scope,
      workspaceId: request.scope === "workspace" ? request.workspaceId : null,
      source: "user_stated",
      sourceRef: { store: MEMORY_HUB_STORE, id: randomUUID() },
      confidence: 1,
      pinned: request.pinned === true,
      originWorkspaceId: request.workspaceId,
      originText: request.content,
    });
    if (result.status === "skipped") {
      return { success: false, error: skipMessage(result), reason: result.reason };
    }
    if (result.item.workspaceId) await this.syncKit(result.item.workspaceId);
    return { success: true, item: toMemoryHubItem(result.item), action: result.action };
  }

  /**
   * Edit an item's text: a new `user_stated` revision supersedes it (same kind, scope and
   * named subject), and the legacy record it mirrors is updated too.
   */
  async update(request: {
    workspaceId: string;
    id: string;
    content: string;
  }): Promise<MemoryHubMutationResult> {
    const item = await this.owned(request.workspaceId, request.id);
    if (item.status !== "active") {
      return { success: false, error: "Only current memories can be edited.", reason: "status" };
    }
    const result = await this.editItem(item, request.content, MEMORY_HUB_STORE);
    if (result.status === "skipped") {
      return { success: false, error: skipMessage(result), reason: result.reason };
    }
    if (item.workspaceId) await this.syncKit(item.workspaceId);
    return { success: true, item: toMemoryHubItem(result.item), action: result.action };
  }

  /**
   * Shared by the Hub and kit back-sync. Unchanged text (same content hash) is a no-op
   * reported as `updated`.
   */
  async editItem(
    item: MemoryItem,
    content: string,
    via: typeof MEMORY_HUB_STORE | typeof KIT_FILE_STORE,
    options: { kind?: MemoryItemKind; extraRef?: Record<string, unknown> } = {},
  ): Promise<MemoryWriteResult> {
    const writer = this.writer();
    const extraRef = options.extraRef ?? {};
    const kind = options.kind ?? item.kind;
    const normalized = normalizeMemoryItemContent(content);
    if (
      normalized &&
      kind === item.kind &&
      hashMemoryItemContent(normalized) === item.contentHash
    ) {
      return { status: "written", action: "updated", item, supersededIds: [], redactions: 0 };
    }
    const ref = primaryRef(item.sourceRef);
    const result = await writer.ingest({
      content,
      kind,
      scope: item.scope,
      workspaceId: item.workspaceId,
      scopeRef: item.scopeRef,
      subjectKey:
        kind === item.kind && !isDerivedSubjectKey(item.subjectKey) ? item.subjectKey : null,
      // Kit files are workspace files the agent can also write, so an edit made
      // there cannot be attributed to the user: it carries curated trust and can
      // never outrank something the user stated in the Hub.
      source: via === KIT_FILE_STORE ? "curated" : "user_stated",
      // Same {store, id}: MemoryWriter treats the write as an edit of this record and
      // supersedes the active revision.
      sourceRef: ref
        ? { ...item.sourceRef, ...extraRef, editedVia: via }
        : { store: via, id: item.id, ...extraRef, editedVia: via },
      confidence: via === KIT_FILE_STORE ? 0.85 : 1,
      pinned: item.pinned,
      privacy: item.privacy,
      taskId: item.taskId,
      originWorkspaceId: item.workspaceId,
      originText: content,
    });
    if (result.status === "skipped") return result;
    if (!ref && result.item.id !== item.id) {
      // No legacy ref to match on: close the old revision explicitly.
      await writer.setStatus(item.id, "superseded");
    }
    if (ref && this.deps.legacy) {
      try {
        await this.deps.legacy.edit(ref, result.item.content, item);
      } catch (error) {
        logger.warn("Legacy mirror edit failed:", error);
      }
    }
    return result;
  }

  async setPinned(request: {
    workspaceId: string;
    id: string;
    pinned: boolean;
  }): Promise<MemoryHubMutationResult> {
    const item = await this.owned(request.workspaceId, request.id);
    if (item.status !== "active") {
      return { success: false, error: "Only current memories can be pinned.", reason: "status" };
    }
    await this.writer().setPinned(item.id, request.pinned);
    const ref = primaryRef(item.sourceRef);
    if (ref && this.deps.legacy?.setPinned) {
      try {
        await this.deps.legacy.setPinned(ref, request.pinned);
      } catch (error) {
        logger.warn("Legacy mirror pin failed:", error);
      }
    }
    const updated = await this.writer().repository.findById(item.id);
    return { success: true, item: updated ? toMemoryHubItem(updated) : null };
  }

  /**
   * A real forget: the item and its older revisions become tombstones with their text
   * scrubbed (retention drops them), the legacy records it mirrors are deleted, the
   * hot-memory version is bumped (by the writer) and kit views are re-rendered.
   */
  async delete(request: { workspaceId: string; id: string }): Promise<MemoryHubMutationResult> {
    const item = await this.owned(request.workspaceId, request.id);
    await this.removeItem(item, "deleted");
    if (item.workspaceId) await this.syncKit(item.workspaceId);
    return { success: true, item: null };
  }

  /** Shared by the Hub (`deleted`) and kit back-sync (`archived`, a removed line). */
  async removeItem(item: MemoryItem, mode: "deleted" | "archived"): Promise<void> {
    const writer = this.writer();
    if (mode === "deleted") {
      const chain = await writer.repository.revisions(item.id, MAX_DELETE_CHAIN);
      for (const revision of [item, ...chain.previous]) {
        await writer.setStatus(revision.id, "deleted");
      }
    } else {
      await writer.setStatus(item.id, "archived");
    }
    if (!this.deps.legacy) return;
    for (const ref of legacyRefs(item.sourceRef)) {
      try {
        await this.deps.legacy.remove(ref, mode, item);
      } catch (error) {
        logger.warn("Legacy mirror remove failed:", error);
      }
    }
  }

  /**
   * Hard-delete every global item (facts about the user that apply everywhere), and the
   * profile and relationship records they mirror. Workspace items are untouched.
   */
  async clearGlobal(): Promise<{ success: true; deleted: number; legacyRecords: number }> {
    const writer = this.writer();
    const globalItems = await writer.repository.list({
      workspaceId: null,
      scope: "global",
      statuses: ["active", "superseded", "archived", "deleted"],
      includePrivate: true,
      limit: 5000,
    });
    const deleted = await writer.purgeGlobal();
    let legacyRecords = 0;
    if (this.deps.legacy) {
      const seen = new Set<string>();
      for (const item of globalItems) {
        for (const ref of legacyRefs(item.sourceRef)) {
          const key = `${ref.store}:${ref.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          try {
            await this.deps.legacy.remove(ref, "deleted", item);
            legacyRecords += 1;
          } catch (error) {
            logger.warn("Legacy mirror clear failed:", error);
          }
        }
      }
    }
    return { success: true, deleted, legacyRecords };
  }

  private async syncKit(workspaceId: string): Promise<void> {
    if (!this.deps.syncKitFiles) return;
    try {
      await this.deps.syncKitFiles(workspaceId);
    } catch (error) {
      // The database change is committed; the files catch up on the next sync.
      logger.warn("Kit file sync after a Memory Hub change failed:", error);
    }
  }
}
