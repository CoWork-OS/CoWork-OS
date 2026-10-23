import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../admin/policies", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../admin/policies")>()),
  loadPolicies: vi.fn(() => ({ connectors: { blocked: [] } })),
}));

import { ToolRegistry } from "../registry";
import { MCPClientManager } from "../../../mcp/client/MCPClientManager";
import { MCPSettingsManager } from "../../../mcp/settings";
import { normalizeToolOutcome } from "../../runtime/tool-outcome";

const server = { id: "server-jira", name: "Jira", enabled: true, transport: "stdio" };
const KEY = "0123456789abcdef0123456789abcdef";

function setup(result: Any) {
  vi.spyOn(MCPSettingsManager, "loadSettings").mockReturnValue({
    toolNamePrefix: "mcp_",
    servers: [server],
  } as Any);
  const callTool = vi.fn(async () => result);
  vi.spyOn(MCPClientManager, "getInstance").mockReturnValue({
    hasTool: (name: string) => name === "jira.create_issue",
    getServerIdForTool: () => server.id,
    getAllTools: () => [{ name: "jira.create_issue", inputSchema: { type: "object" } }],
    callTool,
  } as Any);
  const registry = Object.create(ToolRegistry.prototype) as Any;
  Object.assign(registry, {
    taskId: "task-1",
    daemon: {},
    workspace: {
      id: "fixture-workspace",
      path: "/tmp/fixture-workspace",
      permissions: { read: true, write: true, delete: false, network: true, shell: false },
    },
    evaluateMcpEndpointNetworkPolicy: () => null,
    getMcpServerName: () => server.name,
  });
  return { registry, callTool };
}

const created = (status: string) => ({
  content: [{ type: "text", text: JSON.stringify({ ok: true, status, data: { key: "OPS-1" } }) }],
  structuredContent: { status },
});

describe("MCP idempotency passthrough", () => {
  afterEach(() => vi.restoreAllMocks());

  it("passes the executor's attempt key to the MCP call, and nothing without one", async () => {
    const { registry, callTool } = setup(created("created"));

    await registry.tryExecuteMCPTool(
      "mcp_jira.create_issue",
      { projectKey: "OPS" },
      { toolAttempt: { idempotencyKey: KEY, attemptId: "attempt-1" } },
    );
    await registry.tryExecuteMCPTool("mcp_jira.create_issue", { projectKey: "OPS" }, {});
    await registry.tryExecuteMCPTool(
      "mcp_jira.create_issue",
      { projectKey: "OPS" },
      { toolAttempt: { idempotencyKey: "", attemptId: "attempt-2" } },
    );

    const options = callTool.mock.calls.map((call: Any[]) => call[2]);
    expect(options[0]).toMatchObject({ idempotencyKey: KEY, attemptId: "attempt-1" });
    expect(options[1]).not.toHaveProperty("idempotencyKey");
    expect(options[2]).not.toHaveProperty("idempotencyKey");
  });

  it("returns already_exists as an ordinary successful result", async () => {
    const { registry } = setup(created("already_exists"));
    const result = await registry.tryExecuteMCPTool("mcp_jira.create_issue", {}, {});
    expect(result).toContain('"status":"already_exists"');
    expect(normalizeToolOutcome(result, undefined, { effect: "unknown" }).status).toBe("success");
  });

  it("turns a write the connector could not confirm into an unknown outcome", async () => {
    const unconfirmed = {
      content: [{ type: "text", text: '{"ok":false,"status":"unknown"}' }],
      structuredContent: { status: "unknown", message: "No response from the API" },
      isError: true,
    };
    const { registry } = setup(unconfirmed);
    const error = await registry
      .tryExecuteMCPTool(
        "mcp_jira.create_issue",
        {},
        { toolAttempt: { idempotencyKey: KEY, attemptId: "attempt-1" } },
      )
      .catch((caught: unknown) => caught);
    expect(String((error as Error).message)).toContain("Outcome unknown: No response from the API");
    expect(normalizeToolOutcome(undefined, error, { effect: "unknown" }).status).toBe("unknown");

    // A call without an attempt (a read) keeps the server's result as an ordinary error.
    const read = await registry.tryExecuteMCPTool("mcp_jira.create_issue", {}, {});
    expect(read).toMatchObject({ success: false, structuredContent: { status: "unknown" } });
  });

  it("leaves a successful result whose data happens to say status unknown alone", async () => {
    const { registry } = setup({
      content: [{ type: "text", text: '{"job":"42","status":"unknown"}' }],
      structuredContent: { job: "42", status: "unknown" },
    });
    const result = await registry.tryExecuteMCPTool(
      "mcp_jira.create_issue",
      {},
      { toolAttempt: { idempotencyKey: KEY, attemptId: "attempt-1" } },
    );
    expect(result).toBe('{"job":"42","status":"unknown"}');
  });
});
