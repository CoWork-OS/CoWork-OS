import crypto from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { redactSensitiveMarkdownContent } from "./markdown-index-sql";
import { MemoryService } from "./MemoryService";
import type { MemorySourceKind, MemorySourceRow } from "./memory-source-sql";
import { confinedFilePath } from "../utils/confined-file";
import { evaluateWorkspaceFilesystemAccess } from "../security/access-profile-paths";

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
  /** True only when the excerpt and hash were read from the same stable file snapshot. */
  evidenceAvailable: boolean;
  observedContentHash: string | null;
}

type SourceEvidence = Pick<
  MemorySourceRecheck,
  "excerpt" | "evidenceAvailable" | "observedContentHash"
>;

export type MemorySourceUnitRunner = (name: string, args: unknown[]) => Promise<unknown>;

export interface MemorySourceRecheckDeps {
  run: MemorySourceUnitRunner;
  now?: () => number;
  log?: (message: string, error?: unknown) => void;
  /** Current workspace and privacy/profile authority, resolved again for each read. */
  resolveSourceRoot?: (workspaceId: string, filePath: string) => Promise<string | null>;
}

async function hashFile(filePath: string, root: string): Promise<string | null> {
  try {
    return (await readFileEvidence(filePath, root))?.observedContentHash ?? null;
  } catch {
    return null;
  }
}

/** Hash the full file while retaining a bounded excerpt from that same read. */
async function readFileEvidence(filePath: string, root: string): Promise<SourceEvidence | null> {
  // Registered roots and source paths are canonical. A root itself can also be replaced.
  if ((await fs.realpath(root)) !== root) throw new Error("Source root changed");
  const target = confinedFilePath(root, filePath);
  const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) return null;
    const named = await fs.lstat(confinedFilePath(root, filePath), { bigint: true });
    if (named.dev !== before.dev || named.ino !== before.ino) return null;
    const hash = crypto.createHash("sha256");
    const prefix: Buffer[] = [];
    let remaining = DREAM_EXCERPT_CHARS * 4;
    for await (const data of handle.createReadStream({ autoClose: false })) {
      const chunk = data as Buffer;
      hash.update(chunk);
      if (remaining > 0) {
        const part = chunk.subarray(0, remaining);
        prefix.push(part);
        remaining -= part.length;
      }
    }
    const after = await handle.stat({ bigint: true });
    const checked = confinedFilePath(root, filePath);
    const current = await fs.lstat(checked, { bigint: true });
    if (
      checked !== target ||
      current.dev !== before.dev ||
      current.ino !== before.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      return null;
    const text = Buffer.concat(prefix).toString("utf8");
    const clipped =
      text.length > DREAM_EXCERPT_CHARS ? `${text.slice(0, DREAM_EXCERPT_CHARS)}…` : text;
    return {
      excerpt: redactSensitiveMarkdownContent(clipped),
      evidenceAvailable: true,
      observedContentHash: hash.digest("hex"),
    };
  } finally {
    await handle.close();
  }
}

/** Recover the canonical root recorded by the source path plus its relative key. */
function sourceRoot(row: Pick<MemorySourceRow, "sourcePath" | "sourceKey">): string {
  if (!row.sourcePath || !path.isAbsolute(row.sourcePath)) throw new Error("Invalid source path");
  const parts = row.sourceKey.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.includes("\\")))
    throw new Error("Invalid source key");
  let root = row.sourcePath;
  for (const _part of parts) root = path.dirname(root);
  if (toPosix(path.relative(root, row.sourcePath)) !== row.sourceKey)
    throw new Error("Invalid source binding");
  return root;
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
  private readonly flags = new Map<string, Map<string, MemorySourceFlag>>();
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
      resolveSourceRoot: async (workspaceId, filePath) => {
        const workspace = await MemoryService.getWorkspace(workspaceId);
        if (!workspace) return null;
        const settings = await MemoryService.getSettings(workspaceId);
        if (
          !settings.enabled ||
          settings.privacyMode === "disabled" ||
          settings.privacyMode === "strict"
        )
          return null;
        if (evaluateWorkspaceFilesystemAccess(workspace, filePath, "read").decision !== "allow")
          return null;
        return fs.realpath(workspace.path);
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

  private async authorizedRoot(
    row: Pick<MemorySourceRow, "workspaceId" | "sourcePath" | "sourceKey">,
  ): Promise<string> {
    const root = sourceRoot(row);
    if (this.deps.resolveSourceRoot) {
      if (!row.workspaceId || !row.sourcePath) throw new Error("Source has no workspace");
      const current = await this.deps.resolveSourceRoot(row.workspaceId, row.sourcePath);
      if (!current || (await fs.realpath(current)) !== root)
        throw new Error("Source authority changed");
    }
    return root;
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
    const sources = this.flags.get(row.memoryRef) ?? new Map<string, MemorySourceFlag>();
    sources.set(row.id, {
      sourceKind: row.sourceKind,
      sourceKey: row.sourceKey,
      changedAt: row.changedAt ?? this.now(),
    });
    this.flags.set(row.memoryRef, sources);
  }

  private flagForMemory(memoryRef: string): MemorySourceFlag | undefined {
    const sources = this.flags.get(memoryRef);
    if (!sources) return undefined;
    return [...sources.values()].sort((a, b) => b.changedAt - a.changedAt)[0];
  }

  flagForRepoEntry(file: string, entryHash: string): MemorySourceFlag | undefined {
    return this.flagForMemory(repoEntrySourceRef(file, entryHash));
  }

  flagForItem(itemId: string): MemorySourceFlag | undefined {
    return this.flagForMemory(itemSourceRef(itemId));
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
    let contentHash: string | null = null;
    try {
      contentHash = await hashFile(
        resolved.absolute,
        await this.authorizedRoot({
          workspaceId: input.workspaceId,
          sourcePath: resolved.absolute,
          sourceKey: resolved.key,
        }),
      );
    } catch {
      return undefined;
    }
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
    this.clearFlag(row.memoryRef, row.id);
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
    this.clearFlag(row.memoryRef, row.id);
  }

  private clearFlag(memoryRef: string, sourceId: string, expectedChangedAt?: number | null): void {
    const sources = this.flags.get(memoryRef);
    if (!sources) return;
    const flag = sources.get(sourceId);
    if (!flag || (expectedChangedAt !== undefined && flag.changedAt !== expectedChangedAt)) return;
    sources.delete(sourceId);
    if (sources.size === 0) this.flags.delete(memoryRef);
    this.stamp += 1;
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
    const first = rows[0];
    const observedPath = await fs.realpath(input.absolutePath).catch(() => null);
    let current: string | null = null;
    if (first.sourcePath && first.sourcePath === observedPath) {
      try {
        current = await hashFile(first.sourcePath, await this.authorizedRoot(first));
      } catch {
        /* unavailable source */
      }
    }
    const changed = rows.filter((row) => row.contentHash !== current);
    const restored = rows.filter((row) => row.needsRecheck && row.contentHash === current);
    const now = this.now();
    if (changed.length > 0) {
      await this.deps.run("memorySources_markChanged", [changed.map((row) => row.id), now]);
      const latest = (await this.deps.run("memorySources_listForSource", [
        "file",
        toPosix(input.relPath),
        input.workspaceId,
      ])) as MemorySourceRow[];
      for (const row of latest) if (row.needsRecheck) this.setFlag(row);
    }
    for (const row of restored) {
      const cleared = await this.deps.run("memorySources_markReviewed", [
        row.id,
        row.contentHash,
        now,
        row,
      ]);
      if (cleared) this.clearFlag(row.memoryRef, row.id, row.changedAt);
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
    const latest = (await this.deps.run("memorySources_listForSource", [
      "connector",
      resourceUri,
      null,
    ])) as MemorySourceRow[];
    for (const row of latest) if (row.needsRecheck) this.setFlag(row);
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
        ...(await this.evidenceOf(row)),
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  private async evidenceOf(row: MemorySourceRow): Promise<SourceEvidence> {
    const unavailable = (excerpt: string): SourceEvidence => ({
      excerpt,
      evidenceAvailable: false,
      observedContentHash: null,
    });
    if (row.sourceKind === "connector") {
      return unavailable(
        "(the connector reported that this record was updated; its current content is not available here)",
      );
    }
    if (!row.sourcePath) return unavailable("(the file's current content is not available)");
    try {
      return (
        (await readFileEvidence(row.sourcePath, await this.authorizedRoot(row))) ??
        unavailable("(the file changed while its evidence was being read)")
      );
    } catch {
      return unavailable("(the file was deleted or cannot be read)");
    }
  }

  /** Clear confirmed rechecks only while both the evidence and source revision still match. */
  async markReviewed(rechecks: MemorySourceRecheck[]): Promise<void> {
    const now = this.now();
    for (const recheck of rechecks) {
      const { row, evidenceAvailable, observedContentHash } = recheck;
      if (
        !evidenceAvailable ||
        !observedContentHash ||
        row.sourceKind !== "file" ||
        !row.sourcePath
      )
        continue;
      let current: string | null = null;
      try {
        current = await hashFile(row.sourcePath, await this.authorizedRoot(row));
      } catch {
        /* invalid saved binding */
      }
      if (current !== observedContentHash) continue;
      const cleared = await this.deps.run("memorySources_markReviewed", [
        row.id,
        observedContentHash,
        now,
        row,
      ]);
      if (cleared) this.clearFlag(row.memoryRef, row.id, row.changedAt);
    }
  }

  /** Links whose memory no longer exists. */
  async forget(rows: MemorySourceRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.deps.run("memorySources_delete", [rows.map((row) => row.id)]);
    for (const row of rows) this.clearFlag(row.memoryRef, row.id);
  }
}
