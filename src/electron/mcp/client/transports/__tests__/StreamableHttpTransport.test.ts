import { mcpConfigurationCurrent } from "../../../configuration-authority";
import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StreamableHttpTransport } from "../StreamableHttpTransport";
import { MCPSettingsManager } from "../../../settings";
import { BoxSettingsManager } from "../../../../settings/box-manager";

const nativeFetch = globalThis.fetch;

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

  it("checks current authority after awaiting credential setup and before posting action bytes", async () => {
    const transport = new StreamableHttpTransport({
      id: "fixture",
      name: "Fixture",
      enabled: true,
      transport: "streamable-http",
      url: "https://example.invalid/mcp",
    });
    await transport.connect();
    let current = true;
    vi.spyOn(transport as Any, "ensureFreshToken").mockImplementation(async () => {
      current = false;
    });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })),
    );
    const beforeSend = vi.fn(async () => {
      if (!current) throw new Error("Revoked during refresh");
    });
    await expect(
      (transport as Any).sendRequest(
        "tools/call",
        { name: "fixture", arguments: {} },
        { beforeSend },
      ),
    ).rejects.toThrow("Revoked during refresh");
    expect(beforeSend).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(["cancelled", "disconnected", "reconnected", "endpoint-changed"])(
    "does not post after %s during the final guard",
    async (change) => {
      const transport = new StreamableHttpTransport({
        id: "fixture",
        name: "Fixture",
        enabled: true,
        transport: "streamable-http",
        url: "https://example.invalid/mcp",
      });
      await transport.connect();
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })),
      );
      const controller = new AbortController();
      const beforeSend = async () => {
        if (change === "cancelled") controller.abort();
        if (change === "disconnected") await transport.disconnect();
        if (change === "reconnected") {
          await transport.disconnect();
          await transport.connect();
        }
        if (change === "endpoint-changed")
          (transport as Any).config.url = "https://other.invalid/mcp";
      };
      await expect(
        (transport as Any).sendRequest(
          "tools/call",
          { name: "fixture", arguments: {} },
          { beforeSend, signal: controller.signal },
        ),
      ).rejects.toThrow();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
  it("carries cancellation to a submitted fetch without replaying the request", async () => {
    const transport = new StreamableHttpTransport({
      id: "fixture",
      name: "Fixture",
      enabled: true,
      transport: "streamable-http",
      url: "https://example.invalid/mcp",
    });
    await transport.connect();
    const controller = new AbortController();
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener(
            "abort",
            () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
            { once: true },
          );
        }),
    );
    const call = (transport as Any).sendRequest(
      "tools/call",
      { name: "fixture", arguments: {} },
      { signal: controller.signal },
    );
    const rejected = expect(call).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    controller.abort();
    await rejected;
    expect((transport as Any).activeAbortControllers.size).toBe(0);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it("does not replay a tool call after a 404 session response", async () => {
    const transport = new StreamableHttpTransport({
      id: "fixture",
      name: "Fixture",
      enabled: true,
      transport: "streamable-http",
      url: "https://example.invalid/mcp",
    });
    await transport.connect();
    (transport as Any).sessionId = "expired";
    (transport as Any).lastInitializeRequest = {
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {},
    };
    fetchMock.mockResolvedValueOnce(new Response("Session expired", { status: 404 }));
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, result: {} })),
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })),
    );
    await expect(
      transport.sendRequest("tools/call", { name: "fixture", arguments: {} }),
    ).rejects.toThrow("MCP_TOOL_OUTCOME_UNCONFIRMED");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it.each([false, true])(
    "recovers metadata sessions with a fresh guard for every POST (revoked=%s)",
    async (revoked) => {
      const transport = new StreamableHttpTransport({
        id: "fixture",
        name: "Fixture",
        enabled: true,
        transport: "streamable-http",
        url: "https://example.invalid/mcp",
      });
      await transport.connect();
      (transport as Any).sessionId = "expired";
      (transport as Any).lastInitializeRequest = {
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {},
      };
      let current = true;
      fetchMock.mockResolvedValueOnce(new Response("Session expired", { status: 404 }));
      fetchMock.mockImplementationOnce(async () => {
        if (revoked) current = false;
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, result: {} }), {
          headers: { "Mcp-Session-Id": "new-session" },
        });
      });
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } })),
      );
      const beforeSend = vi.fn(async () => {
        if (!current) throw new Error("Revoked before metadata replay");
      });
      const call = transport.sendRequest("tools/list", undefined, { beforeSend });
      if (revoked) await expect(call).rejects.toThrow("Revoked before metadata replay");
      else await expect(call).resolves.toEqual({ tools: [] });
      expect(beforeSend).toHaveBeenCalledTimes(3);
      expect(fetchMock).toHaveBeenCalledTimes(revoked ? 2 : 3);
    },
  );
  it("does not accept a late session header from an earlier connection generation", async () => {
    const transport = new StreamableHttpTransport({
      id: "fixture",
      name: "Fixture",
      enabled: true,
      transport: "streamable-http",
      url: "https://example.invalid/mcp",
    });
    await transport.connect();
    let resolve!: (response: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((r) => {
          resolve = r;
        }),
    );
    const call = transport.sendRequest("tools/call", { name: "fixture", arguments: {} });
    const rejected = expect(call).rejects.toThrow("MCP_TOOL_OUTCOME_UNCONFIRMED");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await transport.disconnect();
    await transport.connect();
    resolve(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
        headers: { "Mcp-Session-Id": "old-session" },
      }),
    );
    await rejected;
    expect((transport as Any).sessionId).toBeNull();
  });
  it("never forwards action bytes to a redirect destination in a real HTTP fixture", async () => {
    vi.stubGlobal("fetch", nativeFetch);
    let forwarded = 0;
    const destination = http.createServer((_request, response) => {
      forwarded++;
      response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
    });
    const listen = (server: http.Server) =>
      new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const close = (server: http.Server) =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    await listen(destination);
    const destinationPort = (destination.address() as import("node:net").AddressInfo).port;
    const source = http.createServer((_request, response) => {
      response.writeHead(307, { Location: `http://127.0.0.1:${destinationPort}/unapproved` });
      response.end();
    });
    await listen(source);
    const sourcePort = (source.address() as import("node:net").AddressInfo).port;
    const transport = new StreamableHttpTransport({
      id: "fixture",
      name: "Fixture",
      enabled: true,
      transport: "streamable-http",
      url: `http://127.0.0.1:${sourcePort}/mcp`,
      requestTimeout: 2000,
    });
    try {
      await transport.connect();
      await expect(
        transport.sendRequest("tools/call", {
          name: "fixture",
          arguments: { body: "synthetic action bytes" },
        }),
      ).rejects.toThrow("307");
      expect(forwarded).toBe(0);
    } finally {
      await transport.disconnect();
      await close(source);
      await close(destination);
    }
  });
  it.each(["unchanged", "manual-token", "disabled-server"])(
    "preserves exact authority through a real refresh adapter (%s)",
    async (scenario) => {
      const config = {
        id: "refresh-fixture",
        name: "Fixture",
        enabled: true,
        transport: "streamable-http" as const,
        url: "https://fixture.invalid/mcp",
        auth: {
          type: "bearer" as const,
          token: "old-fixture",
          refreshToken: "old-refresh",
          clientId: "client",
          clientSecret: "secret",
          tokenUrl: "https://fixture.invalid/token",
          expiresAt: 1,
        },
      };
      const admitted = structuredClone(config);
      let stored = structuredClone(config);
      vi.spyOn(MCPSettingsManager, "getServer").mockImplementation(() => structuredClone(stored));
      vi.mocked(MCPSettingsManager.updateServer).mockImplementation((_id, updates) => {
        stored = { ...stored, ...updates } as typeof stored;
        return stored;
      });
      fetchMock
        .mockImplementationOnce(async () => {
          if (scenario === "manual-token") stored.auth.token = "manual-fixture";
          if (scenario === "disabled-server") stored.enabled = false;
          return new Response(
            JSON.stringify({
              access_token: "new-fixture",
              refresh_token: "new-refresh",
              expires_in: 3600,
            }),
          );
        })
        .mockResolvedValueOnce(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })));
      const transport = new StreamableHttpTransport(config);
      await transport.connect();
      const beforeSend = vi.fn(async () => {
        if (!mcpConfigurationCurrent(admitted, stored)) throw new Error("Configuration changed");
      });
      const call = transport.sendRequest(
        "tools/call",
        { name: "fixture", arguments: {} },
        { beforeSend },
      );
      if (scenario === "unchanged") {
        await expect(call).resolves.toEqual({});
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(beforeSend).toHaveBeenCalledOnce();
      } else {
        await expect(call).rejects.toThrow(
          scenario === "manual-token" ? "credentials changed" : "Configuration changed",
        );
        expect(fetchMock).toHaveBeenCalledOnce();
      }
      if (scenario === "manual-token") {
        expect(stored.auth.token).toBe("manual-fixture");
        expect(MCPSettingsManager.updateServer).not.toHaveBeenCalled();
      }
      if (scenario === "disabled-server") expect(stored.enabled).toBe(false);
    },
  );
  it("carries proof from the shared Box refresh into the hosted MCP guard", async () => {
    let box = {
      enabled: true,
      accessToken: "box-old",
      refreshToken: "box-refresh",
      clientId: "box-client",
      clientSecret: "box-secret",
      tokenExpiresAt: 1,
    };
    vi.spyOn(BoxSettingsManager, "loadSettings").mockImplementation(() => structuredClone(box));
    vi.spyOn(BoxSettingsManager, "saveSettings").mockImplementation((value) => {
      box = value as typeof box;
    });
    const config = {
      id: "box-refresh-fixture",
      name: "Box",
      enabled: true,
      registryId: "box",
      transport: "streamable-http" as const,
      url: "https://mcp.box.com",
      auth: {
        type: "bearer" as const,
        token: box.accessToken,
        refreshToken: box.refreshToken,
        clientId: box.clientId,
        clientSecret: box.clientSecret,
        tokenUrl: "https://api.box.com/oauth2/token",
        expiresAt: box.tokenExpiresAt,
      },
    };
    const admitted = structuredClone(config);
    let stored = structuredClone(config);
    vi.spyOn(MCPSettingsManager, "getServer").mockImplementation(() => structuredClone(stored));
    vi.mocked(MCPSettingsManager.updateServer).mockImplementation((_id, updates) => {
      stored = { ...stored, ...updates } as typeof stored;
      return stored;
    });
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "box-new",
            refresh_token: "box-new-refresh",
            expires_in: 3600,
          }),
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })));
    const transport = new StreamableHttpTransport(config);
    await transport.connect();
    const beforeSend = async () => {
      if (!mcpConfigurationCurrent(admitted, stored)) throw new Error("Box authority changed");
    };
    await expect(
      transport.sendRequest("tools/call", { name: "fixture", arguments: {} }, { beforeSend }),
    ).resolves.toEqual({});
    expect(stored.auth.token).toBe("box-new");
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
