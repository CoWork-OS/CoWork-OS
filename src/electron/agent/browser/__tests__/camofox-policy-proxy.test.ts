import { afterEach, describe, expect, it } from "vitest";
import { createServer, request } from "http";
import { CamofoxPolicyProxy, CAMOFOX_CHECK_HOST_SUFFIX } from "../camofox-policy-proxy";

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function get(proxyPort: number, url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: proxyPort, method: "GET", path: url }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode || 0, body }));
    });
    req.on("error", reject);
    req.end();
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
    const lease = await proxy.acquire(port, "task-a", () => {});
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

  it("applies every active task's policy and refuses everything without a lease", async () => {
    proxy = new CamofoxPolicyProxy();
    const port = await freePort();
    const seen: string[] = [];
    const a = await proxy.acquire(port, "task-a", (url) => {
      seen.push(`a:${url}`);
    });
    const b = await proxy.acquire(port, "task-b", (url) => {
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
      await expect(proxy.acquire(port, "task-a", () => {})).rejects.toThrow(/already in use/);
      expect(proxy.leaseCount).toBe(0);
    } finally {
      await new Promise<void>((resolve) => taken.close(() => resolve()));
    }
  });

  it("won't move to another port while another task holds a lease", async () => {
    proxy = new CamofoxPolicyProxy();
    const first = await freePort();
    const second = await freePort();
    const lease = await proxy.acquire(first, "task-a", () => {});
    await expect(proxy.acquire(second, "task-b", () => {})).rejects.toThrow(/another task/);
    await lease.release();
    const moved = await proxy.acquire(second, "task-b", () => {});
    expect(proxy.running).toBe(true);
    await moved.release();
  });
});
