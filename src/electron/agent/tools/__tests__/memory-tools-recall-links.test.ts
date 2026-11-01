import { describe, expect, it } from "vitest";

import { MemoryTools } from "../memory-tools";

/** formatHit only reads the hit; it is called on the prototype. */
function formatHit(hit: Record<string, unknown>): Record<string, Any> {
  return (MemoryTools.prototype as Any).formatHit.call({}, hit, false);
}

describe("memory_recall hits link to their task", () => {
  it("renders provenance.taskId as the task_get call that recalls it", () => {
    const formatted = formatHit({
      ref: "event:evt-1",
      lane: "conversations",
      title: "Deploy notes",
      snippet: "We moved the deploy to Friday.",
      source: "event",
      createdAt: Date.UTC(2026, 9, 30),
      relevance: 0.8,
      tokenEstimate: 12,
      provenance: { taskId: "4f1c2a9e-1b2c-4d5e-8f90-123456789abc", role: "assistant" },
    });
    expect(formatted.provenance).toEqual({
      taskId: "task_get(4f1c2a9e-1b2c-4d5e-8f90-123456789abc)",
      role: "assistant",
    });
  });

  it("leaves hits without a usable task id as they are", () => {
    const formatted = formatHit({
      ref: "memory:1",
      lane: "memory",
      snippet: "Prefers short answers.",
      source: "user",
      provenance: { store: "memory", taskId: "not an id" },
    });
    expect(formatted.provenance).toEqual({ store: "memory", taskId: "not an id" });
  });
});
