import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MCPServerConnection } from "../MCPServerConnection";
import type { MCPServerConfig } from "../../types";

describe("browser QA MCP fixture", () => {
  let connection: MCPServerConnection | null = null;

  afterEach(async () => {
    await connection?.disconnect();
    connection = null;
  });

  it("exposes qa_echo over the real stdio MCP client with bounded input", async () => {
    connection = new MCPServerConnection(
      {
        id: "browser-qa-mcp-fixture",
        name: "Browser QA Echo",
        enabled: true,
        transport: "stdio",
        command: process.execPath,
        args: [resolve(process.cwd(), "scripts/qa/fixtures/browser-qa-mcp.mjs")],
        requestTimeout: 3_000,
      } satisfies MCPServerConfig,
      { maxReconnectAttempts: 0, reconnectDelayMs: 100 },
    );

    await connection.connect();
    expect(connection.getTools()).toContainEqual(expect.objectContaining({ name: "qa_echo" }));
    const result = await connection.callTool("qa_echo", { text: "browser lifecycle verified" });
    expect(result).toMatchObject({
      content: [{ type: "text", text: "qa_echo:browser lifecycle verified" }],
      isError: false,
    });
  });
});
