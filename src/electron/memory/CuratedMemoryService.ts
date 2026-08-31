import fs from "fs/promises";
import path from "path";
import type { DatabaseManager } from "../database/schema";
import {
  CuratedMemoryRepository,
  WorkspaceRepository,
  type CuratedMemoryEntryRecord,
} from "../database/repositories";
import type {
  CuratedMemoryEntry,
  CuratedMemoryKind,
  CuratedMemoryTarget,
} from "../../shared/types";
import { MemoryWriteGate, type MemoryWriteOrigin } from "./MemoryWriteGate";

const USER_BLOCK_START = "<!-- cowork:auto:curated-user:start -->";
const USER_BLOCK_END = "<!-- cowork:auto:curated-user:end -->";
const WORKSPACE_BLOCK_START = "<!-- cowork:auto:curated-workspace:start -->";
const WORKSPACE_BLOCK_END = "<!-- cowork:auto:curated-workspace:end -->";
const MAX_CURATED_CONTENT_CHARS = 320;
const MAX_MATCH_CHARS = 120;
const MAX_SYNC_RETRIES = 3;

type SyncFileParams = {
  filePath: string;
  title: string;
  startMarker: string;
  endMarker: string;
  body: string;
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

function renderUserBlock(entries: CuratedMemoryEntryRecord[]): string {
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

function renderWorkspaceBlock(entries: CuratedMemoryEntryRecord[]): string {
  const lines = ["## Auto Curated Memory"];
  if (entries.length === 0) {
    lines.push("- No curated workspace memory yet.");
    return lines.join("\n");
  }
  for (const entry of entries) {
    lines.push(`- ${kindLabel(entry.kind)}: ${entry.content}`);
  }
  return lines.join("\n");
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

  static list(
    workspaceId: string,
    params: {
      target?: CuratedMemoryTarget;
      kind?: CuratedMemoryKind;
      status?: "active" | "archived";
      limit?: number;
    } = {},
  ): CuratedMemoryEntry[] {
    this.ensureInitialized();
    return this.curatedRepo.list({ workspaceId, ...params });
  }

  static getPromptEntries(workspaceId: string, limit = 8): CuratedMemoryEntry[] {
    this.ensureInitialized();
    return this.curatedRepo.list({
      workspaceId,
      status: "active",
      limit,
    });
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

    const syncAccessError = this.validateSyncAccess(
      params.workspaceId,
      params.filesystemReadGuard,
      params.filesystemWriteGuard,
    );
    if (syncAccessError) {
      return { success: false, error: syncAccessError };
    }

    let entry: CuratedMemoryEntryRecord | undefined;
    const existingById = hasStableId ? this.curatedRepo.findById(params.id!.trim()) : undefined;
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
          : this.findMatchCandidate(params.workspaceId, params.target, trimmedMatch, params.kind);
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
      const gate = MemoryWriteGate.evaluate({
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
      const existing = this.curatedRepo.findByNormalizedKey(
        params.workspaceId,
        params.target,
        params.kind || defaultKind,
        normalizedKey,
      );
      if (existing) {
        entry = this.curatedRepo.update(existing.id, {
          confidence: Math.max(existing.confidence, 0.85),
          lastConfirmedAt: Date.now(),
        });
      } else {
        entry = this.curatedRepo.create({
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
        entry = this.curatedRepo.update(existing.id, {
          kind: params.kind || existing.kind,
          content: trimmedContent,
          normalizedKey: normalizeMemoryKey(trimmedContent),
          confidence: Math.max(existing.confidence, 0.85),
          lastConfirmedAt: Date.now(),
        });
      } else {
        entry = this.curatedRepo.archive(existing.id);
      }
    }

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
      this.validateSyncAccess(
        params.workspaceId,
        params.filesystemReadGuard,
        params.filesystemWriteGuard,
      )
    ) {
      return null;
    }

    const normalizedKey = normalizeMemoryKey(content);
    if (!params.skipMemoryWriteGate) {
      const gate = MemoryWriteGate.evaluate({
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

    const existing = this.curatedRepo.findByNormalizedKey(
      params.workspaceId,
      params.target,
      params.kind,
      normalizedKey,
    );

    const entry = existing
      ? this.curatedRepo.update(existing.id, {
          confidence: Math.max(existing.confidence, params.confidence),
          lastConfirmedAt: Date.now(),
        })
      : this.curatedRepo.create({
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
        const workspace = this.workspaceRepo.findById(workspaceId);
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
        const userEntries = this.curatedRepo.list({
          workspaceId,
          target: "user",
          status: "active",
          limit: 200,
        });
        const workspaceEntries = this.curatedRepo.list({
          workspaceId,
          target: "workspace",
          status: "active",
          limit: 200,
        });

        await fs.mkdir(root, { recursive: true });
        await Promise.all([
          this.syncFile({
            filePath: userPath,
            title: "# User Profile",
            startMarker: USER_BLOCK_START,
            endMarker: USER_BLOCK_END,
            body: renderUserBlock(userEntries),
          }),
          this.syncFile({
            filePath: memoryPath,
            title: "# Long-Term Memory",
            startMarker: WORKSPACE_BLOCK_START,
            endMarker: WORKSPACE_BLOCK_END,
            body: renderWorkspaceBlock(workspaceEntries),
          }),
        ]);
      })
      .finally(() => {
        if (this.syncQueueByWorkspace.get(workspaceId) === next) {
          this.syncQueueByWorkspace.delete(workspaceId);
        }
      });
    this.syncQueueByWorkspace.set(workspaceId, next);
    await next;
  }

  private static validateSyncAccess(
    workspaceId: string,
    readGuard?: CuratedMemoryFilesystemGuard,
    writeGuard?: CuratedMemoryFilesystemGuard,
  ): string | undefined {
    if (!readGuard && !writeGuard) return undefined;
    const workspace = this.workspaceRepo.findById(workspaceId);
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

  private static findMatchCandidate(
    workspaceId: string,
    target: CuratedMemoryTarget,
    match: string,
    kind?: CuratedMemoryKind,
  ): {
    entry?: CuratedMemoryEntryRecord;
    error?: string;
  } {
    const normalizedMatch = normalizeMemoryKey(match);
    if (!normalizedMatch) {
      return { error: "match is required" };
    }

    const entries = this.curatedRepo.list({
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

  private static async syncFile(params: SyncFileParams): Promise<void> {
    for (let attempt = 0; attempt < MAX_SYNC_RETRIES; attempt += 1) {
      const snapshot = await this.readFileSnapshot(params.filePath, params.title);
      const next = replaceOrAppendBlock(
        snapshot.content,
        params.startMarker,
        params.endMarker,
        params.body,
      );
      const currentStat = await fs.stat(params.filePath).catch(() => null);
      const currentMtime = currentStat?.mtimeMs || 0;
      if (currentMtime !== snapshot.mtimeMs) {
        continue;
      }
      await fs.writeFile(params.filePath, next, "utf8");
      return;
    }
    throw new Error(
      `Concurrent update detected while syncing curated memory file: ${params.filePath}`,
    );
  }

  private static ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error("[CuratedMemoryService] Not initialized. Call initialize() first.");
    }
  }
}
