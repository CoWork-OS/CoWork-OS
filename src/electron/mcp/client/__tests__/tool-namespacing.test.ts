import { describe, expect, it } from "vitest";
import { assignExposedToolNames } from "../tool-namespacing";

const tool = (name: string) => ({ name, inputSchema: { type: "object" as const } });

describe("MCP tool namespacing", () => {
  it("keeps unique names and namespaces every provider of a shared name", () => {
    const { tools, ambiguous } = assignExposedToolNames([
      { serverId: "a", serverName: "Workday", tools: [tool("get_worker"), tool("search")] },
      { serverId: "b", serverName: "Sales Force!", tools: [tool("search"), tool("get_account")] },
    ]);
    expect(tools.map((entry) => entry.exposedName)).toEqual([
      "get_worker",
      "workday__search",
      "sales_force__search",
      "get_account",
    ]);
    expect(tools[1].tool).toMatchObject({ name: "workday__search", serverToolName: "search" });
    expect(tools[0].tool.serverToolName).toBeUndefined();
    expect(ambiguous.get("search")).toEqual(["workday__search", "sales_force__search"]);
  });

  it("does not depend on connection order and separates servers with the same display name", () => {
    const one = { serverId: "id-1", serverName: "Notes", tools: [tool("list")] };
    const two = { serverId: "id-2", serverName: "Notes", tools: [tool("list")] };
    const forward = assignExposedToolNames([one, two]).tools.map((entry) => [
      entry.serverId,
      entry.exposedName,
    ]);
    const reverse = assignExposedToolNames([two, one]).tools.map((entry) => [
      entry.serverId,
      entry.exposedName,
    ]);
    expect(new Map(forward)).toEqual(new Map(reverse));
    expect(new Set(forward.map(([, name]) => name)).size).toBe(2);
  });

  it("keeps namespaced names within provider limits and unique", () => {
    const long = "x".repeat(70);
    const { tools } = assignExposedToolNames([
      { serverId: "a", serverName: "A very long integration server name", tools: [tool(long)] },
      { serverId: "b", serverName: "Another", tools: [tool(long), tool("a_very_long_integ__x")] },
    ]);
    for (const entry of tools) expect(entry.exposedName.length).toBeLessThanOrEqual(59);
    expect(new Set(tools.map((entry) => entry.exposedName)).size).toBe(tools.length);
  });
});
