import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as dns } from "dns";
import { createServer, type Server } from "http";
import { gzipSync } from "zlib";
import { loadPolicies } from "../../admin/policies";
import { pinnedFetch, resolvePinnedAddresses } from "../pinned-fetch";
import { readBoundedResponse } from "../bounded-response";

let server: Server | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});
async function listen(handler: Parameters<typeof createServer>[0]) {
  server = createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}

describe("DNS validation bound to HTTP connections", () => {
  it("connects once to the validated address and preserves Host, even if DNS then changes", async () => {
    let host: string | undefined;
    const port = await listen((req, res) => {
      host = req.headers.host;
      res.end("public content");
    });
    const lookup = vi
      .spyOn(dns, "lookup")
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }] as Any)
      .mockResolvedValue([{ address: "169.254.169.254", family: 4 }] as Any);
    const response = await pinnedFetch(`http://rebind.example:${port}/`, {});
    expect(await response.text()).toBe("public content");
    expect(host).toBe(`rebind.example:${port}`);
    expect(lookup).toHaveBeenCalledOnce();
  });
  it("rejects mixed DNS answers, encoded metadata literals and resolution failure", async () => {
    const lookup = vi.spyOn(dns, "lookup").mockResolvedValue([
      { address: "8.8.8.8", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ] as Any);
    await expect(pinnedFetch("https://mixed.example", {})).rejects.toThrow("internal");
    await expect(pinnedFetch("http://2852039166", {})).rejects.toThrow("internal");
    lookup.mockRejectedValueOnce(Object.assign(new Error("not found"), { code: "ENOTFOUND" }));
    await expect(pinnedFetch("https://missing.example", {})).rejects.toThrow("not found");
  });
  it("bounds decoded compressed responses and retains legitimate no-body statuses", async () => {
    const port = await listen((req, res) => {
      if (req.url === "/empty") {
        res.writeHead(204);
        res.end();
        return;
      }
      res.setHeader("content-encoding", "gzip");
      res.end(gzipSync(Buffer.alloc(100_000, 65)));
    });
    await expect(
      readBoundedResponse(await pinnedFetch(`http://127.0.0.1:${port}/`, {}), 1000, "HTTP"),
    ).rejects.toThrow("1000-byte limit");
    expect((await pinnedFetch(`http://127.0.0.1:${port}/empty`, {})).status).toBe(204);
    const head = await pinnedFetch(`http://127.0.0.1:${port}/empty`, { method: "HEAD" });
    expect(await head.text()).toBe("");
  });
  it("refuses environment proxy routing when a pinned destination is required", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:1");
    vi.stubEnv("NO_PROXY", "");
    vi.stubEnv("no_proxy", "");
    await expect(pinnedFetch("https://proxy.example", {}, true)).rejects.toThrow(
      "environment proxies",
    );
    await expect(resolvePinnedAddresses("https://proxy.example")).rejects.toThrow(
      "environment proxies",
    );
  });
  it("preserves an administrator's explicit internal-host exception without opening other hosts", async () => {
    const policies = loadPolicies();
    vi.spyOn(await import("../../admin/policies"), "loadPolicies").mockReturnValue({
      ...policies,
      runtime: {
        ...policies.runtime,
        network: { ...policies.runtime.network, allowedInternalHosts: ["named.corp.internal"] },
      },
    });
    vi.spyOn(dns, "lookup").mockResolvedValue([{ address: "10.0.0.5", family: 4 }] as Any);
    await expect(resolvePinnedAddresses("https://named.corp.internal")).resolves.toEqual([
      { address: "10.0.0.5", family: 4 },
    ]);
    await expect(resolvePinnedAddresses("https://other.corp.internal")).rejects.toThrow(
      "Internal destination",
    );
  });
  it("honors cancellation while DNS is still pending", async () => {
    vi.spyOn(dns, "lookup").mockImplementation(() => new Promise(() => {}) as Any);
    const controller = new AbortController();
    const pending = pinnedFetch("https://slow.example", { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
