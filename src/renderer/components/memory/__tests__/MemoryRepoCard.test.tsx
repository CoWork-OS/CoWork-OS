import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { MemoryRepoStatusReport } from "../../../../shared/memory-repo-types";
import { dreamLastLine, dreamNowMessage } from "../memory-repo-dreams-model";
import {
  COMPACT_HISTORY_CONFIRM,
  MemoryRepoCard,
  MemoryRepoDreamingView,
  memoryRepoErrorMessage,
  memoryRepoStatusLine,
} from "../MemoryRepoCard";

const ready: MemoryRepoStatusReport = {
  enabled: true,
  root: "/Users/sam/CoWork Memory",
  ready: true,
  writable: true,
  gitAvailable: true,
  clean: true,
  lastCommitAt: Date.now() - 5 * 60_000,
  entryFileBytes: 800,
  inboxEntries: 0,
  lastWriteError: null,
};

describe("Memory folder card", () => {
  it("renders the switch, folder field, explanation and actions", () => {
    const api = vi.fn();
    const html = renderToStaticMarkup(
      <MemoryRepoCard
        features={{
          contextPackInjectionEnabled: true,
          heartbeatMaintenanceEnabled: true,
          memoryRepoEnabled: true,
          memoryRepoPath: "/Users/sam/Notes/Memory",
        }}
        onFeaturesSaved={vi.fn()}
        api={api as never}
      />,
    );
    expect(html).toContain("Memory folder");
    expect(html).toContain("plain notes in a folder you can open and edit");
    expect(html).toContain('value="/Users/sam/Notes/Memory"');
    expect(html).toContain("Open memory folder");
    expect(html).toContain("Compact history");
    expect(html).toContain("checked");
    // Nothing is loaded during a static render.
    expect(api).not.toHaveBeenCalled();
  });

  it("describes each state of the folder", () => {
    expect(memoryRepoStatusLine(null).text).toMatch(/Checking/);
    expect(memoryRepoStatusLine({ ...ready, enabled: false })).toMatchObject({ tone: "neutral" });
    expect(
      memoryRepoStatusLine({
        ...ready,
        ready: false,
        problem: "the memory folder is a symbolic link",
      }),
    ).toEqual({ tone: "warning", text: "Not ready: the memory folder is a symbolic link." });
    expect(memoryRepoStatusLine(ready)).toEqual({
      tone: "success",
      text: "Ready; last change 5m ago.",
    });
    expect(memoryRepoStatusLine({ ...ready, gitAvailable: false })).toMatchObject({
      tone: "warning",
      text: expect.stringContaining("git not found"),
    });
    expect(memoryRepoStatusLine({ ...ready, lastWriteError: "busy" }).text).toContain(
      "last write failed: busy",
    );
    expect(memoryRepoStatusLine({ ...ready, clean: false }).text).toContain("not yet committed");
  });

  it("shows main's error message without Electron's prefix", () => {
    expect(
      memoryRepoErrorMessage(
        new Error(
          "Error invoking remote method 'memoryFeatures:saveSettings': Error: the memory folder must be outside every workspace",
        ),
        "fallback",
      ),
    ).toBe("the memory folder must be outside every workspace");
    expect(memoryRepoErrorMessage(new Error(""), "fallback")).toBe("fallback");
  });

  it("warns that compacting cannot be undone", () => {
    expect(COMPACT_HISTORY_CONFIRM).toContain(
      "Removes old versions so deleted memories are really gone. This can't be undone.",
    );
  });
});

describe("Memory folder card: Dreaming", () => {
  const dream = {
    id: "d1",
    trigger: "manual" as const,
    status: "completed" as const,
    startedAt: Date.now() - 2 * 60 * 60_000,
    finishedAt: Date.now() - 2 * 60 * 60_000,
    summary: "Tidied lessons.",
    tokens: 3200,
    autoCount: 3,
    undone: false,
    canUndo: true,
    reviewCount: 2,
    reviewStatus: "pending" as const,
    rejected: 0,
    operations: [],
  };
  const report = {
    dreams: [dream],
    tokensUsedToday: 3200,
    dailyBudget: 50_000,
    dreamingEnabled: true,
    folderReady: true,
    pendingReviews: 1,
  };
  const view = (overrides: Partial<Parameters<typeof MemoryRepoDreamingView>[0]> = {}) =>
    renderToStaticMarkup(
      <MemoryRepoDreamingView
        dreamingEnabled
        dailyBudget={50_000}
        report={report}
        ready
        canDreamNow
        disabled={false}
        dreaming={false}
        message={null}
        onToggle={vi.fn()}
        onDreamNow={vi.fn()}
        {...overrides}
      />,
    );

  it("shows the switch, the cost notice, today's use, the last dream and Dream now", () => {
    const html = view();
    expect(html).toContain('aria-label="Dreaming"');
    expect(html).toContain(
      "Dreaming uses your model provider and costs tokens (up to 50,000 tokens/day). It runs about once a day and when you press Dream now.",
    );
    expect(html).toContain("Last dream 2h ago: 3 applied, 2 waiting for review.");
    expect(html).toContain("3,200 of 50,000 tokens used in the last 24 hours.");
    expect(html).toContain("Dream now");
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>Dream now/);
  });

  it("disables Dream now while dreaming or when dreaming is off, and shows the result", () => {
    expect(view({ dreaming: true })).toMatch(/<button[^>]*disabled[^>]*>Dreaming\.\.\./);
    expect(view({ dreamingEnabled: false })).toMatch(/<button[^>]*disabled[^>]*>Dream now/);
    expect(view({ canDreamNow: false })).not.toContain("Dream now</button>");
    expect(view({ ready: false })).not.toContain("Last dream");
    expect(
      view({ message: { tone: "error", text: "No dream ran: nothing new since the last dream." } }),
    ).toContain('role="alert"');
  });

  it("describes the last dream and the Dream now result", () => {
    expect(dreamLastLine(null)).toBe("No dream yet.");
    expect(
      dreamLastLine({ ...report, dreams: [{ ...dream, status: "skipped", skipReason: "budget" }] }),
    ).toContain("skipped, today's token budget is used up");
    expect(
      dreamLastLine({
        ...report,
        dreams: [{ ...dream, status: "failed", error: "provider down" }],
      }),
    ).toContain("failed: provider down");
    expect(dreamNowMessage({ ran: true, dream })).toEqual({
      tone: "success",
      text: "Dream finished: 3 changes applied, 2 waiting for review in the Review tab.",
    });
    expect(
      dreamNowMessage({ ran: true, dream: { ...dream, autoCount: 0, reviewCount: 0 } }).text,
    ).toBe("Dream finished: nothing to change.");
    expect(dreamNowMessage({ ran: false, reason: "busy" })).toEqual({
      tone: "error",
      text: "No dream ran: another dream is running.",
    });
    expect(dreamNowMessage({ ran: false, reason: "failed", error: "timeout" }).text).toBe(
      "Dream failed: timeout",
    );
  });

  it("is part of the card while the folder is on", () => {
    const html = renderToStaticMarkup(
      <MemoryRepoCard
        features={{
          contextPackInjectionEnabled: true,
          heartbeatMaintenanceEnabled: true,
          memoryRepoEnabled: true,
          memoryRepoDreamDailyTokenBudget: 20_000,
        }}
        onFeaturesSaved={vi.fn()}
        api={vi.fn() as never}
      />,
    );
    expect(html).toContain('data-testid="memory-repo-dreaming"');
    expect(html).toContain("up to 20,000 tokens/day");
    const off = renderToStaticMarkup(
      <MemoryRepoCard
        features={{
          contextPackInjectionEnabled: true,
          heartbeatMaintenanceEnabled: true,
          memoryRepoEnabled: false,
        }}
        onFeaturesSaved={vi.fn()}
        api={vi.fn() as never}
      />,
    );
    expect(off).not.toContain("memory-repo-dreaming");
  });
});
