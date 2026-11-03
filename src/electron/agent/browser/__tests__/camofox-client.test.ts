import { describe, expect, it, vi } from "vitest";
import {
  CamofoxApiError,
  CamofoxClient,
  CAMOFOX_MAX_BODY_BYTES,
  CAMOFOX_MAX_COOKIES_PER_REQUEST,
  batchCookies,
  isCamofoxTabGone,
  type CamofoxCookie,
} from "../camofox-client";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function client(fetchImpl: typeof fetch, keys: { accessKey?: string; apiKey?: string } = {}) {
  return new CamofoxClient({ origin: "http://127.0.0.1:9377", fetchImpl, ...keys });
}

describe("CamofoxClient", () => {
  it("sends the access key as a bearer token and never follows redirects", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ tabId: "t1", url: "https://example.com/" }));
    const result = await client(fetchImpl as unknown as typeof fetch, {
      accessKey: "access-key",
    }).createTab("u1", "s1", "https://example.com/");
    expect(result.tabId).toBe("t1");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:9377/tabs");
    expect(init.redirect).toBe("error");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer access-key");
    expect(JSON.parse(String(init.body))).toEqual({
      userId: "u1",
      sessionKey: "s1",
      url: "https://example.com/",
    });
  });

  it("uses the API key for cookie import and batches by count and body size", async () => {
    const calls: Array<{ auth?: string; count: number; bytes: number }> = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = String(init.body);
      const parsed = JSON.parse(body) as { cookies: unknown[] };
      calls.push({
        auth: (init.headers as Record<string, string>).Authorization,
        count: parsed.cookies.length,
        bytes: Buffer.byteLength(body),
      });
      return jsonResponse({ ok: true, count: parsed.cookies.length });
    });
    const cookies: CamofoxCookie[] = Array.from({ length: 1200 }, (_, i) => ({
      name: `c${i}`,
      value: "v".repeat(100),
      domain: ".example.com",
      path: "/",
    }));
    const imported = await client(fetchImpl as unknown as typeof fetch, {
      accessKey: "access",
      apiKey: "api",
    }).importCookies("u1", cookies);
    expect(imported).toBe(1200);
    expect(calls.every((call) => call.auth === "Bearer api")).toBe(true);
    expect(calls.every((call) => call.count <= CAMOFOX_MAX_COOKIES_PER_REQUEST)).toBe(true);
    expect(calls.every((call) => call.bytes <= CAMOFOX_MAX_BODY_BYTES)).toBe(true);
  });

  it("maps Camofox error bodies and redacts keys from messages", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        {
          error: "Tab was destroyed for secret-access-key. Open a new tab.",
          code: "tab_destroyed",
          retryable: true,
        },
        410,
      ),
    );
    const error = await client(fetchImpl as unknown as typeof fetch, {
      accessKey: "secret-access-key",
    })
      .click("u1", "t1", { ref: "e1" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CamofoxApiError);
    expect((error as CamofoxApiError).message).not.toContain("secret-access-key");
    expect((error as CamofoxApiError).code).toBe("tab_destroyed");
    expect(isCamofoxTabGone(error)).toBe(true);
  });

  it("redacts a key that the 400-character cut would split", async () => {
    const key = "k".repeat(40);
    const fetchImpl = vi.fn(async () => jsonResponse({ error: `${"x".repeat(380)}${key}` }, 500));
    const error = await client(fetchImpl as unknown as typeof fetch, { accessKey: key })
      .listTabs("u1")
      .catch((e: unknown) => e);
    expect((error as Error).message).not.toContain("k".repeat(20));
  });

  it("does not pass Camofox's cookie-import error text on", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: "Invalid cookie sid=super-secret-value" }, 400),
    );
    const error = await client(fetchImpl as unknown as typeof fetch, { apiKey: "api" })
      .importCookies("u1", [
        { name: "sid", value: "super-secret-value", domain: "a.test", path: "/" },
      ])
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CamofoxApiError);
    expect((error as Error).message).toBe("Camofox did not accept the saved cookies (HTTP 400).");
  });

  it("explains a 401 and an unreachable server without leaking the token", async () => {
    const unauthorized = await client((async () =>
      jsonResponse({ error: "Unauthorized" }, 401)) as unknown as typeof fetch)
      .health()
      .catch((e: unknown) => e);
    expect((unauthorized as Error).message).toMatch(/access key/);

    const unreachable = await client((async () => {
      throw new Error("connect ECONNREFUSED Bearer abc.def");
    }) as unknown as typeof fetch)
      .health()
      .catch((e: unknown) => e);
    expect((unreachable as CamofoxApiError).code).toBe("unreachable");
    expect((unreachable as Error).message).not.toContain("abc.def");
  });

  it("reads screenshots as PNG bytes and rejects other content", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const ok = client(
      (async () =>
        new Response(png, { headers: { "content-type": "image/png" } })) as unknown as typeof fetch,
    );
    expect(Buffer.compare(await ok.screenshot("u1", "t1", false), png)).toBe(0);
    const bad = client((async () => jsonResponse({ screenshot: {} })) as unknown as typeof fetch);
    await expect(bad.screenshot("u1", "t1", false)).rejects.toThrow(/not a PNG/);
  });

  it("refuses oversized responses", async () => {
    const big = client(
      (async () =>
        new Response("x", {
          headers: {
            "content-type": "application/json",
            "content-length": String(64 * 1024 * 1024),
          },
        })) as unknown as typeof fetch,
    );
    await expect(big.listTabs("u1")).rejects.toThrow(/too large/);
  });
});

describe("batchCookies", () => {
  it("drops a single cookie too large for any request", () => {
    const batches = batchCookies([
      { name: "big", value: "x".repeat(CAMOFOX_MAX_BODY_BYTES), domain: "a.test", path: "/" },
      { name: "ok", value: "1", domain: "a.test", path: "/" },
    ]);
    expect(batches).toEqual([[{ name: "ok", value: "1", domain: "a.test", path: "/" }]]);
  });
});
