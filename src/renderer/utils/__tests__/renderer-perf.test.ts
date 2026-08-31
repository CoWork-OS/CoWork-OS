import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TaskEvent } from "../../../shared/types";
import {
  markTaskEventRenderable,
  markTaskEventVisible,
  noteRendererTaskEventReceived,
  noteRendererTaskEventsAppendDispatched,
  noteRendererTaskEventsAppended,
  incrementRendererPerfCounter,
  recordRendererPerfSample,
  recordRendererRender,
} from "../renderer-perf";

type TestWindow = Window &
  typeof globalThis & {
    __coworkRendererPerfState__?: unknown;
  };

type TestGlobal = typeof globalThis & {
  window?: TestWindow;
};

type RendererPerfTestState = {
  metrics: Map<string, { samples: number[] }>;
  counters: Map<string, { value: number; windowValue?: number }>;
};

function ensureTestWindow(): TestWindow {
  const testGlobal = globalThis as TestGlobal;
  if (!testGlobal.window) {
    testGlobal.window = testGlobal as unknown as TestWindow;
  }
  return testGlobal.window;
}

function makeEvent(
  overrides: Partial<TaskEvent> & Pick<TaskEvent, "id" | "taskId" | "type">,
): TaskEvent {
  return {
    id: overrides.id,
    taskId: overrides.taskId,
    type: overrides.type,
    timestamp: overrides.timestamp ?? Date.now(),
    payload: overrides.payload ?? {},
    schemaVersion: 2,
    ...(overrides.eventId ? { eventId: overrides.eventId } : {}),
  };
}

describe("renderer-perf visibility tracing", () => {
  beforeEach(() => {
    const testWindow = ensureTestWindow();
    if (typeof testWindow.requestAnimationFrame !== "function") {
      testWindow.requestAnimationFrame = (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      };
      testWindow.cancelAnimationFrame = () => {};
    }
    testWindow.__coworkRendererPerfState__ = undefined;
  });

  it("records visible timing immediately when the row reports a normalized event id alias", () => {
    const receivedEvent = makeEvent({
      id: "raw-event-id",
      eventId: "timeline-event-id",
      taskId: "task-1",
      type: "step_started",
    });
    const visibleEvent = makeEvent({
      id: "timeline-event-id",
      taskId: "task-1",
      type: "step_started",
    });

    noteRendererTaskEventReceived(receivedEvent, true);
    noteRendererTaskEventsAppendDispatched([receivedEvent], true);
    noteRendererTaskEventsAppended([{ event: receivedEvent }], true);
    markTaskEventRenderable(visibleEvent, true);
    markTaskEventVisible(visibleEvent, "measured-row", true);

    const state = (
      globalThis.window as Window & {
        __coworkRendererPerfState__?: {
          metrics: Map<string, { samples: number[] }>;
          counters: Map<string, { value: number }>;
        };
      }
    ).__coworkRendererPerfState__;
    expect(state).toBeDefined();

    const receivedToVisible =
      state?.metrics.get("task-event.received_to_visible_ms")?.samples ?? [];
    const appendedToVisible =
      state?.metrics.get("task-event.appended_to_visible_ms")?.samples ?? [];

    expect(receivedToVisible.length).toBe(1);
    expect(appendedToVisible.length).toBe(1);
    expect(state?.counters.get("task-event.visible_signal_count")?.value).toBe(1);
    expect(state?.counters.get("task-event.visible_recorded_count")?.value).toBe(1);
  });

  it("drops unresolved visible signals after bounded retries", () => {
    const visibleEvent = makeEvent({
      id: "untracked-event",
      taskId: "task-1",
      type: "step_started",
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      markTaskEventVisible(visibleEvent, "measured-row", true);
    }

    const state = (
      globalThis.window as Window & {
        __coworkRendererPerfState__?: {
          counters: Map<string, { value: number }>;
        };
      }
    ).__coworkRendererPerfState__;

    expect(state?.counters.get("task-event.visible_drop_no_trace_count")?.value).toBeGreaterThan(0);
  });

  it("ignores repeated renderable and visible notifications after a trace is already settled", () => {
    const event = makeEvent({
      id: "step-1",
      taskId: "task-1",
      type: "step_started",
    });

    noteRendererTaskEventReceived(event, true);
    noteRendererTaskEventsAppendDispatched([event], true);
    noteRendererTaskEventsAppended([{ event }], true);
    markTaskEventRenderable(event, true);
    markTaskEventVisible(event, "measured-row", true);

    markTaskEventRenderable(event, true);
    markTaskEventVisible(event, "measured-row", true);

    const state = (
      globalThis.window as Window & {
        __coworkRendererPerfState__?: {
          counters: Map<string, { value: number }>;
        };
      }
    ).__coworkRendererPerfState__;

    expect(state?.counters.get("task-event.visible_recorded_count")?.value).toBe(1);
    expect(state?.counters.get("task-event.visible_signal_count")?.value).toBe(1);
    expect(state?.counters.get("task-event.renderable_without_trace_count")?.value ?? 0).toBe(0);
    expect(state?.counters.get("task-event.visible_drop_no_trace_count")?.value ?? 0).toBe(0);
  });
});

describe("renderer-perf render summaries", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    ensureTestWindow().__coworkRendererPerfState__ = undefined;
  });

  it("reports render activity for the current interval while retaining cumulative totals", () => {
    const testWindow = ensureTestWindow();
    const pendingReports: Array<() => void> = [];
    const originalSetTimeout = testWindow.setTimeout;
    const originalRequestAnimationFrame = testWindow.requestAnimationFrame;
    const originalCancelAnimationFrame = testWindow.cancelAnimationFrame;
    const originalElectronApi = testWindow.electronAPI;
    const messages: string[] = [];

    testWindow.requestAnimationFrame = undefined as unknown as typeof window.requestAnimationFrame;
    testWindow.cancelAnimationFrame = undefined as unknown as typeof window.cancelAnimationFrame;
    testWindow.setTimeout = ((callback: TimerHandler, timeout?: number) => {
      if (typeof callback === "function" && timeout === 10_000) {
        pendingReports.push(callback as () => void);
      }
      return pendingReports.length + 1;
    }) as typeof window.setTimeout;
    const electronApi = originalElectronApi ? { ...originalElectronApi } : {};
    testWindow.electronAPI = {
      ...electronApi,
      logRendererPerf: vi.fn((entry: { message: string }) => {
        messages.push(entry.message);
      }),
    } as unknown as typeof testWindow.electronAPI;

    try {
      recordRendererRender("MainContent", "task:none", true);
      recordRendererRender("MainContent", "task:none", true);

      expect(pendingReports).toHaveLength(1);
      pendingReports.shift()?.();

      expect(messages).toContain("Summary");
      expect(messages).toContain("MainContent renders=2 unique=1 top=[task:none:2]");

      messages.length = 0;
      recordRendererRender("MainContent", "task:none", true);
      pendingReports.shift()?.();

      expect(messages).toContain("MainContent renders=1 unique=1 top=[task:none:1]");
    } finally {
      testWindow.setTimeout = originalSetTimeout;
      testWindow.requestAnimationFrame = originalRequestAnimationFrame;
      testWindow.cancelAnimationFrame = originalCancelAnimationFrame;
      testWindow.electronAPI = originalElectronApi;
    }
  });

  it("ignores background-scale frame gaps while retaining actionable foreground gaps", () => {
    const testWindow = ensureTestWindow();
    const pendingReports: Array<() => void> = [];
    const pendingFrameTimers: Array<() => void> = [];
    const frameCallbacks: FrameRequestCallback[] = [];
    const originalSetTimeout = testWindow.setTimeout;
    const originalRequestAnimationFrame = testWindow.requestAnimationFrame;
    const originalCancelAnimationFrame = testWindow.cancelAnimationFrame;

    testWindow.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    }) as typeof window.requestAnimationFrame;
    testWindow.cancelAnimationFrame = () => {};
    testWindow.setTimeout = ((callback: TimerHandler, timeout?: number) => {
      if (typeof callback === "function" && timeout === 0) {
        pendingFrameTimers.push(callback as () => void);
      } else if (typeof callback === "function" && timeout === 10_000) {
        pendingReports.push(callback as () => void);
      }
      return pendingReports.length + pendingFrameTimers.length + frameCallbacks.length + 1;
    }) as typeof window.setTimeout;

    try {
      recordRendererRender("App", "view:main", true);

      pendingFrameTimers.shift()?.();
      frameCallbacks.shift()?.(0);
      pendingFrameTimers.shift()?.();
      frameCallbacks.shift()?.(32_789_038);
      pendingFrameTimers.shift()?.();
      frameCallbacks.shift()?.(32_789_100);

      const state = testWindow.__coworkRendererPerfState__ as RendererPerfTestState | undefined;
      expect(state?.metrics.get("renderer.frame_gap_ms")?.samples).toEqual([62]);
      expect(state?.counters.get("renderer.frame_gap_count")?.value ?? 0).toBe(0);
    } finally {
      testWindow.setTimeout = originalSetTimeout;
      testWindow.requestAnimationFrame = originalRequestAnimationFrame;
      testWindow.cancelAnimationFrame = originalCancelAnimationFrame;
    }
  });

  it("does not repeat stale metric and counter buckets after a report flush", () => {
    const testWindow = ensureTestWindow();
    const pendingReports: Array<() => void> = [];
    const originalSetTimeout = testWindow.setTimeout;
    const originalRequestAnimationFrame = testWindow.requestAnimationFrame;
    const originalCancelAnimationFrame = testWindow.cancelAnimationFrame;
    const originalElectronApi = testWindow.electronAPI;
    const messages: string[] = [];

    testWindow.requestAnimationFrame = undefined as unknown as typeof window.requestAnimationFrame;
    testWindow.cancelAnimationFrame = undefined as unknown as typeof window.cancelAnimationFrame;
    testWindow.setTimeout = ((callback: TimerHandler, timeout?: number) => {
      if (typeof callback === "function" && timeout === 10_000) {
        pendingReports.push(callback as () => void);
      }
      return pendingReports.length + 1;
    }) as typeof window.setTimeout;
    const electronApi = originalElectronApi ? { ...originalElectronApi } : {};
    testWindow.electronAPI = {
      ...electronApi,
      logRendererPerf: vi.fn((entry: { message: string }) => {
        messages.push(entry.message);
      }),
    } as unknown as typeof testWindow.electronAPI;

    try {
      recordRendererPerfSample("renderer.frame_gap_ms", 64, true);
      incrementRendererPerfCounter("renderer.frame_gap_count", true);
      incrementRendererPerfCounter("renderer.frame_gap_count", true);
      pendingReports.shift()?.();

      expect(messages).toContain("renderer.frame_gap_ms n=1 p50=64.0ms p95=64.0ms max=64.0ms");
      expect(messages).toContain("renderer.frame_gap_count count=2");

      messages.length = 0;
      recordRendererRender("App", "view:main", true);
      pendingReports.shift()?.();

      expect(messages).toContain("App renders=1 unique=1 top=[view:main:1]");
      expect(messages.some((message) => message.startsWith("renderer.frame_gap_ms "))).toBe(false);
      expect(messages.some((message) => message.startsWith("renderer.frame_gap_count "))).toBe(
        false,
      );
    } finally {
      testWindow.setTimeout = originalSetTimeout;
      testWindow.requestAnimationFrame = originalRequestAnimationFrame;
      testWindow.cancelAnimationFrame = originalCancelAnimationFrame;
      testWindow.electronAPI = originalElectronApi;
    }
  });
});
