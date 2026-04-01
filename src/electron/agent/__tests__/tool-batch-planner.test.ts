import { describe, expect, it } from "vitest";
import { ToolBatchPlanner } from "../runtime/ToolBatchPlanner";
import type { LLMToolUse } from "../llm/types";

describe("ToolBatchPlanner", () => {
  const tools = [
    {
      name: "read_file",
      description: "Read file",
      input_schema: { type: "object", properties: {} },
      runtime: {
        readOnly: true,
        concurrencyClass: "read_parallel",
        interruptBehavior: "cancel",
        approvalKind: "none",
        sideEffectLevel: "none",
        deferLoad: false,
        alwaysExpose: true,
        resultKind: "read",
        supportsContextMutation: false,
        capabilityTags: ["core"],
        exposure: "always",
      },
    },
    {
      name: "write_file",
      description: "Write file",
      input_schema: { type: "object", properties: {} },
      runtime: {
        readOnly: false,
        concurrencyClass: "exclusive",
        interruptBehavior: "block",
        approvalKind: "workspace_policy",
        sideEffectLevel: "low",
        deferLoad: false,
        alwaysExpose: true,
        resultKind: "mutation",
        supportsContextMutation: true,
        capabilityTags: ["core"],
        exposure: "always",
      },
    },
  ] as Any[];

  it("groups consecutive parallel-safe tools together", () => {
    const planner = new ToolBatchPlanner((name) => tools.find((tool) => tool.name === name));
    const batches = planner.partition([
      { type: "tool_use", id: "1", name: "read_file", input: {} },
      { type: "tool_use", id: "2", name: "read_file", input: {} },
      { type: "tool_use", id: "3", name: "write_file", input: {} },
    ] as LLMToolUse[]);

    expect(batches).toHaveLength(2);
    expect(batches[0]?.calls).toHaveLength(2);
    expect(batches[0]?.concurrencyClass).toBe("read_parallel");
    expect(batches[1]?.concurrencyClass).toBe("exclusive");
  });
});
