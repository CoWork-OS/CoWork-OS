import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { startTunnelRelayServer, type TunnelRelayServer } from "../relay";

let relay: TunnelRelayServer | null = null;
const ADMIN_TOKEN = "relay-admin";

afterEach(async () => {
  if (relay) {
    await relay.close();
    relay = null;
  }
});

describe("secure MCP tunnel relay", () => {
  it("requires an admin token to create relay tunnel credentials", async () => {
    relay = await startTunnelRelayServer({ port: 0 });
    const response = await fetch(`http://127.0.0.1:${relay.port}/v1/tunnels`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "test" }),
    });
    expect(response.status).toBe(401);
  });

  it("accepts caller-provided tokens for manual provisioning", async () => {
    relay = await startTunnelRelayServer({ port: 0, adminToken: ADMIN_TOKEN });
    const created = await createTunnel(relay.port, {
      clientToken: "ctun_manual",
      callerToken: "ccall_manual",
    });
    expect(created.clientToken).toBe("ctun_manual");
    expect(created.callerToken).toBe("ccall_manual");
  });

  it("rejects unauthenticated MCP callers", async () => {
    relay = await startTunnelRelayServer({ port: 0, adminToken: ADMIN_TOKEN });
    const created = await createTunnel(relay.port);
    const response = await fetch(`http://127.0.0.1:${relay.port}/v1/tunnels/${created.id}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(401);
  });

  it("rejects MCP calls while the local tunnel client is disconnected", async () => {
    relay = await startTunnelRelayServer({ port: 0, adminToken: ADMIN_TOKEN });
    const created = await createTunnel(relay.port);
    const response = await fetch(`http://127.0.0.1:${relay.port}/v1/tunnels/${created.id}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${created.callerToken}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(503);
  });

  it("forwards JSON-RPC MCP requests to the connected local client", async () => {
    relay = await startTunnelRelayServer({ port: 0, adminToken: ADMIN_TOKEN });
    const created = await createTunnel(relay.port);
    const ws = new WebSocket(
      `ws://127.0.0.1:${relay.port}/v1/tunnels/connect?tunnel_id=${created.id}`,
      { headers: { authorization: `Bearer ${created.clientToken}` } },
    );
    await waitForOpen(ws);
    ws.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.type !== "mcp_request") return;
      ws.send(
        JSON.stringify({
          type: "mcp_response",
          tunnelId: created.id,
          requestId: message.requestId,
          payload: {
            jsonrpc: "2.0",
            id: message.payload.id,
            result: { tools: [] },
          },
        }),
      );
    });

    const response = await fetch(`http://127.0.0.1:${relay.port}/v1/tunnels/${created.id}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${created.callerToken}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [] },
    });
    ws.close();
  });

  it("does not let the local client relax relay-side tool policy", async () => {
    relay = await startTunnelRelayServer({ port: 0, adminToken: ADMIN_TOKEN });
    const created = await createTunnel(relay.port, {
      policy: { allowedTools: ["read_file"] },
    });
    const ws = new WebSocket(
      `ws://127.0.0.1:${relay.port}/v1/tunnels/connect?tunnel_id=${created.id}`,
      { headers: { authorization: `Bearer ${created.clientToken}` } },
    );
    await waitForOpen(ws);
    ws.send(
      JSON.stringify({
        type: "hello",
        tunnelId: created.id,
        protocolVersion: 1,
        targetType: "http",
        policy: {
          allowedTools: [],
          readOnly: false,
          maxRequestBytes: 999999,
          maxResponseBytes: 999999,
          requestTimeoutMs: 60000,
        },
      }),
    );

    const response = await fetch(`http://127.0.0.1:${relay.port}/v1/tunnels/${created.id}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${created.callerToken}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "delete_file", arguments: {} },
      }),
    });
    expect(response.status).toBe(403);
    ws.close();
  });
});

async function createTunnel(
  port: number,
  body: Record<string, unknown> = {},
): Promise<{
  id: string;
  clientToken: string;
  callerToken: string;
}> {
  const response = await fetch(`http://127.0.0.1:${port}/v1/tunnels`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_TOKEN}` },
    body: JSON.stringify({ name: "test", ...body }),
  });
  expect(response.status).toBe(201);
  return response.json() as Promise<{ id: string; clientToken: string; callerToken: string }>;
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}
