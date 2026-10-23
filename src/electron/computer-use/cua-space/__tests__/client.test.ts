import { describe, expect, it, vi } from "vitest";
import {
  CuaSpaceClient,
  connectCuaSpace,
  testCuaSpaceConnection,
  type CuaSpaceClientLike,
} from "../client";
import { resolveCuaSpaceEndpoint } from "../settings";
import type { MCPServerConfig, MCPTransport } from "../../../mcp/types";

function fakeTransport(toolResult: unknown) {
  let connected = false;
  const transport: MCPTransport = {
    connect: vi.fn(async () => {
      connected = true;
    }),
    disconnect: vi.fn(async () => {
      connected = false;
    }),
    send: vi.fn().mockResolvedValue(undefined),
    sendRequest: vi.fn(async (method: string) =>
      method === "initialize" ? { protocolVersion: "2025-06-18" } : toolResult,
    ),
    onMessage: vi.fn(),
    onClose: vi.fn(),
    onError: vi.fn(),
    isConnected: () => connected,
  };
  return transport;
}

describe("CuaSpaceClient", () => {
  it("initializes once, sends the bearer token, and returns structured tool content", async () => {
    const endpoint = resolveCuaSpaceEndpoint("http://192.168.64.5:3211", "space-token");
    const transport = fakeTransport({ content: [], structuredContent: { apps: [] } });
    const configs: MCPServerConfig[] = [];
    const client = new CuaSpaceClient(endpoint, "space-token", (config) => {
      configs.push(config);
      return transport;
    });

    await expect(client.callTool("list_apps", {})).resolves.toEqual({
      content: [],
      structuredContent: { apps: [] },
    });
    await client.callTool("list_apps", {});

    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({
      url: "http://192.168.64.5:3211/mcp",
      auth: { type: "bearer", token: "space-token" },
    });
    expect(transport.sendRequest).toHaveBeenCalledWith("tools/call", {
      name: "list_apps",
      arguments: {},
    });
    expect(
      vi.mocked(transport.sendRequest).mock.calls.filter(([m]) => m === "initialize"),
    ).toHaveLength(1);
  });

  it("raises tool errors with the server's message", async () => {
    const endpoint = resolveCuaSpaceEndpoint("http://127.0.0.1:3211", undefined);
    const transport = fakeTransport({
      isError: true,
      content: [{ type: "text", text: "stale capture" }],
    });
    const client = new CuaSpaceClient(endpoint, undefined, () => transport);
    await expect(client.callTool("click", {})).rejects.toThrow(
      "Cua Space click failed: stale capture",
    );
  });

  it("checks /health without credentials and without following redirects", async () => {
    const endpoint = resolveCuaSpaceEndpoint("http://192.168.64.5:3211", "space-token");
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
    const client = new CuaSpaceClient(endpoint, "space-token", undefined, fetchImpl as never);
    await expect(client.checkHealth()).resolves.toBe(true);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://192.168.64.5:3211/health");
    expect(init.redirect).toBe("error");
    expect(init.headers).toBeUndefined();
  });
});

function stubClient(overrides: Partial<CuaSpaceClientLike> = {}): CuaSpaceClientLike {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(false),
    checkHealth: vi.fn().mockResolvedValue(true),
    callTool: vi.fn(),
    disconnect: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("connectCuaSpace", () => {
  it("says how to fix an unreachable Space and does not try to connect", async () => {
    const client = stubClient({ checkHealth: vi.fn().mockResolvedValue(false) });
    await expect(connectCuaSpace(client, "http://127.0.0.1:3211")).rejects.toThrow(
      /not reachable\. Start the Space in Cua Spaces/,
    );
    expect(client.connect).not.toHaveBeenCalled();
  });

  it("reports only the HTTP status when the Space refuses the MCP session", async () => {
    const refusal = Object.assign(
      new Error("MCP Streamable HTTP error 401: <html>internal admin page</html>"),
      { status: 401 },
    );
    const client = stubClient({ connect: vi.fn().mockRejectedValue(refusal) });
    const error = await connectCuaSpace(client, "https://space.example.com").catch((e) => e);
    expect(error.message).toMatch(
      /refused the connection \(HTTP 401\)\. Check the Space URL and token/,
    );
    expect(error.message).not.toContain("admin page");
  });

  it("skips the probe when already connected", async () => {
    const client = stubClient({ isConnected: vi.fn().mockReturnValue(true) });
    await connectCuaSpace(client, "http://127.0.0.1:3211");
    expect(client.checkHealth).not.toHaveBeenCalled();
  });
});

describe("testCuaSpaceConnection", () => {
  it("reports success and closes the probe session", async () => {
    const client = stubClient();
    await expect(testCuaSpaceConnection(client, "http://127.0.0.1:3211")).resolves.toEqual({
      reachable: true,
    });
    expect(client.disconnect).toHaveBeenCalled();
  });

  it("returns the failure instead of throwing", async () => {
    const client = stubClient({ checkHealth: vi.fn().mockResolvedValue(false) });
    const result = await testCuaSpaceConnection(client, "http://127.0.0.1:3211");
    expect(result.reachable).toBe(false);
    expect(result.error).toMatch(/not reachable/);
    expect(client.disconnect).toHaveBeenCalled();
  });
});
