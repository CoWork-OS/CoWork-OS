import { ensureWorkspaceDirectory } from "../utils/workspace-directory";
import { WorkspaceRepository } from "../database/repository-facades";
import { createHash, randomUUID } from "crypto";
import fs from "fs/promises";
import path from "path";
import type { DatabaseManager } from "../database/schema";
import type {
  CuratedMemoryEntry,
  CuratedMemoryKind,
  CuratedMemoryTarget,
} from "../../shared/types";
import { MemoryWriteGate, type MemoryWriteOrigin } from "./MemoryWriteGate";
import { MemoryWriter } from "./MemoryWriter";
import { KIT_FILE_STORE, MemoryItemsHubService } from "./MemoryItemsHubService";
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
import type { KitRenderState, MemoryItem, MemoryItemKind } from "./memory-items-types";

const USER_BLOCK_START = "<!-- cowork:auto:curated-user:start -->";
const USER_BLOCK_END = "<!-- cowork:auto:curated-user:end -->";
const WORKSPACE_BLOCK_START = "<!-- cowork:auto:curated-workspace:start -->";
const WORKSPACE_BLOCK_END = "<!-- cowork:auto:curated-workspace:end -->";
const MAX_CURATED_CONTENT_CHARS = 320;
const MAX_MATCH_CHARS = 120;
const MAX_SYNC_RETRIES = 3;

type KitView = "user" | "workspace";

type SyncFileParams = {
  workspaceId: string;
  view: KitView;
  filePath: string;
  /** Workspace-relative name, for provenance (`.cowork/USER.md`). */
  relPath: string;
  title: string;
  startMarker: string;
  endMarker: string;
};

type FileSnapshot = {
  content: string;
  mtimeMs: number;
};

export type CuratedMemoryFilesystemGuard = (candidatePath: string) => boolean;

interface SyncWorkspaceFilesOptions {
  readGuard?: CuratedMemoryFilesystemGuard;
  writeGuard?: CuratedMemoryFilesystemGuard;
}

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

function kindLabel(kind: CuratedMemoryKind): string {
  switch (kind) {
    case "identity":
      return "Identity";
    case "preference":
      return "Preference";
    case "constraint":
      return "Constraint";
    case "workflow_rule":
      return "Workflow Rule";
    case "project_fact":
      return "Project Fact";
    case "active_commitment":
      return "Active Commitment";
    default:
      return "Memory";
  }
}

function replaceOrAppendBlock(
  input: string,
  startMarker: string,
  endMarker: string,
  blockBody: string,
): string {
  const body = blockBody.trim();
  const block = `${startMarker}\n${body}\n${endMarker}`;
  const escapedStart = startMarker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedEnd = endMarker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`${escapedStart}[\\s\\S]*?${escapedEnd}`, "m");
  if (pattern.test(input)) {
    return input.replace(pattern, block).trimEnd() + "\n";
  }
  return `${input.trimEnd()}\n\n${block}\n`;
}

/** What the generated kit blocks render: a curated entry or a memory item. */
type KitBlockEntry = { id: string; kind: string; content: string };

const MEMORY_ITEM_KIND_LABELS: Record<MemoryItemKind, string> = {
  identity: "Identity",
  preference: "Preference",
  rule: "Rule",
  project_fact: "Project Fact",
  decision: "Decision",
  commitment: "Active Commitment",
  correction: "Correction",
  insight: "Insight",
  outcome: "Outcome",
};

function kitBlockLabel(kind: string): string {
  return MEMORY_ITEM_KIND_LABELS[kind as MemoryItemKind] ?? kindLabel(kind as CuratedMemoryKind);
}

function renderUserBlock(entries: KitBlockEntry[]): string {
  const lines = ["## Auto Curated Memory"];
  if (entries.length === 0) {
    lines.push("- status: empty");
    return lines.join("\n");
  }
  for (const entry of entries) {
    lines.push(`- ${entry.kind}: ${entry.content}`);
  }
  return lines.join("\n");
}

function renderWorkspaceBlock(entries: KitBlockEntry[]): string {
  const lines = ["## Auto Curated Memory"];
  if (entries.length === 0) {
    lines.push("- No curated workspace memory yet.");
    return lines.join("\n");
  }
  for (const entry of entries) {
    lines.push(`- ${kitBlockLabel(entry.kind)}: ${entry.content}`);
  }
  return lines.join("\n");
}

function renderKitLine(view: KitView, entry: KitBlockEntry): string {
  return `- ${view === "user" ? entry.kind : kitBlockLabel(entry.kind)}: ${entry.content}`;
}

function renderKitBlock(view: KitView, entries: KitBlockEntry[]): string {
  return view === "user" ? renderUserBlock(entries) : renderWorkspaceBlock(entries);
}

// ---- Kit back-sync (PROMPT-12) ----
//
// The auto-blocks in USER.md / MEMORY.md are views of `memory_items`. The last rendered
// block of each file is kept (`maintenance_state`, KitRenderState). On the next sync, a
// block that no longer matches it was edited by hand: its bullet lines are compared with
// the rendered ones, and adds, edits and removals go through MemoryWriter as `curated` (the agent can write
// kit files too, so these edits are never treated as the user's own statements)
// before the block is rendered again. Only blocks rendered from `memory_items` are synced
// back, so every rendered line maps to an item id.

const KIT_PLACEHOLDER_LINES = new Set(["- status: empty", "- no curated workspace memory yet."]);

/** Normalized form of one block line: whitespace collapsed, `*` bullets as `-`. */
function normalizeKitLine(line: string): string {
  return line
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\*\s+/, "- ");
}

function hashKitBody(body: string): string {
  const normalized = body.split(/\r?\n/).map(normalizeKitLine).filter(Boolean).join("\n");
  return createHash("sha256").update(normalized).digest("hex");
}

/** Body between the markers, or null when the block is missing or malformed. */
export function extractKitBlock(
  content: string,
  startMarker: string,
  endMarker: string,
): string | null {
  const start = content.indexOf(startMarker);
  if (start < 0) return null;
  const end = content.indexOf(endMarker, start + startMarker.length);
  if (end < 0) return null;
  return content.slice(start + startMarker.length, end).trim();
}

/** Bullet lines of a block, without the heading and the empty-state placeholder. */
function kitBulletLines(body: string): string[] {
  return body
    .split(/\r?\n/)
    .map(normalizeKitLine)
    .filter((line) => line.startsWith("- ") && !KIT_PLACEHOLDER_LINES.has(line.toLowerCase()));
}

const KIT_LABEL_KINDS: Record<string, MemoryItemKind> = {
  identity: "identity",
  preference: "preference",
  rule: "rule",
  constraint: "rule",
  "workflow rule": "rule",
  workflow_rule: "rule",
  "project fact": "project_fact",
  project_fact: "project_fact",
  decision: "decision",
  commitment: "commitment",
  "active commitment": "commitment",
  active_commitment: "commitment",
  correction: "correction",
  insight: "insight",
  outcome: "outcome",
};

/** `- Label: text` → kind and text; an unknown label is part of the text. */
export function parseKitLine(
  line: string,
  defaultKind: MemoryItemKind,
): { kind: MemoryItemKind; content: string; labelled: boolean } {
  const text = normalizeKitLine(line).replace(/^-\s+/, "");
  const colon = text.indexOf(":");
  if (colon > 0) {
    const kind = KIT_LABEL_KINDS[text.slice(0, colon).trim().toLowerCase()];
    if (kind) return { kind, content: text.slice(colon + 1).trim(), labelled: true };
  }
  return { kind: defaultKind, content: text, labelled: false };
}

function wordSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 1),
  );
}

function similarity(a: string, b: string): number {
  const left = wordSet(a);
  const right = wordSet(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / (left.size + right.size - shared);
}

export type KitBlockEdit =
  | { type: "add"; kind: MemoryItemKind; content: string }
  | { type: "edit"; id: string; kind: MemoryItemKind | null; content: string }
  | { type: "remove"; id: string };

/**
 * Compare a hand-edited block with the rendered one. Lines that still match a rendered
 * line are kept; a new line similar to a vanished one is an edit of that item; other new
 * lines are adds, other vanished lines are removals.
 */
export function diffKitBlock(
  rendered: KitRenderState["entries"],
  currentBody: string,
  view: KitView,
): KitBlockEdit[] {
  const defaultKind: MemoryItemKind = view === "user" ? "preference" : "project_fact";
  const unmatched = rendered.map((entry) => ({ ...entry, line: normalizeKitLine(entry.line) }));
  const added: string[] = [];
  for (const line of kitBulletLines(currentBody)) {
    const index = unmatched.findIndex((entry) => entry.line === line);
    if (index >= 0) unmatched.splice(index, 1);
    else added.push(line);
  }
  const edits: KitBlockEdit[] = [];
  for (const line of added) {
    const parsed = parseKitLine(line, defaultKind);
    if (!parsed.content) continue;
    let best = -1;
    let bestScore = 0;
    unmatched.forEach((entry, index) => {
      const score = similarity(parseKitLine(entry.line, defaultKind).content, parsed.content);
      if (score > bestScore) {
        best = index;
        bestScore = score;
      }
    });
    if (best >= 0 && bestScore >= 0.4) {
      const [entry] = unmatched.splice(best, 1);
      const previousKind = parseKitLine(entry.line, defaultKind).kind;
      edits.push({
        type: "edit",
        id: entry.id,
        kind: parsed.labelled && parsed.kind !== previousKind ? parsed.kind : null,
        content: parsed.content,
      });
    } else {
      edits.push({ type: "add", kind: parsed.kind, content: parsed.content });
    }
  }
  for (const entry of unmatched) edits.push({ type: "remove", id: entry.id });
  return edits;
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
 * Curated memory: the workspace's facts in `memory_items` (workspace scope), and the
 * generated `.cowork/USER.md` / `MEMORY.md` blocks that render them (docs/memory-engine.md
 * §5, "Generated kit views"). The `curated_memory_entries` table is retired; `curate`,
 * `list` and `getPromptEntries` keep their shapes over memory items (an entry id is a
 * memory item id).
 */
export class CuratedMemoryService {
  private static workspaceRepo: WorkspaceRepository;
  private static initialized = false;
  private static syncQueueByWorkspace = new Map<string, Promise<void>>();

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

  /**
   * Prompt entries from the user and workspace lanes (non-private items only, as in the
   * kit files), balanced so neither lane starves the other (PROMPT-6).
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
    filesystemReadGuard?: CuratedMemoryFilesystemGuard;
    filesystemWriteGuard?: CuratedMemoryFilesystemGuard;
  }): Promise<{
    success: boolean;
    entry?: CuratedMemoryEntry;
    updatedFile?: ".cowork/USER.md" | ".cowork/MEMORY.md";
    staged?: boolean;
    pendingId?: string;
    error?: string;
  }> {
    this.ensureInitialized();

    const targetFile = params.target === "user" ? ".cowork/USER.md" : ".cowork/MEMORY.md";
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

    const syncAccessError = await this.validateSyncAccess(
      params.workspaceId,
      params.filesystemReadGuard,
      params.filesystemWriteGuard,
    );
    if (syncAccessError) {
      return { success: false, error: syncAccessError };
    }

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
            updatedFile: targetFile,
          };
        }
        return {
          success: true,
          staged: true,
          pendingId: gate.pendingId,
          updatedFile: targetFile,
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

    await this.syncWorkspaceFiles(params.workspaceId, {
      readGuard: params.filesystemReadGuard,
      writeGuard: params.filesystemWriteGuard,
    });
    return {
      success: !!entry,
      entry,
      updatedFile: targetFile,
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
    filesystemReadGuard?: CuratedMemoryFilesystemGuard;
    filesystemWriteGuard?: CuratedMemoryFilesystemGuard;
  }): Promise<CuratedMemoryEntry | null> {
    this.ensureInitialized();
    const content = normalizeCuratedContent(params.content || "");
    if (!content) return null;
    const writer = MemoryWriter.get();
    if (!writer) return null;

    if (
      await this.validateSyncAccess(
        params.workspaceId,
        params.filesystemReadGuard,
        params.filesystemWriteGuard,
      )
    ) {
      return null;
    }

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
    await this.syncWorkspaceFiles(params.workspaceId, {
      readGuard: params.filesystemReadGuard,
      writeGuard: params.filesystemWriteGuard,
    });
    return result.status === "written" ? toCuratedEntry(result.item) : null;
  }

  static async syncWorkspaceFiles(
    workspaceId: string,
    options: SyncWorkspaceFilesOptions = {},
  ): Promise<void> {
    this.ensureInitialized();
    // The blocks are views of memory_items; without the memory engine there is nothing
    // to render (and no render state to sync edits back against).
    if (!MemoryWriter.get()) return;
    const previous = this.syncQueueByWorkspace.get(workspaceId) || Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const workspace = await this.workspaceRepo.findById(workspaceId);
        if (!workspace?.path) return;

        const root = path.join(workspace.path, ".cowork");
        const userPath = path.join(root, "USER.md");
        const memoryPath = path.join(root, "MEMORY.md");
        const canRead = (candidatePath: string): boolean =>
          !options.readGuard || options.readGuard(candidatePath) === true;
        const canWrite = (candidatePath: string): boolean =>
          !options.writeGuard || options.writeGuard(candidatePath) === true;
        if (!canRead(root) || !canRead(userPath) || !canRead(memoryPath)) {
          throw new Error("Access denied while reading curated memory files.");
        }
        if (!canWrite(root) || !canWrite(userPath) || !canWrite(memoryPath)) {
          throw new Error("Access denied while writing curated memory files.");
        }
        await ensureWorkspaceDirectory(workspace.path, root);
        // One file after the other: a back-synced edit in USER.md can move an item into
        // the MEMORY.md view (and the reverse).
        await this.syncFile({
          workspaceId,
          view: "user",
          filePath: userPath,
          relPath: ".cowork/USER.md",
          title: "# User Profile",
          startMarker: USER_BLOCK_START,
          endMarker: USER_BLOCK_END,
        });
        await this.syncFile({
          workspaceId,
          view: "workspace",
          filePath: memoryPath,
          relPath: ".cowork/MEMORY.md",
          title: "# Long-Term Memory",
          startMarker: WORKSPACE_BLOCK_START,
          endMarker: WORKSPACE_BLOCK_END,
        });
      })
      .finally(() => {
        if (this.syncQueueByWorkspace.get(workspaceId) === next) {
          this.syncQueueByWorkspace.delete(workspaceId);
        }
      });
    this.syncQueueByWorkspace.set(workspaceId, next);
    await next;
  }

  /** Entries for the generated USER.md / MEMORY.md blocks: the workspace's memory items. */
  private static async listKitBlockEntries(
    workspaceId: string,
    view: KitView,
  ): Promise<{ entries: KitBlockEntry[]; source: KitRenderState["source"] }> {
    const writer = MemoryWriter.get();
    const items: MemoryItem[] = writer
      ? await writer.repository.listForView(workspaceId, view, 200)
      : [];
    return { entries: items, source: "memory_items" };
  }

  /** Kit back-sync writes through the Hub operations. */
  private static kitEditor(): MemoryItemsHubService {
    return new MemoryItemsHubService({ getWriter: () => MemoryWriter.get() });
  }

  private static kitStateKey(params: SyncFileParams): string {
    return `${params.workspaceId}:${params.view}`;
  }

  /**
   * Route hand edits of a generated block back into `memory_items`. Returns `applied`
   * when items changed, `none` when there was nothing to sync back, and `concurrent` when
   * the file changed while the edits were being read (nothing is applied then).
   */
  private static async backSyncFile(
    params: SyncFileParams,
    snapshot: FileSnapshot,
  ): Promise<"applied" | "none" | "concurrent"> {
    const writer = MemoryWriter.get();
    if (!writer || snapshot.mtimeMs === 0) return "none";
    let state: KitRenderState | null;
    try {
      state = await writer.repository.getKitRenderState(this.kitStateKey(params));
    } catch {
      return "none";
    }
    // No baseline yet (first render, or a file that came with a repository): nothing to
    // compare against, so nothing is synced back.
    if (!state || state.source !== "memory_items") return "none";
    const body = extractKitBlock(snapshot.content, params.startMarker, params.endMarker);
    // A deleted block is re-rendered rather than read as "forget everything".
    if (body === null || hashKitBody(body) === state.hash) return "none";
    const edits = diffKitBlock(state.entries, body, params.view);
    if (edits.length === 0) return "none";

    const current = await fs.stat(params.filePath).catch(() => null);
    if ((current?.mtimeMs || 0) !== snapshot.mtimeMs) return "concurrent";

    const editor = this.kitEditor();
    const provenance = { file: params.relPath, target: params.view };
    let applied = 0;
    for (const edit of edits) {
      try {
        if (edit.type === "add") {
          const result = await writer.ingest({
            content: edit.content,
            kind: edit.kind,
            scope: "workspace",
            workspaceId: params.workspaceId,
            source: "curated",
            sourceRef: { store: KIT_FILE_STORE, id: randomUUID(), ...provenance },
            confidence: 0.85,
            originText: edit.content,
          });
          if (result.status === "written") applied += 1;
          continue;
        }
        const item = await writer.repository.findById(edit.id);
        // The item changed since the block was rendered: the database wins.
        if (!item || item.status !== "active" || item.workspaceId !== params.workspaceId) {
          continue;
        }
        // A file edit can't archive or rewrite what the user stated or confirmed in
        // the Hub; those changes have to be made there.
        if (item.source === "user_stated" || item.source === "user_confirmed") continue;
        if (edit.type === "remove") {
          await editor.removeItem(item, "archived");
          applied += 1;
        } else {
          const result = await editor.editItem(item, edit.content, KIT_FILE_STORE, {
            kind: edit.kind ?? undefined,
            extraRef: { file: params.relPath },
          });
          if (result.status === "written") applied += 1;
        }
      } catch (error) {
        console.warn("[CuratedMemoryService] Kit back-sync edit failed:", error);
      }
    }
    return applied > 0 ? "applied" : "none";
  }

  private static async validateSyncAccess(
    workspaceId: string,
    readGuard?: CuratedMemoryFilesystemGuard,
    writeGuard?: CuratedMemoryFilesystemGuard,
  ): Promise<string | undefined> {
    if (!readGuard && !writeGuard) return undefined;
    const workspace = await this.workspaceRepo.findById(workspaceId);
    if (!workspace?.path) return "Workspace path is unavailable for curated memory sync.";

    const root = path.join(workspace.path, ".cowork");
    const paths = [root, path.join(root, "USER.md"), path.join(root, "MEMORY.md")];
    if (readGuard && paths.some((candidatePath) => readGuard(candidatePath) !== true)) {
      return "Active access profile does not allow reading curated memory files.";
    }
    if (writeGuard && paths.some((candidatePath) => writeGuard(candidatePath) !== true)) {
      return "Active access profile does not allow writing curated memory files.";
    }
    return undefined;
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

  private static async readFileSnapshot(filePath: string, title: string): Promise<FileSnapshot> {
    try {
      const [content, stat] = await Promise.all([fs.readFile(filePath, "utf8"), fs.stat(filePath)]);
      return { content, mtimeMs: stat.mtimeMs };
    } catch {
      return { content: `${title}\n`, mtimeMs: 0 };
    }
  }

  /**
   * Back-sync hand edits, render the block, and write the file only when its content
   * changes. A file that changes while it is being synced is re-read (up to
   * MAX_SYNC_RETRIES); once edits were synced back from it, a concurrent change skips the
   * rewrite instead, and the next sync picks the new edits up.
   */
  private static async syncFile(params: SyncFileParams): Promise<void> {
    let backSynced = false;
    for (let attempt = 0; attempt < MAX_SYNC_RETRIES; attempt += 1) {
      const snapshot = await this.readFileSnapshot(params.filePath, params.title);
      if (!backSynced) {
        const outcome = await this.backSyncFile(params, snapshot);
        if (outcome === "concurrent") continue;
        backSynced = outcome === "applied";
      }
      const { entries, source } = await this.listKitBlockEntries(params.workspaceId, params.view);
      const body = renderKitBlock(params.view, entries);
      const next = replaceOrAppendBlock(
        snapshot.content,
        params.startMarker,
        params.endMarker,
        body,
      );
      const currentStat = await fs.stat(params.filePath).catch(() => null);
      const currentMtime = currentStat?.mtimeMs || 0;
      if (currentMtime !== snapshot.mtimeMs) {
        if (backSynced) {
          console.warn(
            `[CuratedMemoryService] ${params.relPath} changed during sync; it is re-rendered on the next sync.`,
          );
          return;
        }
        continue;
      }
      if (next !== snapshot.content) {
        await fs.writeFile(params.filePath, next, "utf8");
      }
      await this.recordKitRender(params, source, body, entries);
      return;
    }
    throw new Error(
      `Concurrent update detected while syncing curated memory file: ${params.filePath}`,
    );
  }

  private static async recordKitRender(
    params: SyncFileParams,
    source: KitRenderState["source"],
    body: string,
    entries: KitBlockEntry[],
  ): Promise<void> {
    const writer = MemoryWriter.get();
    if (!writer) return;
    try {
      await writer.repository.setKitRenderState(this.kitStateKey(params), {
        hash: hashKitBody(body),
        source,
        entries: entries.map((entry) => ({
          id: entry.id,
          line: renderKitLine(params.view, entry),
        })),
        renderedAt: Date.now(),
      });
    } catch (error) {
      console.warn("[CuratedMemoryService] Recording the rendered kit block failed:", error);
    }
  }

  private static ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error("[CuratedMemoryService] Not initialized. Call initialize() first.");
    }
  }
}
