import { beforeEach, describe, expect, it } from "vitest";

import { selectVisibleTaskFeedRows } from "../../components/MainContent";
import {
  taskSurfacePerfFixtureBatches,
  taskSurfacePerfFixtureEvents,
  taskSurfacePerfFixtureTask,
} from "../../perf-fixtures/task-surface-mixed-session.fixture";
import {
  taskSurfaceFailureStormEvents,
  taskSurfaceFailureStormTask,
} from "../../perf-fixtures/task-surface-failure-storm.fixture";
import { deriveSharedTaskEventUiState } from "../task-event-derived";
import {
  markTaskEventRenderable,
  markTaskEventVisible,
  noteRendererTaskEventReceived,
  noteRendererTaskEventsAppendDispatched,
  noteRendererTaskEventsAppended,
} from "../renderer-perf";

function percentile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index] ?? 0;
}

describe("renderer perf replay fixture", () => {
  beforeEach(() => {
    const testWindow = globalThis as Any;
    if (!testWindow.window) {
      testWindow.window = testWindow;
    }
    testWindow.window.__coworkRendererPerfState__ = undefined;
    testWindow.window.requestAnimationFrame = (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    };
    testWindow.window.cancelAnimationFrame = () => {};
  });

  it("replays a mixed task surface fixture within the renderer perf budget", () => {
    const byId = new Map(taskSurfacePerfFixtureEvents.map((event) => [event.id, event]));
    const replayedEvents: typeof taskSurfacePerfFixtureEvents = [];

    for (const batchIds of taskSurfacePerfFixtureBatches) {
      const batchEvents = batchIds
        .map((id) => byId.get(id))
        .filter(Boolean) as typeof taskSurfacePerfFixtureEvents;
      batchEvents.forEach((event) => noteRendererTaskEventReceived(event, true));
      noteRendererTaskEventsAppendDispatched(batchEvents, true);
      replayedEvents.push(...batchEvents);
      noteRendererTaskEventsAppended(
        batchEvents.map((event) => ({ event })),
        true,
      );

      const shared = deriveSharedTaskEventUiState({
        rawEvents: replayedEvents,
        task: taskSurfacePerfFixtureTask,
        workspace: null,
        verboseSteps: false,
      });

      const feedRows = shared.baseTimelineItems.map((item, index) => ({
        kind: "timeline" as const,
        key: item.kind === "event" ? `event:${item.event.id}` : `action-block:${item.blockId}`,
        estimatedHeight: 120,
        timelineIndex: index,
        item,
        revision:
          item.kind === "event"
            ? `${item.event.id}:${item.event.type}`
            : `${item.blockId}:${item.events[item.events.length - 1]?.id ?? "none"}`,
        visiblePerfEventId:
          item.kind === "event" ? item.event.id : (item.events[item.events.length - 1]?.id ?? null),
      }));
      const visible = selectVisibleTaskFeedRows(feedRows as Any, "live");
      for (const row of visible.visibleFeedRows) {
        if (!row.visiblePerfEventId) continue;
        markTaskEventRenderable({ id: row.visiblePerfEventId }, true);
        markTaskEventVisible({ id: row.visiblePerfEventId }, "fixture-replay", true);
      }
    }

    const state = (
      globalThis.window as Window & {
        __coworkRendererPerfState__?: {
          metrics: Map<string, { samples: number[] }>;
          counters: Map<string, { value: number }>;
        };
      }
    ).__coworkRendererPerfState__;

    expect(state).toBeDefined();

    const appendSamples = [
      ...(state?.metrics.get("task-event.append_dispatch_to_append_ms")?.samples ?? []),
    ].sort((a, b) => a - b);
    const visibleSamples = [
      ...(state?.metrics.get("task-event.received_to_visible_ms")?.samples ?? []),
    ];
    const appendedVisibleSamples = [
      ...(state?.metrics.get("task-event.appended_to_visible_ms")?.samples ?? []),
    ];
    const visibleSignalCount = state?.counters.get("task-event.visible_signal_count")?.value ?? 0;
    const visibleRecordedCount =
      state?.counters.get("task-event.visible_recorded_count")?.value ?? 0;

    expect(visibleSamples.length).toBeGreaterThan(0);
    expect(appendedVisibleSamples.length).toBeGreaterThan(0);
    expect(visibleRecordedCount).toBeGreaterThan(0);
    expect(visibleRecordedCount).toBeLessThanOrEqual(visibleSignalCount);
    expect(percentile(appendSamples, 0.95)).toBeLessThanOrEqual(35);

    console.info(
      `[renderer-perf-fixture] append_p95=${percentile(appendSamples, 0.95).toFixed(1)}ms visible=${visibleSamples.length} visible_recorded=${visibleRecordedCount}/${visibleSignalCount}`,
    );
  });

  it("projects a failure storm into a bounded live transcript within budget", () => {
    const startedAt = performance.now();
    const shared = deriveSharedTaskEventUiState({
      rawEvents: taskSurfaceFailureStormEvents,
      task: taskSurfaceFailureStormTask,
      workspace: null,
      verboseSteps: false,
      projectionMode: "live",
      liveWindowSize: 160,
    });
    const projectionMs = performance.now() - startedAt;

    const feedRows = shared.baseTimelineItems.map((item, index) => ({
      kind: "timeline" as const,
      key: item.kind === "event" ? `event:${item.event.id}` : `action-block:${item.blockId}`,
      estimatedHeight: 120,
      timelineIndex: index,
      item,
      revision:
        item.kind === "event"
          ? `${item.event.id}:${item.event.type}`
          : `${item.blockId}:${item.events[item.events.length - 1]?.id ?? "none"}`,
      visiblePerfEventId:
        item.kind === "event" ? item.event.id : (item.events[item.events.length - 1]?.id ?? null),
    }));
    const visible = selectVisibleTaskFeedRows(feedRows as Any, "live");

    expect(shared.rawEventCount).toBeGreaterThanOrEqual(600);
    expect(shared.normalizedEvents.length).toBeLessThanOrEqual(167);
    expect(projectionMs).toBeLessThanOrEqual(12);
    expect(visible.visibleFeedRows.length).toBeLessThanOrEqual(12);
    expect(
      shared.filteredEvents.filter((event) => {
        const payload = event.payload as Record<string, unknown> | undefined;
        return (
          event.type === "error" &&
          payload?.message === "fetch failed: network timeout while querying provider"
        );
      }).length,
    ).toBeLessThanOrEqual(2);

    console.info(
      `[renderer-perf-fixture] failure_storm_projection=${projectionMs.toFixed(1)}ms raw=${shared.rawEventCount} projected=${shared.normalizedEvents.length} visible=${visible.visibleFeedRows.length}`,
    );
  });
});
