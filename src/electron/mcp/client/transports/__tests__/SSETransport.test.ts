import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MCPAuthConfig } from "../../../types";
import { SSETransport } from "../SSETransport";

type Seen = { method: string; url: string; authorization?: string; apiKey?: string };

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

/** Minimal legacy MCP SSE server: GET /sse streams, POST /message answers in the body. */
async function startServer(options: { redirectSseTo?: (base: string) => string } = {}) {
  const seen: Seen[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    seen.push({
      method: req.method || "",
      url: req.url || "",
      authorization: req.headers.authorization,
      apiKey: req.headers["x-api-key"] as string | undefined,
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    if (req.url?.startsWith("/old/sse")) {
      res.writeHead(307, { Location: options.redirectSseTo?.(base) ?? "/sse" }).end();
      return;
    }
    if (req.url?.startsWith("/sse")) {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
      res.write(": open\n\n");
      return;
    }
    if (req.url?.startsWith("/message")) {
      const message = JSON.parse(raw);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [] } }));
      return;
    }
    res.writeHead(404).end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

function transport(url: string, auth: MCPAuthConfig) {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  return new SSETransport({
    id: "sse",
    name: "SSE",
    enabled: true,
    transport: "sse",
    url,
    auth,
    connectionTimeout: 3000,
  });
}

describe("SSETransport credentials", () => {
  it("sends the token as a header on the stream and messages, never in a URL or log", async () => {
    const { base, seen } = await startServer();
    const sse = transport(base, { type: "bearer", token: "secret-token" });
    await sse.connect();
    await expect(sse.sendRequest("tools/list")).resolves.toEqual({ tools: [] });
    await sse.disconnect();
    expect(seen.map((entry) => [entry.method, entry.url, entry.authorization])).toEqual([
      ["GET", "/sse", "Bearer secret-token"],
      ["POST", "/message", "Bearer secret-token"],
    ]);
    const logged = JSON.stringify((console.log as any).mock.calls);
    expect(logged).not.toContain("secret-token");
  });

  it("sends an API key in its header", async () => {
    const { base, seen } = await startServer();
    const sse = transport(base, { type: "api-key", apiKey: "key-1" });
    await sse.connect();
    await sse.disconnect();
    expect(seen[0]).toMatchObject({ url: "/sse", apiKey: "key-1" });
  });

  it("follows a same-origin redirect with credentials and refuses another origin", async () => {
    const same = await startServer();
    const ok = transport(`${same.base}/old`, { type: "bearer", token: "t1" });
    await ok.connect();
    await ok.disconnect();
    expect(same.seen.map((entry) => [entry.url, entry.authorization])).toEqual([
      ["/old/sse", "Bearer t1"],
      ["/sse", "Bearer t1"],
    ]);

    const elsewhere = await startServer();
    const redirecting = await startServer({
      redirectSseTo: () => `${elsewhere.base.replace("127.0.0.1", "localhost")}/sse`,
    });
    const refused = transport(`${redirecting.base}/old`, { type: "bearer", token: "t2" });
    await expect(refused.connect()).rejects.toThrow();
    expect(elsewhere.seen).toEqual([]);
  });

  it("adds a query token only when a legacy server opts in, and only on the stream", async () => {
    const { base, seen } = await startServer();
    const sse = transport(base, { type: "bearer", token: "legacy", sendTokenInQuery: true });
    await sse.connect();
    await sse.sendRequest("tools/list");
    await sse.disconnect();
    expect(seen.map((entry) => entry.url)).toEqual(["/sse?token=legacy", "/message"]);
  });
});
