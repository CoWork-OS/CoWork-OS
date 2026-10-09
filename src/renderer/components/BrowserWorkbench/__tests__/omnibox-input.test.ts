import { describe, expect, it } from "vitest";
import {
  buildOmniboxSuggestions,
  buildSearchUrl,
  displayUrl,
  parseOmniboxInput,
  securityStateFor,
} from "../omnibox-input";
import { stepZoomLevel, zoomLevelToPercent } from "../browser-zoom";

describe("omnibox input", () => {
  it("navigates to URL-looking input and searches everything else", () => {
    expect(parseOmniboxInput("example.com")).toEqual({ kind: "url", url: "https://example.com/" });
    expect(parseOmniboxInput("docs.example.co.uk/a?b=1")).toEqual({
      kind: "url",
      url: "https://docs.example.co.uk/a?b=1",
    });
    expect(parseOmniboxInput("localhost:5173")).toEqual({
      kind: "url",
      url: "http://localhost:5173/",
    });
    expect(parseOmniboxInput("127.0.0.1:8080/x")).toEqual({
      kind: "url",
      url: "http://127.0.0.1:8080/x",
    });
    expect(parseOmniboxInput("http://example.com/path")).toEqual({
      kind: "url",
      url: "http://example.com/path",
    });
    expect(parseOmniboxInput("münchen.de").kind).toBe("url");

    expect(parseOmniboxInput("weather tomorrow")).toEqual({
      kind: "search",
      query: "weather tomorrow",
      url: "https://www.google.com/search?q=weather%20tomorrow",
    });
    expect(parseOmniboxInput("react").kind).toBe("search");
    expect(parseOmniboxInput("999.1.1.1").kind).toBe("search");
    expect(parseOmniboxInput("   ")).toEqual({ kind: "empty" });
  });

  it("refuses script and local schemes", () => {
    expect(parseOmniboxInput("javascript:alert(1)")).toEqual({
      kind: "unsupported",
      scheme: "javascript",
    });
    expect(parseOmniboxInput("file:///etc/passwd")).toEqual({
      kind: "unsupported",
      scheme: "file",
    });
    expect(parseOmniboxInput("mailto:a@b.c")).toEqual({ kind: "unsupported", scheme: "mailto" });
  });

  it("builds search URLs for each engine", () => {
    expect(buildSearchUrl("a b&c", "duckduckgo")).toBe("https://duckduckgo.com/?q=a%20b%26c");
    expect(buildSearchUrl("x", "kagi")).toBe("https://kagi.com/search?q=x");
  });

  it("suggests open tabs and recent pages, with the search first for queries", () => {
    const source = {
      tabs: [{ id: "t1", url: "https://github.com/cowork", title: "CoWork on GitHub" }],
      pages: [
        { url: "https://docs.github.com/", title: "GitHub Docs" },
        { url: "https://example.com/", title: "Example" },
      ],
    };
    const forQuery = buildOmniboxSuggestions("git", source);
    expect(forQuery.map((entry) => entry.kind)).toEqual(["search", "switch-tab", "page"]);
    expect(forQuery[1]).toMatchObject({ kind: "switch-tab", tabId: "t1" });

    const forUrl = buildOmniboxSuggestions("example.com", source);
    expect(forUrl[0]).toMatchObject({ kind: "navigate", url: "https://example.com/" });
    expect(forUrl.at(-1)?.kind).toBe("search");
    expect(buildOmniboxSuggestions("", source)).toEqual([]);
  });

  it("labels security state and shows a short address", () => {
    expect(securityStateFor("https://a.com")).toBe("secure");
    expect(securityStateFor("http://a.com")).toBe("insecure");
    expect(securityStateFor("http://localhost:5173/")).toBe("local");
    expect(securityStateFor("")).toBe("none");
    expect(displayUrl("https://www.example.com/")).toBe("example.com");
    expect(displayUrl("https://example.com/a?b=1")).toBe("example.com/a?b=1");
  });
});

describe("browser zoom steps", () => {
  it("steps through Chrome's zoom levels", () => {
    expect(zoomLevelToPercent(0)).toBe(100);
    expect(zoomLevelToPercent(stepZoomLevel(0, 1))).toBe(110);
    expect(zoomLevelToPercent(stepZoomLevel(0, -1))).toBe(90);
    expect(zoomLevelToPercent(stepZoomLevel(stepZoomLevel(0, 1), 1))).toBe(125);
  });
});
