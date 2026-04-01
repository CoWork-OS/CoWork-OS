import { describe, expect, it } from "vitest";
import { ToolHandlerRegistry } from "../tool-handler-registry";

describe("ToolHandlerRegistry", () => {
  it("resolves predicate handlers when no exact handler exists", async () => {
    const registry = new ToolHandlerRegistry();
    registry.registerPredicate((name) => name.startsWith("mcp_"), async ({ request }) => ({
      tool: request.name,
      matched: true,
    }));

    await expect(
      registry.execute("mcp_demo", {
        request: {
          name: "mcp_demo",
          input: {},
        },
      }),
    ).resolves.toEqual({
      tool: "mcp_demo",
      matched: true,
    });
  });

  it("prefers exact handlers over predicate handlers", async () => {
    const registry = new ToolHandlerRegistry();
    registry.registerPredicate((name) => name.startsWith("mcp_"), async () => "predicate");
    registry.register("mcp_demo", async () => "exact");

    await expect(
      registry.execute("mcp_demo", {
        request: {
          name: "mcp_demo",
          input: {},
        },
      }),
    ).resolves.toBe("exact");
  });

  it("resolves scheduler specs from exact registrations before predicates", () => {
    const registry = new ToolHandlerRegistry();
    registry.registerPredicate(
      (name) => name.startsWith("mcp_"),
      async () => "predicate",
      () => ({ concurrencyClass: "serial_only" }),
    );
    registry.register(
      "mcp_demo",
      async () => "exact",
      () => ({ concurrencyClass: "read_parallel", idempotent: true }),
    );

    expect(registry.resolveSchedulerSpec("mcp_demo", {})).toMatchObject({
      concurrencyClass: "read_parallel",
      idempotent: true,
    });
  });
});
