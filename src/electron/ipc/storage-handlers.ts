/**
 * Settings > Storage IPC (storage:*): the profile folder's size by kind of data, clearing
 * caches, moving database copies to the Trash and showing the folder.
 *
 * The renderer never sends a path. Database copies are named by the id the scan gave
 * them and resolved again here from the folder's current contents, so only a copy of the
 * database (never the live database or anything else) can be moved, and only to the
 * Trash, where it can be put back.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ipcMain, session, shell } from "electron";
import { z } from "zod";
import { IPC_CHANNELS } from "../../shared/types";
import type {
  StorageBreakdown,
  StorageClearCacheResult,
  StorageTrashResult,
} from "../../shared/storage-usage";
import { BACKUPS_FOLDER, scanStorage, trashDatabaseCopies } from "../storage/storage-breakdown";
import { getUserDataDir } from "../utils/user-data-dir";
import { createLogger } from "../utils/logger";
import { RATE_LIMIT_CONFIGS, rateLimiter } from "../utils/rate-limiter";
import { validateInput } from "../utils/validation";

const logger = createLogger("Storage");

const TrashSchema = z.object({ ids: z.array(z.string().min(1).max(400)).min(1).max(200) }).strict();
const OpenFolderSchema = z.object({ folder: z.enum(["profile", "backups"]) }).strict();

export interface StorageHandlerDeps {
  /** The profile folder; tests point it elsewhere. */
  root?: () => string;
  clearCaches?: (root: string) => Promise<void>;
  trashItem?: (target: string) => Promise<void>;
  openPath?: (target: string) => Promise<string>;
}

function limit(channel: string): void {
  if (!rateLimiter.check(channel)) throw new Error("Too many requests. Please wait a moment.");
}

/**
 * Empty the HTTP and code caches of the app's own session and of the built-in browser's
 * saved partitions (`Partitions/<name>` is `persist:<name>`). Sign-ins, cookies and site
 * data stay.
 */
export async function clearElectronCaches(root: string): Promise<void> {
  let names: string[] = [];
  try {
    names = await fs.readdir(path.join(root, "Partitions"));
  } catch {
    names = [];
  }
  const sessions = [
    session.defaultSession,
    // The built-in browser's workspace partitions (`persist:cowork-browser-<id>`), only
    // where the folder name maps back to the partition unchanged; others are skipped.
    ...names
      .filter((name) => /^cowork-browser-[A-Za-z0-9-]+$/.test(name))
      .map((name) => session.fromPartition(`persist:${name}`)),
  ];
  for (const target of sessions) {
    // One session that fails to clear does not stop the rest.
    try {
      await target.clearCache();
      await target.clearCodeCaches({});
    } catch (error) {
      logger.warn(
        `Could not clear a session cache: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export function setupStorageHandlers(deps: StorageHandlerDeps = {}): void {
  const root = deps.root ?? getUserDataDir;
  const clearCaches = deps.clearCaches ?? clearElectronCaches;
  const trashItem = deps.trashItem ?? ((target: string) => shell.trashItem(target));
  const openPath = deps.openPath ?? ((target: string) => shell.openPath(target));

  rateLimiter.configure(IPC_CHANNELS.STORAGE_GET_BREAKDOWN, RATE_LIMIT_CONFIGS.standard);
  rateLimiter.configure(IPC_CHANNELS.STORAGE_CLEAR_CACHE, RATE_LIMIT_CONFIGS.limited);
  rateLimiter.configure(IPC_CHANNELS.STORAGE_TRASH_DATABASE_COPIES, RATE_LIMIT_CONFIGS.limited);
  rateLimiter.configure(IPC_CHANNELS.STORAGE_OPEN_FOLDER, RATE_LIMIT_CONFIGS.standard);

  ipcMain.handle(IPC_CHANNELS.STORAGE_GET_BREAKDOWN, async (): Promise<StorageBreakdown> => {
    limit(IPC_CHANNELS.STORAGE_GET_BREAKDOWN);
    return scanStorage(root());
  });

  ipcMain.handle(IPC_CHANNELS.STORAGE_CLEAR_CACHE, async (): Promise<StorageClearCacheResult> => {
    limit(IPC_CHANNELS.STORAGE_CLEAR_CACHE);
    const cacheBytes = (breakdown: StorageBreakdown) =>
      breakdown.categories.find((category) => category.id === "cache")?.bytes ?? 0;
    const before = cacheBytes(await scanStorage(root()));
    await clearCaches(root());
    const after = cacheBytes(await scanStorage(root()));
    logger.info(`Cleared caches: ${before} -> ${after} bytes`);
    return { before, after };
  });

  ipcMain.handle(
    IPC_CHANNELS.STORAGE_TRASH_DATABASE_COPIES,
    async (_event, raw: unknown): Promise<StorageTrashResult> => {
      limit(IPC_CHANNELS.STORAGE_TRASH_DATABASE_COPIES);
      const request = validateInput(TrashSchema, raw, "storage trash");
      const result = await trashDatabaseCopies(root(), request.ids, trashItem);
      logger.info(
        `Moved ${result.trashed.length} database copies to the Trash, ${result.failed.length} failed`,
      );
      return result;
    },
  );

  ipcMain.handle(IPC_CHANNELS.STORAGE_OPEN_FOLDER, async (_event, raw: unknown) => {
    limit(IPC_CHANNELS.STORAGE_OPEN_FOLDER);
    const request = validateInput(OpenFolderSchema, raw, "storage folder");
    const target = request.folder === "backups" ? path.join(root(), BACKUPS_FOLDER) : root();
    const error = await openPath(target);
    return { success: error === "", ...(error ? { error } : {}) };
  });
}
