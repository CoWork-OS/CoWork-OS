/**
 * Memory Hub operations over `memory_items` ("What CoWork knows", audit §8.4): list, get
 * with the supersession chain, add, edit, pin, delete, "why", and clearing global items.
 *
 * Every write goes through MemoryWriter. Callers pass the workspace the Hub is showing;
 * an item is visible and editable only when it belongs to that workspace or is not bound
 * to any workspace (global items, workspace-less contact items). `memory_items` is the
 * only store of these facts (the legacy lanes are retired), so nothing is mirrored.
 */
import { MemoryRepoService } from "./repo/MemoryRepoService";
import { memoryRepoSkipMessage, writableMemoryRepo } from "./repo/memory-repo-producers";
import { randomUUID } from "crypto";
import type {
  MemoryHubItem,
  MemoryHubItemDetail,
  MemoryHubListRequest,
  MemoryHubListResult,
  MemoryHubMutationResult,
  MemoryHubWhy,
} from "../../shared/memory-hub-types";
import { memoryWriteSkipMessage } from "./memory-item-revise";
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

export interface MemoryItemsHubDeps {
  /** The process-wide writer (null before the memory engine starts). */
  getWriter: () => MemoryWriter | null;
  /**
   * The memory folder when it is writable (default: the running one). Facts the user adds,
   * edits or pins go there (docs/memory-repo-phase3-design.md §4); commitments, contact and
   * task items stay in `memory_items`.
   */
  getMemoryRepo?: () => MemoryRepoService | null;
  /** The workspace's name, for a new `workspaces/<slug>.md`. */
  getWorkspaceName?: (workspaceId: string) => Promise<string | null>;
  /** Resolve only the recorded bot identity; never derive ownership from current assignment. */
  getBot?: (id: string) => Promise<{ id: string; displayName: string } | undefined>;
  /** Task title for the "why" link; the title is shown only for the Hub's workspace. */
  getTask?: (
    taskId: string,
  ) => Promise<{ id: string; title?: string | null; workspaceId?: string | null } | undefined>;
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
    originBotId:
      typeof item.sourceRef.agentRoleId === "string" &&
      item.sourceRef.agentRoleId.trim() &&
      item.sourceRef.agentRoleId.length <= 128
        ? item.sourceRef.agentRoleId
        : null,
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

  private async view(item: MemoryItem): Promise<MemoryHubItem> {
    const value = toMemoryHubItem(item);
    if (value.originBotId) {
      try {
        const bot = await this.deps.getBot?.(value.originBotId);
        if (bot?.id === value.originBotId) value.originBotName = bot.displayName;
      } catch {
        /* Historical provenance remains visible if the bot is unavailable. */
      }
    }
    return value;
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
    const items = await Promise.all(
      page.items
      .filter((item) => isMemoryItemVisibleIn(item, request.workspaceId))
        .map((item) => this.view(item)),
    );
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

  private memoryRepo(): MemoryRepoService | null {
    return writableMemoryRepo(this.deps.getMemoryRepo);
  }

  /** A fact (not a commitment, contact or task item) that belongs in the memory folder. */
  private static isFolderFact(item: Pick<MemoryItem, "scope" | "kind" | "privacy">): boolean {
    return (
      (item.scope === "global" || item.scope === "workspace") &&
      item.kind !== "commitment" &&
      item.privacy !== "private"
    );
  }

  /** Write the user's fact to the memory folder; null when the folder could not take it. */
  private async rememberInFolder(
    repo: MemoryRepoService,
    request: {
      workspaceId: string;
      content: string;
      kind: MemoryItemKind;
      scope: "global" | "workspace";
      pinned: boolean;
      taskId?: string | null;
    },
  ): Promise<MemoryHubMutationResult | null> {
    let workspaceName: string | null = null;
    if (request.scope === "workspace") {
      try {
        workspaceName = (await this.deps.getWorkspaceName?.(request.workspaceId)) ?? null;
      } catch {
        workspaceName = null;
      }
    }
    const result = await repo.remember({
      text: request.content,
      kind: request.kind,
      scope: request.scope,
      workspaceId: request.workspaceId,
      workspaceName,
      by: "user",
      pinned: request.pinned,
      taskId: request.taskId ?? null,
      originText: request.content,
      origin: "memory_hub",
      // An explicit user act in the Hub (as `user_stated` items were).
      skipWorkspacePolicy: true,
    });
    if (result.status === "skipped") {
      // Unavailable (a write error): the caller keeps the memory_items path.
      if (result.reason === "unavailable") return null;
      return { success: false, error: memoryRepoSkipMessage(result), reason: result.reason };
    }
    return { success: true, item: null, action: result.action, ref: result.ref };
  }

  /**
   * A fact the user typed, global or in the Hub's workspace: a line in the memory folder
   * when it runs (commitments excepted), otherwise a `user_stated` item.
   */
  async add(request: {
    workspaceId: string;
    content: string;
    kind: MemoryItemKind;
    scope: "global" | "workspace";
    pinned?: boolean;
  }): Promise<MemoryHubMutationResult> {
    const repo = request.kind === "commitment" ? null : this.memoryRepo();
    if (repo) {
      const written = await this.rememberInFolder(repo, {
        ...request,
        pinned: request.pinned === true,
      });
      if (written) return written;
    }
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
      return { success: false, error: memoryWriteSkipMessage(result), reason: result.reason };
    }
    return { success: true, item: toMemoryHubItem(result.item), action: result.action };
  }

  /**
   * Edit an item's text: a new `user_stated` revision supersedes it (same kind, scope and
   * named subject).
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
    const moved = await this.moveToFolder(item, request.workspaceId, {
      content: request.content,
      pinned: item.pinned,
    });
    if (moved) return moved;
    const result = await this.editItem(item, request.content, MEMORY_HUB_STORE);
    if (result.status === "skipped") {
      return { success: false, error: memoryWriteSkipMessage(result), reason: result.reason };
    }
    return { success: true, item: toMemoryHubItem(result.item), action: result.action };
  }

  /**
   * Edit an item (`kit_file` is the provenance of the retired kit back-sync). Unchanged
   * text (same content hash) is a no-op reported as `updated`.
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
      // No source ref to match on: close the old revision explicitly.
      await writer.setStatus(item.id, "superseded");
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
    if (request.pinned) {
      const moved = await this.moveToFolder(item, request.workspaceId, {
        content: item.content,
        pinned: true,
      });
      if (moved) return moved;
    }
    await this.writer().setPinned(item.id, request.pinned);
    const updated = await this.writer().repository.findById(item.id);
    return { success: true, item: updated ? toMemoryHubItem(updated) : null };
  }

  /**
   * Edit or pin of a fact item while the memory folder runs: the fact moves to the folder
   * (the user's line; pinned = `MEMORY.md`) and the item is deleted. Null when the item is
   * not a folder fact or the folder could not take it (the item path applies).
   */
  private async moveToFolder(
    item: MemoryItem,
    workspaceId: string,
    change: { content: string; pinned: boolean },
  ): Promise<MemoryHubMutationResult | null> {
    const repo = MemoryItemsHubService.isFolderFact(item) ? this.memoryRepo() : null;
    if (!repo) return null;
    const written = await this.rememberInFolder(repo, {
      workspaceId: item.workspaceId ?? workspaceId,
      content: change.content,
      kind: item.kind,
      scope: item.scope === "workspace" && item.workspaceId ? "workspace" : "global",
      pinned: change.pinned,
      taskId: item.taskId,
    });
    if (!written || !written.success) return written;
    await this.removeItem(item, "deleted");
    return { ...written, action: "moved" };
  }

  /**
   * A real forget: the item and its older revisions become tombstones with their text
   * scrubbed (retention drops them) and the hot-memory version is bumped (by the writer).
   */
  async delete(request: { workspaceId: string; id: string }): Promise<MemoryHubMutationResult> {
    const item = await this.owned(request.workspaceId, request.id);
    await this.removeItem(item, "deleted");
    return { success: true, item: null };
  }

  /** Hub delete (`deleted`), or an archive (`archived`). */
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
  }

  /**
   * Hard-delete every global item (facts about the user that apply everywhere). Workspace
   * items are untouched.
   */
  async clearGlobal(): Promise<{ success: true; deleted: number }> {
    const deleted = await this.writer().purgeGlobal();
    // The user's global files in the memory repo, then its history is compacted.
    await MemoryRepoService.get()?.clearGlobal();
    return { success: true, deleted };
  }
}
