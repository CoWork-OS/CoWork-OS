import { describe, expect, it, beforeEach } from "vitest";
import { CitationTracker } from "../CitationTracker";

describe("CitationTracker", () => {
  let tracker: CitationTracker;

  beforeEach(() => {
    tracker = new CitationTracker("task-abc");
  });

  // ── addFromSearch ──────────────────────────────────────────────

  it("tracks citations from search results", () => {
    tracker.addFromSearch([
      { title: "Page A", url: "https://example.com/a", snippet: "Snippet A" },
      { title: "Page B", url: "https://example.com/b", snippet: "Snippet B" },
    ]);

    expect(tracker.count).toBe(2);
    const citations = tracker.getCitations();
    expect(citations[0].index).toBe(1);
    expect(citations[0].title).toBe("Page A");
    expect(citations[0].domain).toBe("example.com");
    expect(citations[0].sourceTool).toBe("web_search");
    expect(citations[1].index).toBe(2);
  });

  it("deduplicates by URL (case-insensitive, trailing-slash-normalized)", () => {
    tracker.addFromSearch([{ title: "First", url: "https://Example.com/page/" }]);
    tracker.addFromSearch([{ title: "Duplicate", url: "https://example.com/page" }]);

    expect(tracker.count).toBe(1);
    expect(tracker.getCitations()[0].title).toBe("First");
  });

  it("skips entries without a URL", () => {
    tracker.addFromSearch([{ title: "No URL" }, { title: "Has URL", url: "https://example.com" }]);

    expect(tracker.count).toBe(1);
  });

  it("handles non-array input gracefully", () => {
    tracker.addFromSearch(null as any);
    tracker.addFromSearch(undefined as any);
    expect(tracker.count).toBe(0);
  });

  // ── addFromFetch ───────────────────────────────────────────────

  it("tracks citations from fetch calls", () => {
    tracker.addFromFetch("https://docs.example.com/api", "API Docs");

    expect(tracker.count).toBe(1);
    const c = tracker.getCitations()[0];
    expect(c.title).toBe("API Docs");
    expect(c.sourceTool).toBe("web_fetch");
    expect(c.domain).toBe("docs.example.com");
  });

  it("uses domain as title fallback when title is missing", () => {
    tracker.addFromFetch("https://www.example.com/page");

    expect(tracker.getCitations()[0].title).toBe("example.com");
  });

  it("ignores empty URL", () => {
    tracker.addFromFetch("");
    expect(tracker.count).toBe(0);
  });

  // ── getBundle ──────────────────────────────────────────────────

  it("returns a bundle with taskId and citations", () => {
    tracker.addFromFetch("https://example.com", "Example");
    const bundle = tracker.getBundle();

    expect(bundle.taskId).toBe("task-abc");
    expect(bundle.citations).toHaveLength(1);
  });

  // ── formatForPrompt ────────────────────────────────────────────

  it("returns empty string when no citations", () => {
    expect(tracker.formatForPrompt()).toBe("");
  });

  it("formats citations as numbered source list", () => {
    tracker.addFromSearch([
      { title: "Page A", url: "https://a.com/x", snippet: "S" },
      { title: "Page B", url: "https://b.com/y", snippet: "S" },
    ]);

    const formatted = tracker.formatForPrompt();
    expect(formatted).toContain("## Sources Collected So Far");
    expect(formatted).toContain("[1] Page A — a.com (https://a.com/x)");
    expect(formatted).toContain("[2] Page B — b.com (https://b.com/y)");
    expect(formatted).toContain("[N] notation");
  });

  // ── getCitations returns a copy ────────────────────────────────

  it("getCitations returns a defensive copy", () => {
    tracker.addFromFetch("https://example.com", "E");
    const citations = tracker.getCitations();
    citations.push({} as any);
    expect(tracker.count).toBe(1);
  });

  // ── domain extraction ──────────────────────────────────────────

  it("strips www. prefix from domains", () => {
    tracker.addFromFetch("https://www.example.com/path");
    expect(tracker.getCitations()[0].domain).toBe("example.com");
  });

  it("handles invalid URLs gracefully for domain extraction", () => {
    tracker.addFromFetch("not-a-url", "Fallback");
    expect(tracker.getCitations()[0].domain).toBe("not-a-url");
  });

  // ── sequential index assignment ────────────────────────────────

  it("assigns sequential indices across mixed add calls", () => {
    tracker.addFromSearch([{ title: "A", url: "https://a.com" }]);
    tracker.addFromFetch("https://b.com", "B");
    tracker.addFromSearch([{ title: "C", url: "https://c.com" }]);

    const indices = tracker.getCitations().map((c) => c.index);
    expect(indices).toEqual([1, 2, 3]);
  });
});
