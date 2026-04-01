import { describe, expect, it } from "vitest";

import { createToolBatchSummaryGenerator } from "../ToolBatchSummaryGenerator";
import type { ToolScheduleCallReport } from "../ToolScheduler";

function makeReport(name: string, id: string): ToolScheduleCallReport {
  return {
    call: {
      index: Number(id),
      toolUse: {
        type: "tool_use",
        id,
        name,
        input: {},
      },
    },
    effectiveToolName: name,
    status: "executed",
    toolResult: {
      type: "tool_result",
      tool_use_id: id,
      content: "",
    },
  };
}

describe("ToolBatchSummaryGenerator", () => {
  it("falls back to a deterministic label for tiny batches", async () => {
    const generator = createToolBatchSummaryGenerator();

    const result = await generator.generateSummary({
      phase: "step",
      callReports: [makeReport("read_file", "1")],
      disableModel: true,
    });

    expect(result.source).toBe("fallback");
    expect(result.semanticSummary).toBe("Read File");
  });

  it("uses the assistant intent when provided", async () => {
    const generator = createToolBatchSummaryGenerator();

    const result = await generator.generateSummary({
      phase: "follow_up",
      callReports: [makeReport("search_files", "1"), makeReport("grep", "2")],
      assistantIntent: "review release notes",
      disableModel: true,
    });

    expect(result.semanticSummary).toBe("Review Release Notes");
  });
});
