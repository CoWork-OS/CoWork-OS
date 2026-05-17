import { describe, expect, it } from "vitest";
import {
  rendererPerfLogLevel,
  stringifyRendererPerfPayload,
} from "../renderer-perf-log";

describe("renderer perf logging", () => {
  it("keeps explicit startup readiness marks visible at info level", () => {
    expect(rendererPerfLogLevel({ message: "[Startup] app_shell_ready at 8554.7ms" })).toBe(
      "info",
    );
  });

  it("treats periodic renderer summaries as debug noise by default", () => {
    expect(
      rendererPerfLogLevel({
        message: "startup.app_shell_ready_at_ms n=1 p50=8554.7ms",
      }),
    ).toBe("debug");
    expect(rendererPerfLogLevel({ message: "renderer.frame_gap_ms n=1 p50=966.6ms" })).toBe(
      "debug",
    );
    expect(rendererPerfLogLevel({ message: "renderer.long_task_count count=3" })).toBe("debug");
    expect(
      rendererPerfLogLevel({
        message: "task-event.tool_result.received_to_append_ms n=4 p50=12.6ms",
      }),
    ).toBe("debug");
    expect(
      rendererPerfLogLevel({
        message: "MainContent.taskConversationFlow renders=48 unique=1",
      }),
    ).toBe("debug");
    expect(rendererPerfLogLevel({ message: "Summary" })).toBe("debug");
  });

  it("stringifies non-string payloads for log output", () => {
    expect(stringifyRendererPerfPayload({ message: "Summary" })).toBe('{"message":"Summary"}');
    expect(stringifyRendererPerfPayload("Summary")).toBe("Summary");
  });
});
