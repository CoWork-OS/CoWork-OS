import { afterEach, describe, expect, it } from "vitest";
import { normalizeLlmProviderType } from "../../../shared/llmProviderDisplay";
import { LLM_PROVIDER_TYPES } from "../../../shared/types";
import { usageLocalDateKey } from "../../../shared/usageInsightsDates";
import { UsageInsightsProjector } from "../UsageInsightsProjector";
import { UsageInsightsService } from "../UsageInsightsService";

function isLlmErrorQuery(sql: string): boolean {
  return sql.includes("llm_error");
}

function isLlmUsageQuery(sql: string): boolean {
  return sql.includes("llm_usage") && !sql.includes("llm_error");
}

function isPricingQuery(sql: string): boolean {
  return sql.includes("llm_pricing");
}

function isGlobalLlmUsageQuery(sql: string): boolean {
  return sql.includes("FROM llm_call_events") && sql.includes("success = 1");
}

function isGlobalLlmErrorQuery(sql: string): boolean {
  return sql.includes("FROM llm_call_events") && sql.includes("success = 0");
}

function makeRoutingPayload(activeProvider: string): string {
  return JSON.stringify({ activeProvider });
}

function makeAgentConfig(providerType: string): string {
  return JSON.stringify({ providerType });
}

function makeProviderLogPayload(providerType: string): string {
  return JSON.stringify({
    message: `LLM route selected: provider=${providerType}, profile=cheap, source=profile_model, model=gpt-5.4-mini`,
  });
}

function endOfLocalDay(timestamp: number): number {
  const d = new Date(timestamp);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

function defaultMockDb(overrides: {
  llmRows?: unknown[];
  globalLlmRows?: unknown[];
  toolRows?: unknown[];
  statusRows?: unknown[];
  personaRows?: unknown[];
  personaCostRows?: unknown[];
  feedbackRows?: unknown[];
  retryRow?: unknown;
  llmErrorResult?: { c: number };
  globalLlmErrorResult?: { c: number };
  pricingRows?: unknown[];
  awuCount?: number;
  awuTaskRows?: unknown[];
}) {
  const {
    llmRows = [],
    globalLlmRows = [],
    toolRows = [],
    statusRows = [],
    personaRows = [],
    personaCostRows = [],
    feedbackRows = [],
    retryRow = { avg_attempts: null, retried_tasks: 0, max_attempts: 0 },
    llmErrorResult = { c: 0 },
    globalLlmErrorResult = { c: 0 },
    pricingRows = [],
    awuCount = 0,
    awuTaskRows = Array.from({ length: awuCount }, (_, index) => ({
      completed_at: Date.now() - index * 1000,
    })),
  } = overrides;
  return {
    prepare: (sql: string) => {
      if (isPricingQuery(sql)) {
        return { all: () => pricingRows, get: () => ({ count: 0 }) };
      }
      if (sql.includes("GROUP BY status")) {
        return { all: () => statusRows, get: () => ({ count: 0 }) };
      }
      if (sql.includes("GROUP BY COALESCE(t.assigned_agent_role_id")) {
        return { all: () => personaRows, get: () => ({ count: 0 }) };
      }
      if (sql.includes("SELECT created_at FROM tasks")) {
        return { all: () => [], get: () => ({ count: 0 }) };
      }
      if (
        sql.includes("COALESCE(t.assigned_agent_role_id, 'unassigned') as persona_id") &&
        sql.includes("llm_usage")
      ) {
        return { all: () => personaCostRows, get: () => ({ count: 0 }) };
      }
      if (isLlmUsageQuery(sql)) {
        return { all: () => llmRows, get: () => ({ c: 0 }) };
      }
      if (isGlobalLlmUsageQuery(sql)) {
        return { all: () => globalLlmRows, get: () => ({ c: 0 }) };
      }
      if (isLlmErrorQuery(sql)) {
        return { all: () => [], get: () => llmErrorResult };
      }
      if (isGlobalLlmErrorQuery(sql)) {
        return { all: () => [], get: () => globalLlmErrorResult };
      }
      if (sql.includes("skill_used")) {
        return { all: () => [], get: () => ({ count: 0 }) };
      }
      if (sql.includes("user_feedback")) {
        return { all: () => feedbackRows, get: () => ({ count: 0 }) };
      }
      if (sql.includes("te.type, te.legacy_type as legacy_type")) {
        return { all: () => toolRows, get: () => ({ count: 0 }) };
      }
      if (sql.includes("AVG(CASE WHEN current_attempt")) {
        return { all: () => [], get: () => retryRow };
      }
      if (sql.includes("SELECT completed_at as completed_at FROM tasks")) {
        return { all: () => awuTaskRows, get: () => ({ count: 0 }) };
      }
      if (sql.includes("COUNT(*) as count FROM tasks")) {
        return { all: () => [], get: () => ({ count: awuCount }) };
      }
      return { all: () => [], get: () => ({ count: 0 }) };
    },
  };
}

describe("UsageInsightsService", () => {
  afterEach(() => {
    (UsageInsightsProjector as unknown as { instance: unknown }).instance = null;
  });

  it("counts legacy completed tasks with NULL terminal_status as AWUs", () => {
    const db = {
      prepare: (sql: string) => ({
        all: () => [],
        get: () => {
          if (isPricingQuery(sql)) return { count: 0 };
          if (isLlmErrorQuery(sql)) return { c: 0 };
          if (sql.includes("COUNT(*) as count FROM tasks")) {
            expect(sql).toContain("completed_at >= ? AND completed_at <= ?");
            expect(sql).not.toContain("created_at >= ? AND created_at <= ?");
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

  it("builds a daily AWU efficiency series for the chart", () => {
    const now = Date.now();
    const dayOne = now - 2 * 60 * 60 * 1000;
    const dayTwo = now - 26 * 60 * 60 * 1000;

    const llmRows = [
      {
        task_id: "task-day-one",
        timestamp: dayOne,
        payload: JSON.stringify({
          providerType: "openrouter",
          modelKey: "gpt-5.4",
          delta: { inputTokens: 100, outputTokens: 20, cost: 0.01 },
        }),
      },
      {
        task_id: "task-day-two",
        timestamp: dayTwo,
        payload: JSON.stringify({
          providerType: "azure",
          modelKey: "gpt-5.4-mini",
          delta: { inputTokens: 60, outputTokens: 40, cost: 0.02 },
        }),
      },
    ];

    const awuTaskRows = [
      { completed_at: dayOne },
      { completed_at: dayOne + 1_000 },
      { completed_at: dayTwo },
    ];

    const db = defaultMockDb({
      llmRows,
      awuCount: 3,
      awuTaskRows,
    });

    const service = new UsageInsightsService(
      db as ConstructorParameters<typeof UsageInsightsService>[0],
    );
    const insights = service.generate("ws-1", 7);

    const dayOneRow = insights.awuMetrics.byDay.find(
      (row) => row.dateKey === usageLocalDateKey(dayOne),
    );
    const dayTwoRow = insights.awuMetrics.byDay.find(
      (row) => row.dateKey === usageLocalDateKey(dayTwo),
    );

    expect(dayOneRow).toMatchObject({
      awuCount: 2,
      totalTokens: 120,
      totalCost: 0.01,
      tokensPerAwu: 60,
      costPerAwu: 0.005,
    });
    expect(dayTwoRow).toMatchObject({
      awuCount: 1,
      totalTokens: 100,
      totalCost: 0.02,
      tokensPerAwu: 100,
      costPerAwu: 0.02,
    });
  });

  it("aggregates token and tool execution metrics", () => {
    const noon = new Date();
    noon.setHours(12, 0, 0, 0);
    const ts = noon.getTime();

    const llmRows = [
      {
        task_id: "task-a",
        timestamp: ts,
        payload: JSON.stringify({
          providerType: "openai",
          modelKey: "gpt-4o",
          delta: { inputTokens: 100, outputTokens: 40, cost: 0.0123 },
        }),
      },
      {
        task_id: "task-b",
        timestamp: ts,
        payload: JSON.stringify({
          providerType: "openai",
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

    const db = defaultMockDb({
      llmRows,
      toolRows,
      statusRows: [
        { status: "completed", count: 2, avg_time: 90_000 },
        { status: "failed", count: 1, avg_time: null },
      ],
    });

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

    expect(insights.requestsByDay.reduce((s, d) => s + d.llmCalls, 0)).toBe(2);
    expect(insights.llmSummary.distinctTaskCount).toBe(2);
    expect(insights.llmSuccessRate).toBe(100);
    expect(insights.providerBreakdown).toContainEqual({
      provider: "openai",
      calls: 2,
      distinctTasks: 2,
      cost: 0.0135,
      inputTokens: 120,
      outputTokens: 50,
      cachedTokens: 0,
      percent: 100,
    });
  });

  it("aggregates cachedTokens and cacheReadRate", () => {
    const ts = Date.now();
    const llmRows = [
      {
        task_id: "t1",
        timestamp: ts,
        payload: JSON.stringify({
          modelKey: "gpt-4o",
          delta: { inputTokens: 100, outputTokens: 10, cachedTokens: 50, cost: 0 },
        }),
      },
    ];

    const db = defaultMockDb({ llmRows });
    const service = new UsageInsightsService(
      db as ConstructorParameters<typeof UsageInsightsService>[0],
    );
    const insights = service.generate("ws-1", 7);

    expect(insights.llmSummary.totalCachedTokens).toBe(50);
    expect(insights.llmSummary.cacheReadRate).toBe(50);
    expect(insights.costMetrics.costByModel[0].cachedTokens).toBe(50);
  });

  it("counts distinct tasks per model", () => {
    const ts = Date.now();
    const llmRows = [
      {
        task_id: "t1",
        timestamp: ts,
        payload: JSON.stringify({
          modelKey: "same-model",
          delta: { inputTokens: 1, outputTokens: 1, cost: 0 },
        }),
      },
      {
        task_id: "t2",
        timestamp: ts,
        payload: JSON.stringify({
          modelKey: "same-model",
          delta: { inputTokens: 1, outputTokens: 1, cost: 0 },
        }),
      },
    ];

    const db = defaultMockDb({ llmRows });
    const service = new UsageInsightsService(
      db as ConstructorParameters<typeof UsageInsightsService>[0],
    );
    const insights = service.generate(null, 7);

    expect(insights.costMetrics.costByModel[0].distinctTasks).toBe(2);
    expect(insights.costMetrics.costByModel[0].calls).toBe(2);
  });

  it("computes llmSuccessRate from llm_error count", () => {
    const ts = Date.now();
    const llmRows = [
      {
        task_id: "t1",
        timestamp: ts,
        payload: JSON.stringify({
          modelKey: "claude-3",
          delta: { inputTokens: 10, outputTokens: 5, cost: 0.001 },
        }),
      },
    ];

    const db = defaultMockDb({ llmRows, llmErrorResult: { c: 2 } });
    const service = new UsageInsightsService(
      db as ConstructorParameters<typeof UsageInsightsService>[0],
    );
    const insights = service.generate("ws-1", 7);

    expect(insights.llmSuccessRate).toBeCloseTo((1 / 3) * 100, 5);
  });

  it("includes non-task llm_call_events in usage totals", () => {
    const ts = Date.now();
    const globalLlmRows = [
      {
        task_id: null,
        timestamp: ts,
        provider_type: "openai",
        model_key: "gpt-5.4-nano",
        model_id: "gpt-5.4-nano",
        input_tokens: 240,
        output_tokens: 80,
        cached_tokens: 0,
        cost: 0,
      },
    ];
    const pricingRows = [
      {
        model_key: "gpt-5.4-nano",
        input_cost_per_mtok: 0.2,
        output_cost_per_mtok: 1.25,
        cached_input_cost_per_mtok: 0.02,
      },
    ];

    const db = defaultMockDb({ globalLlmRows, pricingRows });
    const service = new UsageInsightsService(
      db as ConstructorParameters<typeof UsageInsightsService>[0],
    );
    const insights = service.generate("ws-1", 7);

    expect(insights.llmSummary.totalLlmCalls).toBe(1);
    expect(insights.llmSummary.totalInputTokens).toBe(240);
    expect(insights.llmSummary.totalOutputTokens).toBe(80);
    expect(insights.providerBreakdown.some((p) => p.provider === "openai")).toBe(true);
  });

  it("tracks all registered provider types without collapsing them into unknown", () => {
    const ts = Date.now();
    const globalLlmRows = LLM_PROVIDER_TYPES.map((providerType, index) => ({
      task_id: `provider-task-${index}`,
      timestamp: ts + index,
      provider_type: providerType,
      model_key: `model-${providerType}`,
      model_id: `model-${providerType}`,
      input_tokens: 100 + index,
      output_tokens: 20 + index,
      cached_tokens: 0,
      cost: 0.001 + index / 1000,
    }));

    const db = defaultMockDb({ globalLlmRows });
    const service = new UsageInsightsService(
      db as ConstructorParameters<typeof UsageInsightsService>[0],
    );
    const insights = service.generate("ws-1", 7);

    const expectedCallsByProvider = new Map<string, number>();
    for (const providerType of LLM_PROVIDER_TYPES) {
      const normalized = normalizeLlmProviderType(providerType);
      if (!normalized) continue;
      expectedCallsByProvider.set(normalized, (expectedCallsByProvider.get(normalized) || 0) + 1);
    }

    expect(insights.providerBreakdown.some((row) => row.provider === "unknown")).toBe(false);
    expect(insights.providerBreakdown.reduce((sum, row) => sum + row.calls, 0)).toBe(
      LLM_PROVIDER_TYPES.length,
    );

    for (const [provider, calls] of expectedCallsByProvider) {
      expect(insights.providerBreakdown).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            provider,
            calls,
            distinctTasks: calls,
          }),
        ]),
      );
    }
  });

  it("attributes gpt-5.4 usage to the serving provider instead of the model owner", () => {
    const ts = Date.now();
    const globalLlmRows = [
      {
        task_id: "task-openrouter",
        timestamp: ts,
        provider_type: "openrouter",
        model_key: "gpt-5.4",
        model_id: "gpt-5.4",
        input_tokens: 400,
        output_tokens: 120,
        cached_tokens: 30,
        cost: 0.0042,
        routing_payload: makeRoutingPayload("openai"),
        agent_config: makeAgentConfig("openai"),
      },
    ];

    const db = defaultMockDb({ globalLlmRows });
    const service = new UsageInsightsService(
      db as ConstructorParameters<typeof UsageInsightsService>[0],
    );
    const insights = service.generate("ws-1", 7);

    expect(insights.providerBreakdown).toContainEqual({
      provider: "openrouter",
      calls: 1,
      distinctTasks: 1,
      cost: 0.0042,
      inputTokens: 400,
      outputTokens: 120,
      cachedTokens: 30,
      percent: 100,
    });
    expect(insights.providerBreakdown.some((p) => p.provider === "openai")).toBe(false);
  });

  it("falls back to the routed active provider for legacy llm_usage rows", () => {
    const ts = Date.now();
    const llmRows = [
      {
        task_id: "legacy-openrouter-task",
        timestamp: ts,
        routing_payload: makeRoutingPayload("openrouter"),
        agent_config: makeAgentConfig("openai"),
        payload: JSON.stringify({
          modelKey: "gpt-5.4",
          delta: { inputTokens: 150, outputTokens: 45, cost: 0.0015 },
        }),
      },
    ];

    const db = defaultMockDb({ llmRows });
    const service = new UsageInsightsService(
      db as ConstructorParameters<typeof UsageInsightsService>[0],
    );
    const insights = service.generate("ws-1", 7);

    expect(insights.providerBreakdown[0]?.provider).toBe("openrouter");
  });

  it("falls back to task agentConfig provider when legacy usage rows lack routing metadata", () => {
    const ts = Date.now();
    const llmRows = [
      {
        task_id: "legacy-azure-task",
        timestamp: ts,
        agent_config: makeAgentConfig("azure"),
        routing_payload: null,
        payload: JSON.stringify({
          modelKey: "gpt-5.4",
          delta: { inputTokens: 90, outputTokens: 30, cost: 0.0009 },
        }),
      },
    ];

    const db = defaultMockDb({ llmRows });
    const service = new UsageInsightsService(
      db as ConstructorParameters<typeof UsageInsightsService>[0],
    );
    const insights = service.generate("ws-1", 7);

    expect(insights.providerBreakdown[0]?.provider).toBe("azure");
  });

  it("falls back to provider selection logs when older usage rows lack structured routing metadata", () => {
    const ts = Date.now();
    const llmRows = [
      {
        task_id: "legacy-logged-azure-task",
        timestamp: ts,
        agent_config: null,
        routing_payload: null,
        provider_log_payload: makeProviderLogPayload("azure"),
        payload: JSON.stringify({
          modelKey: "gpt-5.4-mini",
          delta: { inputTokens: 120, outputTokens: 40, cost: 0.0012 },
        }),
      },
    ];

    const db = defaultMockDb({ llmRows });
    const service = new UsageInsightsService(
      db as ConstructorParameters<typeof UsageInsightsService>[0],
    );
    const insights = service.generate("ws-1", 7);

    expect(insights.providerBreakdown[0]?.provider).toBe("azure");
  });

  it("estimates cost from llm_pricing table when delta.cost is 0", () => {
    const ts = Date.now();
    const llmRows = [
      {
        task_id: "t1",
        timestamp: ts,
        payload: JSON.stringify({
          modelKey: "gpt-5.4-mini",
          delta: { inputTokens: 1_000_000, outputTokens: 500_000, cachedTokens: 200_000, cost: 0 },
        }),
      },
    ];

    const pricingRows = [
      {
        model_key: "gpt-5.4-mini",
        input_cost_per_mtok: 0.75,
        output_cost_per_mtok: 4.5,
        cached_input_cost_per_mtok: 0.075,
      },
    ];

    const db = defaultMockDb({ llmRows, pricingRows });
    const service = new UsageInsightsService(
      db as ConstructorParameters<typeof UsageInsightsService>[0],
    );
    const insights = service.generate("ws-1", 7);

    // billableInput = 1_000_000 - 200_000 = 800_000
    // cost = (800_000 / 1M) * 0.75 + (500_000 / 1M) * 4.5 + (200_000 / 1M) * 0.075
    // cost = 0.6 + 2.25 + 0.015 = 2.865
    expect(insights.costMetrics.totalCost).toBeCloseTo(2.865, 4);
    expect(insights.llmSummary.totalCost).toBeCloseTo(2.865, 4);
    expect(insights.costMetrics.costByModel[0].cost).toBeCloseTo(2.865, 4);
  });

  it("uses reported delta.cost when > 0 even if pricing exists", () => {
    const ts = Date.now();
    const llmRows = [
      {
        task_id: "t1",
        timestamp: ts,
        payload: JSON.stringify({
          modelKey: "gpt-5.4-mini",
          delta: { inputTokens: 1_000_000, outputTokens: 500_000, cost: 1.23 },
        }),
      },
    ];

    const pricingRows = [
      {
        model_key: "gpt-5.4-mini",
        input_cost_per_mtok: 0.75,
        output_cost_per_mtok: 4.5,
        cached_input_cost_per_mtok: 0.075,
      },
    ];

    const db = defaultMockDb({ llmRows, pricingRows });
    const service = new UsageInsightsService(
      db as ConstructorParameters<typeof UsageInsightsService>[0],
    );
    const insights = service.generate("ws-1", 7);

    expect(insights.costMetrics.totalCost).toBeCloseTo(1.23, 4);
  });

  it("treats :free and ollama models as zero cost", () => {
    const ts = Date.now();
    const llmRows = [
      {
        task_id: "t1",
        timestamp: ts,
        payload: JSON.stringify({
          modelKey: "nvidia/nemotron-3-nano-30b-a3b:free",
          delta: { inputTokens: 500_000, outputTokens: 100_000, cost: 0 },
        }),
      },
      {
        task_id: "t2",
        timestamp: ts,
        payload: JSON.stringify({
          modelKey: "qwen3.5:latest",
          delta: { inputTokens: 200_000, outputTokens: 50_000, cost: 0 },
        }),
      },
    ];

    const db = defaultMockDb({ llmRows });
    const service = new UsageInsightsService(
      db as ConstructorParameters<typeof UsageInsightsService>[0],
    );
    const insights = service.generate("ws-1", 7);

    expect(insights.costMetrics.totalCost).toBe(0);
    expect(insights.llmSummary.totalLlmCalls).toBe(2);
  });

  it("aggregates persona metrics with per-persona cost", () => {
    const ts = Date.now();
    const db = defaultMockDb({
      personaRows: [
        {
          persona_id: "agent-qa",
          persona_name: "QA Agent",
          total: 4,
          completed: 3,
          failed: 1,
          cancelled: 0,
          avg_time: 120_000,
          avg_attempts: 1.5,
        },
      ],
      personaCostRows: [
        {
          persona_id: "agent-qa",
          payload: JSON.stringify({
            modelKey: "gpt-4o",
            delta: { inputTokens: 100, outputTokens: 50, cost: 0.25 },
          }),
        },
        {
          persona_id: "agent-qa",
          payload: JSON.stringify({
            modelKey: "gpt-4o",
            delta: { inputTokens: 50, outputTokens: 20, cost: 0.1 },
          }),
        },
      ],
    });
    const service = new UsageInsightsService(
      db as ConstructorParameters<typeof UsageInsightsService>[0],
    );
    const insights = service.generate("ws-1", 7);

    expect(insights.personaMetrics).toHaveLength(1);
    expect(insights.personaMetrics[0]).toMatchObject({
      personaId: "agent-qa",
      personaName: "QA Agent",
      total: 4,
      completed: 3,
      failed: 1,
    });
    expect(insights.personaMetrics[0].successRate).toBe(75);
    expect(insights.personaMetrics[0].totalCost).toBeCloseTo(0.35, 5);
  });

  it("aggregates feedback and retry metrics", () => {
    const db = defaultMockDb({
      feedbackRows: [
        { payload: JSON.stringify({ decision: "accepted", kind: "task" }) },
        { payload: JSON.stringify({ decision: "rejected", reason: "Too vague" }) },
        { payload: JSON.stringify({ rating: "negative", reason: "Missed files" }) },
      ],
      retryRow: {
        avg_attempts: 1.8,
        retried_tasks: 3,
        max_attempts: 4,
      },
      statusRows: [{ status: "completed", count: 6, avg_time: 60_000 }],
    });
    const service = new UsageInsightsService(
      db as ConstructorParameters<typeof UsageInsightsService>[0],
    );
    const insights = service.generate("ws-1", 7);

    expect(insights.feedbackMetrics.totalFeedback).toBe(3);
    expect(insights.feedbackMetrics.accepted).toBe(1);
    expect(insights.feedbackMetrics.rejected).toBe(2);
    expect(insights.feedbackMetrics.topRejectionReasons[0]).toEqual({
      reason: "Too vague",
      count: 1,
    });
    expect(insights.retryMetrics.avgAttempts).toBe(1.8);
    expect(insights.retryMetrics.retriedTasks).toBe(3);
    expect(insights.retryMetrics.maxAttempts).toBe(4);
    expect(insights.retryMetrics.retriedRate).toBe(50);
  });

  it("uses rollup tables when the usage insights projector is ready", () => {
    const ts = Date.now();
    const db = {
      prepare: (sql: string) => {
        if (sql.includes("SELECT value FROM usage_insights_state")) {
          return { get: () => ({ value: "1" }) };
        }
        if (sql.includes("FROM usage_insights_day")) {
          return {
            all: () => [
              {
                date_key: usageLocalDateKey(ts),
                task_created_total: 4,
                task_completed_created: 3,
                task_failed_created: 1,
                task_cancelled_created: 0,
                completed_duration_total_ms_created: 240_000,
                completed_duration_count_created: 3,
                attempt_sum_created: 6,
                attempt_count_created: 4,
                retried_tasks_created: 2,
                max_attempt_created: 3,
                feedback_accepted: 2,
                feedback_rejected: 1,
                awu_completed_ok: 2,
              },
            ],
          };
        }
        if (sql.includes("FROM usage_insights_hour")) {
          return {
            all: () => [
              {
                day_of_week: new Date(ts).getDay(),
                hour_of_day: new Date(ts).getHours(),
                count: 4,
              },
            ],
          };
        }
        if (sql.includes("FROM usage_insights_skill_day")) {
          return { all: () => [{ skill: "summarize", count: 5 }] };
        }
        if (sql.includes("FROM usage_insights_persona_day")) {
          return {
            all: () => [
              {
                persona_id: "agent-qa",
                persona_name: "QA Agent",
                total: 4,
                completed: 3,
                failed: 1,
                cancelled: 0,
                completion_duration_total_ms: 240_000,
                completion_duration_count: 3,
                attempt_sum: 6,
                attempt_count: 4,
                total_cost: 0,
              },
            ],
          };
        }
        if (sql.includes("FROM usage_insights_feedback_reason_day")) {
          return { all: () => [{ reason: "Too vague", count: 1 }] };
        }
        if (sql.includes("FROM usage_insights_tool_day")) {
          return {
            all: () => [
              { tool: "run_command", calls: 3, results: 2, errors: 1, blocked: 0, warnings: 0 },
            ],
          };
        }
        if (sql.includes("FROM llm_call_events") && sql.includes("success = 1")) {
          return {
            all: () => [
              {
                task_id: "task-1",
                timestamp: ts,
                provider_type: "openai",
                model_key: "gpt-5.4-mini",
                model_id: "gpt-5.4-mini",
                input_tokens: 100,
                output_tokens: 40,
                cached_tokens: 10,
                cost: 0.02,
                persona_id: "agent-qa",
                persona_name: "QA Agent",
              },
            ],
          };
        }
        if (sql.includes("FROM llm_call_events") && sql.includes("success = 0")) {
          return { get: () => ({ c: 0 }) };
        }
        if (sql.includes("SELECT MIN(created_at)")) {
          return { get: () => ({ earliest: ts }) };
        }
        if (sql.includes("llm_usage")) {
          throw new Error(`unexpected raw query: ${sql}`);
        }
        return { all: () => [], get: () => ({ c: 0, value: null }) };
      },
    };

    UsageInsightsProjector.initialize(
      db as ConstructorParameters<typeof UsageInsightsProjector.initialize>[0],
    );
    const service = new UsageInsightsService(
      db as ConstructorParameters<typeof UsageInsightsService>[0],
    );
    const insights = service.generate("ws-1", 7);

    expect(insights.taskMetrics).toMatchObject({
      totalCreated: 4,
      completed: 3,
      failed: 1,
    });
    expect(insights.topSkills).toEqual([{ skill: "summarize", count: 5 }]);
    expect(insights.feedbackMetrics.totalFeedback).toBe(3);
    expect(insights.executionMetrics.totalToolCalls).toBe(3);
    expect(insights.llmSummary.totalLlmCalls).toBe(1);
    expect(insights.personaMetrics[0]?.totalCost).toBeCloseTo(0.02, 5);
  });

  it("uses rollups plus a raw tail while backfill is still in progress", () => {
    const historicalTs = Date.now() - 3 * 24 * 60 * 60 * 1000;
    const tailTs = Date.now() - 2 * 60 * 60 * 1000;
    const watermarkMs = endOfLocalDay(historicalTs);
    const watermarkDateKey = usageLocalDateKey(historicalTs);

    const isTailRange = (params: unknown[]): boolean => {
      const numeric = params.filter((value): value is number => typeof value === "number");
      if (numeric.length < 2) return false;
      const [start] = numeric.slice(-2);
      return start > watermarkMs;
    };

    const db = {
      transaction: <T extends (...args: never[]) => unknown>(fn: T) => fn,
      prepare: (sql: string) => {
        if (sql.includes("SELECT value FROM usage_insights_state WHERE key = ?")) {
          return {
            get: (key: string) => ({
              value:
                key === "backfill_complete"
                  ? "0"
                  : key === "schema_version"
                    ? "1"
                    : key === "llm_watermark_ms"
                      ? String(endOfLocalDay(tailTs))
                      : key === "task_watermark_ms" || key === "event_watermark_ms"
                        ? String(watermarkMs)
                        : null,
            }),
          };
        }
        if (sql.includes("FROM usage_insights_day")) {
          return {
            all: () => [
              {
                date_key: watermarkDateKey,
                task_created_total: 4,
                task_completed_created: 3,
                task_failed_created: 1,
                task_cancelled_created: 0,
                completed_duration_total_ms_created: 240_000,
                completed_duration_count_created: 3,
                attempt_sum_created: 6,
                attempt_count_created: 4,
                retried_tasks_created: 2,
                max_attempt_created: 3,
                feedback_accepted: 1,
                feedback_rejected: 0,
                awu_completed_ok: 2,
              },
            ],
          };
        }
        if (sql.includes("FROM usage_insights_hour")) {
          return {
            all: () => [{ day_of_week: new Date(historicalTs).getDay(), hour_of_day: 9, count: 4 }],
          };
        }
        if (sql.includes("FROM usage_insights_skill_day")) {
          return { all: () => [{ skill: "summarize", count: 5 }] };
        }
        if (sql.includes("FROM usage_insights_persona_day")) {
          return {
            all: () => [
              {
                persona_id: "agent-qa",
                persona_name: "QA Agent",
                total: 4,
                completed: 3,
                failed: 1,
                cancelled: 0,
                completion_duration_total_ms: 240_000,
                completion_duration_count: 3,
                attempt_sum: 6,
                attempt_count: 4,
                total_cost: 0,
              },
            ],
          };
        }
        if (sql.includes("FROM usage_insights_feedback_reason_day")) {
          return { all: () => [] };
        }
        if (sql.includes("FROM usage_insights_tool_day")) {
          return {
            all: () => [
              { tool: "run_command", calls: 3, results: 2, errors: 1, blocked: 0, warnings: 0 },
            ],
          };
        }
        if (sql.includes("FROM llm_call_events") && sql.includes("success = 1")) {
          return {
            all: (...params: unknown[]) => {
              const numeric = params.filter((value): value is number => typeof value === "number");
              const [start, end] = numeric.slice(-2);
              return [
                {
                  task_id: "task-historical",
                  timestamp: historicalTs,
                  provider_type: "openai",
                  model_key: "gpt-5.4-mini",
                  model_id: "gpt-5.4-mini",
                  input_tokens: 100,
                  output_tokens: 40,
                  cached_tokens: 10,
                  cost: 0.02,
                  persona_id: "agent-qa",
                  persona_name: "QA Agent",
                },
                {
                  task_id: "task-tail",
                  timestamp: tailTs,
                  provider_type: "openai",
                  model_key: "gpt-5.4-mini",
                  model_id: "gpt-5.4-mini",
                  input_tokens: 50,
                  output_tokens: 20,
                  cached_tokens: 0,
                  cost: 0.01,
                  persona_id: "agent-qa",
                  persona_name: "QA Agent",
                },
              ].filter((row) => row.timestamp >= start && row.timestamp <= end);
            },
          };
        }
        if (sql.includes("FROM llm_call_events") && sql.includes("success = 0")) {
          return { get: () => ({ c: 0 }) };
        }
        if (sql.includes("GROUP BY COALESCE(t.assigned_agent_role_id")) {
          return {
            all: (...params: unknown[]) =>
              isTailRange(params)
                ? [
                    {
                      persona_id: "agent-qa",
                      persona_name: "QA Agent",
                      total: 1,
                      completed: 1,
                      failed: 0,
                      cancelled: 0,
                      completion_duration_sum: 60_000,
                      completion_duration_count: 1,
                      attempt_sum: 1,
                      attempt_count: 1,
                    },
                  ]
                : [],
          };
        }
        if (sql.includes("COUNT(*) as total")) {
          return {
            get: (...params: unknown[]) =>
              isTailRange(params)
                ? {
                    total: 1,
                    completed: 1,
                    failed: 0,
                    cancelled: 0,
                    completion_duration_sum: 60_000,
                    completion_duration_count: 1,
                    attempt_sum: 1,
                    attempt_count: 1,
                    retried_tasks: 0,
                    max_attempts: 1,
                  }
                : {
                    total: 0,
                    completed: 0,
                    failed: 0,
                    cancelled: 0,
                    completion_duration_sum: 0,
                    completion_duration_count: 0,
                    attempt_sum: 0,
                    attempt_count: 0,
                    retried_tasks: 0,
                    max_attempts: 0,
                  },
          };
        }
        if (sql.includes("SELECT created_at") && sql.includes("FROM tasks")) {
          return {
            all: (...params: unknown[]) => (isTailRange(params) ? [{ created_at: tailTs }] : []),
          };
        }
        if (sql.includes("user_feedback")) {
          return {
            all: (...params: unknown[]) =>
              isTailRange(params)
                ? [
                    {
                      payload: JSON.stringify({
                        decision: "rejected",
                        reason: "Needs more detail",
                      }),
                    },
                  ]
                : [],
            get: () => ({ c: 0, event_max: 0 }),
          };
        }
        if (sql.includes("te.type, te.legacy_type as legacy_type")) {
          return {
            all: (...params: unknown[]) =>
              isTailRange(params)
                ? [
                    {
                      type: "tool_call",
                      legacy_type: null,
                      payload: JSON.stringify({ tool: "grep" }),
                    },
                  ]
                : [],
          };
        }
        if (sql.includes("SELECT completed_at") && sql.includes("terminal_status")) {
          return {
            all: (...params: unknown[]) => (isTailRange(params) ? [{ completed_at: tailTs }] : []),
          };
        }
        if (sql.includes("llm_usage")) {
          return { all: () => [], get: () => ({ c: 0, event_max: 0 }), run: () => undefined };
        }
        if (sql.includes("SELECT MIN(created_at)")) {
          return { get: () => ({ earliest: historicalTs }) };
        }
        return { all: () => [], get: () => ({ c: 0, value: null }), run: () => undefined };
      },
    };

    UsageInsightsProjector.initialize(
      db as ConstructorParameters<typeof UsageInsightsProjector.initialize>[0],
    );
    const service = new UsageInsightsService(
      db as ConstructorParameters<typeof UsageInsightsService>[0],
    );
    const insights = service.generate("ws-1", 7);

    expect(insights.taskMetrics.totalCreated).toBe(5);
    expect(insights.feedbackMetrics.totalFeedback).toBe(2);
    expect(insights.feedbackMetrics.rejected).toBe(1);
    expect(insights.executionMetrics.totalToolCalls).toBe(4);
    expect(insights.awuMetrics.awuCount).toBe(3);
    expect(insights.llmSummary.totalLlmCalls).toBe(2);
    expect(insights.personaMetrics[0]?.total).toBe(5);
    expect(insights.personaMetrics[0]?.totalCost).toBeCloseTo(0.03, 5);
  });
});
