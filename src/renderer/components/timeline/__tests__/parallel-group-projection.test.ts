import { describe, expect, it } from "vitest";

import type { TaskEvent } from "../../../../shared/types";
import {
  buildParallelGroupProjection,
  getEventGroupId,
  isToolsParallelGroupId,
} from "../parallel-group-projection";

function makeEvent(
  type: TaskEvent["type"],
  id: string,
  payload: Record<string, unknown>,
  overrides: Partial<TaskEvent> = {},
): TaskEvent {
  return {
    id,
    taskId: "task-1",
    timestamp: 1000 + Number(id.replace(/\D+/g, "") || 0),
    schemaVersion: 2,
    type,
    payload,
    ...overrides,
  };
}

describe("parallel-group-projection", () => {
  it("detects tool parallel group identifiers", () => {
    expect(isToolsParallelGroupId("tools:step:build:1")).toBe(true);
    expect(isToolsParallelGroupId(" stage:build ")).toBe(false);
    expect(isToolsParallelGroupId(null)).toBe(false);
  });

  it("extracts group id from event fields", () => {
    const event = makeEvent(
      "timeline_group_started",
      "evt-1",
      { groupId: "tools:step:build:1" },
      { groupId: "tools:step:build:1" },
    );
    expect(getEventGroupId(event)).toBe("tools:step:build:1");
  });

  it("builds stable lane ordering and suppression sets for tool groups", () => {
    const groupId = "tools:step:build:1";
    const events: TaskEvent[] = [
      makeEvent("timeline_group_started", "evt-1", {
        groupId,
        groupLabel: "Tool batch (2)",
      }),
      makeEvent("tool_call", "evt-2", {
        groupId,
        tool: "web_search",
        toolUseId: "use-2",
        toolCallIndex: 2,
      }),
      makeEvent("tool_call", "evt-3", {
        groupId,
        tool: "web_fetch",
        toolUseId: "use-1",
        toolCallIndex: 1,
      }),
      makeEvent("timeline_step_started", "evt-4", {
        groupId,
        step: { id: "tool_lane:step:use-1", description: "Running web_fetch" },
        status: "in_progress",
      }),
      makeEvent("tool_result", "evt-5", {
        groupId,
        tool: "web_search",
        toolUseId: "use-2",
        toolCallIndex: 2,
        result: { success: true },
      }),
      makeEvent("timeline_step_finished", "evt-6", {
        groupId,
        step: { id: "tool_lane:step:use-1", description: "Running web_fetch" },
        status: "completed",
      }),
      makeEvent("tool_result", "evt-7", {
        groupId,
        tool: "web_fetch",
        toolUseId: "use-1",
        toolCallIndex: 1,
        result: { success: true },
      }),
      makeEvent("timeline_group_finished", "evt-8", {
        groupId,
        groupLabel: "Tool batch",
        status: "completed",
      }),
    ];

    const projection = buildParallelGroupProjection(events);
    const group = projection.groupsByAnchorEventId.get("evt-1");
    expect(group).toBeDefined();
    expect(group?.groupId).toBe(groupId);
    expect(group?.status).toBe("completed");
    expect(group?.lanes.map((lane) => lane.toolUseId)).toEqual(["use-1", "use-2"]);
    expect(group?.lanes.map((lane) => lane.toolCallIndex)).toEqual([1, 2]);
    expect(group?.lanes.map((lane) => lane.title)).toEqual(["Fetched page", "Search complete"]);

    expect(projection.suppressedEventIds.has("evt-1")).toBe(false);
    expect(projection.suppressedEventIds.has("evt-2")).toBe(true);
    expect(projection.suppressedEventIds.has("evt-5")).toBe(true);
    expect(projection.suppressedEventIds.has("evt-8")).toBe(true);
  });

  it("suppresses orphaned tool results that match a lane by toolUseId", () => {
    const groupId = "tools:step:build:1";
    const events: TaskEvent[] = [
      makeEvent("timeline_group_started", "evt-1", {
        groupId,
        groupLabel: "Tool batch (1)",
      }),
      makeEvent("tool_call", "evt-2", {
        groupId,
        tool: "http_request",
        toolUseId: "use-1",
        toolCallIndex: 1,
        input: { url: "https://api.github.com/repos/org/repo/releases" },
      }),
      makeEvent("timeline_group_finished", "evt-3", {
        groupId,
        groupLabel: "Tool batch (1)",
        status: "completed",
      }),
      makeEvent("tool_result", "evt-4", {
        tool: "http_request",
        toolUseId: "use-1",
        result: {
          success: true,
          url: "https://api.github.com/repos/org/repo/releases",
        },
      }),
    ];

    const projection = buildParallelGroupProjection(events);
    const group = projection.groupsByAnchorEventId.get("evt-1");
    expect(group?.lanes[0]?.title).toContain("api.github.com/repos/org/repo/releases");
    expect(projection.suppressedEventIds.has("evt-4")).toBe(true);
  });

  it("suppresses orphaned tool calls that match a lane by toolUseId", () => {
    const groupId = "tools:step:build:1";
    const events: TaskEvent[] = [
      makeEvent("timeline_group_started", "evt-1", {
        groupId,
        groupLabel: "Tool batch (1)",
      }),
      makeEvent("timeline_step_started", "evt-2", {
        groupId,
        step: { id: "tool_lane:step:use-1", description: "Running http_request" },
        status: "in_progress",
      }),
      makeEvent("tool_call", "evt-3", {
        tool: "http_request",
        toolUseId: "use-1",
        input: { url: "https://api.github.com/repos/foo/bar/contents/src/electron" },
      }),
    ];

    const projection = buildParallelGroupProjection(events);
    const group = projection.groupsByAnchorEventId.get("evt-1");
    expect(group?.lanes[0]?.title).toContain("api.github.com/repos/foo/bar/contents/src/electron");
    expect(projection.suppressedEventIds.has("evt-3")).toBe(true);
  });

  it("keeps a specific search_files title when completion is generic", () => {
    const groupId = "tools:step:build:1";
    const events: TaskEvent[] = [
      makeEvent("timeline_group_started", "evt-1", {
        groupId,
        groupLabel: "Tool batch (1)",
      }),
      makeEvent("tool_call", "evt-2", {
        groupId,
        tool: "search_files",
        toolUseId: "use-1",
        toolCallIndex: 1,
        input: { query: "SessionRuntime" },
      }),
      makeEvent("tool_result", "evt-3", {
        groupId,
        tool: "search_files",
        toolUseId: "use-1",
        toolCallIndex: 1,
        result: { matches: [{ path: "src/electron/agent/runtime/SessionRuntime.ts" }], totalFound: 1 },
      }),
      makeEvent("timeline_step_finished", "evt-4", {
        groupId,
        step: { id: "tool_lane:step:use-1", description: "Running search_files" },
        status: "completed",
      }),
    ];

    const projection = buildParallelGroupProjection(events);
    const group = projection.groupsByAnchorEventId.get("evt-1");
    expect(group?.lanes[0]?.title).toBe("Search files: SessionRuntime");
  });

  it("shows the files read for read_files results", () => {
    const groupId = "tools:step:build:1";
    const events: TaskEvent[] = [
      makeEvent("timeline_group_started", "evt-1", {
        groupId,
        groupLabel: "Tool batch (1)",
      }),
      makeEvent("tool_result", "evt-2", {
        groupId,
        tool: "read_files",
        toolUseId: "use-1",
        toolCallIndex: 1,
        result: {
          files: [
            { path: "src/electron/agent/runtime/SessionRuntime.ts", content: "..." },
            { path: "src/electron/agent/runtime/ToolScheduler.ts", content: "..." },
          ],
        },
      }),
    ];

    const projection = buildParallelGroupProjection(events);
    const group = projection.groupsByAnchorEventId.get("evt-1");
    expect(group?.lanes[0]?.title).toBe("Read files: SessionRuntime.ts, ToolScheduler.ts");
  });

  it("uses embedded timeline tool payloads for lane titles", () => {
    const groupId = "tools:step:build:1";
    const events: TaskEvent[] = [
      makeEvent("timeline_group_started", "evt-1", {
        groupId,
        groupLabel: "Tool batch (1)",
      }),
      makeEvent("timeline_step_updated", "evt-2", {
        groupId,
        legacyType: "tool_call",
        tool: "web_fetch",
        toolUseId: "use-1",
        toolCallIndex: 1,
        input: { url: "https://ccunpacked.dev/" },
        step: { id: "tool_lane:step:use-1", description: "Running web_fetch" },
        status: "in_progress",
      }),
      makeEvent("timeline_step_finished", "evt-3", {
        groupId,
        legacyType: "tool_result",
        tool: "web_fetch",
        toolUseId: "use-1",
        toolCallIndex: 1,
        result: { success: true, url: "https://ccunpacked.dev/", title: "CCUnpacked" },
        step: { id: "tool_lane:step:use-1", description: "Running web_fetch" },
        status: "completed",
      }),
    ];

    const projection = buildParallelGroupProjection(events);
    const group = projection.groupsByAnchorEventId.get("evt-1");
    expect(group?.lanes[0]?.title).toBe("Fetched CCUnpacked");
  });
});
