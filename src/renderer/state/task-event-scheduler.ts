import type { TaskEvent } from "../../shared/types";
import {
  classifyLiveTaskEvent,
  getLiveTaskEventCoalesceFingerprint,
} from "../utils/live-task-event-policy";
import {
  appendRendererTaskEvents,
  capTaskEvents,
  getTransientEventReplacementKey,
} from "../utils/task-event-append";
import { compareTaskEventOrder, getTaskEventIdentity } from "../utils/task-event-stream";

export type TaskEventSource = "local" | "remote";

export interface TaskEventTarget {
  surfaceId: string;
  taskId: string;
  source: TaskEventSource;
  deviceId?: string;
}

export interface TaskEventSchedulerInput {
  event: TaskEvent;
  target: TaskEventTarget;
  /** Token returned by switchTarget/activate for the target's surface. */
  generation?: number;
}

export interface TaskEventSchedulerOptions {
  /** Renderer batches stay within the 50-100ms budget. Defaults to 100ms. */
  batchIntervalMs?: number;
  /** Hard upper bound for a queued batch. Defaults to 250ms. */
  maxWaitMs?: number;
  /** Maximum retained events in one surface/task buffer. */
  maxEventsPerBuffer?: number;
  /** Maximum estimated payload bytes in one surface/task buffer. */
  maxPayloadBytes?: number;
  /** Flush before this many pending events can accumulate. */
  maxPendingEvents?: number;
  /** Maximum number of inactive surface/task buffers retained in memory. */
  maxBuffers?: number;
  /** Clock used for deterministic buffer bookkeeping. */
  now?: () => number;
}

export interface TaskEventSchedulerSnapshot {
  target: TaskEventTarget | null;
  generation: number;
  version: number;
  events: TaskEvent[];
}

type Listener = () => void;
type TimerHandle = ReturnType<typeof setTimeout>;

interface SurfaceState {
  generation: number;
  activeTargetKey: string | null;
}

interface BufferState {
  key: string;
  target: TaskEventTarget;
  generation: number;
  version: number;
  events: TaskEvent[];
  pending: TaskEvent[];
  listeners: Set<Listener>;
  batchTimer: TimerHandle | null;
  maxWaitTimer: TimerHandle | null;
  lastTouchedAt: number;
  snapshot: TaskEventSchedulerSnapshot | null;
}

const DEFAULT_BATCH_INTERVAL_MS = 100;
const MIN_BATCH_INTERVAL_MS = 50;
const MAX_BATCH_INTERVAL_MS = 100;
const DEFAULT_MAX_WAIT_MS = 250;
const DEFAULT_MAX_EVENTS_PER_BUFFER = 600;
const DEFAULT_MAX_PAYLOAD_BYTES = 750 * 1024;
const DEFAULT_MAX_PENDING_EVENTS = 32;
const DEFAULT_MAX_BUFFERS = 64;

export const TASK_EVENT_BATCH_MIN_MS = MIN_BATCH_INTERVAL_MS;
export const TASK_EVENT_BATCH_MAX_MS = MAX_BATCH_INTERVAL_MS;
export const TASK_EVENT_MAX_FLUSH_MS = DEFAULT_MAX_WAIT_MS;

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function normalizeTarget(target: TaskEventTarget): TaskEventTarget {
  return {
    surfaceId: target.surfaceId.trim() || "default",
    taskId: target.taskId.trim(),
    source: target.source === "remote" ? "remote" : "local",
    ...(target.deviceId?.trim() ? { deviceId: target.deviceId.trim() } : {}),
  };
}

export function getTaskEventTargetKey(target: TaskEventTarget): string {
  const normalized = normalizeTarget(target);
  return JSON.stringify([
    normalized.surfaceId,
    normalized.taskId,
    normalized.source,
    normalized.deviceId ?? "",
  ]);
}

function getSurfaceKey(surfaceId: string): string {
  return surfaceId.trim() || "default";
}

function getEventIdentityKeys(event: TaskEvent): string[] {
  const keys: string[] = [];
  const eventId = typeof event.eventId === "string" ? event.eventId.trim() : "";
  const id = typeof event.id === "string" ? event.id.trim() : "";
  if (eventId) keys.push(`event:${eventId}`);
  if (id) keys.push(`id:${id}`);
  if (keys.length === 0) keys.push(getTaskEventIdentity(event));
  return keys;
}

function findIdentityMatch(events: TaskEvent[], incoming: TaskEvent): number {
  const incomingKeys = new Set(getEventIdentityKeys(incoming));
  return events.findIndex((event) =>
    getEventIdentityKeys(event).some((key) => incomingKeys.has(key)),
  );
}

function dedupeEvents(events: TaskEvent[]): TaskEvent[] {
  const indexesByKey = new Map<string, number>();
  const deduped: TaskEvent[] = [];

  for (const event of events) {
    const keys = getEventIdentityKeys(event);
    const existingIndex = keys
      .map((key) => indexesByKey.get(key))
      .find((index): index is number => typeof index === "number");

    if (existingIndex !== undefined) {
      deduped[existingIndex] = event;
      for (const key of keys) indexesByKey.set(key, existingIndex);
      continue;
    }

    const nextIndex = deduped.length;
    deduped.push(event);
    for (const key of keys) indexesByKey.set(key, nextIndex);
  }

  return deduped;
}

function sameEventArray(left: TaskEvent[], right: TaskEvent[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((event, index) => event === right[index]);
}

function estimatePayloadBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value ?? null)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function truncateString(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const suffix = "\n\n[... renderer payload truncated ...]";
  return `${value.slice(0, Math.max(0, maxChars - suffix.length))}${suffix}`;
}

function truncatePayloadStrings(value: unknown, maxChars: number): unknown {
  if (typeof value === "string") return truncateString(value, maxChars);
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => truncatePayloadStrings(entry, maxChars));

  const objectValue = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(objectValue).map(([key, entry]) => [
      key,
      truncatePayloadStrings(
        entry,
        key === "output" || key === "stdout" || key === "stderr"
          ? Math.min(maxChars, 16 * 1024)
          : maxChars,
      ),
    ]),
  );
}

function enforcePayloadByteBound(event: TaskEvent, maxPayloadBytes: number): TaskEvent {
  if (estimatePayloadBytes(event.payload) <= maxPayloadBytes) return event;

  const recursivelyTrimmedPayload = truncatePayloadStrings(
    event.payload,
    Math.max(16, maxPayloadBytes),
  );
  if (estimatePayloadBytes(recursivelyTrimmedPayload) <= maxPayloadBytes) {
    return { ...event, payload: recursivelyTrimmedPayload as TaskEvent["payload"] };
  }

  const serialized = (() => {
    try {
      return JSON.stringify(event.payload ?? null);
    } catch {
      return "[unserializable renderer payload]";
    }
  })();

  for (
    let maxChars = Math.max(16, maxPayloadBytes);
    maxChars >= 16;
    maxChars = Math.floor(maxChars / 2)
  ) {
    const candidatePayload = {
      rendererPayloadTruncated: true,
      preview: truncateString(serialized, maxChars),
    };
    if (estimatePayloadBytes(candidatePayload) <= maxPayloadBytes) {
      return { ...event, payload: candidatePayload as TaskEvent["payload"] };
    }
  }

  return { ...event, payload: null as TaskEvent["payload"] };
}

function boundEvent(event: TaskEvent, maxPayloadBytes: number): TaskEvent {
  const capped = capTaskEvents([event], 1, maxPayloadBytes)[0] ?? event;
  if (estimatePayloadBytes(capped.payload) <= maxPayloadBytes) return capped;
  return enforcePayloadByteBound(capped, maxPayloadBytes);
}

function mergeRetainedEvents(
  previous: TaskEvent[],
  incoming: TaskEvent[],
  maxEventsPerBuffer: number,
  maxPayloadBytes: number,
): TaskEvent[] {
  if (incoming.length === 0) return previous;

  // This preserves the existing renderer replacement rules for transient
  // progress/streaming frames and ID-based updates before the scheduler adds
  // eventId-aware deduplication and deterministic ordering.
  const appended = appendRendererTaskEvents(previous, incoming);
  const deduped = dedupeEvents(appended);
  deduped.sort(compareTaskEventOrder);
  return capTaskEvents(deduped, maxEventsPerBuffer, maxPayloadBytes);
}

export class TaskEventScheduler {
  private readonly batchIntervalMs: number;
  private readonly maxWaitMs: number;
  private readonly maxEventsPerBuffer: number;
  private readonly maxPayloadBytes: number;
  private readonly maxPendingEvents: number;
  private readonly maxBuffers: number;
  private readonly now: () => number;
  private readonly surfaces = new Map<string, SurfaceState>();
  private readonly buffers = new Map<string, BufferState>();
  private readonly globalListeners = new Set<Listener>();
  private disposed = false;

  constructor(options: TaskEventSchedulerOptions = {}) {
    this.batchIntervalMs = clamp(
      options.batchIntervalMs ?? DEFAULT_BATCH_INTERVAL_MS,
      MIN_BATCH_INTERVAL_MS,
      MAX_BATCH_INTERVAL_MS,
    );
    this.maxWaitMs = clamp(
      options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS,
      this.batchIntervalMs,
      DEFAULT_MAX_WAIT_MS,
    );
    this.maxEventsPerBuffer = Math.max(
      1,
      Math.floor(options.maxEventsPerBuffer ?? DEFAULT_MAX_EVENTS_PER_BUFFER),
    );
    this.maxPayloadBytes = Math.max(
      1,
      Math.floor(options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES),
    );
    this.maxPendingEvents = Math.max(
      1,
      Math.floor(options.maxPendingEvents ?? DEFAULT_MAX_PENDING_EVENTS),
    );
    this.maxBuffers = Math.max(1, Math.floor(options.maxBuffers ?? DEFAULT_MAX_BUFFERS));
    this.now = options.now ?? Date.now;
  }

  /** Activate a surface/task and return its current generation token. */
  switchTarget(target: TaskEventTarget): number {
    if (this.disposed) return 0;

    const normalizedTarget = normalizeTarget(target);
    const surfaceKey = getSurfaceKey(normalizedTarget.surfaceId);
    const targetKey = getTaskEventTargetKey(normalizedTarget);
    const surface = this.getSurface(surfaceKey);

    if (surface.activeTargetKey === targetKey) {
      const buffer = this.getOrCreateBuffer(normalizedTarget);
      this.flushBuffer(buffer);
      return surface.generation;
    }

    if (surface.activeTargetKey) {
      const previousBuffer = this.buffers.get(surface.activeTargetKey);
      if (previousBuffer) this.flushBuffer(previousBuffer);
    }

    surface.generation += 1;
    surface.activeTargetKey = targetKey;

    const buffer = this.getOrCreateBuffer(normalizedTarget);
    buffer.generation = surface.generation;
    buffer.version += 1;
    buffer.snapshot = null;
    this.notify(buffer);
    return surface.generation;
  }

  /** Alias kept explicit for later App integration where a surface is the caller's unit. */
  switchSurface(target: TaskEventTarget): number {
    return this.switchTarget(target);
  }

  activate(target: TaskEventTarget): number {
    return this.switchTarget(target);
  }

  getGeneration(surfaceId: string): number {
    return this.surfaces.get(getSurfaceKey(surfaceId))?.generation ?? 0;
  }

  getPendingCount(target: TaskEventTarget): number {
    return this.getOrCreateBuffer(normalizeTarget(target)).pending.length;
  }

  enqueue(input: TaskEventSchedulerInput): boolean {
    if (this.disposed) return false;

    const target = normalizeTarget(input.target);
    if (input.event.taskId !== target.taskId) return false;

    const targetKey = getTaskEventTargetKey(target);
    const surface = this.getSurface(getSurfaceKey(target.surfaceId));
    if (!surface.activeTargetKey) {
      if (input.generation !== undefined) return false;
      surface.generation += 1;
      surface.activeTargetKey = targetKey;
      const autoActivatedBuffer = this.getOrCreateBuffer(target);
      autoActivatedBuffer.generation = surface.generation;
      autoActivatedBuffer.version += 1;
      autoActivatedBuffer.snapshot = null;
    }

    if (surface.activeTargetKey !== targetKey) return false;
    if (input.generation !== undefined && input.generation !== surface.generation) return false;

    const buffer = this.getOrCreateBuffer(target);
    buffer.generation = surface.generation;
    buffer.lastTouchedAt = this.now();
    const event = boundEvent(input.event, this.maxPayloadBytes);

    if (classifyLiveTaskEvent(event) === "immediate") {
      const pending = this.takePending(buffer);
      pending.push(event);
      this.commit(buffer, pending);
      return true;
    }

    this.queuePending(buffer, event);
    if (buffer.pending.length >= this.maxPendingEvents) {
      this.flushBuffer(buffer);
    } else {
      this.schedule(buffer);
    }
    return true;
  }

  ingest(input: TaskEventSchedulerInput): boolean {
    return this.enqueue(input);
  }

  flush(target?: TaskEventTarget): TaskEvent[] {
    if (this.disposed) return [];
    if (target) {
      const buffer = this.buffers.get(getTaskEventTargetKey(normalizeTarget(target)));
      return buffer ? this.flushBuffer(buffer) : [];
    }

    const flushed: TaskEvent[] = [];
    for (const buffer of this.buffers.values()) {
      flushed.push(...this.flushBuffer(buffer));
    }
    return flushed;
  }

  flushAll(): TaskEvent[] {
    return this.flush();
  }

  /** Flush pending work and invalidate the target's generation token. */
  unsubscribe(target: TaskEventTarget): TaskEvent[] {
    if (this.disposed) return [];
    const normalizedTarget = normalizeTarget(target);
    const targetKey = getTaskEventTargetKey(normalizedTarget);
    const buffer = this.buffers.get(targetKey);
    const flushed = buffer ? this.flushBuffer(buffer) : [];
    const surface = this.surfaces.get(getSurfaceKey(normalizedTarget.surfaceId));
    if (surface?.activeTargetKey === targetKey) {
      surface.activeTargetKey = null;
      surface.generation += 1;
    }
    return flushed;
  }

  getSnapshot(target: TaskEventTarget): TaskEventSchedulerSnapshot {
    const buffer = this.getOrCreateBuffer(normalizeTarget(target));
    if (!buffer.snapshot) {
      buffer.snapshot = {
        target: { ...buffer.target },
        generation: buffer.generation,
        version: buffer.version,
        events: buffer.events.slice(),
      };
    }
    return buffer.snapshot;
  }

  subscribe(listener: Listener): () => void;
  subscribe(target: TaskEventTarget, listener: Listener): () => void;
  subscribe(targetOrListener: TaskEventTarget | Listener, maybeListener?: Listener): () => void {
    if (typeof targetOrListener === "function") {
      const listener = targetOrListener;
      this.globalListeners.add(listener);
      return () => this.globalListeners.delete(listener);
    }

    if (!maybeListener) return () => undefined;
    const buffer = this.getOrCreateBuffer(normalizeTarget(targetOrListener));
    buffer.listeners.add(maybeListener);
    return () => buffer.listeners.delete(maybeListener);
  }

  dispose(): void {
    if (this.disposed) return;
    this.flush();
    for (const buffer of this.buffers.values()) this.clearTimers(buffer);
    this.buffers.clear();
    this.surfaces.clear();
    this.globalListeners.clear();
    this.disposed = true;
  }

  private getSurface(surfaceKey: string): SurfaceState {
    let surface = this.surfaces.get(surfaceKey);
    if (!surface) {
      surface = { generation: 0, activeTargetKey: null };
      this.surfaces.set(surfaceKey, surface);
    }
    return surface;
  }

  private getOrCreateBuffer(target: TaskEventTarget): BufferState {
    const key = getTaskEventTargetKey(target);
    const existing = this.buffers.get(key);
    if (existing) {
      existing.lastTouchedAt = this.now();
      return existing;
    }

    this.evictBufferIfNeeded();
    const buffer: BufferState = {
      key,
      target: { ...target },
      generation: 0,
      version: 0,
      events: [],
      pending: [],
      listeners: new Set(),
      batchTimer: null,
      maxWaitTimer: null,
      lastTouchedAt: this.now(),
      snapshot: null,
    };
    this.buffers.set(key, buffer);
    return buffer;
  }

  private evictBufferIfNeeded(): void {
    while (this.buffers.size >= this.maxBuffers) {
      let candidate: BufferState | null = null;
      for (const buffer of this.buffers.values()) {
        if (buffer.listeners.size > 0 || buffer.pending.length > 0) continue;
        if ([...this.surfaces.values()].some((surface) => surface.activeTargetKey === buffer.key)) {
          continue;
        }
        if (!candidate || buffer.lastTouchedAt < candidate.lastTouchedAt) candidate = buffer;
      }
      if (!candidate) return;
      this.clearTimers(candidate);
      this.buffers.delete(candidate.key);
    }
  }

  private queuePending(buffer: BufferState, event: TaskEvent): void {
    const replacementKey = getTransientEventReplacementKey(event);
    const coalesceKey = getLiveTaskEventCoalesceFingerprint(event);
    const identityIndex = findIdentityMatch(buffer.pending, event);
    const replacementIndex = replacementKey
      ? buffer.pending.findIndex(
          (pendingEvent) => getTransientEventReplacementKey(pendingEvent) === replacementKey,
        )
      : -1;
    const coalesceIndex = coalesceKey
      ? buffer.pending.findIndex(
          (pendingEvent) => getLiveTaskEventCoalesceFingerprint(pendingEvent) === coalesceKey,
        )
      : -1;
    const index =
      identityIndex >= 0 ? identityIndex : replacementIndex >= 0 ? replacementIndex : coalesceIndex;

    if (index >= 0) {
      buffer.pending[index] = event;
    } else {
      buffer.pending.push(event);
    }
  }

  private schedule(buffer: BufferState): void {
    if (buffer.batchTimer === null) {
      buffer.batchTimer = setTimeout(() => {
        buffer.batchTimer = null;
        this.flushBuffer(buffer);
      }, this.batchIntervalMs);
    }
    if (buffer.maxWaitTimer === null) {
      buffer.maxWaitTimer = setTimeout(() => {
        buffer.maxWaitTimer = null;
        this.flushBuffer(buffer);
      }, this.maxWaitMs);
    }
  }

  private takePending(buffer: BufferState): TaskEvent[] {
    this.clearTimers(buffer);
    const pending = buffer.pending;
    buffer.pending = [];
    return pending;
  }

  private flushBuffer(buffer: BufferState): TaskEvent[] {
    const pending = this.takePending(buffer);
    if (pending.length === 0) return [];
    return this.commit(buffer, pending);
  }

  private commit(buffer: BufferState, incoming: TaskEvent[]): TaskEvent[] {
    if (incoming.length === 0) return [];
    const nextEvents = mergeRetainedEvents(
      buffer.events,
      incoming,
      this.maxEventsPerBuffer,
      this.maxPayloadBytes,
    );
    const changed = !sameEventArray(buffer.events, nextEvents);
    buffer.events = nextEvents;
    if (!changed) return [];

    buffer.version += 1;
    buffer.snapshot = null;
    this.notify(buffer);
    return buffer.events.slice();
  }

  private clearTimers(buffer: BufferState): void {
    if (buffer.batchTimer !== null) {
      clearTimeout(buffer.batchTimer);
      buffer.batchTimer = null;
    }
    if (buffer.maxWaitTimer !== null) {
      clearTimeout(buffer.maxWaitTimer);
      buffer.maxWaitTimer = null;
    }
  }

  private notify(buffer: BufferState): void {
    const listeners = new Set<Listener>([...this.globalListeners, ...buffer.listeners]);
    for (const listener of listeners) listener();
  }
}

export function createTaskEventScheduler(
  options: TaskEventSchedulerOptions = {},
): TaskEventScheduler {
  return new TaskEventScheduler(options);
}
