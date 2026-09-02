import { describe, expect, it } from "vitest";
import type { TaskEvent } from "../../../shared/types";
import { extractCanonicalTaskImpactMetrics } from "../canonical-task-impact";

function event(result: unknown): TaskEvent {
  return {
    id: "event-7",
    taskId: "task-1",
    type: "tool_result",
    seq: 7,
    timestamp: 1234,
    payload: { tool: "generate_presentation", result },
  };
}

describe("extractCanonicalTaskImpactMetrics", () => {
  it("accepts explicit typed outcome counts", () => {
    expect(
      extractCanonicalTaskImpactMetrics(
        event({ success: true, impactMetrics: [{ kind: "slides_created", value: 12 }] }),
      ),
    ).toEqual([
      expect.objectContaining({
        id: "task-1:slides_created:canonical:event-7",
        kind: "slides_created",
        value: 12,
        provenance: "canonical_tool_outcome",
        sourceEventIds: ["event-7"],
        revision: 7,
      }),
    ]);
  });

  it("ignores prose, lookalike fields, failures, and unsupported metrics", () => {
    expect(extractCanonicalTaskImpactMetrics(event({ message: "Created 99 slides" }))).toEqual([]);
    expect(extractCanonicalTaskImpactMetrics(event({ slideCount: 99 }))).toEqual([]);
    expect(
      extractCanonicalTaskImpactMetrics(
        event({
          success: false,
          impactMetrics: [{ kind: "slides_created", value: 99 }],
        }),
      ),
    ).toEqual([]);
    expect(
      extractCanonicalTaskImpactMetrics(
        event({ impactMetrics: [{ kind: "files_changed", value: 99 }] }),
      ),
    ).toEqual([]);
  });
});
