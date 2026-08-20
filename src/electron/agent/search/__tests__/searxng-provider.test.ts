import { createServer } from "http";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../security/network-policy", () => ({
  assertNetworkPolicyAllowed: vi.fn(),
}));

import { assertNetworkPolicyAllowed } from "../../../security/network-policy";
import { SearXngProvider } from "../searxng-provider";

describe("SearXngProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("requires explicit opt-in for private and local instances", () => {
    expect(
      () =>
        new SearXngProvider({
          type: "searxng",
          searxngBaseUrl: "http://localhost:8080",
        }),
    ).toThrow("private/local instance access is disabled");
  });

  it("recognizes canonicalized IPv4-mapped IPv6 loopback addresses as private", () => {
    expect(
      () =>
        new SearXngProvider({
          type: "searxng",
          searxngBaseUrl: "https://[::ffff:127.0.0.1]",
        }),
    ).toThrow("private/local instance access is disabled");
  });

  it("rejects insecure public instances even when private access is enabled", () => {
    expect(
      () =>
        new SearXngProvider({
          type: "searxng",
          searxngBaseUrl: "http://8.8.8.8",
          searxngAllowPrivate: true,
        }),
    ).toThrow("must use HTTPS");
  });

  it("allows an opted-in HTTP hostname to proceed to pinned private-DNS validation", () => {
    expect(
      () =>
        new SearXngProvider({
          type: "searxng",
          searxngBaseUrl: "http://searxng.internal",
          searxngAllowPrivate: true,
        }),
    ).not.toThrow();
  });

  it("maps valid JSON results and forwards language, region and safe-search filters", async () => {
    const provider = new SearXngProvider({
      type: "searxng",
      searxngBaseUrl: "http://localhost:8080/",
      searxngAllowPrivate: true,
    });
    const requestSpy = vi.spyOn(provider as Any, "request").mockResolvedValue({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        number_of_results: 42,
        results: [
          {
            title: "Example result",
            url: "https://example.com/article",
            content: "Relevant source snippet",
            publishedDate: "2026-08-20T10:00:00Z",
            engines: ["brave", "bing"],
            img_src: "https://example.com/image.jpg",
          },
          { title: "Unsafe scheme", url: "javascript:alert(1)" },
          { title: "Missing URL" },
        ],
      }),
    });

    const response = await provider.search({
      query: "example query",
      searchType: "news",
      maxResults: 3,
      dateRange: "week",
      region: "tr",
      safeSearch: true,
    });

    const body = String(requestSpy.mock.calls[0][0]);
    expect(body).toContain("categories=news");
    expect(body).toContain("time_range=week");
    expect(body).toContain("language=tr-TR");
    expect(body).toContain("safesearch=1");
    expect(response.results).toEqual([
      expect.objectContaining({
        title: "Example result",
        url: "https://example.com/article",
        source: "brave, bing",
      }),
    ]);
  });

  it("lets an explicit language override the region-derived locale", async () => {
    const provider = new SearXngProvider({
      type: "searxng",
      searxngBaseUrl: "http://localhost:8080",
      searxngAllowPrivate: true,
    });
    const requestSpy = vi.spyOn(provider as Any, "request").mockResolvedValue({
      status: 200,
      contentType: "application/json",
      body: '{"results":[]}',
    });

    await provider.search({ query: "test", region: "tr", language: "de-DE" });

    expect(String(requestSpy.mock.calls[0][0])).toContain("language=de-DE");
  });

  it("enforces workspace allowlists and blocked domains on the endpoint", async () => {
    const provider = new SearXngProvider({
      type: "searxng",
      searxngBaseUrl: "https://search.example.com",
    });
    const requestSpy = vi.spyOn(provider as Any, "request");

    await expect(
      provider.search({
        query: "private query",
        endpointDomainPolicy: { allowedDomains: ["approved.example"], blockedDomains: [] },
      }),
    ).rejects.toThrow("not in the workspace network allowlist");
    await expect(
      provider.search({
        query: "private query",
        endpointDomainPolicy: {
          allowedDomains: ["search.example.com"],
          blockedDomains: ["search.example.com"],
        },
      }),
    ).rejects.toThrow("denied by workspace network policy");
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it("also applies the global network policy before transport", async () => {
    vi.mocked(assertNetworkPolicyAllowed).mockImplementationOnce(() => {
      throw new Error("Network access denied: blocked_domain");
    });
    const provider = new SearXngProvider({
      type: "searxng",
      searxngBaseUrl: "https://search.example.com",
    });
    const requestSpy = vi.spyOn(provider as Any, "request");

    await expect(provider.search({ query: "private query" })).rejects.toThrow(
      "Network access denied",
    );
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it("rejects redirects instead of following them", async () => {
    const provider = new SearXngProvider({
      type: "searxng",
      searxngBaseUrl: "http://localhost:8080",
      searxngAllowPrivate: true,
    });
    vi.spyOn(provider as Any, "request").mockResolvedValue({
      status: 302,
      contentType: "text/html",
      body: "redirect",
    });

    await expect(provider.search({ query: "test" })).rejects.toThrow("redirects are not allowed");
  });

  it("bounds response bodies before buffering them", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(2 * 1024 * 1024 + 1),
      });
      response.end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP server address");

    try {
      const provider = new SearXngProvider({
        type: "searxng",
        searxngBaseUrl: `http://127.0.0.1:${address.port}`,
        searxngAllowPrivate: true,
      });
      await expect(provider.search({ query: "test" })).rejects.toThrow("2 MiB size limit");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("explains when JSON output is disabled on the instance", async () => {
    const provider = new SearXngProvider({
      type: "searxng",
      searxngBaseUrl: "http://localhost:8080",
      searxngAllowPrivate: true,
    });
    vi.spyOn(provider as Any, "request").mockResolvedValue({
      status: 200,
      contentType: "text/html",
      body: "not json",
    });

    await expect(provider.search({ query: "test" })).rejects.toThrow("Enable the json format");
  });
});
