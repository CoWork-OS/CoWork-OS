import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { redactSensitiveMarkdownContent } from "./markdown-index-sql";
import { MemoryService } from "./MemoryService";
import type { MemorySourceKind, MemorySourceRow } from "./memory-source-sql";

/**
 * Source-tied memory (WP15): a memory saved from a workspace file or a connector record keeps
 * a link to that source and the file's content hash. When the file changes (the ambient file
 * watcher) or the record is updated (a connector's `resource_updated`), the memory is flagged:
 * recall and the prompt say its source may have changed, and the next dream rechecks it
 * against the current source. Flags are cached in memory; this service is their only writer.
 */

export const SOURCE_CHANGED_NOTE = "source may have changed";
const REPO_ENTRY_PREFIX = "repo-entry:";
const ITEM_PREFIX = "memory:";
/** Characters of a changed file the dream sees. */
const DREAM_EXCERPT_CHARS = 1_500;

export function repoEntrySourceRef(file: string, entryHash: string): string {
  return `${REPO_ENTRY_PREFIX}${file.replace(/\\/g, "/")}#${entryHash}`;
}

export function itemSourceRef(itemId: string): string {
  return `${ITEM_PREFIX}${itemId}`;
}

export function parseRepoEntrySourceRef(ref: string): { file: string; entryHash: string } | null {
  if (!ref.startsWith(REPO_ENTRY_PREFIX)) return null;
  const body = ref.slice(REPO_ENTRY_PREFIX.length);
  const at = body.lastIndexOf("#");
  if (at <= 0 || at === body.length - 1) return null;
  return { file: body.slice(0, at), entryHash: body.slice(at + 1) };
}

export interface MemorySourceFlag {
  sourceKind: MemorySourceKind;
  sourceKey: string;
  changedAt: number;
}

/** A flagged memory folder entry, with what the dream needs to recheck it. */
export interface MemorySourceRecheck {
  row: MemorySourceRow;
  file: string;
  entryHash: string;
  source: string;
  changedAt: number;
  /** The current source text (bounded), or a note when there is none. */
  excerpt: string;
}

export type MemorySourceUnitRunner = (name: string, args: unknown[]) => Promise<unknown>;

export interface MemorySourceRecheckDeps {
  run: MemorySourceUnitRunner;
  now?: () => number;
  log?: (message: string, error?: unknown) => void;
}

async function hashFile(filePath: string): Promise<string | null> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return null;
    const hash = crypto.createHash("sha256");
    for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
    return hash.digest("hex");
  } catch {
    return null;
  }
}

function toPosix(relPath: string): string {
  return relPath.split(path.sep).join("/").replace(/\\/g, "/").replace(/^\.\//, "");
}

/** `file` inside `root` (after resolving links): its real path and workspace-relative key. */
async function resolveInWorkspace(
  root: string,
  file: string,
): Promise<{ absolute: string; key: string } | null> {
  try {
    const realRoot = await fs.realpath(root);
    const real = await fs.realpath(path.resolve(root, file));
    const relative = path.relative(realRoot, real);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
    return { absolute: real, key: toPosix(relative) };
  } catch {
    return null;
  }
}

export class MemorySourceRecheckService {
  private static instance: MemorySourceRecheckService | null = null;
  private readonly flags = new Map<string, MemorySourceFlag>();
  private stamp = 0;

  constructor(private readonly deps: MemorySourceRecheckDeps) {}

  /** The process-wide service over the memory domain's statement port. */
  static getDefault(): MemorySourceRecheckService {
    this.instance ??= new MemorySourceRecheckService({
      run: async (name, args) => {
        const sql = MemoryService.getStatements();
        if (!sql) throw new Error("memory store is not initialized");
        return (sql.unit as (unit: string, unitArgs: unknown[]) => Promise<unknown>)(name, args);
      },
    });
    return this.instance;
  }

  static setDefault(instance: MemorySourceRecheckService | null): void {
    this.instance = instance;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Changes whenever a flag is set or cleared (prompt caches key on it). */
  version(): string {
    return String(this.stamp);
  }

  /** Load the flags from the database (at startup). */
  async load(): Promise<void> {
    const rows = (await this.deps.run("memorySources_listFlagged", [1_000])) as MemorySourceRow[];
    this.flags.clear();
    for (const row of rows) this.setFlag(row);
    this.stamp += 1;
  }

  private setFlag(row: MemorySourceRow): void {
    this.flags.set(row.memoryRef, {
      sourceKind: row.sourceKind,
      sourceKey: row.sourceKey,
      changedAt: row.changedAt ?? this.now(),
    });
  }

  flagForRepoEntry(file: string, entryHash: string): MemorySourceFlag | undefined {
    return this.flags.get(repoEntrySourceRef(file, entryHash));
  }

  flagForItem(itemId: string): MemorySourceFlag | undefined {
    return this.flags.get(itemSourceRef(itemId));
  }

  /**
   * Link a memory to a workspace file as it is now. Undefined when the file is not inside
   * the workspace or does not exist.
   */
  async trackFile(input: {
    workspaceId: string;
    workspaceRoot: string;
    file: string;
    memoryRef: string;
  }): Promise<{ sourceKey: string } | undefined> {
    const resolved = await resolveInWorkspace(input.workspaceRoot, input.file);
    if (!resolved) return undefined;
    const contentHash = await hashFile(resolved.absolute);
    if (!contentHash) return undefined;
    const row = (await this.deps.run("memorySources_track", [
      {
        workspaceId: input.workspaceId,
        sourceKind: "file",
        sourceKey: resolved.key,
        sourcePath: resolved.absolute,
        contentHash,
        memoryRef: input.memoryRef,
        now: this.now(),
      },
    ])) as MemorySourceRow;
    this.clearFlag(row.memoryRef);
    return { sourceKey: resolved.key };
  }

  /** Link a memory to a connector record (an MCP resource URI). */
  async trackConnector(input: { resourceUri: string; memoryRef: string }): Promise<void> {
    const row = (await this.deps.run("memorySources_track", [
      {
        workspaceId: null,
        sourceKind: "connector",
        sourceKey: input.resourceUri,
        sourcePath: null,
        contentHash: null,
        memoryRef: input.memoryRef,
        now: this.now(),
      },
    ])) as MemorySourceRow;
    this.clearFlag(row.memoryRef);
  }

  private clearFlag(memoryRef: string): void {
    if (this.flags.delete(memoryRef)) this.stamp += 1;
  }

  /**
   * A workspace file changed: memories saved from it are flagged when its content differs
   * from what they were saved from, and unflagged when it is back to that content.
   */
  async onFileChanged(input: {
    workspaceId: string;
    relPath: string;
    absolutePath: string;
  }): Promise<number> {
    const rows = (await this.deps.run("memorySources_listForSource", [
      "file",
      toPosix(input.relPath),
      input.workspaceId,
    ])) as MemorySourceRow[];
    if (rows.length === 0) return 0;
    const current = await hashFile(input.absolutePath);
    const changed = rows.filter((row) => row.contentHash !== current);
    const restored = rows.filter((row) => row.needsRecheck && row.contentHash === current);
    const now = this.now();
    if (changed.length > 0) {
      await this.deps.run("memorySources_markChanged", [changed.map((row) => row.id), now]);
      for (const row of changed) this.setFlag({ ...row, changedAt: now });
    }
    for (const row of restored) {
      await this.deps.run("memorySources_markReviewed", [row.id, row.contentHash, now]);
      this.flags.delete(row.memoryRef);
    }
    if (changed.length > 0 || restored.length > 0) this.stamp += 1;
    return changed.length;
  }

  /** A connector record was updated: memories saved from it are flagged. */
  async onConnectorRecordChanged(resourceUri: string): Promise<number> {
    const rows = (await this.deps.run("memorySources_listForSource", [
      "connector",
      resourceUri,
      null,
    ])) as MemorySourceRow[];
    if (rows.length === 0) return 0;
    const now = this.now();
    await this.deps.run("memorySources_markChanged", [rows.map((row) => row.id), now]);
    for (const row of rows) this.setFlag({ ...row, changedAt: now });
    this.stamp += 1;
    return rows.length;
  }

  /** Flagged memory folder entries for the next dream, most recently changed first. */
  async pendingForDream(limit = 10): Promise<MemorySourceRecheck[]> {
    const rows = (await this.deps.run("memorySources_listFlagged", [
      Math.max(1, limit) * 3,
    ])) as MemorySourceRow[];
    const out: MemorySourceRecheck[] = [];
    for (const row of rows) {
      const entry = parseRepoEntrySourceRef(row.memoryRef);
      if (!entry) continue;
      out.push({
        row,
        file: entry.file,
        entryHash: entry.entryHash,
        source: row.sourceKey,
        changedAt: row.changedAt ?? row.observedAt,
        excerpt: await this.excerptOf(row),
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  private async excerptOf(row: MemorySourceRow): Promise<string> {
    if (row.sourceKind === "connector") {
      return "(the connector reported that this record was updated; its current content is not available here)";
    }
    if (!row.sourcePath) return "(the file's current content is not available)";
    try {
      const handle = await fs.open(row.sourcePath, "r");
      try {
        const buffer = Buffer.alloc(DREAM_EXCERPT_CHARS * 4);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const text = buffer.subarray(0, bytesRead).toString("utf8");
        const clipped =
          text.length > DREAM_EXCERPT_CHARS ? `${text.slice(0, DREAM_EXCERPT_CHARS)}…` : text;
        return redactSensitiveMarkdownContent(clipped);
      } finally {
        await handle.close();
      }
    } catch {
      return "(the file was deleted or cannot be read)";
    }
  }

  /** Rechecked against the current source: the flags clear and the current hash is kept. */
  async markReviewed(rows: MemorySourceRow[]): Promise<void> {
    const now = this.now();
    for (const row of rows) {
      const hash =
        row.sourceKind === "file" && row.sourcePath ? await hashFile(row.sourcePath) : null;
      await this.deps.run("memorySources_markReviewed", [row.id, hash, now]);
      this.flags.delete(row.memoryRef);
    }
    if (rows.length > 0) this.stamp += 1;
  }

  /** Links whose memory no longer exists. */
  async forget(rows: MemorySourceRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.deps.run("memorySources_delete", [rows.map((row) => row.id)]);
    for (const row of rows) this.flags.delete(row.memoryRef);
    this.stamp += 1;
  }
}
