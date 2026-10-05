import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type {
  MemoryRepoDreamSummary,
  MemoryRepoDreamsReport,
} from "../../../../shared/memory-repo-types";
import {
  DreamDiff,
  MemoryRepoDreamsView,
  type MemoryRepoDreamsViewProps,
} from "../MemoryRepoDreamsSection";
import { MemoryReviewView } from "../MemoryReviewTab";
import { dreamDiffLineKind, splitDreams } from "../memory-repo-dreams-model";

const NOW = Date.now();

function dream(overrides: Partial<MemoryRepoDreamSummary> = {}): MemoryRepoDreamSummary {
  return {
    id: "d1",
    trigger: "daily",
    status: "completed",
    startedAt: NOW - 3 * 60 * 60_000,
    finishedAt: NOW - 3 * 60 * 60_000,
    summary: "Merged duplicate preferences and moved a lesson.",
    tokens: 2000,
    autoCount: 0,
    undone: false,
    canUndo: false,
    reviewCount: 1,
    reviewStatus: "pending",
    rejected: 0,
    operations: [
      {
        decision: "review",
        description: "update MEMORY.md: Prefers short replies",
        reason: "The user corrected this twice",
        why: "it changes MEMORY.md",
      },
      { decision: "rejected", description: "add secrets.md", why: "unsafe path" },
    ],
    ...overrides,
  };
}

const PENDING = dream();
const AUTO = dream({
  id: "d2",
  autoCount: 2,
  canUndo: true,
  reviewCount: 0,
  reviewStatus: null,
  summary: "Removed a stale entry.",
  operations: [
    { decision: "auto", description: "remove lessons.md: Use npm 8", reason: "outdated" },
    { decision: "auto", description: "merge me.md (2 entries)", reason: "duplicates" },
  ],
});
const COMPACTED = dream({
  id: "d3",
  autoCount: 1,
  canUndo: false,
  reviewCount: 0,
  reviewStatus: null,
  historyNote: "history compacted",
  operations: [{ decision: "auto", description: "remove me.md: old" }],
});

const REPORT: MemoryRepoDreamsReport = {
  dreams: [PENDING, AUTO, COMPACTED],
  tokensUsedToday: 2000,
  dailyBudget: 50_000,
  dreamingEnabled: true,
  folderReady: true,
  pendingReviews: 1,
};

function render(overrides: Partial<MemoryRepoDreamsViewProps> = {}) {
  return renderToStaticMarkup(
    <MemoryRepoDreamsView
      report={REPORT}
      loading={false}
      error={null}
      notice={null}
      busyId={null}
      diffs={{}}
      onToggleDiff={vi.fn()}
      onAccept={vi.fn()}
      onReject={vi.fn()}
      onUndo={vi.fn()}
      {...overrides}
    />,
  );
}

describe("Review tab: memory folder dreams", () => {
  it("lists pending proposals with their review operations, reasons and Accept / Reject", () => {
    const html = render();
    expect(html).toContain("Memory folder");
    expect(html).toContain('data-dream-id="d1"');
    expect(html).toContain("1 change for review");
    expect(html).toContain("Merged duplicate preferences and moved a lesson.");
    expect(html).toContain("update MEMORY.md: Prefers short replies");
    expect(html).toContain("The user corrected this twice");
    expect(html).toContain("Needs your review:</strong> it changes MEMORY.md");
    // Rejected operations are not offered for review.
    expect(html).not.toContain("add secrets.md");
    expect(html).toContain("Show the diff");
    expect(html).toContain(">Accept</button>");
    expect(html).toContain(">Reject</button>");
  });

  it("lists recent automatic changes with Undo, disabled when it cannot be undone", () => {
    const html = render();
    expect(html).toContain("Recent dream changes");
    expect(html).toContain("2 changes applied");
    expect(html).toContain("remove lessons.md: Use npm 8 (outdated)");
    expect(html).toMatch(
      /data-dream-id="d2"[\s\S]*?<button type="button" class="memory-inline-btn">Undo<\/button>/,
    );
    expect(html).toMatch(/data-dream-id="d3"[\s\S]*?<button[^>]*disabled[^>]*>Undo<\/button>/);
    expect(html).toContain("Cannot be undone: history compacted");
    const undone = render({
      report: {
        ...REPORT,
        dreams: [{ ...AUTO, undone: true, canUndo: false, undoneAt: NOW - 60_000 }],
      },
    });
    expect(undone).toContain("Undone 1m ago");
    expect(undone).not.toContain(">Undo</button>");
  });

  it("shows errors and notices inline, and disables buttons while busy", () => {
    const html = render({
      error: "The memory folder changed since this dream; it was not applied.",
      notice: null,
      busyId: "accept:d1",
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain("The memory folder changed since this dream");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Accepting\.\.\.<\/button>/);
    expect(render({ notice: "Dream changes accepted." })).toContain("Dream changes accepted.");
  });

  it("shows an empty state", () => {
    const html = render({ report: { ...REPORT, dreams: [], pendingReviews: 0 } });
    expect(html).toContain("No dream proposals waiting for review.");
    expect(html).not.toContain("Recent dream changes");
  });

  it("renders the diff with + and - lines marked", () => {
    const html = renderToStaticMarkup(
      <DreamDiff
        state={{
          loading: false,
          text: "diff --git a/me.md b/me.md\n--- a/me.md\n+++ b/me.md\n@@ -1 +1 @@\n-old <entry>\n+new\n same",
        }}
      />,
    );
    expect(html).toContain('<pre class="memory-review-diff">');
    expect(html).toContain('memory-review-diff-line--del">-old &lt;entry&gt;');
    expect(html).toContain('memory-review-diff-line--add">+new');
    expect(html).toContain('memory-review-diff-line--meta">+++ b/me.md');
    expect(html).toContain('memory-review-diff-line--context"> same');
    expect(renderToStaticMarkup(<DreamDiff state={{ loading: true }} />)).toContain(
      "Loading the diff",
    );
    expect(renderToStaticMarkup(<DreamDiff state={{ loading: false, error: "gone" }} />)).toContain(
      'role="alert"',
    );
    expect(renderToStaticMarkup(<DreamDiff state={{ loading: false, text: "" }} />)).toContain(
      "No diff available.",
    );
  });

  it("classifies diff lines and splits dreams", () => {
    expect(dreamDiffLineKind("+x")).toBe("add");
    expect(dreamDiffLineKind("-x")).toBe("del");
    expect(dreamDiffLineKind("--- a/x")).toBe("meta");
    expect(dreamDiffLineKind("@@ -1 +1 @@")).toBe("meta");
    expect(dreamDiffLineKind(" x")).toBe("context");
    const { pending, automatic } = splitDreams(REPORT);
    expect(pending.map((entry) => entry.id)).toEqual(["d1"]);
    expect(automatic.map((entry) => entry.id)).toEqual(["d2", "d3"]);
    expect(splitDreams(null)).toEqual({ pending: [], automatic: [] });
  });

  it("leaves the workspace commitments view separate", () => {
    const html = renderToStaticMarkup(
      <MemoryReviewView
        state={null}
        loading
        error={null}
        notice={null}
        busyId={null}
        canWrite
        onUndo={vi.fn()}
        onDismissMessage={vi.fn()}
      />,
    );
    expect(html).toContain("Loading changes...");
    expect(html).not.toContain('data-group="memory-folder"');
  });
});
