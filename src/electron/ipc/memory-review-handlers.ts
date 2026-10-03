/**
 * Memory Hub "Review" IPC: Dreaming's curation proposals (accept / reject), the changes it
 * applied (undo), a manual run and the LLM synthesis switch. Every payload is validated
 * with zod in main (memory-review-ipc-validation.ts); every request names the workspace
 * the Hub is showing, which must exist, and MemoryReviewService only reaches proposals and
 * log entries of that workspace.
 */
import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/types";
import type { MemoryReviewService } from "../memory/MemoryReviewService";
import { RATE_LIMIT_CONFIGS, rateLimiter } from "../utils/rate-limiter";
import { validateInput } from "../utils/validation";
import {
  MemoryReviewProposalRequestSchema,
  MemoryReviewSetLlmRequestSchema,
  MemoryReviewUndoRequestSchema,
  MemoryReviewWorkspaceRequestSchema,
} from "./memory-review-ipc-validation";

export interface MemoryReviewIpcDeps {
  service: MemoryReviewService;
  /** Whether the workspace exists (and the caller may act on it). */
  workspaceExists: (workspaceId: string) => Promise<boolean>;
  /** Throws when the channel is over its rate limit. */
  checkRateLimit?: (channel: string) => void;
}

type Handler = (raw: unknown) => Promise<unknown>;

const MUTATING_CHANNELS = [
  IPC_CHANNELS.MEMORY_REVIEW_ACCEPT,
  IPC_CHANNELS.MEMORY_REVIEW_REJECT,
  IPC_CHANNELS.MEMORY_REVIEW_UNDO,
  IPC_CHANNELS.MEMORY_REVIEW_RUN_NOW,
  IPC_CHANNELS.MEMORY_REVIEW_SET_LLM,
] as const;

function defaultRateLimit(channel: string): void {
  if (!rateLimiter.check(channel)) {
    const resetSec = Math.ceil(rateLimiter.getResetTime(channel) / 1000);
    throw new Error(`Rate limit exceeded. Try again in ${resetSec} seconds.`);
  }
}

/** The handlers by channel, independent of Electron (tests call them directly). */
export function createMemoryReviewIpcHandlers(deps: MemoryReviewIpcDeps): Record<string, Handler> {
  const limit = deps.checkRateLimit ?? defaultRateLimit;
  const requireWorkspace = async (workspaceId: string) => {
    if (!(await deps.workspaceExists(workspaceId))) throw new Error("Workspace not found");
  };
  const handler =
    <T extends { workspaceId: string }>(
      channel: string | null,
      parse: (raw: unknown) => T,
      run: (value: T) => Promise<unknown> | unknown,
    ): Handler =>
    async (raw) => {
      if (channel) limit(channel);
      const value = parse(raw);
      await requireWorkspace(value.workspaceId);
      return run(value);
    };

  return {
    [IPC_CHANNELS.MEMORY_REVIEW_GET]: handler(
      null,
      (raw) => validateInput(MemoryReviewWorkspaceRequestSchema, raw, "memory review"),
      (value) => deps.service.state(value.workspaceId),
    ),
    [IPC_CHANNELS.MEMORY_REVIEW_COUNT]: handler(
      null,
      (raw) => validateInput(MemoryReviewWorkspaceRequestSchema, raw, "memory review"),
      (value) => deps.service.count(value.workspaceId),
    ),
    [IPC_CHANNELS.MEMORY_REVIEW_ACCEPT]: handler(
      IPC_CHANNELS.MEMORY_REVIEW_ACCEPT,
      (raw) => validateInput(MemoryReviewProposalRequestSchema, raw, "memory review proposal"),
      (value) => deps.service.accept(value.workspaceId, value.id),
    ),
    [IPC_CHANNELS.MEMORY_REVIEW_REJECT]: handler(
      IPC_CHANNELS.MEMORY_REVIEW_REJECT,
      (raw) => validateInput(MemoryReviewProposalRequestSchema, raw, "memory review proposal"),
      (value) => deps.service.reject(value.workspaceId, value.id),
    ),
    [IPC_CHANNELS.MEMORY_REVIEW_UNDO]: handler(
      IPC_CHANNELS.MEMORY_REVIEW_UNDO,
      (raw) => validateInput(MemoryReviewUndoRequestSchema, raw, "memory review undo"),
      (value) => deps.service.undo(value.workspaceId, value.id),
    ),
    [IPC_CHANNELS.MEMORY_REVIEW_RUN_NOW]: handler(
      IPC_CHANNELS.MEMORY_REVIEW_RUN_NOW,
      (raw) => validateInput(MemoryReviewWorkspaceRequestSchema, raw, "memory review run"),
      (value) => deps.service.runNow(value.workspaceId),
    ),
    [IPC_CHANNELS.MEMORY_REVIEW_SET_LLM]: handler(
      IPC_CHANNELS.MEMORY_REVIEW_SET_LLM,
      (raw) => validateInput(MemoryReviewSetLlmRequestSchema, raw, "memory review setting"),
      (value) => deps.service.setLlmEnabled(value.enabled),
    ),
  };
}

export function setupMemoryReviewHandlers(deps: MemoryReviewIpcDeps): void {
  for (const channel of MUTATING_CHANNELS) {
    rateLimiter.configure(channel, RATE_LIMIT_CONFIGS.limited);
  }
  const handlers = createMemoryReviewIpcHandlers(deps);
  for (const [channel, handle] of Object.entries(handlers)) {
    ipcMain.handle(channel, (_event, raw: unknown) => handle(raw));
  }
}
