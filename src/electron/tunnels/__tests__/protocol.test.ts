import { describe, expect, it } from "vitest";
import { enforceTunnelPolicy, getMcpToolName, parseTunnelRelayMessage } from "../protocol";
import { DEFAULT_SECURE_MCP_TUNNEL_POLICY } from "../types";

describe("secure MCP tunnel protocol", () => {
  it.each([
    "home-assistant.call_service",
    "comfyui.submit_workflow",
    "discord.add_reaction",
    "server.write",
    "read_file",
    "unknown",
  ])("fails closed for read-only tool %s even if allowlisted", (name) => {
    const payload = { jsonrpc: "2.0", method: "tools/call", params: { name, arguments: {} } };
    expect(
      enforceTunnelPolicy(
        { ...DEFAULT_SECURE_MCP_TUNNEL_POLICY, readOnly: true, allowedTools: [name] },
        payload,
        100,
      ).approved,
    ).toBe(false);
    expect(
      enforceTunnelPolicy(
        { ...DEFAULT_SECURE_MCP_TUNNEL_POLICY, readOnly: false, allowedTools: [name] },
        payload,
        100,
      ).approved,
    ).toBe(true);
  });
  it("extracts tool names from MCP tool calls", () => {
    expect(
      getMcpToolName({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "read_file", arguments: {} },
      }),
    ).toBe("read_file");
  });

  it("blocks disallowed tools", () => {
    const result = enforceTunnelPolicy(
      { ...DEFAULT_SECURE_MCP_TUNNEL_POLICY, allowedTools: ["read_file"] },
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "delete_file", arguments: {} },
      },
      128,
    );
    expect(result).toMatchObject({ approved: false, toolName: "delete_file" });
  });

  it("blocks write-like tools in read-only mode", () => {
    const result = enforceTunnelPolicy(
      { ...DEFAULT_SECURE_MCP_TUNNEL_POLICY, readOnly: true },
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "write_file", arguments: {} },
      },
      128,
    );
    expect(result).toMatchObject({ approved: false });
  });

  it("rejects malformed relay messages", () => {
    expect(() => parseTunnelRelayMessage(JSON.stringify({ type: "mcp_request" }))).toThrow(
      /tunnelId/,
    );
  });
});

describe("tunnel host lifecycle boundary", () => {
  it.each([true, false])("denies shutdown and unknown methods with readOnly=%s", (readOnly) => {
    for (const method of ["shutdown", "host/restart", "SHUTDOWN"]) {
      expect(
        enforceTunnelPolicy(
          { ...DEFAULT_SECURE_MCP_TUNNEL_POLICY, readOnly },
          { jsonrpc: "2.0", method },
          100,
        ).approved,
      ).toBe(false);
    }
  });
  it("allows the client protocol surface and rejects malformed tool calls", () => {
    for (const method of [
      "initialize",
      "notifications/initialized",
      "ping",
      "tools/list",
      "resources/list",
      "resources/read",
      "resources/templates/list",
      "prompts/list",
      "prompts/get",
      "notifications/cancelled",
    ]) {
      expect(
        enforceTunnelPolicy(DEFAULT_SECURE_MCP_TUNNEL_POLICY, { jsonrpc: "2.0", method }, 100)
          .approved,
      ).toBe(true);
    }
    expect(
      enforceTunnelPolicy(
        DEFAULT_SECURE_MCP_TUNNEL_POLICY,
        { jsonrpc: "2.0", method: "tools/call", params: {} },
        100,
      ).approved,
    ).toBe(false);
  });
});
