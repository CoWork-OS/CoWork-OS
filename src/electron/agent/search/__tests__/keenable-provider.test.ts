import { afterEach, describe, expect, it, vi } from "vitest";
import { KeenableProvider } from "../keenable-provider";

function okResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as Response;
}

describe("KeenableProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("searches the keyless endpoint with an app title and maps results", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      okResponse({
        query: "example query",
        mode: "pro",
        results: [
          {
            title: "Example title",
            url: "https://example.com/post",
            description: "",
            snippet: "  Useful snippet  ",
            published_at: "2026-10-30T00:00:00Z",
          },
          { title: "No URL", snippet: "dropped" },
        ],
      }),
    );

    const response = await new KeenableProvider({ type: "keenable" }).search({
      query: "example query",
      maxResults: 3,
      dateRange: "week",
    });

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.keenable.ai/v1/search/public");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({
      "Content-Type": "application/json",
      "X-Keenable-Title": "CoWork OS",
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      query: "example query",
      max_results: 3,
      snippet_max_length: 400,
      published_after: "7d",
    });
    expect(response).toMatchObject({ provider: "keenable", searchType: "web", totalResults: 2 });
    expect(response.results).toEqual([
      {
        title: "Example title",
        url: "https://example.com/post",
        snippet: "Useful snippet",
        publishedDate: "2026-10-30T00:00:00Z",
      },
    ]);
  });

  it("uses the keyed endpoint and X-API-Key when a key is set", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse({ results: [] }));

    await new KeenableProvider({ type: "keenable", keenableApiKey: " keen_test " }).search({
      query: "q",
      maxResults: 500,
    });

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.keenable.ai/v1/search");
    expect(init?.headers).toEqual({
      "Content-Type": "application/json",
      "X-API-Key": "keen_test",
    });
    expect(JSON.parse(String(init?.body)).max_results).toBe(50);
  });

  it("reports API errors with the status", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "rate limited",
    } as Response);

    await expect(new KeenableProvider({ type: "keenable" }).search({ query: "q" })).rejects.toThrow(
      "Keenable API error: 429 - rate limited",
    );
  });

  it("rejects unsupported search types without a request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(
      new KeenableProvider({ type: "keenable" }).search({ query: "q", searchType: "images" }),
    ).rejects.toThrow("Keenable does not support images search");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("is blocked when the workspace has network off", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(
      new KeenableProvider({ type: "keenable" }).search({ query: "q", networkEnabled: false }),
    ).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
