import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BrowserUseCloudClient,
  BrowserUseApiError,
  isPrivateOrLocalBrowserTarget,
  normalizeBrowserUseProxyCountryCode,
  normalizeBrowserUseTimeoutMinutes,
  parseRetryAfterMs,
  redactBrowserUseErrorText,
  redactBrowserUseUrl,
} from "../browser-use-cloud-client";

describe("BrowserUseCloudClient", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("creates browser sessions with the Browser Use API key header", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "browser-session-1",
          cdpUrl: "https://cdp.browser-use.example/session",
          liveUrl: "https://live.browser-use.example/session",
        }),
        { status: 200 },
      ),
    );
    const client = new BrowserUseCloudClient("test-key", {
      baseUrl: "https://api.test/api/v3",
      fetchImpl: fetchImpl as Any,
    });

    const session = await client.createBrowserSession({
      proxyCountryCode: "us",
      timeout: 15,
      enableRecording: true,
    });

    expect(session.id).toBe("browser-session-1");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.test/api/v3/browsers",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "X-Browser-Use-API-Key": "test-key",
        }),
        body: JSON.stringify({
          proxyCountryCode: "us",
          timeout: 15,
          enableRecording: true,
        }),
      }),
    );
  });

  it("uses the Browser Use V4 API by default", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: "browser-session-1" }), { status: 201 }),
      );
    const client = new BrowserUseCloudClient("test-key", { fetchImpl: fetchImpl as Any });

    await client.createBrowserSession({ proxyCountryCode: "us" });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.browser-use.com/api/v4/browsers",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("stops browser sessions through the V4 patch action", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "browser-session-1", status: "stopped" }), {
        status: 200,
      }),
    );
    const client = new BrowserUseCloudClient("test-key", {
      baseUrl: "https://api.test/api/v4",
      fetchImpl: fetchImpl as Any,
    });

    await client.stopBrowserSession("browser-session-1");

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.test/api/v4/browsers/browser-session-1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ action: "stop" }),
      }),
    );
  });

  it("retries provider rate limits and honors Retry-After", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("busy", { status: 429, headers: { "Retry-After": "3" } }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "browser-session-1" }), { status: 201 }),
      );
    const sleep = vi.fn().mockResolvedValue(undefined);
    const client = new BrowserUseCloudClient("test-key", {
      fetchImpl: fetchImpl as Any,
      sleep,
      maxRetries: 2,
    });

    const session = await client.createBrowserSession({});

    expect(session.id).toBe("browser-session-1");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(3000);
  });

  it("returns a structured retryable error after exhausting provider retries", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('{"message":"temporarily unavailable"}', { status: 503 }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const client = new BrowserUseCloudClient("test-key", {
      fetchImpl: fetchImpl as Any,
      sleep,
      maxRetries: 2,
    });

    await expect(client.stopBrowserSession("browser-session-1")).rejects.toMatchObject<
      Partial<BrowserUseApiError>
    >({
      name: "BrowserUseApiError",
      status: 503,
      retryable: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("does not retry non-retryable authentication failures", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const client = new BrowserUseCloudClient("test-key", {
      fetchImpl: fetchImpl as Any,
      sleep,
    });

    await expect(client.createBrowserSession({})).rejects.toMatchObject({ status: 401 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("parses rate-limit reset headers when Retry-After is absent", () => {
    const headers = new Headers({ "x-ratelimit-reset": "4" });
    expect(parseRetryAfterMs(headers)).toBe(4000);
  });

  it("parses absolute rate-limit reset timestamps", () => {
    const now = 1_700_000_000_000;
    const headers = new Headers({ "x-ratelimit-reset": "1700000004" });
    expect(parseRetryAfterMs(headers, now)).toBe(4000);
  });

  it("normalizes Browser Use option inputs", () => {
    expect(normalizeBrowserUseProxyCountryCode("US")).toBe("us");
    expect(normalizeBrowserUseProxyCountryCode(null)).toBeNull();
    expect(normalizeBrowserUseProxyCountryCode("none")).toBeNull();
    expect(normalizeBrowserUseTimeoutMinutes(999)).toBe(240);
    expect(normalizeBrowserUseTimeoutMinutes(0, 12)).toBe(1);
    expect(() => normalizeBrowserUseProxyCountryCode("usa")).toThrow("two-letter country code");
  });

  it("detects local and private browser targets", () => {
    expect(isPrivateOrLocalBrowserTarget("http://localhost:5173")).toBe(true);
    expect(isPrivateOrLocalBrowserTarget("http://127.0.0.1:9222")).toBe(true);
    expect(isPrivateOrLocalBrowserTarget("https://10.1.2.3")).toBe(true);
    expect(isPrivateOrLocalBrowserTarget("https://172.16.0.8")).toBe(true);
    expect(isPrivateOrLocalBrowserTarget("https://192.168.1.20")).toBe(true);
    expect(isPrivateOrLocalBrowserTarget("https://[fd00::1]")).toBe(true);
    expect(isPrivateOrLocalBrowserTarget("https://printer.local")).toBe(true);
    expect(isPrivateOrLocalBrowserTarget("https://intranet")).toBe(true);
    expect(isPrivateOrLocalBrowserTarget("file:///tmp/index.html")).toBe(true);
    expect(isPrivateOrLocalBrowserTarget("https://example.com")).toBe(false);
  });

  it("redacts sensitive query values from Browser Use URLs", () => {
    expect(redactBrowserUseUrl("wss://connect.browser-use.com?apiKey=secret&wss=value")).toBe(
      "wss://connect.browser-use.com?apiKey=[REDACTED]&wss=[REDACTED]",
    );
  });

  it("redacts secret-looking Browser Use API error text", () => {
    expect(
      redactBrowserUseErrorText(
        'apiKey=secret-token Authorization: Bearer bearer-secret {"X-Browser-Use-API-Key":"secret"}',
      ),
    ).not.toContain("secret");
  });

  it("honors disabled encrypted settings while allowing env override", () => {
    expect(BrowserUseCloudClient.resolveApiKey({ enabled: false, apiKey: "stored-key" })).toBe("");
    vi.stubEnv("BROWSER_USE_API_KEY", "env-key");
    expect(BrowserUseCloudClient.resolveApiKey({ enabled: false, apiKey: "stored-key" })).toBe(
      "env-key",
    );
  });
});
