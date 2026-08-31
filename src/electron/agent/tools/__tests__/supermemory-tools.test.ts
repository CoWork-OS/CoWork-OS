import { describe, expect, it } from "vitest";
import { SupermemoryTools } from "../supermemory-tools";

describe("SupermemoryTools", () => {
  it("exposes an Azure-compatible schema for supermemory_forget", () => {
    const tool = SupermemoryTools.getToolDefinitions().find(
      (def) => def.name === "supermemory_forget",
    );

    expect(tool).toBeDefined();
    expect(tool?.input_schema.type).toBe("object");
    expect(tool?.input_schema.properties).toHaveProperty("memoryId");
    expect(tool?.input_schema.properties).toHaveProperty("content");
    expect(tool?.input_schema.required).toEqual([]);
    expect(tool?.input_schema).not.toHaveProperty("anyOf");
    expect(tool?.input_schema).not.toHaveProperty("oneOf");
    expect(tool?.input_schema).not.toHaveProperty("allOf");
  });
});
