import { describe, expect, it } from "vitest";
import { FileOperationTracker, ToolCallDeduplicator, ToolFailureTracker } from "../executor-helpers";
import { TaskExecutor } from "../executor";

describe("ToolCallDeduplicator read-history invalidation", () => {
  it("does not dedupe repeated screenshot calls", () => {
    const dedupe = new ToolCallDeduplicator(2, 60_000, 2, 20);

    dedupe.recordCall("screenshot", { app: "Calculator" }, '{"captureId":"cap_1"}');
    dedupe.recordCall("screenshot", { app: "Calculator" }, '{"captureId":"cap_2"}');

    expect(dedupe.checkDuplicate("screenshot", { app: "Calculator" })).toEqual(
      expect.objectContaining({ isDuplicate: false }),
    );
  });

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

  it("allows higher per-minute throughput for read-only cloud action pagination", () => {
    const dedupe = new ToolCallDeduplicator(2, 60_000, 2, 20);

    for (let i = 0; i < 20; i++) {
      dedupe.recordCall("box_action", {
        action: "list_folder_items",
        folder_id: "0",
        offset: i * 100,
      });
    }

    const nextPageCall = dedupe.checkDuplicate("box_action", {
      action: "list_folder_items",
      folder_id: "0",
      offset: 2000,
    });
    expect(nextPageCall.isDuplicate).toBe(false);
  });

  it("keeps strict rate limit for mutating cloud actions", () => {
    const dedupe = new ToolCallDeduplicator(2, 60_000, 2, 20);

    for (let i = 0; i < 20; i++) {
      dedupe.recordCall("box_action", {
        action: "create_folder",
        parent_id: "0",
        name: `temp-${i}`,
      });
    }

    const createCall = dedupe.checkDuplicate("box_action", {
      action: "create_folder",
      parent_id: "0",
      name: "temp-over-limit",
    });
    expect(createCall.isDuplicate).toBe(true);
    expect(createCall.reason || "").toContain("Rate limit exceeded");
  });

  it("resets mutation duplicate history per step while preserving read duplicates", () => {
    const dedupe = new ToolCallDeduplicator(2, 60_000, 4, 20);

    dedupe.recordCall("read_file", { path: "styles.css" }, '{"content":"..."}');
    dedupe.recordCall("read_file", { path: "styles.css" }, '{"content":"..."}');
    dedupe.recordCall("write_file", { path: "styles.css", content: "a" }, '{"success":true}');
    dedupe.recordCall("write_file", { path: "styles.css", content: "a" }, '{"success":true}');

    expect(dedupe.checkDuplicate("read_file", { path: "styles.css" }).isDuplicate).toBe(true);
    expect(dedupe.checkDuplicate("write_file", { path: "styles.css", content: "a" }).isDuplicate).toBe(
      true,
    );

    dedupe.resetMutationHistoryForNewStep();

    expect(dedupe.checkDuplicate("read_file", { path: "styles.css" }).isDuplicate).toBe(true);
    expect(dedupe.checkDuplicate("write_file", { path: "styles.css", content: "a" }).isDuplicate).toBe(
      false,
    );
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

  it("tracks created files per full path without collapsing different extensions", () => {
    const tracker = new FileOperationTracker();

    tracker.recordFileCreation("deliverables/report.csv");
    tracker.recordFileCreation("deliverables/report.json");

    expect(tracker.getCreatedFiles()).toEqual(
      expect.arrayContaining(["deliverables/report.csv", "deliverables/report.json"]),
    );
    expect(tracker.getCreatedFiles()).toHaveLength(2);
  });

  it("does not flag rewriting the same file path as a duplicate creation", () => {
    const tracker = new FileOperationTracker();

    tracker.recordFileCreation("deliverables/report.md");

    expect(tracker.checkFileCreation("deliverables/report.md")).toEqual(
      expect.objectContaining({ isDuplicate: false }),
    );
  });

  it("blocks duplicate file creation within the same tool batch", () => {
    const fakeThis: Any = Object.create(TaskExecutor.prototype);
    fakeThis.fileOperationTracker = new FileOperationTracker();
    fakeThis.logTag = "[Executor:test]";

    const batchCreatedPaths = new Set<string>();
    const first = (TaskExecutor as Any).prototype.checkFileOperation.call(
      fakeThis,
      "write_file",
      { path: "artifacts/skills/demo/novelist/chapters/ch_08.md", content: "one" },
      batchCreatedPaths,
    );
    const second = (TaskExecutor as Any).prototype.checkFileOperation.call(
      fakeThis,
      "write_file",
      { path: "artifacts/skills/demo/novelist/chapters/ch_08.md", content: "two" },
      batchCreatedPaths,
    );

    expect(first.blocked).toBe(false);
    expect(second.blocked).toBe(true);
    expect(second.reason || "").toContain("tool batch");
  });

  it("releases a failed batch file reservation so the same path can be retried", () => {
    const fakeThis: Any = Object.create(TaskExecutor.prototype);
    fakeThis.fileOperationTracker = new FileOperationTracker();
    fakeThis.logTag = "[Executor:test]";

    const batchCreatedPaths = new Set<string>();
    const first = (TaskExecutor as Any).prototype.checkFileOperation.call(
      fakeThis,
      "write_file",
      { path: "artifacts/seed.txt", content: "one" },
      batchCreatedPaths,
    );

    (TaskExecutor as Any).prototype.releaseBatchCreatedPathReservation.call(
      fakeThis,
      batchCreatedPaths,
      "write_file",
      { path: "artifacts/seed.txt", content: "one" },
    );

    const retry = (TaskExecutor as Any).prototype.checkFileOperation.call(
      fakeThis,
      "write_file",
      { path: "artifacts/seed.txt", content: "two" },
      batchCreatedPaths,
    );

    expect(first.blocked).toBe(false);
    expect(retry.blocked).toBe(false);
  });
});

describe("ToolFailureTracker browser HTTP status handling", () => {
  it("treats browser HTTP status failures as input-dependent (no immediate disable)", () => {
    const tracker = new ToolFailureTracker();

    for (let i = 0; i < 9; i++) {
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

  it("does not globally disable web_search for provider-scoped quota failures", () => {
    const tracker = new ToolFailureTracker();

    expect(
      tracker.recordFailure(
        "web_search",
        'Tavily API error: 432 - {"detail":{"error":"This request exceeds your plan\'s set usage limit"}}',
      ),
    ).toBe(false);
    expect(tracker.isDisabled("web_search")).toBe(false);
  });

  it("treats missing-module runtime errors as input-dependent before disabling monty_run", () => {
    const tracker = new ToolFailureTracker();

    for (let i = 0; i < 7; i++) {
      expect(
        tracker.recordFailure("monty_run", "ModuleNotFoundError: No module named 'datetime'"),
      ).toBe(false);
    }
    expect(tracker.isDisabled("monty_run")).toBe(false);

    expect(
      tracker.recordFailure("monty_run", "ModuleNotFoundError: No module named 'datetime'"),
    ).toBe(true);
    expect(tracker.isDisabled("monty_run")).toBe(true);
  });
});
