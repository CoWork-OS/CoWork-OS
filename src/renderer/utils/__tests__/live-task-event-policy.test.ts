import { describe, expect, it } from "vitest";

import type { TaskEvent } from "../../../shared/types";
import {
  classifyLiveTaskEvent,
  getLiveTaskEventCoalesceFingerprint,
} from "../live-task-event-policy";

function event(type: string, payload: Record<string, unknown> = {}): TaskEvent {
  return {
    id: `${type}-1`,
    taskId: "task-1",
    type,
    timestamp: 100,
    payload,
  } as TaskEvent;
}

describe("live task event policy", () => {
  it("keeps user-critical events immediate", () => {
    expect(classifyLiveTaskEvent(event("approval_requested"))).toBe("immediate");
    expect(classifyLiveTaskEvent(event("assistant_message", { message: "Done" }))).toBe(
      "immediate",
    );
  });

  it("batches successful tool results", () => {
    expect(classifyLiveTaskEvent(event("tool_result", { tool: "read_file" }))).toBe("batchable");
  });

  it("coalesces repeated provider and network failures", () => {
    const failed = event("tool_result", {
      tool: "web_search",
      success: false,
      error: "fetch failed: network timeout",
      code: "FETCH_FAILED",
    });

    expect(classifyLiveTaskEvent(failed)).toBe("coalescible");
    expect(getLiveTaskEventCoalesceFingerprint(failed)).toContain("FETCH_FAILED");
  });

  it("hides live-only background noise", () => {
    expect(classifyLiveTaskEvent(event("llm_usage"))).toBe("hiddenLiveNoise");
  });
});
