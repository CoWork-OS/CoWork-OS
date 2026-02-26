import { describe, expect, it, vi } from "vitest";
import { TaskExecutor } from "../executor";

function createExecutor(intent: string = "execution") {
  const executor = Object.create(TaskExecutor.prototype) as Any;
  executor.task = {
    id: "task-test-1",
    title: "Research and analyze docs",
    prompt: "Inspect docs and gather relevant integrations",
    agentConfig: { taskIntent: intent },
  };
  executor.lastUserMessage = "Please use relevant integrations and docs";
  executor.currentStepId = "2";
  executor.plan = {
    steps: [
      { id: "1", description: "collect requirements", status: "completed" },
      { id: "2", description: "use integration tools to fetch docs", status: "in_progress" },
      { id: "3", description: "summarize findings", status: "pending" },
    ],
  };
  executor.lastAssistantOutput = "Need integration-specific tools for this step.";
  executor.toolUsageCounts = new Map<string, number>();
  executor.toolUsageEventsSinceDecay = 0;
  executor.toolResultMemory = [];
  executor.toolResultMemoryLimit = 8;
  executor.filesReadTracker = new Map<string, { step: string; sizeBytes: number }>();
  executor.toolSelectionEpoch = 0;
  executor.logTag = "[Executor:test]";
  return executor;
}

function buildTools(countBuiltIn: number, countMcp: number) {
  const builtIn = Array.from({ length: countBuiltIn }, (_, i) => ({
    name: `builtin_${i}`,
    description: "built-in",
  }));
  const mcp = Array.from({ length: countMcp }, (_, i) => ({
    name: `mcp_tool_${i}`,
    description: "external connector tool",
  }));
  return [...builtIn, ...mcp];
}

describe("TaskExecutor adaptive tool cap + file tracking", () => {
  it("does not enforce a strict 80-tool cap for execution intent", () => {
    const executor = createExecutor("execution");
    const tools = buildTools(10, 160);

    const capped = (executor as Any).capToolCount(tools);

    expect(capped.length).toBeGreaterThan(80);
    expect(capped.length).toBeLessThanOrEqual(120);
  });

  it("uses stable hash tie-breaking instead of registry order for equal-score MCP tools", () => {
    const executorA = createExecutor("execution");
    const executorB = createExecutor("execution");
    const builtIn = Array.from({ length: 10 }, (_, i) => ({ name: `builtin_${i}`, description: "" }));
    const mcp = Array.from({ length: 140 }, (_, i) => ({
      name: `mcp_generic_${i}`,
      description: "generic external tool",
    }));

    const selectedA = ((executorA as Any).capToolCount([...builtIn, ...mcp]) as Any[])
      .filter((t) => String(t.name).startsWith("mcp_"))
      .map((t) => t.name)
      .sort();
    const selectedB = ((executorB as Any).capToolCount([...builtIn, ...mcp.slice().reverse()]) as Any[])
      .filter((t) => String(t.name).startsWith("mcp_"))
      .map((t) => t.name)
      .sort();

    expect(selectedA).toEqual(selectedB);
  });

  it("rotates low-signal MCP tie picks across calls to avoid permanently hidden tools", () => {
    const executor = createExecutor("execution");
    const tools = buildTools(10, 220);

    const selectedA = ((executor as Any).capToolCount(tools) as Any[])
      .filter((t) => String(t.name).startsWith("mcp_"))
      .map((t) => t.name)
      .sort();
    const selectedB = ((executor as Any).capToolCount(tools) as Any[])
      .filter((t) => String(t.name).startsWith("mcp_"))
      .map((t) => t.name)
      .sort();

    expect(selectedA).not.toEqual(selectedB);
    expect(selectedA.length).toBe(selectedB.length);
  });

  it("records read_file paths from input when result has no path", () => {
    const executor = createExecutor("execution");

    (executor as Any).recordToolResult("read_file", { size: 1234 }, { path: "docs/spec.md" });
    const summary = (executor as Any).getFilesReadSummary();

    expect(summary).toContain("docs/spec.md");
    expect(summary).toContain("1234B");
  });

  it("decays tool usage counts to avoid permanent early-phase bias", () => {
    const executor = createExecutor("execution");
    const recordToolUsage = (executor as Any).recordToolUsage.bind(executor) as (name: string) => void;

    for (let i = 0; i < 40; i++) {
      recordToolUsage("mcp_important_tool");
    }

    const afterDecay = (executor as Any).toolUsageCounts.get("mcp_important_tool");
    expect(afterDecay).toBeLessThan(40);
    expect(afterDecay).toBeGreaterThan(0);
  });

  it("clears currentStepId after executeStep even when step runner throws", async () => {
    const executor = createExecutor("execution");
    executor.useUnifiedTurnLoop = false;
    executor.executeStepLegacy = vi.fn().mockRejectedValue(new Error("boom"));

    await expect((executor as Any).executeStep({ id: "X", description: "x", status: "pending" })).rejects.toThrow(
      "boom",
    );
    expect((executor as Any).currentStepId).toBeNull();
  });
});
