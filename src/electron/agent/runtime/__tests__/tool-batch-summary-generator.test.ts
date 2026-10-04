import { describe, expect, it, vi } from "vitest";

const providerFactory = vi.hoisted(() => {
  const createMessage = vi.fn(async () => ({
    content: [{ type: "text", text: "Model Written Label" }],
    stopReason: "end_turn",
  }));
  return {
    createMessage,
    createProvider: vi.fn(() => ({ type: "openai", createMessage })),
  };
});

vi.mock("../../llm/provider-factory", () => ({
  LLMProviderFactory: {
    createProvider: providerFactory.createProvider,
    loadSettings: vi.fn(() => ({ providerType: "openai" })),
    resolveTaskModelSelection: vi.fn(() => ({ modelId: "global-model" })),
  },
}));

import { createToolBatchSummaryGenerator } from "../ToolBatchSummaryGenerator";
import type { ToolScheduleCallReport } from "../ToolScheduler";

function makeReport(
  name: string,
  id: string,
  options?: {
    input?: Record<string, unknown>;
    content?: string;
  },
): ToolScheduleCallReport {
  return {
    call: {
      index: Number(id),
      toolUse: {
        type: "tool_use",
        id,
        name,
        input: options?.input || {},
      },
    },
    effectiveToolName: name,
    status: "executed",
    toolResult: {
      type: "tool_result",
      tool_use_id: id,
      content: options?.content || "",
    },
  };
}

describe("ToolBatchSummaryGenerator", () => {
  it("falls back to a deterministic label for tiny batches", async () => {
    const generator = createToolBatchSummaryGenerator();

    const result = await generator.generateSummary({
      phase: "step",
      callReports: [makeReport("read_file", "1")],
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
    });

    expect(result.semanticSummary).toBe("Review Release Notes");
  });

  it("ignores assistant intent for single-tool batches", async () => {
    const generator = createToolBatchSummaryGenerator();

    const result = await generator.generateSummary({
      phase: "verification",
      callReports: [makeReport("task_history", "1")],
      assistantIntent: "exit status is `0`",
    });

    expect(result.semanticSummary).toBe("Check Task History");
  });

  it("falls back to a deterministic family label when assistant intent is long narrative prose", async () => {
    const generator = createToolBatchSummaryGenerator();

    const result = await generator.generateSummary({
      phase: "step",
      callReports: [makeReport("read_file", "1"), makeReport("list_directory", "2")],
      assistantIntent:
        "I’m checking the workspace for what this task is referring to, then validating the context.",
    });

    expect(result.semanticSummary).toBe("Inspect Workspace");
  });

  it("does not surface structured task history payloads in single-tool labels", async () => {
    const generator = createToolBatchSummaryGenerator();

    const result = await generator.generateSummary({
      phase: "step",
      callReports: [
        makeReport("task_history", "1", {
          input: { period: "today" },
          content:
            'Task History {success:true,period:today,range:{startMs:177594840,endMs:177603480,startIso:"2026-04-12T00:00:00.000Z"}}',
        }),
      ],
    });

    expect(result.semanticSummary).toBe("Check Task History");
  });

  it("labels multi-call batches synchronously without contacting any model provider", () => {
    const generator = createToolBatchSummaryGenerator();

    const result = generator.generateSummary({
      phase: "step",
      callReports: [
        makeReport("web_fetch", "1", {
          input: { url: "https://internal.example/secret-report" },
          content: "confidential tool output",
        }),
        makeReport("web_search", "2", { input: { query: "quarterly numbers" } }),
      ],
    });

    expect(result).not.toBeInstanceOf(Promise);
    expect(result).toEqual({ semanticSummary: "Research Sources", source: "fallback" });
    expect(providerFactory.createProvider).not.toHaveBeenCalled();
    expect(providerFactory.createMessage).not.toHaveBeenCalled();
  });
});
