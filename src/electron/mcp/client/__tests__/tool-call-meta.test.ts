import { describe, expect, it, vi } from "vitest";
import { MCPServerConnection } from "../MCPServerConnection";

function connected() {
  const connection = new MCPServerConnection({
    id: "test",
    name: "jira",
    transport: "sse",
    enabled: true,
  });
  const transport = {
    sendRequest: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
    sendResponse: vi.fn(async () => {}),
    isConnected: vi.fn(() => true),
  };
  Object.assign(connection, {
    transport,
    status: "connected",
    tools: [{ name: "jira.create_issue" }],
  });
  return { connection, transport };
}

describe("MCP tool call _meta", () => {
  it("sends the attempt's idempotency key and id only when a key is supplied", async () => {
    const { connection, transport } = connected();

    await connection.callTool(
      "jira.create_issue",
      { projectKey: "OPS" },
      { idempotencyKey: "0123456789abcdef0123456789abcdef", attemptId: "attempt-1" },
    );
    await connection.callTool("jira.create_issue", { projectKey: "OPS" });
    await connection.callTool("jira.create_issue", {}, { idempotencyKey: "  " });

    const params = transport.sendRequest.mock.calls.map((call: Any[]) => call[1]);
    expect(params[0]).toEqual({
      name: "jira.create_issue",
      arguments: { projectKey: "OPS" },
      _meta: {
        "cowork.idempotencyKey": "0123456789abcdef0123456789abcdef",
        "cowork.attemptId": "attempt-1",
      },
    });
    expect(params[1]).not.toHaveProperty("_meta");
    expect(params[2]).not.toHaveProperty("_meta");
  });

  it("sends the preview flag on its own when CoWork asks a tool to describe a write", async () => {
    const { connection, transport } = connected();

    await connection.callTool("jira.create_issue", { projectKey: "OPS" }, { preview: true });

    expect(transport.sendRequest.mock.calls[0][1]).toEqual({
      name: "jira.create_issue",
      arguments: { projectKey: "OPS" },
      _meta: { "cowork.preview": true },
    });
  });
});
