import { describe, expect, it } from "vitest";
import { UsageInsightsService } from "../UsageInsightsService";

describe("UsageInsightsService", () => {
  it("counts legacy completed tasks with NULL terminal_status as AWUs", () => {
    const db = {
      prepare: (sql: string) => ({
        all: () => [],
        get: () => {
          if (sql.includes("COUNT(*) as count FROM tasks")) {
            expect(sql).toContain("completed_at >= ? AND completed_at <= ?");
            expect(sql).not.toContain("created_at >= ? AND created_at <= ?");
            // Distinguish whether the AWU query includes the legacy NULL fallback.
            return { count: sql.includes("terminal_status IS NULL") ? 2 : 1 };
          }
          return { count: 0 };
        },
      }),
    };

    const service = new UsageInsightsService(
      db as ConstructorParameters<typeof UsageInsightsService>[0],
    );
    const insights = service.generate("ws-1", 7);

    expect(insights.awuMetrics.awuCount).toBe(2);
  });

  it("aggregates token and tool execution metrics", () => {
    const llmRows = [
      {
        payload: JSON.stringify({
          modelKey: "gpt-4o",
          delta: { inputTokens: 100, outputTokens: 40, cost: 0.0123 },
        }),
      },
      {
        payload: JSON.stringify({
          modelKey: "gpt-4o-mini",
          delta: { inputTokens: 20, outputTokens: 10, cost: 0.0012 },
        }),
      },
    ];

    const toolRows = [
      { type: "tool_call", legacy_type: null, payload: JSON.stringify({ tool: "run_command" }) },
      { type: "tool_result", legacy_type: null, payload: JSON.stringify({ tool: "run_command" }) },
      { type: "tool_call", legacy_type: null, payload: JSON.stringify({ tool: "glob" }) },
      { type: "tool_error", legacy_type: null, payload: JSON.stringify({ tool: "glob" }) },
      {
        type: "timeline_step_updated",
        legacy_type: "tool_blocked",
        payload: JSON.stringify({ tool: "web_search" }),
      },
      { type: "tool_warning", legacy_type: null, payload: JSON.stringify({ tool: "glob" }) },
    ];

    const db = {
      prepare: (sql: string) => {
        if (sql.includes("GROUP BY status")) {
          return {
            all: () => [
              { status: "completed", count: 2, avg_time: 90_000 },
              { status: "failed", count: 1, avg_time: null },
            ],
            get: () => ({ count: 0 }),
          };
        }

        if (sql.includes("SELECT created_at FROM tasks")) {
          return {
            all: () => [],
            get: () => ({ count: 0 }),
          };
        }

        if (sql.includes("te.type = 'llm_usage'")) {
          return {
            all: () => llmRows,
            get: () => ({ count: 0 }),
          };
        }

        if (sql.includes("te.type = 'skill_used'")) {
          return {
            all: () => [],
            get: () => ({ count: 0 }),
          };
        }

        if (sql.includes("te.type, te.legacy_type as legacy_type")) {
          return {
            all: () => toolRows,
            get: () => ({ count: 0 }),
          };
        }

        if (sql.includes("COUNT(*) as count FROM tasks")) {
          return {
            all: () => [],
            get: () => ({ count: 1 }),
          };
        }

        return {
          all: () => [],
          get: () => ({ count: 0 }),
        };
      },
    };

    const service = new UsageInsightsService(
      db as ConstructorParameters<typeof UsageInsightsService>[0],
    );
    const insights = service.generate("ws-1", 7);

    expect(insights.executionMetrics.totalPromptTokens).toBe(120);
    expect(insights.executionMetrics.totalCompletionTokens).toBe(50);
    expect(insights.executionMetrics.totalTokens).toBe(170);
    expect(insights.executionMetrics.totalLlmCalls).toBe(2);
    expect(insights.executionMetrics.avgTokensPerLlmCall).toBe(85);
    expect(insights.executionMetrics.avgTokensPerTask).toBe(57);

    expect(insights.executionMetrics.totalToolCalls).toBe(2);
    expect(insights.executionMetrics.totalToolResults).toBe(1);
    expect(insights.executionMetrics.toolErrors).toBe(1);
    expect(insights.executionMetrics.toolBlocked).toBe(1);
    expect(insights.executionMetrics.toolWarnings).toBe(1);
    expect(insights.executionMetrics.uniqueTools).toBe(3);
    expect(insights.executionMetrics.toolCompletionRate).toBe(50);
    expect(insights.executionMetrics.topTools[0]).toEqual({
      tool: "glob",
      calls: 1,
      errors: 1,
    });
  });
});
