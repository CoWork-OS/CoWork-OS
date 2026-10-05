import { WorkspaceRepository } from "../database/repository-facades";
import { randomUUID } from "crypto";
import type { DatabaseManager } from "../database/schema";
import type {
  CuratedMemoryEntry,
  CuratedMemoryKind,
  CuratedMemoryTarget,
  Workspace,
} from "../../shared/types";
import { MemoryWriteGate, type MemoryWriteOrigin } from "./MemoryWriteGate";
import { MemoryWriter } from "./MemoryWriter";
import {
  memoryWriteSkipMessage,
  primarySourceRef,
  reviseMemoryItem,
} from "./memory-item-revise";
import {
  MEMORY_LANE_STORES,
  curatedEntryCandidate,
  memoryKindForCuratedKind,
} from "./memory-items-lanes";
import type { MemoryItem } from "./memory-items-types";

const MAX_CURATED_CONTENT_CHARS = 320;
const MAX_MATCH_CHARS = 120;

function normalizeMemoryKey(value: string): string {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCuratedContent(value: string): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_CURATED_CONTENT_CHARS);
}

function normalizeMatch(value: string): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_MATCH_CHARS);
}

/**
 * Pick prompt entries from the user and workspace lanes: up to 60% of `limit`
 * for the user lane and the rest for the workspace lane, with either lane
 * filling slots the other leaves unused. Each lane keeps its own order
 * (confidence, then recency); user entries are listed first.
 */
export function balanceCuratedPromptEntries<T>(
  userEntries: T[],
  workspaceEntries: T[],
  limit: number,
): T[] {
  const max = Math.max(0, Math.floor(limit));
  if (max === 0) return [];
  const userQuota = Math.min(max, Math.ceil(max * 0.6));
  const workspaceQuota = max - userQuota;
  let userTake = Math.min(userEntries.length, userQuota);
  let workspaceTake = Math.min(workspaceEntries.length, workspaceQuota);
  const spare = max - userTake - workspaceTake;
  if (spare > 0) {
    const extraUser = Math.min(spare, userEntries.length - userTake);
    userTake += extraUser;
    workspaceTake += Math.min(spare - extraUser, workspaceEntries.length - workspaceTake);
  }
  return [...userEntries.slice(0, userTake), ...workspaceEntries.slice(0, workspaceTake)];
}

/** Curated kind of a workspace memory item: recorded at write, else derived from its kind. */
export function curatedKindOf(item: Pick<MemoryItem, "kind" | "sourceRef">): CuratedMemoryKind {
  const recorded = item.sourceRef.curatedKind;
  if (typeof recorded === "string" && CURATED_KIND_LABELS.has(recorded as CuratedMemoryKind)) {
    return recorded as CuratedMemoryKind;
  }
  switch (item.kind) {
    case "identity":
      return "identity";
    case "preference":
      return "preference";
    case "rule":
      return "constraint";
    case "commitment":
      return "active_commitment";
    default:
      return "project_fact";
  }
}

/** Kit lane of a workspace item, as `listForView` splits USER.md and MEMORY.md. */
export function curatedTargetOf(item: Pick<MemoryItem, "kind" | "sourceRef">): CuratedMemoryTarget {
  if (item.sourceRef.target === "user") return "user";
  return item.kind === "identity" || item.kind === "preference" ? "user" : "workspace";
}

const CURATED_KIND_LABELS: ReadonlySet<CuratedMemoryKind> = new Set([
  "identity",
  "preference",
  "constraint",
  "workflow_rule",
  "project_fact",
  "active_commitment",
]);

/** A workspace memory item in the curated-entry shape of the curate API and tool. */
export function toCuratedEntry(item: MemoryItem): CuratedMemoryEntry {
  const source: CuratedMemoryEntry["source"] =
    item.source === "user_stated" || item.source === "user_confirmed"
      ? "user_edit"
      : item.source === "inferred"
        ? "distill"
        : item.source === "import"
          ? "migration"
          : "agent_tool";
  return {
    id: item.id,
    workspaceId: item.workspaceId ?? "",
    ...(item.taskId ? { taskId: item.taskId } : {}),
    target: curatedTargetOf(item),
    kind: curatedKindOf(item),
    content: item.content,
    normalizedKey: normalizeMemoryKey(item.content),
    source,
    confidence: item.confidence,
    status: item.status === "active" ? "active" : "archived",
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    lastConfirmedAt: item.updatedAt,
  };
}

/** Items the user stated or confirmed are changed in the Memory Hub, not by the agent. */
function isUserOwned(item: Pick<MemoryItem, "source">): boolean {
  return item.source === "user_stated" || item.source === "user_confirmed";
}

/**
 * Curated memory: the workspace's facts in `memory_items` (workspace scope). The
 * `curated_memory_entries` table and the generated `.cowork/USER.md` / `MEMORY.md` blocks
 * are retired (kit-block-strip.ts removes leftover blocks); `curate`, `list` and
 * `getPromptEntries` keep their shapes over memory items (an entry id is a memory item id).
 */
export class CuratedMemoryService {
  private static workspaceRepo: WorkspaceRepository;
  private static initialized = false;

  static initialize(dbManager: DatabaseManager): void {
    if (this.initialized) return;
    const db = dbManager.getDatabase();
    MemoryWriteGate.initialize(dbManager);
    this.workspaceRepo = new WorkspaceRepository(db);
    this.initialized = true;
  }

  /** The workspace's memory items as curated entries (private items included). */
  static async list(
    workspaceId: string,
    params: {
      target?: CuratedMemoryTarget;
      kind?: CuratedMemoryKind;
      status?: "active" | "archived";
      limit?: number;
    } = {},
  ): Promise<CuratedMemoryEntry[]> {
    this.ensureInitialized();
    const repository = MemoryWriter.get()?.repository;
    if (!repository) return [];
    const items = await repository.list({
      workspaceId,
      scope: "workspace",
      statuses: [params.status ?? "active"],
      includePrivate: true,
      limit: 1000,
    });
    return items
      .map(toCuratedEntry)
      .filter((entry) => !params.target || entry.target === params.target)
      .filter((entry) => !params.kind || entry.kind === params.kind)
      .slice(0, Math.max(1, Math.floor(params.limit ?? 100)));
  }

  /** The stored workspace, or undefined when unknown or before initialization. */
  static async findWorkspace(workspaceId: string): Promise<Workspace | undefined> {
    if (!this.initialized) return undefined;
    return (await this.workspaceRepo.findById(workspaceId)) ?? undefined;
  }

  /**
   * Prompt entries from the user and workspace lanes (non-private items only), balanced so neither lane starves the other (PROMPT-6).
   */
  static async getPromptEntries(workspaceId: string, limit = 8): Promise<CuratedMemoryEntry[]> {
    this.ensureInitialized();
    const max = Math.max(1, Math.floor(limit));
    const repository = MemoryWriter.get()?.repository;
    if (!repository) return [];
    const entries = (
      await repository.list({
        workspaceId,
        scope: "workspace",
        statuses: ["active"],
        includePrivate: false,
        limit: 400,
      })
    ).map(toCuratedEntry);
    return balanceCuratedPromptEntries(
      entries.filter((entry) => entry.target === "user"),
      entries.filter((entry) => entry.target === "workspace"),
      max,
    );
  }

  static async curate(params: {
    workspaceId: string;
    taskId?: string;
    action: "add" | "replace" | "remove";
    target: CuratedMemoryTarget;
    id?: string;
    kind?: CuratedMemoryKind;
    content?: string;
    match?: string;
    reason?: string;
    origin?: MemoryWriteOrigin;
    skipMemoryWriteGate?: boolean;
  }): Promise<{
    success: boolean;
    entry?: CuratedMemoryEntry;
    staged?: boolean;
    pendingId?: string;
    error?: string;
  }> {
    this.ensureInitialized();

    const trimmedContent = normalizeCuratedContent(params.content || "");
    const trimmedMatch = normalizeMatch(params.match || "");
    const defaultKind: CuratedMemoryKind = params.target === "user" ? "preference" : "project_fact";

    if (params.action === "add" && !trimmedContent) {
      return { success: false, error: "content is required for add" };
    }
    const hasStableId = typeof params.id === "string" && params.id.trim().length > 0;
    if (params.action === "replace" && (!trimmedContent || (!trimmedMatch && !hasStableId))) {
      return { success: false, error: "replace requires content and either id or match" };
    }
    if (params.action === "remove" && !trimmedMatch && !hasStableId) {
      return { success: false, error: "remove requires either id or match" };
    }
    const writer = MemoryWriter.get();
    if (!writer) return { success: false, error: "Memory is not available yet." };

    let existing: MemoryItem | undefined;
    if (params.action !== "add") {
      if (hasStableId) {
        const byId = await writer.repository.findById(params.id!.trim());
        if (byId && (byId.workspaceId !== params.workspaceId || byId.scope !== "workspace")) {
          return {
            success: false,
            error: "Curated memory id does not belong to this workspace/target",
          };
        }
        if (byId && curatedTargetOf(byId) !== params.target) {
          return {
            success: false,
            error: "Curated memory id does not belong to this workspace/target",
          };
        }
        // An id from before a replace names a superseded revision: follow the record
        // (same source ref) to its active revision.
        const ref = byId && byId.status === "superseded" ? primarySourceRef(byId) : null;
        const current = ref
          ? (await writer.repository.findBySourceRef(ref.store, ref.id, ["active"])).find(
              (item) => item.workspaceId === params.workspaceId && item.scope === "workspace",
            )
          : byId;
        existing = current?.status === "active" ? current : undefined;
      } else {
        const resolved = await this.findMatchCandidate(
          writer,
          params.workspaceId,
          params.target,
          trimmedMatch,
          params.kind,
        );
        if (resolved.error) return { success: false, error: resolved.error };
        existing = resolved.item;
      }
      if (!existing) {
        return {
          success: false,
          error: hasStableId
            ? `No curated memory found for id "${params.id}"`
            : `No curated memory matched "${trimmedMatch}"`,
        };
      }
      if (isUserOwned(existing)) {
        return {
          success: false,
          error:
            "That memory was stated by the user; it can only be changed in the Memory Hub (What CoWork knows).",
        };
      }
    }

    if (!params.skipMemoryWriteGate) {
      const gate = await MemoryWriteGate.evaluate({
        workspaceId: params.workspaceId,
        taskId: params.taskId,
        target: "curated",
        action: params.action,
        origin: params.origin || "agent_tool",
        summary: `${params.action} ${params.target} curated memory`,
        payload: {
          action: params.action,
          target: params.target,
          id: params.id,
          kind: params.kind || defaultKind,
          content: trimmedContent || undefined,
          match: trimmedMatch || undefined,
          reason: params.reason,
        },
        oldValue: existing?.content,
        proposedValue: trimmedContent || params.match,
        reason: params.reason,
      });
      if (!gate.allowed) {
        if ("blocked" in gate) {
          return {
            success: false,
            error: gate.error,
          };
        }
        return {
          success: true,
          staged: true,
          pendingId: gate.pendingId,
        };
      }
    }

    let entry: CuratedMemoryEntry | undefined;
    let error: string | undefined;
    if (params.action === "add") {
      const result = await writer.ingest({
        ...curatedEntryCandidate({
          id: randomUUID(),
          workspaceId: params.workspaceId,
          taskId: params.taskId ?? null,
          target: params.target,
          kind: params.kind || defaultKind,
          content: trimmedContent,
          source: "agent_tool",
          confidence: 0.85,
        }),
        originText: trimmedContent,
      });
      if (result.status === "written") entry = toCuratedEntry(result.item);
      else error = memoryWriteSkipMessage(result);
    } else if (params.action === "replace") {
      const item = existing!;
      const kind = params.kind || curatedKindOf(item);
      const result = await reviseMemoryItem(
        writer,
        item,
        {
          content: trimmedContent,
          kind: memoryKindForCuratedKind(kind),
          source: "curated",
          confidence: Math.max(item.confidence, 0.85),
          sourceRefPatch: { target: params.target, curatedKind: kind },
        },
        MEMORY_LANE_STORES.curated,
      );
      if (result.status === "written") entry = toCuratedEntry(result.item);
      else error = memoryWriteSkipMessage(result);
    } else {
      const item = existing!;
      await writer.setStatus(item.id, "archived");
      const archived = await writer.repository.findById(item.id);
      entry = toCuratedEntry(archived ?? { ...item, status: "archived" });
    }

    return {
      success: !!entry,
      entry,
      ...(entry ? {} : { error: error ?? "Curated memory mutation failed" }),
    };
  }

  /**
   * A distilled (core memory) promotion: an inferred workspace item, or a curated one when
   * `source` says it was curated. A repeat reinforces the active item.
   */
  static async upsertDistilledEntry(params: {
    workspaceId: string;
    taskId?: string;
    target: CuratedMemoryTarget;
    kind: CuratedMemoryKind;
    content: string;
    confidence: number;
    source?: CuratedMemoryEntry["source"];
    skipMemoryWriteGate?: boolean;
  }): Promise<CuratedMemoryEntry | null> {
    this.ensureInitialized();
    const content = normalizeCuratedContent(params.content || "");
    if (!content) return null;
    const writer = MemoryWriter.get();
    if (!writer) return null;

    if (!params.skipMemoryWriteGate) {
      const gate = await MemoryWriteGate.evaluate({
        workspaceId: params.workspaceId,
        taskId: params.taskId,
        target: "curated",
        action: "upsert",
        origin: "distill",
        summary: `Promote distilled ${params.target} memory`,
        payload: {
          target: params.target,
          kind: params.kind,
          content,
          confidence: params.confidence,
          source: params.source || "distill",
        },
        proposedValue: content,
      });
      if (!gate.allowed) return null;
    }

    const result = await writer.ingest({
      ...curatedEntryCandidate({
        id: randomUUID(),
        workspaceId: params.workspaceId,
        taskId: params.taskId ?? null,
        target: params.target,
        kind: params.kind,
        content,
        source: params.source || "distill",
        confidence: params.confidence,
      }),
      originText: content,
    });
    return result.status === "written" ? toCuratedEntry(result.item) : null;
  }

  private static async findMatchCandidate(
    writer: MemoryWriter,
    workspaceId: string,
    target: CuratedMemoryTarget,
    match: string,
    kind?: CuratedMemoryKind,
  ): Promise<{
    item?: MemoryItem;
    error?: string;
  }> {
    const normalizedMatch = normalizeMemoryKey(match);
    if (!normalizedMatch) {
      return { error: "match is required" };
    }

    const items = (
      await writer.repository.list({
        workspaceId,
        scope: "workspace",
        statuses: ["active"],
        includePrivate: true,
        limit: 1000,
      })
    ).filter(
      (item) => curatedTargetOf(item) === target && (!kind || curatedKindOf(item) === kind),
    );

    const exactMatches = items.filter(
      (item) => normalizeMemoryKey(item.content) === normalizedMatch,
    );
    if (exactMatches.length === 1) {
      return { item: exactMatches[0] };
    }
    if (exactMatches.length > 1) {
      return {
        error:
          "Multiple memories matched exactly. Use memory_recall to get the stable id and retry.",
      };
    }

    const partialMatches = items.filter((item) =>
      normalizeMemoryKey(item.content).includes(normalizedMatch),
    );
    if (partialMatches.length === 1) {
      return { item: partialMatches[0] };
    }
    if (partialMatches.length > 1) {
      return {
        error:
          "Multiple memories matched. Use memory_recall to get the stable id or provide a more specific match.",
      };
    }

    return {};
  }

  private static ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error("[CuratedMemoryService] Not initialized. Call initialize() first.");
    }
  }
}
