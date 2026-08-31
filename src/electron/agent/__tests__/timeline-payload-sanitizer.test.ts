import { describe, expect, it } from "vitest";
import {
  sanitizeTimelineEventForStorage,
  sanitizeTimelinePayloadForStorage,
} from "../timeline-payload-sanitizer";
import type { TaskEvent } from "../../../shared/types";

describe("timeline payload sanitizer", () => {
  it("omits nested base64 image fields while keeping capture metadata", () => {
    const imageBase64 = "a".repeat(2_000_000);
    const payload = {
      tool: "screenshot",
      result: {
        captureId: "capture-1",
        mediaType: "image/png",
        imageBase64,
      },
    };

    const sanitized = sanitizeTimelinePayloadForStorage(payload) as {
      result: Record<string, unknown>;
    };

    expect(sanitized.result.captureId).toBe("capture-1");
    expect(sanitized.result.mediaType).toBe("image/png");
    expect(sanitized.result.imageBase64).toBeUndefined();
    expect(sanitized.result.imageBase64Omitted).toBe(true);
    expect(sanitized.result.imageBase64OriginalChars).toBe(imageBase64.length);
  });

  it("truncates oversized text payloads", () => {
    const output = "x".repeat(130_000);
    const sanitized = sanitizeTimelinePayloadForStorage({ output }) as {
      output: string;
    };

    expect(sanitized.output.length).toBeLessThan(output.length);
    expect(sanitized.output).toContain("truncated 70000 chars");
  });

  it("enforces an aggregate payload byte limit", () => {
    const sanitized = sanitizeTimelinePayloadForStorage({
      tool: "run_command",
      message: "large output",
      chunks: Array.from({ length: 10 }, (_, index) => ({
        index,
        output: "x".repeat(60_000),
      })),
    }) as Record<string, unknown>;

    expect(sanitized.__coworkPayloadTruncated).toBe(true);
    expect(sanitized.tool).toBe("run_command");
    expect(Buffer.byteLength(JSON.stringify(sanitized), "utf8")).toBeLessThanOrEqual(256 * 1024);
  });

  it("normalizes non-json primitives and opaque containers", () => {
    const sanitized = sanitizeTimelinePayloadForStorage({
      startedAt: new Date("2026-05-25T10:00:00.000Z"),
      count: 12n,
      values: new Set(["a", "b"]),
      invalidNumber: Number.POSITIVE_INFINITY,
    }) as Record<string, unknown>;

    expect(sanitized.startedAt).toBe("2026-05-25T10:00:00.000Z");
    expect(sanitized.count).toBe("12n");
    expect(sanitized.values).toMatchObject({ omitted: true, reason: "Set payload", size: 2 });
    expect(sanitized.invalidNumber).toBe("Infinity");
    expect(() => JSON.stringify(sanitized)).not.toThrow();
  });

  it("sanitizes task events without mutating the original event", () => {
    const event: TaskEvent = {
      id: "event-1",
      taskId: "task-1",
      timestamp: 1,
      type: "tool_result",
      schemaVersion: 2,
      payload: {
        result: {
          imageBase64: "b".repeat(100),
        },
      },
    };

    const sanitized = sanitizeTimelineEventForStorage(event);

    expect((event.payload as { result: { imageBase64: string } }).result.imageBase64).toHaveLength(
      100,
    );
    expect(
      (sanitized.payload as { result: { imageBase64Omitted: boolean } }).result.imageBase64Omitted,
    ).toBe(true);
  });
});
