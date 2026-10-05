/**
 * Memory Hub "Sources" and "Health" IPC: aggregate counts of where the workspace's memory
 * comes from, and the qa:memory-health checks over the profile database. Read-only. Every
 * payload is validated with zod in main (memory-health-ipc-validation.ts) and names the
 * workspace the Hub is showing, which must exist.
 */
import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/types";
import type { MemoryHealthService } from "../memory/MemoryHealthService";
import { RATE_LIMIT_CONFIGS, rateLimiter } from "../utils/rate-limiter";
import { validateInput } from "../utils/validation";
import { MemoryHubWorkspaceRequestSchema } from "./memory-health-ipc-validation";

export interface MemoryHealthIpcDeps {
  service: Pick<MemoryHealthService, "sources" | "health">;
  /** Whether the workspace exists (and the caller may act on it). */
  workspaceExists: (workspaceId: string) => Promise<boolean>;
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
export function createMemoryHealthIpcHandlers(deps: MemoryHealthIpcDeps): Record<string, Handler> {
  const limit = deps.checkRateLimit ?? defaultRateLimit;
  const handler =
    (channel: string, run: (workspaceId: string) => Promise<unknown>): Handler =>
    async (raw) => {
      limit(channel);
      const value = validateInput(MemoryHubWorkspaceRequestSchema, raw, "memory hub request");
      if (!(await deps.workspaceExists(value.workspaceId))) throw new Error("Workspace not found");
      return run(value.workspaceId);
    };
  return {
    [IPC_CHANNELS.MEMORY_HUB_SOURCES]: handler(IPC_CHANNELS.MEMORY_HUB_SOURCES, (workspaceId) =>
      deps.service.sources(workspaceId),
    ),
    // Profile-wide: the workspace only gates access, as in the browser host.
    [IPC_CHANNELS.MEMORY_HUB_HEALTH]: handler(IPC_CHANNELS.MEMORY_HUB_HEALTH, () =>
      deps.service.health(),
    ),
  };
}

export function setupMemoryHealthHandlers(deps: MemoryHealthIpcDeps): void {
  rateLimiter.configure(IPC_CHANNELS.MEMORY_HUB_SOURCES, RATE_LIMIT_CONFIGS.standard);
  // Health scans whole tables (duplicate grouping); the Refresh button is the only caller.
  rateLimiter.configure(IPC_CHANNELS.MEMORY_HUB_HEALTH, RATE_LIMIT_CONFIGS.expensive);
  const handlers = createMemoryHealthIpcHandlers(deps);
  for (const [channel, handle] of Object.entries(handlers)) {
    ipcMain.handle(channel, (_event, raw: unknown) => handle(raw));
  }
}
