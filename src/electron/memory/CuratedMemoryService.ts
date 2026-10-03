import { ensureWorkspaceDirectory } from "../utils/workspace-directory";
import { WorkspaceRepository } from "../database/repository-facades";
import { CuratedMemoryRepository } from "../database/repository-facades";
import { createHash, randomUUID } from "crypto";
import fs from "fs/promises";
import path from "path";
import type { DatabaseManager } from "../database/schema";
import { type CuratedMemoryEntryRecord } from "../database/repositories";
import type {
  CuratedMemoryEntry,
  CuratedMemoryKind,
  CuratedMemoryTarget,
} from "../../shared/types";
import { MemoryWriteGate, type MemoryWriteOrigin } from "./MemoryWriteGate";
import { bumpHotMemoryVersion } from "./hot-memory-version";
import { MemoryWriter } from "./MemoryWriter";
import { KIT_FILE_STORE, MemoryItemsHubService } from "./MemoryItemsHubService";
import { MEMORY_LANE_STORES, curatedEntryCandidate } from "./memory-items-lanes";
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

export class CuratedMemoryService {
  private static curatedRepo: CuratedMemoryRepository;
  private static workspaceRepo: WorkspaceRepository;
  private static initialized = false;
  private static syncQueueByWorkspace = new Map<string, Promise<void>>();

  static initialize(dbManager: DatabaseManager): void {
    if (this.initialized) return;
    const db = dbManager.getDatabase();
    MemoryWriteGate.initialize(dbManager);
    this.curatedRepo = new CuratedMemoryRepository(db);
    this.workspaceRepo = new WorkspaceRepository(db);
    this.initialized = true;
  }

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
    return this.curatedRepo.list({ workspaceId, ...params });
  }

  static async getPromptEntries(workspaceId: string, limit = 8): Promise<CuratedMemoryEntry[]> {
    this.ensureInitialized();
    const max = Math.max(1, Math.floor(limit));
    // The repository orders the user lane first, so one combined query starves
    // workspace rules once there are `limit` user entries (PROMPT-6). Read each
    // lane on its own and balance them.
    const [userEntries, workspaceEntries] = await Promise.all([
      this.curatedRepo.list({ workspaceId, target: "user", status: "active", limit: max }),
      this.curatedRepo.list({ workspaceId, target: "workspace", status: "active", limit: max }),
    ]);
    return balanceCuratedPromptEntries(userEntries, workspaceEntries, max);
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
    const defaultKind = params.target === "user" ? "preference" : "project_fact";

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

    const syncAccessError = await this.validateSyncAccess(
      params.workspaceId,
      params.filesystemReadGuard,
      params.filesystemWriteGuard,
    );
    if (syncAccessError) {
      return { success: false, error: syncAccessError };
    }

    let entry: CuratedMemoryEntryRecord | undefined;
    const existingById = hasStableId
      ? await this.curatedRepo.findById(params.id!.trim())
      : undefined;
    if (
      existingById &&
      (existingById.workspaceId !== params.workspaceId || existingById.target !== params.target)
    ) {
      return {
        success: false,
        error: "Curated memory id does not belong to this workspace/target",
      };
    }
    const resolvedMatch =
      params.action === "add"
        ? undefined
        : existingById
          ? { entry: existingById }
          : await this.findMatchCandidate(
              params.workspaceId,
              params.target,
              trimmedMatch,
              params.kind,
            );
    if (resolvedMatch?.error) {
      return {
        success: false,
        error: resolvedMatch.error,
      };
    }
    if (params.action !== "add" && !resolvedMatch?.entry) {
      return {
        success: false,
        error: hasStableId
          ? `No curated memory found for id "${params.id}"`
          : `No curated memory matched "${trimmedMatch}"`,
      };
    }

    if (!params.skipMemoryWriteGate) {
      const oldValue = params.action === "add" ? undefined : resolvedMatch?.entry?.content;
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
        oldValue,
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

    if (params.action === "add") {
      const normalizedKey = normalizeMemoryKey(trimmedContent);
      const existing = await this.curatedRepo.findByNormalizedKey(
        params.workspaceId,
        params.target,
        params.kind || defaultKind,
        normalizedKey,
      );
      if (existing) {
        entry = await this.curatedRepo.update(existing.id, {
          confidence: Math.max(existing.confidence, 0.85),
          lastConfirmedAt: Date.now(),
        });
      } else {
        entry = await this.curatedRepo.create({
          workspaceId: params.workspaceId,
          taskId: params.taskId,
          target: params.target,
          kind: params.kind || defaultKind,
          content: trimmedContent,
          normalizedKey,
          source: "agent_tool",
          confidence: 0.85,
          status: "active",
          lastConfirmedAt: Date.now(),
        });
      }
    } else {
      const existing = resolvedMatch!.entry!;
      if (params.action === "replace") {
        entry = await this.curatedRepo.update(existing.id, {
          kind: params.kind || existing.kind,
          content: trimmedContent,
          normalizedKey: normalizeMemoryKey(trimmedContent),
          confidence: Math.max(existing.confidence, 0.85),
          lastConfirmedAt: Date.now(),
        });
      } else {
        entry = await this.curatedRepo.archive(existing.id);
      }
    }

    if (entry) {
      await this.mirrorToMemoryItems(entry, params.action === "remove" ? "archived" : "active");
    }
    bumpHotMemoryVersion();
    await this.syncWorkspaceFiles(params.workspaceId, {
      readGuard: params.filesystemReadGuard,
      writeGuard: params.filesystemWriteGuard,
    });
    return {
      success: !!entry,
      entry,
      updatedFile: targetFile,
      ...(entry ? {} : { error: "Curated memory mutation failed" }),
    };
  }

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

    if (
      await this.validateSyncAccess(
        params.workspaceId,
        params.filesystemReadGuard,
        params.filesystemWriteGuard,
      )
    ) {
      return null;
    }

    const normalizedKey = normalizeMemoryKey(content);
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

    const existing = await this.curatedRepo.findByNormalizedKey(
      params.workspaceId,
      params.target,
      params.kind,
      normalizedKey,
    );

    const entry = existing
      ? await this.curatedRepo.update(existing.id, {
          confidence: Math.max(existing.confidence, params.confidence),
          lastConfirmedAt: Date.now(),
        })
      : await this.curatedRepo.create({
          workspaceId: params.workspaceId,
          taskId: params.taskId,
          target: params.target,
          kind: params.kind,
          content,
          normalizedKey,
          source: params.source || "distill",
          confidence: params.confidence,
          status: "active",
          lastConfirmedAt: Date.now(),
        });

    if (entry) await this.mirrorToMemoryItems(entry, "active");
    bumpHotMemoryVersion();
    await this.syncWorkspaceFiles(params.workspaceId, {
      readGuard: params.filesystemReadGuard,
      writeGuard: params.filesystemWriteGuard,
    });
    return entry || null;
  }

  static async syncWorkspaceFiles(
    workspaceId: string,
    options: SyncWorkspaceFilesOptions = {},
  ): Promise<void> {
    this.ensureInitialized();
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

  /**
   * Dual write (memory engine Phase 2): curated entries stay the system of record for
   * reads this wave, and every change is mirrored into `memory_items` through MemoryWriter.
   * Awaited so the kit files rendered next see it; a failure is logged and never fails
   * the curated write.
   */
  private static async mirrorToMemoryItems(
    entry: CuratedMemoryEntry,
    status: "active" | "archived",
  ): Promise<void> {
    const writer = MemoryWriter.get();
    if (!writer) return;
    try {
      if (status === "archived") {
        await writer.setStatusBySourceRef(MEMORY_LANE_STORES.curated, entry.id, "archived");
      } else {
        await writer.ingest(curatedEntryCandidate(entry));
      }
    } catch (error) {
      console.warn("[CuratedMemoryService] Memory item dual write failed:", error);
    }
  }

  /**
   * Entries for the generated USER.md / MEMORY.md blocks. Once the legacy lanes have been
   * copied into `memory_items`, the blocks are a view of the workspace's memory items;
   * before that (and without a writer) they render from the curated table as before.
   */
  private static async listKitBlockEntries(
    workspaceId: string,
    view: KitView,
  ): Promise<{ entries: KitBlockEntry[]; source: KitRenderState["source"] }> {
    const writer = MemoryWriter.get();
    if (writer) {
      try {
        if (await writer.repository.isLaneMigrationComplete()) {
          const items: MemoryItem[] = await writer.repository.listForView(workspaceId, view, 200);
          return { entries: items, source: "memory_items" };
        }
      } catch (error) {
        console.warn(
          "[CuratedMemoryService] Falling back to curated entries for kit files:",
          error,
        );
      }
    }
    const entries = await this.curatedRepo.list({
      workspaceId,
      target: view,
      status: "active",
      limit: 200,
    });
    return { entries, source: "curated" };
  }

  /**
   * Apply a Memory Hub or kit edit to the curated entry a memory item mirrors, without a
   * kit sync (the caller renders the files). No dual write: `memory_items` already has it.
   */
  static async applyMirroredEdit(entryId: string, content: string): Promise<void> {
    this.ensureInitialized();
    const entry = await this.curatedRepo.findById(entryId);
    const trimmed = normalizeCuratedContent(content);
    if (!entry || entry.status !== "active" || !trimmed) return;
    await this.curatedRepo.update(entry.id, {
      content: trimmed,
      normalizedKey: normalizeMemoryKey(trimmed),
      lastConfirmedAt: Date.now(),
    });
    bumpHotMemoryVersion();
  }

  /** Archive the curated entry a forgotten or removed memory item mirrors (no kit sync). */
  static async archiveMirroredEntry(entryId: string): Promise<void> {
    this.ensureInitialized();
    const entry = await this.curatedRepo.findById(entryId);
    if (!entry || entry.status !== "active") return;
    await this.curatedRepo.archive(entry.id);
    bumpHotMemoryVersion();
  }

  /** Kit back-sync writes through the Hub operations, with the curated lane mirrored. */
  private static kitEditor(): MemoryItemsHubService {
    return new MemoryItemsHubService({
      getWriter: () => MemoryWriter.get(),
      legacy: {
        edit: async (ref, content) => {
          if (ref.store === MEMORY_LANE_STORES.curated) {
            await this.applyMirroredEdit(ref.id, content);
          }
        },
        remove: async (ref) => {
          if (ref.store === MEMORY_LANE_STORES.curated) await this.archiveMirroredEntry(ref.id);
        },
      },
    });
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
    workspaceId: string,
    target: CuratedMemoryTarget,
    match: string,
    kind?: CuratedMemoryKind,
  ): Promise<{
    entry?: CuratedMemoryEntryRecord;
    error?: string;
  }> {
    const normalizedMatch = normalizeMemoryKey(match);
    if (!normalizedMatch) {
      return { error: "match is required" };
    }

    const entries = await this.curatedRepo.list({
      workspaceId,
      target,
      kind,
      status: "active",
      limit: 200,
    });

    const exactMatches = entries.filter(
      (entry) => normalizeMemoryKey(entry.content) === normalizedMatch,
    );
    if (exactMatches.length === 1) {
      return { entry: exactMatches[0] };
    }
    if (exactMatches.length > 1) {
      return {
        error:
          "Multiple curated memories matched exactly. Use memory_curated_read to get the stable id and retry.",
      };
    }

    const partialMatches = entries.filter((entry) =>
      normalizeMemoryKey(entry.content).includes(normalizedMatch),
    );
    if (partialMatches.length === 1) {
      return { entry: partialMatches[0] };
    }
    if (partialMatches.length > 1) {
      return {
        error:
          "Multiple curated memories matched. Use memory_curated_read to get the stable id or provide a more specific match.",
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
