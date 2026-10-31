import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, request, type Server } from "http";
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from "net";
import { promises as dns } from "dns";
import { BrowserService } from "../../agent/browser/browser-service";
import { createBrowserNetworkProxy, type BrowserNetworkProxy } from "../browser-network-proxy";
let server: Server | undefined;
let service: BrowserService | undefined;
let proxy: BrowserNetworkProxy | undefined;
let echo: TcpServer | undefined;
afterEach(async () => {
  await service?.close();
  service = undefined;
  await proxy?.close();
  proxy = undefined;
  if (echo) {
    await new Promise<void>((r) => echo!.close(() => r()));
    echo = undefined;
  }
  vi.restoreAllMocks();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  }
});
async function listen(handler: Parameters<typeof createServer>[0]) {
  server = createServer(handler);
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return (server.address() as { port: number }).port;
}
/** A TCP echo server on loopback, standing in for a WebSocket peer. */
async function listenEcho() {
  echo = createTcpServer((socket) => socket.pipe(socket));
  await new Promise<void>((r) => echo!.listen(0, "127.0.0.1", r));
  return (echo.address() as { port: number }).port;
}
/** Open a CONNECT tunnel through the proxy; rejects when the proxy refuses it. */
function tunnel(target: string): Promise<Socket> {
  const address = new URL(proxy!.url);
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: address.hostname,
      port: address.port,
      method: "CONNECT",
      path: target,
    });
    req.once("connect", (res, socket) =>
      res.statusCode === 200 ? resolve(socket) : reject(new Error(`status ${res.statusCode}`)),
    );
    req.on("error", reject);
    req.end();
  });
}
/** A plain-HTTP request through the proxy (Chromium sends http: URLs this way). */
function proxiedGet(url: string): Promise<{ status: number; body: string }> {
  const address = new URL(proxy!.url);
  return new Promise((resolve, reject) => {
    const req = request(
      { hostname: address.hostname, port: address.port, method: "GET", path: url },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode || 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}
function roundTrip(socket: Socket, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    socket.once("data", (chunk) => resolve(String(chunk)));
    socket.once("error", reject);
    socket.once("close", () => reject(new Error("tunnel closed")));
    socket.write(text);
  });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
describe("browser connection pinning", () => {
  it("preserves allowed redirects, cookies, POST bodies and blocks redirected destinations in real Chromium", async () => {
    let forbidden = 0;
    const port = await listen((req, res) => {
      if (req.headers.host?.startsWith("denied.test")) {
        forbidden++;
        res.end("DENIED");
        return;
      }
      if (req.url === "/start") {
        res.writeHead(302, { location: "/page", "set-cookie": ["one=1; Path=/", "two=2; Path=/"] });
        res.end();
        return;
      }
      if (req.url === "/escape") {
        res.writeHead(302, { location: `http://denied.test:${port}/forbidden` });
        res.end();
        return;
      }
      if (req.url === "/post") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => res.end(body + " " + req.headers.cookie));
        return;
      }
      res.end("<html><body>TEST DATA</body></html>");
    });
    vi.spyOn(dns, "lookup").mockResolvedValue([{ address: "127.0.0.1", family: 4 }] as Any);
    service = new BrowserService({
      id: "TEST DATA",
      path: "/tmp",
      permissions: {
        network: true,
        accessNetworkMode: "enabled",
        accessDomainRules: [{ pattern: "allowed.test", access: "allow" }],
      },
    } as Any);
    await service.init();
    const page = (service as Any).page;
    await page.goto(`http://allowed.test:${port}/start`);
    expect(page.url()).toBe(`http://allowed.test:${port}/page`);
    const result = await page.evaluate(async () => {
      const response = await fetch("/post", { method: "POST", body: "TEST DATA POST" });
      return response.text();
    });
    expect(result).toContain("TEST DATA POST");
    expect(result).toContain("one=1");
    expect(result).toContain("two=2");
    await page.goto(`http://allowed.test:${port}/escape`).catch(() => {});
    expect(forbidden).toBe(0);
    await expect(service.init()).resolves.toBeUndefined();
  }, 20_000);
  it("pins CONNECT to one validated address and refuses mixed internal answers", async () => {
    const port = await listen((_req, res) => res.end("TEST DATA"));
    const lookup = vi
      .spyOn(dns, "lookup")
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }] as Any)
      .mockResolvedValue([{ address: "169.254.169.254", family: 4 }] as Any);
    proxy = await createBrowserNetworkProxy(() => {});
    const address = new URL(proxy.url);
    const result = await new Promise<string>((resolve, reject) => {
      const req = request({
        hostname: address.hostname,
        port: address.port,
        method: "CONNECT",
        path: `pinned.test:${port}`,
      });
      req.once("connect", (res, socket) => {
        expect(res.statusCode).toBe(200);
        let data = "";
        socket.on("data", (chunk) => (data += chunk));
        socket.on("end", () => resolve(data));
        socket.on("error", reject);
        socket.write("GET / HTTP/1.1\r\nHost: pinned.test\r\nConnection: close\r\n\r\n");
      });
      req.on("error", reject);
      req.end();
    });
    expect(result).toContain("TEST DATA");
    expect(lookup).toHaveBeenCalledOnce();
    await expect(
      new Promise<void>((resolve, reject) => {
        const req = request({
          hostname: address.hostname,
          port: address.port,
          method: "CONNECT",
          path: `pinned.test:${port}`,
        });
        req.once("connect", () => resolve());
        req.on("error", reject);
        req.end();
      }),
    ).rejects.toThrow();
  });
  it("reaches loopback only for an approved origin, whatever name leads there", async () => {
    const port = await listen((_req, res) => res.end("TEST DATA"));
    const lookup = vi
      .spyOn(dns, "lookup")
      .mockResolvedValue([{ address: "127.0.0.1", family: 4 }] as Any);
    const approved = `http://127.0.0.1:${port}`;
    proxy = await createBrowserNetworkProxy(() => {}, {
      allowsLoopback: (origin) => origin === approved,
    });
    const socket = await tunnel(`127.0.0.1:${port}`);
    socket.destroy();
    expect(await proxiedGet(`${approved}/`)).toEqual({ status: 200, body: "TEST DATA" });
    for (const target of [
      `localhost:${port}`,
      `127.0.0.2:${port}`,
      `[::ffff:7f00:1]:${port}`,
      `loopback.test:${port}`,
    ]) {
      await expect(tunnel(target), target).rejects.toThrow();
    }
    expect(lookup).toHaveBeenCalled();
    expect((await proxiedGet(`http://loopback.test:${port}/`)).status).toBe(502);
    expect((await proxiedGet(`http://localhost:${port}/`)).status).toBe(502);
  });
  it("keeps the old loopback behaviour for callers without loopback approvals", async () => {
    const port = await listen((_req, res) => res.end("TEST DATA"));
    vi.spyOn(dns, "lookup").mockResolvedValue([{ address: "127.0.0.1", family: 4 }] as Any);
    proxy = await createBrowserNetworkProxy(() => {});
    const socket = await tunnel(`loopback.test:${port}`);
    socket.destroy();
  });
  it("keeps established tunnels open past the request idle limit, then closes idle ones", async () => {
    const port = await listenEcho();
    proxy = await createBrowserNetworkProxy(() => {}, {
      allowsLoopback: () => true,
      idleTimeoutMs: 100,
      tunnelIdleTimeoutMs: 1_500,
    });
    const socket = await tunnel(`127.0.0.1:${port}`);
    await sleep(400);
    expect(await roundTrip(socket, "TEST DATA ping")).toBe("TEST DATA ping");
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    const started = Date.now();
    await closed;
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);
  }, 10_000);
});
