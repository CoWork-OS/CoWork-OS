import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, request, type Server } from "http";
import { promises as dns } from "dns";
import { BrowserService } from "../../agent/browser/browser-service";
import { createBrowserNetworkProxy, type BrowserNetworkProxy } from "../browser-network-proxy";
let server: Server | undefined;
let service: BrowserService | undefined;
let proxy: BrowserNetworkProxy | undefined;
afterEach(async () => {
  await service?.close();
  service = undefined;
  await proxy?.close();
  proxy = undefined;
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
});
