/**
 * Memory Hub IPC over `memory_items` ("What CoWork knows"). Every payload is validated
 * with zod in main (memory-ipc-validation.ts); every request names the workspace the Hub
 * is showing, which must exist, and items are only reachable when they belong to it or
 * to no workspace (MemoryItemsHubService enforces ownership).
 */
import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/types";
import type { MemoryItemsHubService } from "../memory/MemoryItemsHubService";
import { RATE_LIMIT_CONFIGS, rateLimiter } from "../utils/rate-limiter";
import { validateInput } from "../utils/validation";
import {
  MemoryItemAddRequestSchema,
  MemoryItemPinRequestSchema,
  MemoryItemRefRequestSchema,
  MemoryItemsClearGlobalRequestSchema,
  MemoryItemsListRequestSchema,
  MemoryItemUpdateRequestSchema,
} from "./memory-ipc-validation";

export interface MemoryItemsIpcDeps {
  service: MemoryItemsHubService;
  /** Whether the workspace exists (and the caller may act on it). */
  workspaceExists: (workspaceId: string) => Promise<boolean>;
  /** Throws when the channel is over its rate limit. */
  checkRateLimit?: (channel: string) => void;
}

type Handler = (raw: unknown) => Promise<unknown>;

const MUTATING_CHANNELS = [
  IPC_CHANNELS.MEMORY_ITEMS_ADD,
  IPC_CHANNELS.MEMORY_ITEMS_UPDATE,
  IPC_CHANNELS.MEMORY_ITEMS_SET_PINNED,
  IPC_CHANNELS.MEMORY_ITEMS_DELETE,
  IPC_CHANNELS.MEMORY_ITEMS_CLEAR_GLOBAL,
] as const;

function defaultRateLimit(channel: string): void {
  if (!rateLimiter.check(channel)) {
    const resetSec = Math.ceil(rateLimiter.getResetTime(channel) / 1000);
    throw new Error(`Rate limit exceeded. Try again in ${resetSec} seconds.`);
  }
}

/** The handlers by channel, independent of Electron (tests call them directly). */
export function createMemoryItemsIpcHandlers(deps: MemoryItemsIpcDeps): Record<string, Handler> {
  const limit = deps.checkRateLimit ?? defaultRateLimit;
  const requireWorkspace = async (workspaceId: string) => {
    if (!(await deps.workspaceExists(workspaceId))) throw new Error("Workspace not found");
  };
  const mutation =
    <T extends { workspaceId: string }>(
      channel: string,
      parse: (raw: unknown) => T,
      run: (value: T) => Promise<unknown>,
    ): Handler =>
    async (raw) => {
      limit(channel);
      const value = parse(raw);
      await requireWorkspace(value.workspaceId);
      return run(value);
    };
  const read =
    <T extends { workspaceId: string }>(
      parse: (raw: unknown) => T,
      run: (value: T) => Promise<unknown>,
    ): Handler =>
    async (raw) => {
      const value = parse(raw);
      await requireWorkspace(value.workspaceId);
      return run(value);
    };

  return {
    [IPC_CHANNELS.MEMORY_ITEMS_LIST]: read(
      (raw) => validateInput(MemoryItemsListRequestSchema, raw, "memory items list"),
      (value) => deps.service.list(value),
    ),
    [IPC_CHANNELS.MEMORY_ITEMS_GET]: read(
      (raw) => validateInput(MemoryItemRefRequestSchema, raw, "memory item"),
      (value) => deps.service.get(value.workspaceId, value.id),
    ),
    [IPC_CHANNELS.MEMORY_ITEMS_WHY]: read(
      (raw) => validateInput(MemoryItemRefRequestSchema, raw, "memory item"),
      (value) => deps.service.why(value.workspaceId, value.id),
    ),
    [IPC_CHANNELS.MEMORY_ITEMS_ADD]: mutation(
      IPC_CHANNELS.MEMORY_ITEMS_ADD,
      (raw) => validateInput(MemoryItemAddRequestSchema, raw, "memory item"),
      (value) => deps.service.add(value),
    ),
    [IPC_CHANNELS.MEMORY_ITEMS_UPDATE]: mutation(
      IPC_CHANNELS.MEMORY_ITEMS_UPDATE,
      (raw) => validateInput(MemoryItemUpdateRequestSchema, raw, "memory item update"),
      (value) => deps.service.update(value),
    ),
    [IPC_CHANNELS.MEMORY_ITEMS_SET_PINNED]: mutation(
      IPC_CHANNELS.MEMORY_ITEMS_SET_PINNED,
      (raw) => validateInput(MemoryItemPinRequestSchema, raw, "memory item pin"),
      (value) => deps.service.setPinned(value),
    ),
    [IPC_CHANNELS.MEMORY_ITEMS_DELETE]: mutation(
      IPC_CHANNELS.MEMORY_ITEMS_DELETE,
      (raw) => validateInput(MemoryItemRefRequestSchema, raw, "memory item"),
      (value) => deps.service.delete(value),
    ),
    [IPC_CHANNELS.MEMORY_ITEMS_CLEAR_GLOBAL]: mutation(
      IPC_CHANNELS.MEMORY_ITEMS_CLEAR_GLOBAL,
      (raw) => validateInput(MemoryItemsClearGlobalRequestSchema, raw, "clear global memory"),
      () => deps.service.clearGlobal(),
    ),
  };
}

export function setupMemoryItemsHandlers(deps: MemoryItemsIpcDeps): void {
  for (const channel of MUTATING_CHANNELS) {
    rateLimiter.configure(channel, RATE_LIMIT_CONFIGS.limited);
  }
  const handlers = createMemoryItemsIpcHandlers(deps);
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, (_event, raw: unknown) => handler(raw));
  }
}
