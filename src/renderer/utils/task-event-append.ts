import type { TaskEvent } from "../../shared/types";
import { getEffectiveTaskEventType } from "./task-event-compat";

const RENDERER_NOISE_EVENT_TYPES = new Set([
  "log",
  "llm_usage",
  "llm_streaming",
  "progress_update",
  "task_analysis",
  "jev_decision",
  "memory_used",
  "executing",
]);

const RENDERER_REPLACEABLE_EVENT_TYPES = new Set(["progress_update", "executing", "llm_streaming"]);

// Matches the history window App.tsx loads for a selected task (MAX_TIMELINE_HISTORY_EVENTS), so
// a live task keeps as many events as reopening it would.
const DEFAULT_MAX_EVENTS = 1200;
const DEFAULT_MAX_EVENT_PAYLOAD_BYTES = 750 * 1024;
const LARGE_EVENT_TYPES = new Set([
  "command_output",
  "tool_call",
  "tool_result",
  "timeline_command_output",
  "timeline_step_updated",
]);
const LARGE_LEGACY_TYPES = new Set(["command_output", "tool_call", "tool_result"]);
const MAX_LARGE_EVENT_STRING_CHARS = 32 * 1024;
const MAX_COMMAND_OUTPUT_CHARS = 16 * 1024;
// Tool results and command output carry the bulk of a long task's payload bytes. Once the byte
// budget is exceeded, the ones that fall outside the recent window are shortened to a preview
// instead of being dropped: dropping them unpaired their tool calls and emptied the step rows.
const BULKY_EVENT_EFFECTIVE_TYPES = new Set(["tool_result", "command_output"]);
const COMPACT_EVENT_STRING_CHARS = 1024;
const compactedEvents = new WeakSet<TaskEvent>();
// Events are replaced, never mutated, so a payload's size can be cached by event identity. The
// cap runs on every live append over up to DEFAULT_MAX_EVENTS events.
const payloadBytesByEvent = new WeakMap<TaskEvent, number>();

function estimateEventPayloadBytes(event: TaskEvent): number {
  const cached = payloadBytesByEvent.get(event);
  if (cached !== undefined) return cached;
  const bytes = estimatePayloadBytes(event.payload);
  payloadBytesByEvent.set(event, bytes);
  return bytes;
}

function estimatePayloadBytes(value: unknown, seen = new Set<object>()): number {
  if (value == null) return 0;
  if (typeof value === "string") return value.length;
  if (typeof value === "number" || typeof value === "boolean") return 8;
  if (typeof value !== "object") return 0;
  if (seen.has(value)) return 0;
  seen.add(value);
  if (Array.isArray(value)) {
    let total = 2;
    for (const entry of value) total += estimatePayloadBytes(entry, seen) + 1;
    return total;
  }
  let total = 2;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    total += key.length + estimatePayloadBytes(entry, seen) + 4;
  }
  return total;
}

function truncateString(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return (
    value.slice(0, Math.max(0, maxChars - 80)) +
    `\n\n[... renderer payload truncated ${value.length - maxChars} chars ...]`
  );
}

function truncatePayloadStrings(
  value: unknown,
  maxChars: number,
  options: { outputFieldChars?: number } = {},
): unknown {
  if (typeof value === "string") return truncateString(value, maxChars);
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((entry) => truncatePayloadStrings(entry, maxChars, options));
  }
  const outputFieldChars = options.outputFieldChars ?? MAX_COMMAND_OUTPUT_CHARS;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const fieldLimit =
      key === "output" || key === "stdout" || key === "stderr" || key === "command"
        ? outputFieldChars
        : maxChars;
    next[key] = truncatePayloadStrings(entry, fieldLimit, options);
  }
  return next;
}

function shouldTrimPayload(event: TaskEvent): boolean {
  const effectiveType = getEffectiveTaskEventType(event);
  const legacyType =
    typeof (event as TaskEvent & { legacyType?: unknown }).legacyType === "string"
      ? String((event as TaskEvent & { legacyType?: unknown }).legacyType)
      : typeof (event as TaskEvent & { legacy_type?: unknown }).legacy_type === "string"
        ? String((event as TaskEvent & { legacy_type?: unknown }).legacy_type)
        : "";
  return (
    LARGE_EVENT_TYPES.has(event.type) ||
    LARGE_EVENT_TYPES.has(effectiveType) ||
    LARGE_LEGACY_TYPES.has(legacyType)
  );
}

function trimRendererEventPayload(event: TaskEvent): TaskEvent {
  if (!shouldTrimPayload(event)) return event;
  const payloadBytes = estimateEventPayloadBytes(event);
  if (payloadBytes <= MAX_LARGE_EVENT_STRING_CHARS) return event;
  return {
    ...event,
    payload: truncatePayloadStrings(
      event.payload,
      MAX_LARGE_EVENT_STRING_CHARS,
    ) as TaskEvent["payload"],
  };
}

function isBulkyEvent(event: TaskEvent): boolean {
  return (
    event.type === "timeline_command_output" ||
    BULKY_EVENT_EFFECTIVE_TYPES.has(getEffectiveTaskEventType(event))
  );
}

function compactBulkyEventPayload(event: TaskEvent): TaskEvent {
  if (compactedEvents.has(event)) return event;
  if (estimateEventPayloadBytes(event) <= COMPACT_EVENT_STRING_CHARS) return event;
  const compacted = {
    ...event,
    payload: truncatePayloadStrings(event.payload, COMPACT_EVENT_STRING_CHARS, {
      outputFieldChars: COMPACT_EVENT_STRING_CHARS,
    }) as TaskEvent["payload"],
  };
  compactedEvents.add(compacted);
  return compacted;
}

export function isRendererNoiseEvent(event: TaskEvent): boolean {
  return RENDERER_NOISE_EVENT_TYPES.has(getEffectiveTaskEventType(event));
}

/**
 * The newest `llm_usage` event of each task. Its payload carries the task's cumulative
 * token and cost totals, so it is kept through the cap even though usage events are
 * otherwise droppable noise; evicting it made displayed totals fall back to zero.
 */
function getLatestUsageEventsByTask(events: TaskEvent[]): Set<TaskEvent> {
  const latestByTask = new Map<string, TaskEvent>();
  for (const event of events) {
    if (getEffectiveTaskEventType(event) === "llm_usage") latestByTask.set(event.taskId, event);
  }
  return new Set(latestByTask.values());
}

export function capTaskEvents(
  events: TaskEvent[],
  maxEvents: number = DEFAULT_MAX_EVENTS,
  maxPayloadBytes: number = DEFAULT_MAX_EVENT_PAYLOAD_BYTES,
): TaskEvent[] {
  if (events.length <= maxEvents) {
    let payloadBytes = 0;
    let needsTrim = false;
    for (const event of events) {
      const bytes = estimateEventPayloadBytes(event);
      payloadBytes += bytes;
      if (shouldTrimPayload(event) && bytes > MAX_LARGE_EVENT_STRING_CHARS) {
        needsTrim = true;
      }
    }
    if (!needsTrim && payloadBytes <= maxPayloadBytes) return events;
  }

  let trimmedEvents: TaskEvent[] | null = null;
  const getTrimmedEvents = () => {
    if (trimmedEvents) return trimmedEvents;
    trimmedEvents = events.map(trimRendererEventPayload);
    return trimmedEvents;
  };
  const eventsForByteCap = getTrimmedEvents();
  const pinnedUsageEvents = getLatestUsageEventsByTask(eventsForByteCap);
  const isDroppableNoise = (event: TaskEvent) =>
    isRendererNoiseEvent(event) && !pinnedUsageEvents.has(event);
  let payloadBytes = 0;
  for (let index = eventsForByteCap.length - 1; index >= 0; index -= 1) {
    payloadBytes += estimateEventPayloadBytes(eventsForByteCap[index]);
    if (payloadBytes > maxPayloadBytes) {
      // Events before `index` fall outside the byte budget. Noise goes, every other event
      // stays: bulky ones as compact previews, the rest as-is. The compacted previews get a
      // budget of their own; past it the oldest are dropped so memory stays bounded.
      const older: TaskEvent[] = [];
      let compactBudget = maxPayloadBytes;
      for (let olderIndex = index; olderIndex >= 0; olderIndex -= 1) {
        const event = eventsForByteCap[olderIndex];
        if (isDroppableNoise(event)) continue;
        if (!isBulkyEvent(event)) {
          older.push(event);
          continue;
        }
        if (compactBudget <= 0) continue;
        const compacted = compactBulkyEventPayload(event);
        compactBudget -= estimateEventPayloadBytes(compacted);
        older.push(compacted);
      }
      older.reverse();
      const recent = eventsForByteCap.slice(index + 1);
      const kept = [...older, ...recent];
      if (kept.length <= maxEvents) return kept;
      return keepNewestWithPinned(kept, maxEvents, pinnedUsageEvents);
    }
  }

  const trimmed = eventsForByteCap;
  if (trimmed.length <= maxEvents) return trimmed;

  const indexed = trimmed.map((event, index) => ({ event, index }));
  const structural = indexed.filter(({ event }) => !isDroppableNoise(event));

  if (structural.length >= maxEvents) {
    return keepNewestWithPinned(
      structural.map(({ event }) => event),
      maxEvents,
      pinnedUsageEvents,
    );
  }

  const noiseBudget = maxEvents - structural.length;
  const recentNoise = indexed.filter(({ event }) => isDroppableNoise(event)).slice(-noiseBudget);
  const keepIndexes = new Set<number>([
    ...structural.map(({ index }) => index),
    ...recentNoise.map(({ index }) => index),
  ]);

  return indexed.filter(({ index }) => keepIndexes.has(index)).map(({ event }) => event);
}

/**
 * The newest `maxEvents` of `events`, except that pinned events older than that window
 * are kept in place of the oldest unpinned ones. Order is preserved and the result never
 * exceeds `maxEvents`.
 */
function keepNewestWithPinned(
  events: TaskEvent[],
  maxEvents: number,
  pinned: ReadonlySet<TaskEvent>,
): TaskEvent[] {
  if (events.length <= maxEvents) return events;
  const windowStart = events.length - maxEvents;
  let pinnedOutside = 0;
  for (let index = 0; index < windowStart; index += 1) {
    if (pinned.has(events[index])) pinnedOutside += 1;
  }
  if (pinnedOutside === 0) return events.slice(windowStart);
  const kept: TaskEvent[] = [];
  let unpinnedToSkip = windowStart;
  for (const event of events) {
    if (pinned.has(event)) {
      kept.push(event);
    } else if (unpinnedToSkip > 0) {
      unpinnedToSkip -= 1;
    } else {
      kept.push(event);
    }
  }
  return kept.slice(-maxEvents);
}

export function getTransientEventReplacementKey(event: TaskEvent): string | null {
  if (!RENDERER_REPLACEABLE_EVENT_TYPES.has(event.type)) return null;
  const payload =
    event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
      ? (event.payload as Record<string, unknown>)
      : {};
  const payloadStep =
    payload.step && typeof payload.step === "object" && !Array.isArray(payload.step)
      ? (payload.step as Record<string, unknown>)
      : null;
  const stepId =
    typeof event.stepId === "string"
      ? event.stepId
      : typeof payload.stepId === "string"
        ? payload.stepId
        : typeof payloadStep?.id === "string"
          ? payloadStep.id
          : "";
  const groupId =
    typeof event.groupId === "string"
      ? event.groupId
      : typeof payload.groupId === "string"
        ? payload.groupId
        : "";
  const stage =
    typeof payload.stage === "string"
      ? payload.stage
      : typeof payload.label === "string"
        ? payload.label
        : "";
  return [event.taskId, event.type, stepId, groupId, stage].join(":");
}

export function appendRendererTaskEvents(
  previousEvents: TaskEvent[],
  incomingEvents: TaskEvent[],
): TaskEvent[] {
  if (incomingEvents.length === 0) return previousEvents;

  const replacements = new Map<string, TaskEvent>();
  const idReplacements = new Map<string, TaskEvent>();
  const appends: TaskEvent[] = [];
  for (const event of incomingEvents) {
    const key = getTransientEventReplacementKey(event);
    if (key) {
      replacements.set(key, event);
    } else {
      appends.push(event);
    }
  }

  let nextEvents = previousEvents;
  if (replacements.size > 0) {
    const usedKeys = new Set<string>();
    nextEvents = previousEvents.map((event) => {
      const key = getTransientEventReplacementKey(event);
      if (key && replacements.has(key)) {
        usedKeys.add(key);
        return replacements.get(key)!;
      }
      return event;
    });
    for (const [key, event] of replacements) {
      if (!usedKeys.has(key)) appends.push(event);
    }
  }

  // Replace events by ID: when the backend re-emits an event with updated
  // payload (e.g. async mail-compose frame materialization), replace the
  // existing event in-place instead of appending a duplicate.
  if (appends.length > 0) {
    const remaining: TaskEvent[] = [];
    for (const event of appends) {
      const eventId = typeof event.id === "string" ? event.id.trim() : "";
      if (eventId) {
        idReplacements.set(eventId, event);
      } else {
        remaining.push(event);
      }
    }

    if (idReplacements.size > 0) {
      const usedIds = new Set<string>();
      nextEvents = nextEvents.map((event) => {
        const existingId = typeof event.id === "string" ? event.id.trim() : "";
        if (existingId && idReplacements.has(existingId)) {
          usedIds.add(existingId);
          return idReplacements.get(existingId)!;
        }
        return event;
      });
      for (const [id, event] of idReplacements) {
        if (!usedIds.has(id)) remaining.push(event);
      }
    }

    if (remaining.length > 0) {
      nextEvents = [...nextEvents, ...remaining];
    }
  }

  return capTaskEvents(nextEvents);
}
