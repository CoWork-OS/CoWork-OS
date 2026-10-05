/**
 * "Memory used" per reply (docs/memory-engine.md §4a). The executor emits a hidden
 * `memory_used` task event `{ surface, refs, source }` for every prompt surface of a turn
 * (chat turn, plan, step, follow-up) before the model call; the reply that follows used
 * those memories. Refs are `memory:<memory_items id>`, `archive:<memories id>`,
 * `external:<provider>` and `repo:<path>#L<line>` (a line of the memory folder,
 * docs/memory-repo-phase1-design.md §6.1).
 *
 * Attribution here is pure, so main (which reads the hidden events) and tests share it.
 */

export type MemoryUsedLane = "memory" | "archive" | "external" | "repo";

export interface MemoryUsedRef {
  ref: string;
  lane: MemoryUsedLane;
  id: string;
}

export interface MemoryUsedReply {
  /** The assistant reply (`assistant_message` / `task_completed` event id). */
  eventId: string;
  /** Unique refs in first-use order, at most MEMORY_USED_MAX_REFS. */
  refs: string[];
  /** Prompt surfaces the refs came through (`pinned_profile`, `step`, `chat`, …). */
  surfaces: string[];
}

export interface MemoryUsedForTask {
  taskId: string;
  /** Reply event id → what it used; replies that used nothing are absent. */
  replies: Record<string, MemoryUsedReply>;
  /** Every reply event id seen, so the UI knows which replies are already accounted for. */
  replyEventIds: string[];
}

export interface MemoryUsedTimelineEvent {
  id?: string;
  type: string;
  timestamp: number;
  payload?: unknown;
}

/** A stored task event as the attribution reads it (legacy type names win). */
export function toMemoryUsedTimelineEvent(event: {
  id?: string;
  type: string;
  legacyType?: string | null;
  timestamp: number;
  payload?: unknown;
}): MemoryUsedTimelineEvent {
  return {
    id: event.id,
    type: String(event.legacyType ?? event.type),
    timestamp: event.timestamp,
    payload: event.payload,
  };
}

/** Most events read per task for the attribution. */
export const MEMORY_USED_MAX_EVENTS = 2000;

/** Event types the attribution reads (main queries exactly these). */
export const MEMORY_USED_EVENT_TYPES = [
  "memory_used",
  "assistant_message",
  "task_completed",
  "user_message",
] as const;

const REPLY_TYPES = new Set(["assistant_message", "task_completed"]);
export const MEMORY_USED_MAX_REFS = 100;
const MAX_REF_CHARS = 600;

export function parseMemoryUsedRef(ref: unknown): MemoryUsedRef | null {
  if (typeof ref !== "string") return null;
  const value = ref.trim();
  if (!value || value.length > MAX_REF_CHARS) return null;
  // A memory folder line: a relative markdown path and a 1-based line number.
  const repo = /^repo:([^#\r\n]+\.md)#L([1-9]\d*)$/i.exec(value);
  if (repo) return { ref: value, lane: "repo", id: `${repo[1]}#L${repo[2]}` };
  const match = /^(memory|archive|external):(.+)$/.exec(value);
  if (!match) return null;
  return { ref: value, lane: match[1] as MemoryUsedLane, id: match[2] };
}

function payloadOf(event: MemoryUsedTimelineEvent): Record<string, unknown> {
  const payload = event.payload;
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

/**
 * Attribute `memory_used` events to replies: the events after the latest user message (or
 * the previous reply) and before a reply belong to that reply. Memory used in a turn that
 * ended without a reply is dropped at the next user message.
 */
export function attributeMemoryUse(
  taskId: string,
  events: MemoryUsedTimelineEvent[],
): MemoryUsedForTask {
  const ordered = events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => a.event.timestamp - b.event.timestamp || a.index - b.index)
    .map(({ event }) => event);
  const replies: Record<string, MemoryUsedReply> = {};
  const replyEventIds: string[] = [];
  let pendingRefs: string[] = [];
  let pendingSurfaces: string[] = [];

  for (const event of ordered) {
    if (event.type === "memory_used") {
      const payload = payloadOf(event);
      const refs = Array.isArray(payload.refs) ? payload.refs : [];
      for (const raw of refs) {
        const parsed = parseMemoryUsedRef(raw);
        if (!parsed || pendingRefs.includes(parsed.ref)) continue;
        if (pendingRefs.length >= MEMORY_USED_MAX_REFS) break;
        pendingRefs.push(parsed.ref);
      }
      const surface = typeof payload.surface === "string" ? payload.surface.trim() : "";
      if (surface && !pendingSurfaces.includes(surface)) pendingSurfaces.push(surface);
      continue;
    }
    if (event.type === "user_message") {
      pendingRefs = [];
      pendingSurfaces = [];
      continue;
    }
    if (REPLY_TYPES.has(event.type) && event.id) {
      replyEventIds.push(event.id);
      if (pendingRefs.length > 0) {
        replies[event.id] = { eventId: event.id, refs: pendingRefs, surfaces: pendingSurfaces };
      }
      pendingRefs = [];
      pendingSurfaces = [];
    }
  }
  return { taskId, replies, replyEventIds };
}

/** Count of refs per lane, for a compact label. */
export function countMemoryUsedRefs(refs: string[]): Record<MemoryUsedLane, number> {
  const counts: Record<MemoryUsedLane, number> = { memory: 0, archive: 0, external: 0, repo: 0 };
  for (const ref of refs) {
    const parsed = parseMemoryUsedRef(ref);
    if (parsed) counts[parsed.lane] += 1;
  }
  return counts;
}
