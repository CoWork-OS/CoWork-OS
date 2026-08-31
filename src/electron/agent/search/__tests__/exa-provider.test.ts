import { afterEach, describe, expect, it, vi } from "vitest";
import { ExaProvider } from "../exa-provider";

describe("ExaProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps Exa search results into shared search results", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          {
            title: "Example title",
            url: "https://example.com/post",
            publishedDate: "2026-03-30T12:00:00.000Z",
            author: "Example Author",
            highlights: ["Useful highlighted snippet"],
            text: "Longer page text",
          },
        ],
      }),
    } as Response);

    const provider = new ExaProvider({ type: "exa", exaApiKey: "exa-test-key" });
    const response = await provider.search({
      query: "example query",
      searchType: "news",
      maxResults: 3,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(response.provider).toBe("exa");
    expect(response.searchType).toBe("news");
    expect(response.results).toEqual([
      {
        title: "Example title",
        url: "https://example.com/post",
        snippet: "Useful highlighted snippet",
        publishedDate: "2026-03-30T12:00:00.000Z",
        source: "Example Author",
      },
    ]);
  });

  it("rejects unsupported image searches", async () => {
    const provider = new ExaProvider({ type: "exa", exaApiKey: "exa-test-key" });

    await expect(provider.search({ query: "snow leopard", searchType: "images" })).rejects.toThrow(
      "Exa does not support images search",
    );
  });
});
