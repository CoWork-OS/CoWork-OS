/**
 * Kit back-sync on file edit (docs/memory-engine.md §5, "Generated kit views"): watches the
 * `.cowork` directory of workspaces whose kit is in use and, a moment after `USER.md` or
 * `MEMORY.md` changes, runs the kit sync so hand edits of the generated blocks reach
 * `memory_items` (through MemoryWriter, `curated` trust) without waiting for the next
 * curated write or Memory Hub change.
 *
 * - Debounced per workspace (`KIT_EDIT_DEBOUNCE_MS`): an editor's save burst is one sync.
 * - The sync re-reads the workspace and checks its access profile (read and write guards)
 *   at that time, and refuses kit files that are symlinks or resolve outside the workspace
 *   (`kitFilesInsideWorkspace`).
 * - A sync writes the file only when its content changes, so the event from that write
 *   leads to one sync that does nothing: no loop.
 * - At most `MAX_WATCHED_WORKSPACES` directories are watched; the least recently used is
 *   dropped first. Installed by `startMemoryEngine` and closed with it.
 */
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { createLogger } from "../utils/logger";

const logger = createLogger("KitFileWatcher");

export const KIT_EDIT_DEBOUNCE_MS = 1500;
export const MAX_WATCHED_WORKSPACES = 32;
export const KIT_FILE_NAMES: readonly string[] = ["USER.md", "MEMORY.md"];

export interface KitWatchHandle {
  close(): void;
}

export interface KitFileWatcherDeps {
  /** Watch a directory (non-recursive); the listener gets the changed file's name. */
  watch(
    directory: string,
    onChange: (fileName: string | null) => void,
    onError: (error: unknown) => void,
  ): KitWatchHandle;
  /** Run the kit sync for a file edit (`CuratedMemoryService.syncWorkspaceFiles`). */
  sync(workspaceId: string): Promise<void>;
  setTimer(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimer(timer: ReturnType<typeof setTimeout>): void;
  debounceMs?: number;
  maxWorkspaces?: number;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Whether the workspace's `.cowork` directory and kit files stay inside the workspace:
 * the directory and the files must not be symlinks, and their real paths must resolve
 * under the workspace's real path. Missing files are fine (the sync creates them).
 */
export async function kitFilesInsideWorkspace(workspacePath: string): Promise<boolean> {
  try {
    const realWorkspace = await fsp.realpath(workspacePath);
    const root = path.join(workspacePath, ".cowork");
    const rootStat = await fsp.lstat(root).catch(() => null);
    if (!rootStat) return true;
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return false;
    if (!isInside(realWorkspace, await fsp.realpath(root))) return false;
    for (const name of KIT_FILE_NAMES) {
      const filePath = path.join(root, name);
      const stat = await fsp.lstat(filePath).catch(() => null);
      if (!stat) continue;
      if (stat.isSymbolicLink() || !stat.isFile()) return false;
      if (!isInside(realWorkspace, await fsp.realpath(filePath))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

interface WatchedWorkspace {
  path: string;
  handle: KitWatchHandle;
  timer?: ReturnType<typeof setTimeout>;
  running?: Promise<void>;
  rerun?: boolean;
}

export class KitFileWatcher {
  private static instance: KitFileWatcher | null = null;

  /** Install the process-wide watcher; returns a function that closes it. */
  static install(deps: KitFileWatcherDeps = defaultKitFileWatcherDeps()): () => void {
    KitFileWatcher.instance?.close();
    const watcher = new KitFileWatcher(deps);
    KitFileWatcher.instance = watcher;
    return () => {
      watcher.close();
      if (KitFileWatcher.instance === watcher) KitFileWatcher.instance = null;
    };
  }

  /** Start watching a workspace's kit files (no-op without an installed watcher). */
  static watchWorkspace(workspace: { id: string; path?: string } | null | undefined): void {
    if (!workspace?.id || !workspace.path) return;
    KitFileWatcher.instance?.watch(workspace.id, workspace.path);
  }

  private readonly watched = new Map<string, WatchedWorkspace>();
  private closed = false;

  constructor(private readonly deps: KitFileWatcherDeps) {}

  get size(): number {
    return this.watched.size;
  }

  watch(workspaceId: string, workspacePath: string): void {
    if (this.closed) return;
    const existing = this.watched.get(workspaceId);
    if (existing && existing.path === workspacePath) {
      // Most recently used last.
      this.watched.delete(workspaceId);
      this.watched.set(workspaceId, existing);
      return;
    }
    if (existing) this.unwatch(workspaceId);
    const directory = path.join(workspacePath, ".cowork");
    try {
      const stat = fs.lstatSync(directory);
      // Never watch a `.cowork` that is a symlink (it may point outside the workspace).
      if (stat.isSymbolicLink() || !stat.isDirectory()) return;
    } catch {
      return;
    }
    let handle: KitWatchHandle;
    try {
      handle = this.deps.watch(
        directory,
        (fileName) => {
          if (fileName && !KIT_FILE_NAMES.includes(path.basename(fileName))) return;
          this.schedule(workspaceId);
        },
        (error) => {
          logger.debug(`Kit watcher for ${workspaceId} stopped:`, error);
          this.unwatch(workspaceId);
        },
      );
    } catch (error) {
      logger.debug(`Kit files of ${workspaceId} cannot be watched:`, error);
      return;
    }
    this.watched.set(workspaceId, { path: workspacePath, handle });
    const max = Math.max(1, this.deps.maxWorkspaces ?? MAX_WATCHED_WORKSPACES);
    while (this.watched.size > max) {
      const oldest = this.watched.keys().next().value as string | undefined;
      if (!oldest) break;
      this.unwatch(oldest);
    }
  }

  unwatch(workspaceId: string): void {
    const entry = this.watched.get(workspaceId);
    if (!entry) return;
    this.watched.delete(workspaceId);
    if (entry.timer) this.deps.clearTimer(entry.timer);
    try {
      entry.handle.close();
    } catch {
      // Already closed.
    }
  }

  close(): void {
    this.closed = true;
    // Deleting the visited entry while iterating a Map is safe.
    for (const workspaceId of this.watched.keys()) this.unwatch(workspaceId);
  }

  private schedule(workspaceId: string): void {
    const entry = this.watched.get(workspaceId);
    if (!entry || this.closed) return;
    if (entry.timer) this.deps.clearTimer(entry.timer);
    entry.timer = this.deps.setTimer(() => {
      entry.timer = undefined;
      void this.run(workspaceId);
    }, this.deps.debounceMs ?? KIT_EDIT_DEBOUNCE_MS);
  }

  /** One sync at a time per workspace; an edit during a sync runs one more afterwards. */
  private async run(workspaceId: string): Promise<void> {
    const entry = this.watched.get(workspaceId);
    if (!entry || this.closed) return;
    if (entry.running) {
      entry.rerun = true;
      return;
    }
    entry.running = (async () => {
      do {
        entry.rerun = false;
        try {
          await this.deps.sync(workspaceId);
        } catch (error) {
          logger.warn(`Kit back-sync after a file edit failed for ${workspaceId}:`, error);
        }
      } while (entry.rerun && !this.closed && this.watched.get(workspaceId) === entry);
    })();
    try {
      await entry.running;
    } finally {
      entry.running = undefined;
    }
  }
}

export function defaultKitFileWatcherDeps(): KitFileWatcherDeps {
  return {
    watch(directory, onChange, onError) {
      const watcher = fs.watch(directory, { persistent: false }, (_event, fileName) =>
        onChange(fileName ? String(fileName) : null),
      );
      watcher.on("error", onError);
      return watcher;
    },
    async sync(workspaceId) {
      const { CuratedMemoryService } = await import("./CuratedMemoryService");
      await CuratedMemoryService.syncWorkspaceFiles(workspaceId, { fromFileEdit: true });
    },
    setTimer: (callback, ms) => {
      const timer = setTimeout(callback, ms);
      timer.unref?.();
      return timer;
    },
    clearTimer: (timer) => clearTimeout(timer),
  };
}
