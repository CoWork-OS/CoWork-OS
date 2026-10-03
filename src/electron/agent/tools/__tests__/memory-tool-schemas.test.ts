import { describe, expect, it } from "vitest";
import { MemoryTools } from "../memory-tools";

describe("memory tool schemas", () => {
  it("expose Azure-compatible schemas (plain objects, no combinators)", () => {
    for (const tool of MemoryTools.getToolDefinitions()) {
      expect(tool.input_schema.type).toBe("object");
      expect(tool.input_schema).not.toHaveProperty("anyOf");
      expect(tool.input_schema).not.toHaveProperty("oneOf");
      expect(tool.input_schema).not.toHaveProperty("allOf");
    }
    const forget = MemoryTools.getToolDefinitions().find((def) => def.name === "memory_forget");
    expect(forget?.input_schema.properties).toHaveProperty("id");
    expect(forget?.input_schema.properties).toHaveProperty("match");
    expect(forget?.input_schema.required).toEqual([]);
  });
});
