import type { TaskEvent } from "../../shared/types";
type MetricBucket = {
  samples: number[];
};

type RenderBucket = {
  total: number;
  keys: Map<string, number>;
  windowTotal: number;
  windowKeys: Map<string, number>;
};

type CounterBucket = {
  value: number;
  windowValue: number;
};

type PendingVisibleEvent = {
  location: string;
  attempts: number;
  firstQueuedAtMs: number;
};

type TaskEventTrace = {
  eventId: string;
  aliasId?: string;
  taskId: string;
  type: string;
  receivedAtMs: number;
  queuedAtMs?: number;
  appendDispatchAtMs?: number;
  appendedAtMs?: number;
  renderable: boolean;
  renderableAtMs?: number;
  visibleRecorded?: boolean;
};

type StartupMark = {
  name: string;
  atMs: number;
  details?: Record<string, unknown>;
  emitted: boolean;
};

type PerfMark = {
  name: string;
  atMs: number;
  details?: Record<string, unknown>;
};

type RendererPerfState = {
  schemaVersion: number;
  metrics: Map<string, MetricBucket>;
  renders: Map<string, RenderBucket>;
  counters: Map<string, CounterBucket>;
  startupMarks: Map<string, StartupMark>;
  perfMarks: PerfMark[];
  taskEvents: Map<string, TaskEventTrace>;
  taskEventAliases: Map<string, string>;
  settledVisibleEvents: Map<string, number>;
  pendingVisibleEvents: Map<string, PendingVisibleEvent>;
  reportTimer: number | null;
  visibleFrame1: number | null;
  visibleFrame2: number | null;
  frameMonitorStarted: boolean;
  frameMonitorTimer: number | null;
  frameMonitorFrame: number | null;
  lastFrameAtMs: number | null;
  longTaskObserverStarted: boolean;
  longTaskObserver: PerformanceObserver | null;
};

declare global {
  interface Window {
    __coworkRendererPerfState__?: RendererPerfState;
  }
}

const MAX_METRIC_SAMPLES = 240;
const MAX_RENDER_KEYS = 120;
const MAX_PERF_MARKS = 500;
const MAX_PENDING_VISIBLE_EVENTS = 240;
const MAX_PENDING_VISIBLE_ATTEMPTS = 4;
const PENDING_VISIBLE_TTL_MS = 5_000;
const REPORT_INTERVAL_MS = 10_000;
const TASK_EVENT_TTL_MS = 60_000;
const MAX_ACTIONABLE_FRAME_GAP_MS = 1_000;
const RENDERER_PERF_STATE_SCHEMA_VERSION = 3;

function isRendererPerfEnabled(enabled?: boolean): boolean {
  return Boolean(enabled && typeof window !== "undefined" && typeof performance !== "undefined");
}

function getState(): RendererPerfState | null {
  if (typeof window === "undefined") return null;
  if (!window.__coworkRendererPerfState__) {
    window.__coworkRendererPerfState__ = {
      schemaVersion: RENDERER_PERF_STATE_SCHEMA_VERSION,
      metrics: new Map(),
      renders: new Map(),
      counters: new Map(),
      startupMarks: new Map(),
      perfMarks: [],
      taskEvents: new Map(),
      taskEventAliases: new Map(),
      settledVisibleEvents: new Map(),
      pendingVisibleEvents: new Map(),
      reportTimer: null,
      visibleFrame1: null,
      visibleFrame2: null,
      frameMonitorStarted: false,
      frameMonitorTimer: null,
      frameMonitorFrame: null,
      lastFrameAtMs: null,
      longTaskObserverStarted: false,
      longTaskObserver: null,
    };
  } else if (
    window.__coworkRendererPerfState__.schemaVersion !== RENDERER_PERF_STATE_SCHEMA_VERSION
  ) {
    migrateRendererPerfState(window.__coworkRendererPerfState__);
  }
  return window.__coworkRendererPerfState__;
}

function migrateRendererPerfState(state: RendererPerfState): void {
  state.schemaVersion = RENDERER_PERF_STATE_SCHEMA_VERSION;
  state.metrics.clear();
  state.renders.clear();
  state.counters.clear();
  state.perfMarks = [];
}

function percentile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index] ?? 0;
}

function cleanupTaskEventTraces(state: RendererPerfState, nowMs: number): void {
  for (const [eventId, trace] of state.taskEvents) {
    const ageMs = nowMs - (trace.appendedAtMs ?? trace.receivedAtMs);
    if (ageMs > TASK_EVENT_TTL_MS) {
      if (trace.renderable && !trace.visibleRecorded) {
        const bucket = state.counters.get("task-event.visible_trace_expired_count") ?? {
          value: 0,
          windowValue: 0,
        };
        bucket.value += 1;
        bucket.windowValue += 1;
        state.counters.set("task-event.visible_trace_expired_count", bucket);
      }
      state.taskEvents.delete(eventId);
      if (trace.aliasId) {
        state.taskEventAliases.delete(trace.aliasId);
      }
      state.pendingVisibleEvents.delete(eventId);
      if (trace.aliasId) {
        state.pendingVisibleEvents.delete(trace.aliasId);
      }
    }
  }
  for (const [eventId, settledAtMs] of state.settledVisibleEvents) {
    if (nowMs - settledAtMs > TASK_EVENT_TTL_MS) {
      state.settledVisibleEvents.delete(eventId);
    }
  }
}

function getTaskEventAlias(event: Pick<TaskEvent, "id" | "eventId">): string | null {
  if (typeof event.eventId === "string" && event.eventId.trim().length > 0) {
    return event.eventId;
  }
  return null;
}

function resolveTaskEventTrace(
  state: RendererPerfState,
  event: Pick<TaskEvent, "id" | "eventId"> | string,
): TaskEventTrace | null {
  const key = typeof event === "string" ? event : event.id;
  const direct = state.taskEvents.get(key);
  if (direct) return direct;
  if (typeof event === "string") {
    const canonicalId = state.taskEventAliases.get(event);
    return canonicalId ? (state.taskEvents.get(canonicalId) ?? null) : null;
  }

  const aliasCandidates = [event.id];
  const explicitAlias = getTaskEventAlias(event);
  if (explicitAlias && explicitAlias !== event.id) {
    aliasCandidates.push(explicitAlias);
  }

  for (const alias of aliasCandidates) {
    const canonicalId = state.taskEventAliases.get(alias);
    if (!canonicalId) continue;
    const traced = state.taskEvents.get(canonicalId);
    if (traced) return traced;
  }

  return null;
}

function deleteTaskEventTrace(state: RendererPerfState, trace: TaskEventTrace): void {
  state.taskEvents.delete(trace.eventId);
  if (trace.aliasId) {
    state.taskEventAliases.delete(trace.aliasId);
  }
}

function isTaskEventVisibilitySettled(
  state: RendererPerfState,
  event: Pick<TaskEvent, "id" | "eventId"> | string,
): boolean {
  const eventId = typeof event === "string" ? event : event.id;
  if (state.settledVisibleEvents.has(eventId)) return true;
  if (typeof event !== "string") {
    const alias = getTaskEventAlias(event);
    if (alias && state.settledVisibleEvents.has(alias)) return true;
  }
  const canonicalId = state.taskEventAliases.get(eventId);
  return canonicalId ? state.settledVisibleEvents.has(canonicalId) : false;
}

function emitRendererPerfLog(message: string): void {
  try {
    void window.electronAPI?.logRendererPerf?.({
      timestamp: new Date().toISOString(),
      message,
    });
  } catch {
    // Perf logging must never affect renderer interaction.
  }
}

function formatStartupMark(mark: StartupMark): string {
  let details = "";
  if (mark.details && Object.keys(mark.details).length > 0) {
    try {
      details = ` ${JSON.stringify(mark.details)}`;
    } catch {
      details = "";
    }
  }
  return `[Startup] ${mark.name} at ${mark.atMs.toFixed(1)}ms${details}`;
}

function formatPerfMark(name: string, atMs: number, details?: Record<string, unknown>): string {
  let suffix = "";
  if (details && Object.keys(details).length > 0) {
    try {
      suffix = ` ${JSON.stringify(details)}`;
    } catch {
      suffix = "";
    }
  }
  return `[Mark] ${name} at ${atMs.toFixed(1)}ms${suffix}`;
}

function addRendererPerfSample(state: RendererPerfState, name: string, valueMs: number): void {
  if (!Number.isFinite(valueMs) || valueMs < 0) return;
  const bucket = state.metrics.get(name) ?? { samples: [] };
  bucket.samples.push(valueMs);
  if (bucket.samples.length > MAX_METRIC_SAMPLES) {
    bucket.samples.splice(0, bucket.samples.length - MAX_METRIC_SAMPLES);
  }
  state.metrics.set(name, bucket);
}

function createRenderBucket(): RenderBucket {
  return {
    total: 0,
    keys: new Map<string, number>(),
    windowTotal: 0,
    windowKeys: new Map<string, number>(),
  };
}

function incrementRenderKey(keys: Map<string, number>, key: string): void {
  keys.set(key, (keys.get(key) ?? 0) + 1);
  if (keys.size <= MAX_RENDER_KEYS) return;
  const sorted = [...keys.entries()].sort((a, b) => a[1] - b[1]);
  const toDelete = sorted.slice(0, keys.size - MAX_RENDER_KEYS);
  for (const [renderKey] of toDelete) {
    keys.delete(renderKey);
  }
}

function shouldRecordFrameGap(gapMs: number): boolean {
  if (!Number.isFinite(gapMs) || gapMs <= 0) return false;
  if (gapMs > MAX_ACTIONABLE_FRAME_GAP_MS) return false;
  return !(typeof document !== "undefined" && document.hidden);
}

function flushRendererPerfReport(state: RendererPerfState): void {
  const metricSummaries: string[] = [];
  for (const [name, bucket] of state.metrics.entries()) {
    if (bucket.samples.length === 0) continue;
    const sorted = [...bucket.samples].sort((a, b) => a - b);
    metricSummaries.push(
      `${name} n=${sorted.length} p50=${percentile(sorted, 0.5).toFixed(1)}ms p95=${percentile(sorted, 0.95).toFixed(1)}ms max=${sorted[sorted.length - 1]!.toFixed(1)}ms`,
    );
    bucket.samples.length = 0;
  }

  const renderSummaries: string[] = [];
  for (const [name, bucket] of state.renders.entries()) {
    if (bucket.windowTotal <= 0) continue;
    const topKeys = [...bucket.windowKeys.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([key, count]) => `${key}:${count}`)
      .join(", ");
    renderSummaries.push(
      `${name} renders=${bucket.windowTotal} unique=${bucket.windowKeys.size}${topKeys ? ` top=[${topKeys}]` : ""}`,
    );
    bucket.windowTotal = 0;
    bucket.windowKeys.clear();
  }

  const counterSummaries: string[] = [];
  for (const [name, bucket] of state.counters.entries()) {
    const windowValue = bucket.windowValue ?? 0;
    if (windowValue <= 0) continue;
    counterSummaries.push(`${name} count=${windowValue}`);
    bucket.windowValue = 0;
  }

  if (
    metricSummaries.length === 0 &&
    renderSummaries.length === 0 &&
    counterSummaries.length === 0
  ) {
    return;
  }

  emitRendererPerfLog("Summary");
  for (const summary of metricSummaries) {
    emitRendererPerfLog(summary);
  }
  for (const summary of renderSummaries) {
    emitRendererPerfLog(summary);
  }
  for (const summary of counterSummaries) {
    emitRendererPerfLog(summary);
  }
}

function scheduleRendererPerfReport(state: RendererPerfState): void {
  startRendererPerfMonitors(state);
  if (state.reportTimer != null) return;
  state.reportTimer = window.setTimeout(() => {
    state.reportTimer = null;
    cleanupTaskEventTraces(state, performance.now());
    flushRendererPerfReport(state);
  }, REPORT_INTERVAL_MS);
}

function startRendererPerfMonitors(state: RendererPerfState): void {
  if (!state.frameMonitorStarted && typeof window.requestAnimationFrame === "function") {
    state.frameMonitorStarted = true;
    const scheduleNextFrame = () => {
      if (state.frameMonitorTimer != null) return;
      state.frameMonitorTimer = window.setTimeout(() => {
        state.frameMonitorTimer = null;
        state.frameMonitorFrame = window.requestAnimationFrame((nowMs) => {
          state.frameMonitorFrame = null;
          if (state.lastFrameAtMs != null) {
            const gapMs = nowMs - state.lastFrameAtMs;
            if (gapMs > 50 && shouldRecordFrameGap(gapMs)) {
              recordRendererPerfSample("renderer.frame_gap_ms", gapMs, true);
              if (gapMs > 80) {
                incrementRendererPerfCounter("renderer.frame_gap_count", true);
              }
            }
          }
          state.lastFrameAtMs = nowMs;
          scheduleNextFrame();
        });
      }, 0);
    };
    scheduleNextFrame();
  }

  if (!state.longTaskObserverStarted && typeof PerformanceObserver !== "undefined") {
    state.longTaskObserverStarted = true;
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          recordRendererPerfSample("renderer.long_task_ms", entry.duration, true);
          incrementRendererPerfCounter("renderer.long_task_count", true);
        }
      });
      observer.observe({ entryTypes: ["longtask"] });
      state.longTaskObserver = observer;
    } catch {
      state.longTaskObserver = null;
    }
  }
}

export function measureRendererPerf<T>(name: string, enabled: boolean | undefined, fn: () => T): T {
  if (!isRendererPerfEnabled(enabled)) {
    return fn();
  }
  const startedAtMs = performance.now();
  try {
    return fn();
  } finally {
    recordRendererPerfSample(name, performance.now() - startedAtMs, enabled);
  }
}

export function recordRendererPerfSample(name: string, valueMs: number, enabled?: boolean): void {
  if (!isRendererPerfEnabled(enabled) || !Number.isFinite(valueMs) || valueMs < 0) {
    return;
  }
  const state = getState();
  if (!state) return;
  addRendererPerfSample(state, name, valueMs);
  scheduleRendererPerfReport(state);
}

export function markRendererStartup(
  name: string,
  enabled?: boolean,
  details?: Record<string, unknown>,
): void {
  if (typeof window === "undefined" || typeof performance === "undefined") return;
  const state = getState();
  if (!state) return;
  if (!state.startupMarks.has(name)) {
    state.startupMarks.set(name, {
      name,
      atMs: performance.now(),
      details,
      emitted: false,
    });
  }
  flushRendererStartupMarks(enabled);
}

export function markRendererPerfEvent(
  name: string,
  enabled?: boolean,
  details?: Record<string, unknown>,
): void {
  if (!isRendererPerfEnabled(enabled)) return;
  const state = getState();
  if (!state) return;
  const atMs = performance.now();
  state.perfMarks.push({ name, atMs, details });
  if (state.perfMarks.length > MAX_PERF_MARKS) {
    state.perfMarks.splice(0, state.perfMarks.length - MAX_PERF_MARKS);
  }
  addRendererPerfSample(state, `mark.${name}_at_ms`, atMs);
  emitRendererPerfLog(formatPerfMark(name, atMs, details));
  scheduleRendererPerfReport(state);
}

export function flushRendererStartupMarks(enabled?: boolean): void {
  if (!isRendererPerfEnabled(enabled)) return;
  const state = getState();
  if (!state) return;
  let emittedAny = false;
  for (const mark of state.startupMarks.values()) {
    if (mark.emitted) continue;
    mark.emitted = true;
    emittedAny = true;
    addRendererPerfSample(state, `startup.${mark.name}_at_ms`, mark.atMs);
    emitRendererPerfLog(formatStartupMark(mark));
  }
  if (emittedAny) {
    scheduleRendererPerfReport(state);
  }
}

export function recordRendererRender(name: string, key: string, enabled?: boolean): void {
  if (!isRendererPerfEnabled(enabled)) return;
  const state = getState();
  if (!state) return;
  const bucket = state.renders.get(name) ?? createRenderBucket();
  bucket.total += 1;
  bucket.windowTotal += 1;
  incrementRenderKey(bucket.keys, key);
  incrementRenderKey(bucket.windowKeys, key);
  state.renders.set(name, bucket);
  scheduleRendererPerfReport(state);
}

export function incrementRendererPerfCounter(
  name: string,
  enabled?: boolean,
  delta: number = 1,
): void {
  if (!isRendererPerfEnabled(enabled) || !Number.isFinite(delta) || delta <= 0) return;
  const state = getState();
  if (!state) return;
  const bucket = state.counters.get(name) ?? { value: 0, windowValue: 0 };
  bucket.value += delta;
  bucket.windowValue = (bucket.windowValue ?? 0) + delta;
  state.counters.set(name, bucket);
  scheduleRendererPerfReport(state);
}

export function noteRendererTaskEventReceived(
  event: Pick<TaskEvent, "id" | "eventId" | "taskId" | "type">,
  enabled?: boolean,
): void {
  if (!isRendererPerfEnabled(enabled)) return;
  const state = getState();
  if (!state) return;
  cleanupTaskEventTraces(state, performance.now());
  const trace: TaskEventTrace = {
    eventId: event.id,
    taskId: event.taskId,
    type: event.type,
    receivedAtMs: performance.now(),
    renderable: false,
  };
  state.taskEvents.set(event.id, trace);
  const alias = getTaskEventAlias(event);
  if (alias && alias !== event.id) {
    trace.aliasId = alias;
    state.taskEventAliases.set(alias, event.id);
  }
}

export function noteRendererTaskEventQueued(
  event: Pick<TaskEvent, "id" | "eventId">,
  queuedAtMs: number,
  enabled?: boolean,
): void {
  if (!isRendererPerfEnabled(enabled)) return;
  const state = getState();
  const trace = state ? resolveTaskEventTrace(state, event) : null;
  if (!trace) return;
  trace.queuedAtMs = queuedAtMs;
}

export function noteRendererTaskEventsAppended(
  entries: Array<{ event: Pick<TaskEvent, "id" | "type">; queuedAtMs?: number }>,
  enabled?: boolean,
): void {
  if (!isRendererPerfEnabled(enabled) || entries.length === 0) return;
  const state = getState();
  if (!state) return;
  const nowMs = performance.now();
  for (const entry of entries) {
    const trace = resolveTaskEventTrace(state, entry.event);
    if (!trace) continue;
    const queuedAtMs = entry.queuedAtMs ?? trace.queuedAtMs;
    trace.appendedAtMs = nowMs;
    if (queuedAtMs != null) {
      recordRendererPerfSample("task-event.batch_wait_ms", nowMs - queuedAtMs, enabled);
      recordRendererPerfSample(
        `task-event.${entry.event.type}.batch_wait_ms`,
        nowMs - queuedAtMs,
        enabled,
      );
    }
    recordRendererPerfSample(
      "task-event.received_to_append_ms",
      nowMs - trace.receivedAtMs,
      enabled,
    );
    recordRendererPerfSample(
      `task-event.${entry.event.type}.received_to_append_ms`,
      nowMs - trace.receivedAtMs,
      enabled,
    );
    if (trace.appendDispatchAtMs != null) {
      recordRendererPerfSample(
        "task-event.append_dispatch_to_append_ms",
        nowMs - trace.appendDispatchAtMs,
        enabled,
      );
      recordRendererPerfSample(
        `task-event.${entry.event.type}.append_dispatch_to_append_ms`,
        nowMs - trace.appendDispatchAtMs,
        enabled,
      );
    }
  }
}

export function noteRendererTaskEventsAppendDispatched(
  entries: Array<Pick<TaskEvent, "id" | "eventId" | "type">>,
  enabled?: boolean,
): void {
  if (!isRendererPerfEnabled(enabled) || entries.length === 0) return;
  const state = getState();
  if (!state) return;
  const nowMs = performance.now();
  for (const entry of entries) {
    const trace = resolveTaskEventTrace(state, entry);
    if (!trace) continue;
    trace.appendDispatchAtMs = nowMs;
    recordRendererPerfSample(
      "task-event.received_to_append_dispatch_ms",
      nowMs - trace.receivedAtMs,
      enabled,
    );
    recordRendererPerfSample(
      `task-event.${entry.type}.received_to_append_dispatch_ms`,
      nowMs - trace.receivedAtMs,
      enabled,
    );
  }
}

function flushPendingVisibleEvents(state: RendererPerfState, enabled?: boolean): void {
  state.visibleFrame1 = null;
  state.visibleFrame2 = null;
  if (state.pendingVisibleEvents.size === 0) return;
  const pending = [...state.pendingVisibleEvents.entries()];
  state.pendingVisibleEvents.clear();
  const nowMs = performance.now();
  for (const [eventId, pendingVisible] of pending) {
    const recorded = recordTaskEventVisibleFromTrace(eventId, pendingVisible.location, enabled);
    if (!recorded) {
      const trace = resolveTaskEventTrace(state, eventId);
      const nextAttempts = pendingVisible.attempts + 1;
      const ageMs = nowMs - pendingVisible.firstQueuedAtMs;
      if (
        !trace &&
        (nextAttempts >= MAX_PENDING_VISIBLE_ATTEMPTS || ageMs >= PENDING_VISIBLE_TTL_MS)
      ) {
        incrementRendererPerfCounter("task-event.visible_drop_no_trace_count", enabled);
        continue;
      }
      if (
        trace &&
        !trace.renderable &&
        (nextAttempts >= MAX_PENDING_VISIBLE_ATTEMPTS || ageMs >= PENDING_VISIBLE_TTL_MS)
      ) {
        incrementRendererPerfCounter("task-event.visible_drop_not_renderable_count", enabled);
        continue;
      }
      state.pendingVisibleEvents.set(eventId, {
        ...pendingVisible,
        attempts: nextAttempts,
      });
    }
  }
  if (state.pendingVisibleEvents.size > 0) {
    schedulePendingVisibleEvents(state, enabled);
  }
}

function schedulePendingVisibleEvents(state: RendererPerfState, enabled?: boolean): void {
  if (state.visibleFrame1 != null || state.visibleFrame2 != null) return;
  state.visibleFrame1 = window.requestAnimationFrame(() => {
    state.visibleFrame1 = null;
    state.visibleFrame2 = window.requestAnimationFrame(() => {
      flushPendingVisibleEvents(state, enabled);
    });
  });
}

function recordTaskEventVisibleFromTrace(
  event: Pick<TaskEvent, "id" | "eventId"> | string,
  location: string,
  enabled?: boolean,
): boolean {
  if (!isRendererPerfEnabled(enabled)) return false;
  const state = getState();
  if (!state) return false;
  const trace = resolveTaskEventTrace(state, event);
  if (!trace || trace.visibleRecorded || !trace.renderable) return false;
  const nowMs = performance.now();
  trace.visibleRecorded = true;
  incrementRendererPerfCounter("task-event.visible_recorded_count", enabled);
  recordRendererPerfSample(
    "task-event.received_to_visible_ms",
    nowMs - trace.receivedAtMs,
    enabled,
  );
  recordRendererPerfSample(
    `task-event.${trace.type}.received_to_visible_ms`,
    nowMs - trace.receivedAtMs,
    enabled,
  );
  if (trace.appendedAtMs != null) {
    recordRendererPerfSample(
      "task-event.appended_to_visible_ms",
      nowMs - trace.appendedAtMs,
      enabled,
    );
    recordRendererPerfSample(
      `task-event.${trace.type}.appended_to_visible_ms`,
      nowMs - trace.appendedAtMs,
      enabled,
    );
    recordRendererPerfSample(
      `task-event.visible.${location}.ms`,
      nowMs - trace.appendedAtMs,
      enabled,
    );
  }
  state.settledVisibleEvents.set(trace.eventId, nowMs);
  if (trace.aliasId) {
    state.settledVisibleEvents.set(trace.aliasId, nowMs);
  }
  deleteTaskEventTrace(state, trace);
  state.pendingVisibleEvents.delete(trace.eventId);
  if (trace.aliasId) {
    state.pendingVisibleEvents.delete(trace.aliasId);
  }
  return true;
}

export function markTaskEventRenderable(
  event: Pick<TaskEvent, "id" | "eventId">,
  enabled?: boolean,
): void {
  if (!isRendererPerfEnabled(enabled)) return;
  const state = getState();
  if (!state) return;
  if (isTaskEventVisibilitySettled(state, event)) {
    return;
  }
  const trace = resolveTaskEventTrace(state, event);
  if (!trace) {
    incrementRendererPerfCounter("task-event.renderable_without_trace_count", enabled);
    return;
  }
  trace.renderable = true;
  trace.renderableAtMs = performance.now();
  if (state.pendingVisibleEvents.size > 0) {
    schedulePendingVisibleEvents(state, enabled);
  }
}

export function markTaskEventVisible(
  event: Pick<TaskEvent, "id" | "eventId">,
  location: string,
  enabled?: boolean,
): void {
  if (!isRendererPerfEnabled(enabled)) return;
  const state = getState();
  if (!state) return;
  if (isTaskEventVisibilitySettled(state, event)) {
    return;
  }
  incrementRendererPerfCounter("task-event.visible_signal_count", enabled);
  if (recordTaskEventVisibleFromTrace(event, location, enabled)) {
    return;
  }
  if (state.pendingVisibleEvents.size >= MAX_PENDING_VISIBLE_EVENTS) {
    incrementRendererPerfCounter("task-event.visible_queue_overflow_count", enabled);
    return;
  }
  const pendingVisible = {
    location,
    attempts: 0,
    firstQueuedAtMs: performance.now(),
  };
  state.pendingVisibleEvents.set(event.id, pendingVisible);
  const alias = getTaskEventAlias(event);
  if (alias && alias !== event.id && state.pendingVisibleEvents.size < MAX_PENDING_VISIBLE_EVENTS) {
    state.pendingVisibleEvents.set(alias, pendingVisible);
  }
  schedulePendingVisibleEvents(state, enabled);
}

export function noteRendererTaskEventVisible(
  event: Pick<TaskEvent, "id" | "eventId">,
  location: string,
  enabled?: boolean,
): void {
  markTaskEventVisible(event, location, enabled);
}
