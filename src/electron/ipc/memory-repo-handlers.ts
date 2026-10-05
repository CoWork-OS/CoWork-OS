/**
 * Memory folder IPC (memoryRepo:*, docs/memory-repo-phase1-design.md §9): status, open the
 * folder, compact its history, and read entry lines by ref; and the dreams over it
 * (docs/memory-repo-phase2-design.md §5-§7): list, diff, accept, reject, undo, dream now.
 * The folder is always resolved in main from the settings (the running service's root); the
 * renderer never sends a path. Payloads are validated with zod in main
 * (memory-repo-ipc-validation.ts).
 */
import fs from "node:fs/promises";
import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/types";
import type {
  MemoryRepoCompactResult,
  MemoryRepoDreamActionResult,
  MemoryRepoDreamNowResult,
  MemoryRepoDreamsReport,
  MemoryRepoLine,
  MemoryRepoStatusReport,
} from "../../shared/memory-repo-types";
import { getMemoryRepoDreamer, type MemoryRepoDreamer } from "../memory/repo/MemoryRepoDreamer";
import type { MemoryRepoService } from "../memory/repo/MemoryRepoService";
import {
  buildMemoryRepoDreamsReport,
  loadMemoryRepoDreamSettings,
  memoryRepoDreamDiffText,
  runMemoryRepoDreamAction,
  toMemoryRepoDreamNowResult,
  type MemoryRepoDreamServicePort,
  type MemoryRepoDreamSettings,
} from "../memory/repo/memory-repo-dream-report";
import { RATE_LIMIT_CONFIGS, rateLimiter } from "../utils/rate-limiter";
import { validateInput } from "../utils/validation";
import {
  MemoryRepoDreamDiffRequestSchema,
  MemoryRepoDreamRequestSchema,
  MemoryRepoNoArgsSchema,
  MemoryRepoReadLinesRequestSchema,
} from "./memory-repo-ipc-validation";

/** "Dream now" calls the model and costs tokens: a few per hour. */
const DREAM_NOW_RATE_LIMIT = { maxRequests: 4, windowMs: 60 * 60 * 1000 };

export interface MemoryRepoIpcDeps {
  /** Status of the running repo, or of the configured path when it is off or refused. */
  status: () => Promise<MemoryRepoStatusReport>;
  /** The running service, or null when the memory folder is off. */
  getService: () =>
    | (Pick<MemoryRepoService, "root" | "isReady" | "compactHistory"> & MemoryRepoDreamServicePort)
    | null;
  readLines: (refs: string[]) => Promise<MemoryRepoLine[]>;
  /** `shell.openPath`: resolves to an error message, or "" on success. */
  openPath: (folder: string) => Promise<string>;
  /** The dreamer (default: the process-wide one), or null when dreaming is not wired. */
  getDreamer?: () => Pick<MemoryRepoDreamer, "run"> | null;
  /** The dream settings (default: from the memory feature settings). */
  dreamSettings?: () => MemoryRepoDreamSettings;
  /** Throws when the channel is over its rate limit. */
  checkRateLimit?: (channel: string) => void;
}

type Handler = (raw: unknown) => Promise<unknown>;

function defaultRateLimit(channel: string): void {
  if (!rateLimiter.check(channel)) {
    const resetSec = Math.ceil(rateLimiter.getResetTime(channel) / 1000);
    throw new Error(`Rate limit exceeded. Try again in ${resetSec} seconds.`);
  }
}

/** The handlers by channel, independent of Electron (tests call them directly). */
export function createMemoryRepoIpcHandlers(deps: MemoryRepoIpcDeps): Record<string, Handler> {
  const limit = deps.checkRateLimit ?? defaultRateLimit;
  const getDreamer = deps.getDreamer ?? getMemoryRepoDreamer;
  const dreamSettings = deps.dreamSettings ?? loadMemoryRepoDreamSettings;
  const dreamAction =
    (channel: string, action: "accept" | "reject" | "undo"): Handler =>
    async (raw): Promise<MemoryRepoDreamActionResult> => {
      limit(channel);
      const value = validateInput(MemoryRepoDreamRequestSchema, raw, "memory folder dream");
      return runMemoryRepoDreamAction(deps.getService(), action, value.id);
    };
  const noArgs =
    (channel: string, run: () => Promise<unknown>): Handler =>
    async (raw) => {
      limit(channel);
      validateInput(MemoryRepoNoArgsSchema, raw, "memory folder request");
      return run();
    };
  return {
    [IPC_CHANNELS.MEMORY_REPO_STATUS]: noArgs(IPC_CHANNELS.MEMORY_REPO_STATUS, () => deps.status()),
    [IPC_CHANNELS.MEMORY_REPO_OPEN_FOLDER]: noArgs(
      IPC_CHANNELS.MEMORY_REPO_OPEN_FOLDER,
      async (): Promise<{ success: true }> => {
        const service = deps.getService();
        if (!service?.isReady()) throw new Error("The memory folder is not ready.");
        // The root was checked at start; check again that it is still a real folder.
        const stat = await fs.lstat(service.root).catch(() => null);
        if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
          throw new Error("The memory folder is not available.");
        }
        const error = await deps.openPath(service.root);
        if (error) throw new Error(error);
        return { success: true };
      },
    ),
    [IPC_CHANNELS.MEMORY_REPO_COMPACT_HISTORY]: noArgs(
      IPC_CHANNELS.MEMORY_REPO_COMPACT_HISTORY,
      async (): Promise<MemoryRepoCompactResult> => {
        const service = deps.getService();
        if (!service) return { compacted: false, error: "The memory folder is off." };
        return service.compactHistory();
      },
    ),
    [IPC_CHANNELS.MEMORY_REPO_READ_LINES]: async (raw) => {
      limit(IPC_CHANNELS.MEMORY_REPO_READ_LINES);
      const value = validateInput(MemoryRepoReadLinesRequestSchema, raw, "memory folder lines");
      return deps.readLines(value.refs);
    },
    [IPC_CHANNELS.MEMORY_REPO_DREAMS]: noArgs(
      IPC_CHANNELS.MEMORY_REPO_DREAMS,
      (): Promise<MemoryRepoDreamsReport> =>
        buildMemoryRepoDreamsReport({ service: deps.getService(), settings: dreamSettings() }),
    ),
    [IPC_CHANNELS.MEMORY_REPO_DREAM_DIFF]: async (raw) => {
      limit(IPC_CHANNELS.MEMORY_REPO_DREAM_DIFF);
      const value = validateInput(
        MemoryRepoDreamDiffRequestSchema,
        raw,
        "memory folder dream diff",
      );
      return memoryRepoDreamDiffText(deps.getService(), value.id, value.part);
    },
    [IPC_CHANNELS.MEMORY_REPO_ACCEPT_DREAM]: dreamAction(
      IPC_CHANNELS.MEMORY_REPO_ACCEPT_DREAM,
      "accept",
    ),
    [IPC_CHANNELS.MEMORY_REPO_REJECT_DREAM]: dreamAction(
      IPC_CHANNELS.MEMORY_REPO_REJECT_DREAM,
      "reject",
    ),
    [IPC_CHANNELS.MEMORY_REPO_UNDO_DREAM]: dreamAction(IPC_CHANNELS.MEMORY_REPO_UNDO_DREAM, "undo"),
    [IPC_CHANNELS.MEMORY_REPO_DREAM_NOW]: noArgs(
      IPC_CHANNELS.MEMORY_REPO_DREAM_NOW,
      async (): Promise<MemoryRepoDreamNowResult> => {
        const dreamer = getDreamer();
        return toMemoryRepoDreamNowResult(dreamer ? await dreamer.run("manual") : null);
      },
    ),
  };
}

export function setupMemoryRepoHandlers(deps: MemoryRepoIpcDeps): void {
  rateLimiter.configure(IPC_CHANNELS.MEMORY_REPO_STATUS, RATE_LIMIT_CONFIGS.standard);
  rateLimiter.configure(IPC_CHANNELS.MEMORY_REPO_OPEN_FOLDER, RATE_LIMIT_CONFIGS.limited);
  // Rewrites the history and runs `git gc`; one button is the only caller.
  rateLimiter.configure(IPC_CHANNELS.MEMORY_REPO_COMPACT_HISTORY, RATE_LIMIT_CONFIGS.limited);
  rateLimiter.configure(IPC_CHANNELS.MEMORY_REPO_READ_LINES, RATE_LIMIT_CONFIGS.standard);
  rateLimiter.configure(IPC_CHANNELS.MEMORY_REPO_DREAMS, RATE_LIMIT_CONFIGS.standard);
  rateLimiter.configure(IPC_CHANNELS.MEMORY_REPO_DREAM_DIFF, RATE_LIMIT_CONFIGS.standard);
  // Accept, reject and undo change the folder's history; one button each is the only caller.
  rateLimiter.configure(IPC_CHANNELS.MEMORY_REPO_ACCEPT_DREAM, RATE_LIMIT_CONFIGS.limited);
  rateLimiter.configure(IPC_CHANNELS.MEMORY_REPO_REJECT_DREAM, RATE_LIMIT_CONFIGS.limited);
  rateLimiter.configure(IPC_CHANNELS.MEMORY_REPO_UNDO_DREAM, RATE_LIMIT_CONFIGS.limited);
  rateLimiter.configure(IPC_CHANNELS.MEMORY_REPO_DREAM_NOW, DREAM_NOW_RATE_LIMIT);
  const handlers = createMemoryRepoIpcHandlers(deps);
  for (const [channel, handle] of Object.entries(handlers)) {
    ipcMain.handle(channel, (_event, raw: unknown) => handle(raw));
  }
}
