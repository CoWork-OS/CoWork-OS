import { afterEach, describe, expect, it } from "vitest";
import { createServer, request } from "http";
import { connect } from "net";
import { CamofoxPolicyProxy, CAMOFOX_CHECK_HOST_SUFFIX } from "../camofox-policy-proxy";

const PASSWORD = "proxy-password";
const AUTH = `Basic ${Buffer.from(`cowork:${PASSWORD}`).toString("base64")}`;

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** A request through the proxy (absolute URL), or straight to it (a path), as a browser sends. */
function get(
  proxyPort: number,
  url: string,
  auth: string | null = AUTH,
): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: proxyPort,
        method: "GET",
        path: url,
        headers: auth ? { "proxy-authorization": auth } : {},
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode || 0, body, headers: res.headers }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function connectWithout(proxyPort: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(proxyPort, "127.0.0.1", () => {
      socket.write("CONNECT example.test:443 HTTP/1.1\r\nHost: example.test:443\r\n\r\n");
    });
    let reply = "";
    socket.on("data", (chunk) => (reply += chunk));
    socket.on("close", () => resolve(reply));
    socket.on("error", reject);
  });
}

let proxy: CamofoxPolicyProxy | null = null;

afterEach(async () => {
  // Release any leases a failed assertion left behind.
  proxy = null;
});

describe("CamofoxPolicyProxy", () => {
  it("serves its check page with a one-time token on the fixed port, only while leased", async () => {
    proxy = new CamofoxPolicyProxy();
    const port = await freePort();
    const lease = await proxy.acquire(port, PASSWORD, "task-a", () => {});
    const check = proxy.issueCheck();
    expect(new URL(check.url).hostname.endsWith(CAMOFOX_CHECK_HOST_SUFFIX)).toBe(true);
    const page = await get(port, check.url);
    expect(page.status).toBe(200);
    expect(page.body).toContain(check.token);
    check.done();
    expect((await get(port, check.url)).body).not.toContain(check.token);
    await lease.release();
    await expect(get(port, check.url)).rejects.toThrow();
  });

  it("asks for the proxy password before serving anything", async () => {
    proxy = new CamofoxPolicyProxy();
    const port = await freePort();
    const lease = await proxy.acquire(port, PASSWORD, "task-a", () => {});
    const check = proxy.issueCheck();
    for (const auth of [null, `Basic ${Buffer.from("cowork:wrong").toString("base64")}`]) {
      const refused = await get(port, check.url, auth);
      expect(refused.status).toBe(407);
      expect(refused.headers["proxy-authenticate"]).toMatch(/^Basic/);
      expect(refused.body).not.toContain(check.token);
    }
    expect(await connectWithout(port)).toMatch(/^HTTP\/1\.1 407/);
    await lease.release();
  });

  it("hands a canary only to loopback scripts that skip the proxy", async () => {
    proxy = new CamofoxPolicyProxy();
    const port = await freePort();
    const lease = await proxy.acquire(port, PASSWORD, "task-a", () => {});
    const check = proxy.issueCheck();
    const page = (await get(port, check.url)).body;
    // The page writes the marker from script, so the plain source does not contain it.
    expect(page).not.toContain(check.marker);
    const scripts = [...page.matchAll(/<script src="([^"]+)"/g)].map((match) => match[1]);
    expect(scripts.map((src) => new URL(src).host)).toEqual([
      `127.0.0.1:${port}`,
      `localhost:${port}`,
    ]);
    const path = new URL(scripts[0]).pathname;
    // Straight to the port, as a browser that bypasses the proxy for loopback would ask.
    const direct = await get(port, path, null);
    expect(direct.status).toBe(200);
    expect(direct.body.replace(/" \+ "/g, "")).toContain(check.canary);
    // Through the proxy it is a loopback target like any other, and refused.
    const proxied = await get(port, scripts[0]);
    expect(proxied.status).toBe(502);
    expect(proxied.body).not.toContain(check.canary.slice(0, 8));
    expect((await get(port, "/cowork-loopback-check/unknown.js", null)).status).toBe(502);
    check.done();
    expect((await get(port, path, null)).status).toBe(502);
    await lease.release();
  });

  it("applies every active task's policy and refuses everything without a lease", async () => {
    proxy = new CamofoxPolicyProxy();
    const port = await freePort();
    const seen: string[] = [];
    const a = await proxy.acquire(port, PASSWORD, "task-a", (url) => {
      seen.push(`a:${url}`);
    });
    const b = await proxy.acquire(port, PASSWORD, "task-b", (url) => {
      seen.push(`b:${url}`);
      throw new Error("denied for b");
    });
    const refused = await get(port, "http://example.test/");
    expect(refused.status).toBe(502);
    expect(seen).toContain("a:http://example.test/");
    expect(seen).toContain("b:http://example.test/");
    await b.release();
    expect(proxy.leaseCount).toBe(1);
    await a.release();
    await a.release();
    expect(proxy.running).toBe(false);
  });

  it("explains a port that is already taken", async () => {
    proxy = new CamofoxPolicyProxy();
    const taken = createServer();
    await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", resolve));
    const port = (taken.address() as { port: number }).port;
    try {
      await expect(proxy.acquire(port, PASSWORD, "task-a", () => {})).rejects.toThrow(
        /already in use/,
      );
      expect(proxy.leaseCount).toBe(0);
    } finally {
      await new Promise<void>((resolve) => taken.close(() => resolve()));
    }
  });

  it("won't change port or password while another task holds a lease", async () => {
    proxy = new CamofoxPolicyProxy();
    const first = await freePort();
    const second = await freePort();
    const lease = await proxy.acquire(first, PASSWORD, "task-a", () => {});
    await expect(proxy.acquire(second, PASSWORD, "task-b", () => {})).rejects.toThrow(
      /another task/,
    );
    await expect(proxy.acquire(first, "other", "task-b", () => {})).rejects.toThrow(/another task/);
    await lease.release();
    const moved = await proxy.acquire(second, PASSWORD, "task-b", () => {});
    expect(proxy.running).toBe(true);
    await moved.release();
  });
});
