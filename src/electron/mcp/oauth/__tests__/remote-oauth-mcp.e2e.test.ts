/**
 * Headless end to end: a local "Workday-like" server (OAuth token endpoint plus a
 * bearer-protected Streamable HTTP MCP endpoint) driven through the real
 * MCPServerConnection, with no Electron, browser or person in the loop.
 */
import { generateKeyPairSync } from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MCPServerConnection } from "../../client/MCPServerConnection";
import { MCPSettingsManager } from "../../settings";
import type { MCPServerConfig } from "../../types";

const servers: http.Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

async function startWorkdayLikeServer() {
  const state = { minted: 0, current: "", toolCalls: [] as string[], rejectNext: false };
  const tools = Array.from({ length: 30 }, (_, i) => ({
    name: i === 0 ? "Get_Time_Off_Balance" : `Tool_${i}`,
    description: i === 0 ? "Returns the worker's time off balance" : `Tool ${i}`,
    inputSchema: { type: "object", properties: { worker: { type: "string" } } },
    annotations: { readOnlyHint: true },
  }));
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === "/auth/oauth2/acme/token") {
      const form = new URLSearchParams(raw);
      if (form.get("grant_type") !== "urn:ietf:params:oauth:grant-type:jwt-bearer") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unsupported_grant_type" }));
        return;
      }
      state.minted += 1;
      state.current = `asu-${state.minted}`;
      res.writeHead(200, { "Content-Type": "application/json" });
      // Workday may send expires_in as a string.
      res.end(
        JSON.stringify({ access_token: state.current, token_type: "Bearer", expires_in: "14400" }),
      );
      return;
    }
    if (url.pathname !== "/acme/mcp") {
      res.writeHead(404).end();
      return;
    }
    if (req.headers.authorization !== `Bearer ${state.current}` || state.rejectNext) {
      state.rejectNext = false;
      res.writeHead(401, { "WWW-Authenticate": 'Bearer error="invalid_token"' }).end();
      return;
    }
    // No server-initiated stream and no session teardown in this fixture.
    if (req.method !== "POST") {
      res.writeHead(req.method === "DELETE" ? 200 : 405).end();
      return;
    }
    const message = JSON.parse(raw);
    if (!("id" in message)) {
      res.writeHead(202).end();
      return;
    }
    const reply = (result: unknown) => {
      res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "s1" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    };
    switch (message.method) {
      case "initialize":
        return reply({
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "workday-like", version: "1" },
        });
      case "tools/list":
        return reply({ tools });
      case "tools/call":
        state.toolCalls.push(message.params.name);
        return reply({ content: [{ type: "text", text: "Balance: 12 days" }] });
      default:
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: "no" },
          }),
        );
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, state };
}

describe("remote OAuth MCP server, headless", () => {
  let stored: MCPServerConfig | undefined;
  beforeEach(() => {
    vi.spyOn(MCPSettingsManager, "getServer").mockImplementation(() => stored ?? null);
    vi.spyOn(MCPSettingsManager, "updateServer").mockImplementation((_id, updates) => {
      stored = { ...stored!, ...updates };
      return stored;
    });
  });

  it("mints an ambient token, lists and calls tools, and renews after the server revokes it", async () => {
    const { base, state } = await startWorkdayLikeServer();
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    stored = {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Workday",
      enabled: true,
      transport: "streamable-http",
      url: `${base}/acme/mcp`,
      auth: {
        type: "bearer",
        clientId: "agent-client",
        tokenUrl: `${base}/auth/oauth2/acme/token`,
        privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        oauth: { grant: "jwt_bearer", jwt: { subject: "asu-agent" } },
      },
    };
    const connection = new MCPServerConnection(stored, { maxReconnectAttempts: 0 });
    await connection.connect();
    expect(connection.getStatus().status).toBe("connected");
    expect(connection.getTools()).toHaveLength(30);
    expect(state.minted).toBe(1);

    await expect(
      connection.callTool("Get_Time_Off_Balance", { worker: "me" }),
    ).resolves.toMatchObject({
      content: [{ type: "text", text: "Balance: 12 days" }],
    });

    // The gateway revokes the token: one renewal, one resend, and the call succeeds.
    state.rejectNext = true;
    await expect(
      connection.callTool("Get_Time_Off_Balance", { worker: "me" }),
    ).resolves.toBeTruthy();
    expect(state.minted).toBe(2);
    expect(state.toolCalls).toEqual(["Get_Time_Off_Balance", "Get_Time_Off_Balance"]);
    // The renewed credential is persisted for the next process (desktop or daemon).
    expect(stored.auth).toMatchObject({ token: "asu-2" });
    await connection.disconnect();
  });
});
