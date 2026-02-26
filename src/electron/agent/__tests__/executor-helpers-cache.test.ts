import { describe, expect, it } from "vitest";
import { FileOperationTracker, ToolCallDeduplicator, ToolFailureTracker } from "../executor-helpers";

describe("ToolCallDeduplicator read-history invalidation", () => {
  it("clears read/list duplicate history while preserving write history", () => {
    const dedupe = new ToolCallDeduplicator(2, 60_000, 4, 20);

    dedupe.recordCall("read_file", { path: "doc.md" }, '{"content":"a"}');
    dedupe.recordCall("read_file", { path: "doc.md" }, '{"content":"a"}');
    dedupe.recordCall("write_file", { path: "doc.md", content: "x" }, '{"success":true}');
    dedupe.recordCall("write_file", { path: "doc.md", content: "x" }, '{"success":true}');

    expect(dedupe.checkDuplicate("read_file", { path: "doc.md" }).isDuplicate).toBe(true);
    expect(dedupe.checkDuplicate("write_file", { path: "doc.md", content: "x" }).isDuplicate).toBe(
      true,
    );

    dedupe.clearReadOnlyHistory();

    expect(dedupe.checkDuplicate("read_file", { path: "doc.md" }).isDuplicate).toBe(false);
    expect(dedupe.checkDuplicate("write_file", { path: "doc.md", content: "x" }).isDuplicate).toBe(
      true,
    );
  });

  it("treats browser_navigate URLs that differ only by tracking params as semantic duplicates", () => {
    const dedupe = new ToolCallDeduplicator(2, 60_000, 2, 20);

    dedupe.recordCall("browser_navigate", {
      url: "https://example.com/news?utm_source=twitter",
    });
    dedupe.recordCall("browser_navigate", {
      url: "https://example.com/news?utm_source=linkedin&utm_medium=social",
    });

    const duplicate = dedupe.checkDuplicate("browser_navigate", {
      url: "https://example.com/news?utm_campaign=test",
    });
    expect(duplicate.isDuplicate).toBe(true);
  });

  it("does not treat distinct browser_navigate business queries as semantic duplicates", () => {
    const dedupe = new ToolCallDeduplicator(2, 60_000, 2, 20);

    dedupe.recordCall("browser_navigate", { url: "https://example.com/news?page=1" });
    dedupe.recordCall("browser_navigate", { url: "https://example.com/news?page=2" });

    const duplicate = dedupe.checkDuplicate("browser_navigate", {
      url: "https://example.com/news?page=3",
    });
    expect(duplicate.isDuplicate).toBe(false);
  });
});

describe("FileOperationTracker cache invalidation", () => {
  it("invalidates read cache for a modified file", () => {
    const tracker = new FileOperationTracker();

    tracker.recordFileRead("NexusChain-Whitepaper.md", "one");
    tracker.recordFileRead("NexusChain-Whitepaper.md", "two");

    expect(tracker.checkFileRead("NexusChain-Whitepaper.md").blocked).toBe(true);

    tracker.invalidateFileRead("NexusChain-Whitepaper.md");

    expect(tracker.checkFileRead("NexusChain-Whitepaper.md").blocked).toBe(false);
  });

  it("invalidates directory listing cache after filesystem changes", () => {
    const tracker = new FileOperationTracker();

    tracker.recordDirectoryListing("research", ["01-state-of-the-art-research.md"]);
    tracker.recordDirectoryListing("research", ["01-state-of-the-art-research.md"]);

    expect(tracker.checkDirectoryListing("research").blocked).toBe(true);

    tracker.invalidateDirectoryListing("research");

    expect(tracker.checkDirectoryListing("research").blocked).toBe(false);
  });
});

describe("ToolFailureTracker browser HTTP status handling", () => {
  it("treats browser HTTP status failures as input-dependent (no immediate disable)", () => {
    const tracker = new ToolFailureTracker();

    for (let i = 0; i < 5; i++) {
      expect(tracker.recordFailure("browser_navigate", "Navigation failed with HTTP 403")).toBe(
        false,
      );
    }
    expect(tracker.isDisabled("browser_navigate")).toBe(false);

    expect(tracker.recordFailure("browser_navigate", "Navigation failed with HTTP 403")).toBe(
      true,
    );
    expect(tracker.isDisabled("browser_navigate")).toBe(true);
  });

  it("still immediately disables non-browser non-retryable failures", () => {
    const tracker = new ToolFailureTracker();

    expect(tracker.recordFailure("web_fetch", "HTTP 429 rate limit exceeded")).toBe(true);
    expect(tracker.isDisabled("web_fetch")).toBe(true);
  });
});
