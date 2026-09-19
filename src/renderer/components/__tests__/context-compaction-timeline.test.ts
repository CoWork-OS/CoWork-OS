import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ListTree } from "lucide-react";

import type { TaskEvent } from "../../../shared/types";
import {
  getCompactionDetailsPayload,
  renderEventDetails,
  renderEventTitle,
} from "../MainContent/timeline-event-rendering";
import { resolveTimelineIndicator } from "../timeline/timeline-indicators";
import {
  isDuplicateContextSummaryEvent,
  isRedundantStageTransitionGroupEvent,
  isResolvedContextCompactionStartEvent,
} from "../../utils/task-event-visibility";

function makeEvent(type: TaskEvent["type"], payload: Record<string, unknown>): TaskEvent {
  return {
    id: `${type}-1`,
    taskId: "task-1",
    timestamp: 1,
    type,
    payload,
    schemaVersion: 2,
  };
}

function renderTitle(event: TaskEvent): string {
  return renderToStaticMarkup(React.createElement(React.Fragment, null, renderEventTitle(event)));
}

describe("context compaction timeline", () => {
  it("uses the automatic lifecycle titles", () => {
    expect(renderTitle(makeEvent("context_compaction_started", {}))).toBe(
      "Context automatically compacting",
    );
    expect(renderTitle(makeEvent("context_compaction_completed", {}))).toBe(
      "Context automatically compacted",
    );
    expect(renderTitle(makeEvent("context_compaction_failed", {}))).toBe(
      "Context compaction failed",
    );
  });

  it("uses the context icon and spins only while compaction is active", () => {
    const started = resolveTimelineIndicator(makeEvent("context_compaction_started", {}));
    const completed = resolveTimelineIndicator(makeEvent("context_compaction_completed", {}));
    const failed = resolveTimelineIndicator(makeEvent("context_compaction_failed", {}));

    expect(started.icon).toBe(ListTree);
    expect(started.spin).toBe(true);
    expect(completed.icon).toBe(ListTree);
    expect(completed.spin).toBeUndefined();
    expect(failed.icon).toBe(ListTree);
    expect(failed.spin).toBeUndefined();
  });

  it("renders typed compaction statistics and summary details", () => {
    const event = makeEvent("context_compaction_completed", {
      compactionId: "compact-1",
      trigger: "automatic",
      phase: "pre_turn",
      tokensBefore: 24_000,
      tokensAfter: 11_000,
      removedMessageCount: 7,
      contextRatio: 0.9,
      targetRatio: 0.55,
      durationMs: 1_250,
      summary: "The task is ready to resume from the replacement history.",
    });

    const details = renderToStaticMarkup(
      React.createElement(React.Fragment, null, renderEventDetails(event, false, {})),
    );

    expect(details).toContain("Trigger: automatic");
    expect(details).toContain("Context: 24,000 tokens → 11,000 tokens");
    expect(details).toContain("Messages summarized: 7");
    expect(details).toContain("Context usage: 90%");
    expect(details).toContain("Compaction target: 55%");
    expect(details).toContain("Duration: 1.3s");
    expect(details).toContain("The task is ready to resume from the replacement history.");
  });

  it("accepts legacy compaction payload aliases", () => {
    const details = getCompactionDetailsPayload(
      makeEvent("context_compaction_completed", {
        compaction_id: "legacy-1",
        summaryText: "Legacy summary",
        inputTokens: 800,
        replacementTokens: 300,
        removedCount: 2,
        usedFallback: true,
      }),
    );

    expect(details.compactionId).toBe("legacy-1");
    expect(details.summary).toBe("Legacy summary");
    expect(details.tokensBefore).toBe(800);
    expect(details.tokensAfter).toBe(300);
    expect(details.removedMessages).toBe(2);
    expect(details.fallbackUsed).toBe(true);
  });

  it("hides a matching legacy context_summarized row when lifecycle completion exists", () => {
    const completed = makeEvent("context_compaction_completed", {
      compactionId: "compact-1",
      summary: "Replacement history installed.",
    });
    const summary = makeEvent("context_summarized", {
      compactionId: "compact-1",
      summary: "Replacement history installed.",
    });

    expect(isDuplicateContextSummaryEvent(summary, [completed, summary])).toBe(true);
    expect(isDuplicateContextSummaryEvent(summary, [summary])).toBe(false);
  });

  it("hides a legacy summary when the lifecycle later failed", () => {
    const failed = makeEvent("context_compaction_failed", {
      compactionId: "compact-failed",
      reason: "compaction_snapshot_persistence_failed",
    });
    const summary = makeEvent("context_summarized", {
      compactionId: "compact-failed",
      summary: "Replacement history installed before persistence failed.",
    });

    expect(isDuplicateContextSummaryEvent(summary, [failed, summary])).toBe(true);
  });

  it("hides the compacting row once its lifecycle resolves", () => {
    const started = makeEvent("context_compaction_started", { compactionId: "compact-1" });
    const completed = {
      ...makeEvent("context_compaction_completed", { compactionId: "compact-1" }),
      id: "completed-1",
      timestamp: 2,
    };

    expect(isResolvedContextCompactionStartEvent(started, [started, completed])).toBe(true);
    expect(isResolvedContextCompactionStartEvent(completed, [started, completed])).toBe(false);
  });

  it("keeps the compacting row visible while compaction is still running", () => {
    const started = makeEvent("context_compaction_started", { compactionId: "compact-1" });

    expect(isResolvedContextCompactionStartEvent(started, [started])).toBe(false);
  });

  it("does not let one compaction's completion hide a later compaction's start", () => {
    const firstStart = {
      ...makeEvent("context_compaction_started", { compactionId: "a" }),
      id: "s1",
    };
    const firstDone = {
      ...makeEvent("context_compaction_completed", { compactionId: "a" }),
      id: "c1",
      timestamp: 2,
    };
    const secondStart = {
      ...makeEvent("context_compaction_started", { compactionId: "b" }),
      id: "s2",
      timestamp: 3,
    };
    const events = [firstStart, firstDone, secondStart];

    expect(isResolvedContextCompactionStartEvent(firstStart, events)).toBe(true);
    expect(isResolvedContextCompactionStartEvent(secondStart, events)).toBe(false);
  });

  it("drops the stage transition row that restates the event that triggered it", () => {
    const groupStarted = {
      ...makeEvent("timeline_group_started", {
        stage: "FIX",
        groupId: "stage:fix",
        groupLabel: "Context automatically compacting",
      }),
      id: "group-1",
    };
    const started = {
      ...makeEvent("context_compaction_started", { compactionId: "compact-1" }),
      id: "started-1",
      timestamp: 2,
    };

    expect(isRedundantStageTransitionGroupEvent(groupStarted, [groupStarted, started])).toBe(true);
    expect(isRedundantStageTransitionGroupEvent(groupStarted, [groupStarted])).toBe(false);
  });

  it("keeps a stage transition row whose label is not a restatement", () => {
    const groupStarted = {
      ...makeEvent("timeline_group_started", {
        stage: "BUILD",
        groupId: "stage:build",
        groupLabel: "Wiring the API client",
      }),
      id: "group-1",
    };
    const started = {
      ...makeEvent("context_compaction_started", { compactionId: "compact-1" }),
      id: "started-1",
      timestamp: 2,
    };

    expect(isRedundantStageTransitionGroupEvent(groupStarted, [groupStarted, started])).toBe(false);
  });

  it("keeps an unmatched legacy summary visible for backward compatibility", () => {
    const completed = makeEvent("context_compaction_completed", {
      compactionId: "compact-1",
      summary: "New summary",
    });
    const summary = makeEvent("context_summarized", {
      summary: "Older summary",
    });

    expect(isDuplicateContextSummaryEvent(summary, [completed, summary])).toBe(false);
    expect(renderTitle(summary)).toBe("Context automatically compacted");
    expect(resolveTimelineIndicator(summary).icon).toBe(ListTree);
  });
});
