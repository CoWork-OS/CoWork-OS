import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StreamableHttpTransport } from "../StreamableHttpTransport";
import { MCPSettingsManager } from "../../../settings";
import { BoxSettingsManager } from "../../../../settings/box-manager";

describe("StreamableHttpTransport", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    vi.spyOn(MCPSettingsManager, "updateServer").mockReturnValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("posts to the MCP endpoint and carries the negotiated session headers", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              protocolVersion: "2025-06-18",
              serverInfo: { name: "Box", version: "1.0.0" },
            },
          }),
          {
            headers: {
              "content-type": "application/json",
              "Mcp-Session-Id": "session-1",
            },
          },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            result: { content: [{ type: "text", text: "ok" }] },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    const transport = new StreamableHttpTransport({
      id: "box-server",
      name: "Box MCP",
      enabled: true,
      transport: "streamable-http",
      url: "https://mcp.box.com",
      auth: { type: "bearer", token: "access-token" },
    });

    await transport.connect();
    await transport.sendRequest("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "CoWork-OS", version: "1.0.0" },
    });
    await transport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const result = await transport.sendRequest("tools/call", {
      name: "who_am_i",
      arguments: {},
    });
    await transport.disconnect();

    expect(result).toEqual({ content: [{ type: "text", text: "ok" }] });
    expect(fetchMock).toHaveBeenCalledTimes(4);

    const initializeOptions = fetchMock.mock.calls[0][1];
    expect(fetchMock.mock.calls[0][0]).toBe("https://mcp.box.com");
    expect(initializeOptions.method).toBe("POST");
    expect(initializeOptions.headers).toMatchObject({
      Accept: "application/json, text/event-stream",
      Authorization: "Bearer access-token",
      "Mcp-Method": "initialize",
      "MCP-Protocol-Version": "2025-06-18",
    });

    const toolOptions = fetchMock.mock.calls[2][1];
    expect(toolOptions.headers).toMatchObject({
      Authorization: "Bearer access-token",
      "Mcp-Method": "tools/call",
      "Mcp-Name": "who_am_i",
      "Mcp-Session-Id": "session-1",
      "MCP-Protocol-Version": "2025-06-18",
    });
    expect(JSON.parse(toolOptions.body)).toMatchObject({
      method: "tools/call",
      params: { name: "who_am_i" },
    });

    const deleteOptions = fetchMock.mock.calls[3][1];
    expect(deleteOptions.method).toBe("DELETE");
    expect(deleteOptions.headers).toMatchObject({
      Authorization: "Bearer access-token",
      "Mcp-Session-Id": "session-1",
    });
  });

  it("parses SSE responses and forwards intermediate notifications", async () => {
    const notifications: Any[] = [];
    fetchMock.mockResolvedValueOnce(
      new Response(
        [
          "event: message",
          'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":50}}',
          "",
          "event: message",
          'data: {"jsonrpc":"2.0","id":1,"result":{"tools":[]}}',
          "",
        ].join("\n"),
        { headers: { "content-type": "text/event-stream" } },
      ),
    );

    const transport = new StreamableHttpTransport({
      id: "server",
      name: "Server",
      enabled: true,
      transport: "streamable-http",
      url: "http://127.0.0.1:3333/mcp",
    });
    transport.onMessage((message) => notifications.push(message));

    await transport.connect();
    await expect(transport.sendRequest("tools/list")).resolves.toEqual({ tools: [] });

    expect(notifications).toEqual([
      {
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: { progress: 50 },
      },
    ]);
  });

  it("refreshes an expired OAuth token before a request", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "new-token",
            refresh_token: "new-refresh",
            expires_in: 3600,
          }),
          { headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }), {
          headers: { "content-type": "application/json" },
        }),
      );

    const transport = new StreamableHttpTransport({
      id: "server-id",
      name: "Server",
      enabled: true,
      transport: "streamable-http",
      url: "https://example.com/mcp",
      auth: {
        type: "bearer",
        token: "old-token",
        refreshToken: "old-refresh",
        clientId: "client-id",
        clientSecret: "client-secret",
        tokenUrl: "https://example.com/oauth/token",
        expiresAt: Date.now() - 1,
      },
    });

    await transport.connect();
    await expect(transport.sendRequest("tools/list")).resolves.toEqual({ tools: [] });

    expect(fetchMock.mock.calls[0][0]).toBe("https://example.com/oauth/token");
    expect(fetchMock.mock.calls[1][1].headers).toMatchObject({
      Authorization: "Bearer new-token",
    });
  });

  it("uses the shared Box integration token for the hosted Box server", async () => {
    vi.spyOn(BoxSettingsManager, "loadSettings").mockReturnValue({
      enabled: true,
      accessToken: "current-box-token",
      mcpEnabled: true,
    });
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }), {
        headers: { "content-type": "application/json" },
      }),
    );

    const transport = new StreamableHttpTransport({
      id: "box-server",
      name: "Box MCP",
      enabled: true,
      transport: "streamable-http",
      registryId: "box",
      url: "https://mcp.box.com",
      auth: { type: "bearer", token: "stale-box-token" },
    });

    await transport.connect();
    await expect(transport.sendRequest("tools/list")).resolves.toEqual({ tools: [] });

    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
      Authorization: "Bearer current-box-token",
    });
  });
});
