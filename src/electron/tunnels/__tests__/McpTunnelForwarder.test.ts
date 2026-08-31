import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpTunnelForwarder } from "../McpTunnelForwarder";
import { DEFAULT_SECURE_MCP_TUNNEL_POLICY, type SecureMcpTunnelConfig } from "../types";

const mcpHostServerMock = {
  getHttpAuthToken: vi.fn(() => "host-token"),
};

vi.mock("../../mcp/host/MCPHostServer", () => ({
  MCPHostServer: {
    getInstance: () => mcpHostServerMock,
  },
}));

function buildConfig(overrides: Partial<SecureMcpTunnelConfig> = {}): SecureMcpTunnelConfig {
  return {
    id: "tunnel-1",
    name: "Local tunnel",
    enabled: true,
    relayUrl: "ws://127.0.0.1:9000",
    targetType: "cowork-host",
    coworkHostPort: 3333,
    policy: {
      ...DEFAULT_SECURE_MCP_TUNNEL_POLICY,
      allowedTools: ["read_file"],
    },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("McpTunnelForwarder", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    mcpHostServerMock.getHttpAuthToken.mockReturnValue("host-token");
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it("adds the local MCP host bearer token for cowork-host targets", async () => {
    const forwarder = new McpTunnelForwarder(buildConfig());

    await forwarder.forward({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "read_file", arguments: {} },
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3333/mcp",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer host-token",
        }),
      }),
    );
  });

  it("does not add local MCP host auth for explicit HTTP targets", async () => {
    const forwarder = new McpTunnelForwarder(
      buildConfig({
        targetType: "http",
        targetUrl: "http://127.0.0.1:4444/mcp",
      }),
    );

    await forwarder.forward({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "read_file", arguments: {} },
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:4444/mcp",
      expect.objectContaining({
        headers: expect.not.objectContaining({
          authorization: expect.any(String),
        }),
      }),
    );
  });
});
