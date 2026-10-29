/**
 * A bot's own memory in the memory folder: `bots/<slug>.md`, mapped to the bot (`AgentRole`
 * id) by its `[bot: <id>]` marker line. The bot writes it with `memory_remember` scope `bot`;
 * it is loaded into that bot's tasks only and kept out of other tasks' recall, dreams and the
 * Hub's folder view. The bot's details panel lists it, with Forget and Undo per change.
 */
import {
  MEMORY_REPO_BOT_HISTORY_LIMIT,
  type MemoryRepoBotMemoryReport,
  type MemoryRepoEntryActionResult,
} from "../../../shared/memory-repo-types";
import type { MemoryRepoService } from "./MemoryRepoService";
import {
  isExpiredMemoryRepoEntry,
  isMemoryRepoMarker,
  parseMemoryRepoEntries,
  parseMemoryRepoRef,
} from "./memory-repo-format";
import { toMemoryRepoHubEntry } from "./memory-repo-hub";

export type MemoryRepoBotPort = Pick<
  MemoryRepoService,
  "isReady" | "isWritable" | "readFile" | "botFile" | "forget" | "fileHistory" | "undoFileChange"
> &
  Partial<Pick<MemoryRepoService, "removeBotFile">>;

function isoDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** What the bot remembers (current and expired entries) and its latest changes. */
export async function botMemoryReport(
  service: MemoryRepoBotPort | null,
  botId: string,
  now: number = Date.now(),
): Promise<MemoryRepoBotMemoryReport> {
  const empty = { path: null, entries: [], expired: [], history: [] };
  if (!service?.isReady()) return { available: false, writable: false, ...empty };
  const writable = service.isWritable();
  const path = await service.botFile(botId);
  if (!path) return { available: true, writable, ...empty };
  const today = isoDay(now);
  const entries = parseMemoryRepoEntries((await service.readFile(path)) ?? "").filter(
    (entry) => !isMemoryRepoMarker(entry),
  );
  return {
    available: true,
    writable,
    path,
    entries: entries
      .filter((entry) => !isExpiredMemoryRepoEntry(entry, today))
      .map((entry) => toMemoryRepoHubEntry(path, entry)),
    expired: entries
      .filter((entry) => isExpiredMemoryRepoEntry(entry, today))
      .map((entry) => toMemoryRepoHubEntry(path, entry)),
    history: await service.fileHistory(path, MEMORY_REPO_BOT_HISTORY_LIMIT),
  };
}

/** How many current entries the bot's file holds; skips the history read of the full report. */
export async function botMemoryCount(
  service: Pick<MemoryRepoBotPort, "isReady" | "botFile" | "readFile"> | null,
  botId: string,
  now: number = Date.now(),
): Promise<{ available: boolean; saved: number }> {
  if (!service?.isReady()) return { available: false, saved: 0 };
  const path = await service.botFile(botId);
  if (!path) return { available: true, saved: 0 };
  const today = isoDay(now);
  const saved = parseMemoryRepoEntries((await service.readFile(path)) ?? "").filter(
    (entry) => !isMemoryRepoMarker(entry) && !isExpiredMemoryRepoEntry(entry, today),
  ).length;
  return { available: true, saved };
}

/** Forget one entry of the bot's file; a ref outside that file is refused. */
export async function forgetBotMemoryEntry(
  service: MemoryRepoBotPort | null,
  botId: string,
  ref: string,
  hash: string,
): Promise<MemoryRepoEntryActionResult> {
  if (!service?.isWritable()) return { ok: false, error: "The memory folder is not available." };
  const parsed = parseMemoryRepoRef(ref);
  const path = await service.botFile(botId);
  if (!parsed || !path || parsed.path !== path) {
    return { ok: false, error: "That memory is not this bot's." };
  }
  const result = await service.forget(parsed.path, parsed.line, {
    expectHash: hash,
    origin: "memory_hub",
  });
  return result.removed ? { ok: true } : { ok: false, error: result.error ?? "Not removed." };
}

/** Undo one change to the bot's file (remove what it added, restore what it removed). */
export async function undoBotMemoryChange(
  service: MemoryRepoBotPort | null,
  botId: string,
  commit: string,
): Promise<MemoryRepoEntryActionResult> {
  if (!service?.isWritable()) return { ok: false, error: "The memory folder is not available." };
  const path = await service.botFile(botId);
  if (!path) return { ok: false, error: "This bot has no memory yet." };
  const result = await service.undoFileChange(path, commit, { origin: "memory_hub" });
  return result.undone ? { ok: true } : { ok: false, error: result.error ?? "Not undone." };
}

/** Delete the bot's whole file (after the bot itself was deleted and the user agreed). */
export async function deleteBotMemory(
  service: MemoryRepoBotPort | null,
  botId: string,
): Promise<MemoryRepoEntryActionResult & { entries?: number }> {
  if (!service?.isWritable() || !service.removeBotFile) {
    return { ok: false, error: "The memory folder is not available." };
  }
  const result = await service.removeBotFile(botId);
  return result.removed
    ? { ok: true, entries: result.entries }
    : { ok: false, error: "This bot has no memory to delete." };
}
