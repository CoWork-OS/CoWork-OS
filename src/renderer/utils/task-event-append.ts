import type { TaskEvent } from "../../shared/types";
import { getEffectiveTaskEventType } from "./task-event-compat";

const RENDERER_NOISE_EVENT_TYPES = new Set([
  "log",
  "llm_usage",
  "llm_streaming",
  "progress_update",
  "task_analysis",
  "executing",
]);

const RENDERER_REPLACEABLE_EVENT_TYPES = new Set(["progress_update", "executing", "llm_streaming"]);

const DEFAULT_MAX_EVENTS = 600;
const DEFAULT_MAX_EVENT_PAYLOAD_BYTES = 750 * 1024;
const LARGE_EVENT_TYPES = new Set([
  "command_output",
  "tool_call",
  "tool_result",
  "timeline_command_output",
  "timeline_step_updated",
]);
const LARGE_LEGACY_TYPES = new Set([
  "command_output",
  "tool_call",
  "tool_result",
]);
const MAX_LARGE_EVENT_STRING_CHARS = 32 * 1024;
const MAX_COMMAND_OUTPUT_CHARS = 16 * 1024;

function estimateEventPayloadBytes(event: TaskEvent): number {
  return estimatePayloadBytes(event.payload);
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

function truncatePayloadStrings(value: unknown, maxChars: number): unknown {
  if (typeof value === "string") return truncateString(value, maxChars);
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((entry) => truncatePayloadStrings(entry, maxChars));
  }
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const fieldLimit =
      key === "output" || key === "stdout" || key === "stderr" || key === "command"
        ? MAX_COMMAND_OUTPUT_CHARS
        : maxChars;
    next[key] = truncatePayloadStrings(entry, fieldLimit);
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
    payload: truncatePayloadStrings(event.payload, MAX_LARGE_EVENT_STRING_CHARS) as TaskEvent["payload"],
  };
}

export function isRendererNoiseEvent(event: TaskEvent): boolean {
  return RENDERER_NOISE_EVENT_TYPES.has(getEffectiveTaskEventType(event));
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
  let payloadBytes = 0;
  for (let index = eventsForByteCap.length - 1; index >= 0; index -= 1) {
    payloadBytes += estimateEventPayloadBytes(eventsForByteCap[index]);
    if (payloadBytes > maxPayloadBytes) {
      const structural = eventsForByteCap.filter(
        (event) => !isRendererNoiseEvent(event) && !shouldTrimPayload(event),
      );
      const recent = eventsForByteCap.slice(index + 1);
      const keepIds = new Set(recent.map((event) => event.id));
      for (let structuralIndex = structural.length - 1; structuralIndex >= 0; structuralIndex -= 1) {
        if (keepIds.size >= maxEvents) break;
        keepIds.add(structural[structuralIndex].id);
      }
      return eventsForByteCap.filter((event) => keepIds.has(event.id)).slice(-maxEvents);
    }
  }

  const trimmed = getTrimmedEvents();
  if (trimmed.length <= maxEvents) return trimmed;

  const indexed = trimmed.map((event, index) => ({ event, index }));
  const structural = indexed.filter(({ event }) => !isRendererNoiseEvent(event));

  if (structural.length >= maxEvents) {
    return structural.slice(-maxEvents).map(({ event }) => event);
  }

  const noiseBudget = maxEvents - structural.length;
  const recentNoise = indexed
    .filter(({ event }) => isRendererNoiseEvent(event))
    .slice(-noiseBudget);
  const keepIndexes = new Set<number>([
    ...structural.map(({ index }) => index),
    ...recentNoise.map(({ index }) => index),
  ]);

  return indexed.filter(({ index }) => keepIndexes.has(index)).map(({ event }) => event);
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

  if (appends.length > 0) {
    nextEvents = [...nextEvents, ...appends];
  }
  return capTaskEvents(nextEvents);
}
