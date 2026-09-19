import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ActionBlock } from "../ActionBlock";

function renderHeader(props: Partial<React.ComponentProps<typeof ActionBlock>> = {}): string {
  return renderToStaticMarkup(
    React.createElement(ActionBlock, {
      blockId: "block-1",
      summary: "Working",
      iconKind: "work",
      stepCount: 1,
      toolCallCount: 0,
      durationMs: 20_000,
      outputTokens: 0,
      isActive: true,
      expanded: false,
      onToggle: () => {},
      replay: true,
      children: null,
      ...props,
    }),
  );
}

function countOccurrences(markup: string, needle: string): number {
  return markup.split(needle).length - 1;
}

describe("ActionBlock header labels", () => {
  it("shows the working state once when the latest activity repeats it", () => {
    const markup = renderHeader({ lastStepLabel: "Working" });

    expect(countOccurrences(markup, ">Working<")).toBe(1);
    expect(markup).not.toContain("action-block-last-step-label");
  });

  it("falls back to the summary only when it differs from the state label", () => {
    const markup = renderHeader({ isActive: false, summary: "Read 3 files" });

    expect(countOccurrences(markup, ">Read 3 files<")).toBe(1);
    expect(markup).not.toContain("action-block-last-step-label");
  });

  it("keeps a distinct latest activity label alongside the state label", () => {
    const markup = renderHeader({ lastStepLabel: "Ran command" });

    expect(markup).toContain(">Working<");
    expect(markup).toContain("action-block-last-step-label");
    expect(markup).toContain(">Ran command<");
  });

  it("ignores trailing punctuation when comparing the two labels", () => {
    const markup = renderHeader({ lastStepLabel: "Working..." });

    expect(markup).not.toContain("action-block-last-step-label");
  });

  it("uses the latest activity as the only visible label in minimal mode", () => {
    const markup = renderHeader({ minimal: true, lastStepLabel: "Reading App.tsx" });

    expect(markup).toContain('class="action-block timeline-event');
    expect(markup).toContain(" minimal");
    expect(markup).toContain("action-block-minimal-label");
    expect(markup).toContain(">Reading App.tsx<");
    expect(markup).not.toContain(">Working<");
    expect(markup).not.toContain("action-block-meta");
  });

  it("uses Thinking when a running group has no more specific activity label", () => {
    const markup = renderHeader({ minimal: true, lastStepLabel: "Working" });

    expect(markup).toContain(">Thinking<");
    expect(markup).not.toContain(">Working<");
  });

  it("shows the last completed step in a collapsed minimal group", () => {
    const markup = renderHeader({
      minimal: true,
      isActive: false,
      summary: "Read 3 files, ran 1 command",
      lastStepLabel: "Ran command",
      compactLabel: "Read 3 files, ran 1 command",
    });

    expect(markup).toContain(">Read 3 files, ran 1 command<");
    expect(markup).not.toContain("action-block-minimal-label current");
  });

  it("keeps the concrete latest step for an active minimal group", () => {
    const markup = renderHeader({
      minimal: true,
      compactLabel: "Reading files…",
      lastStepLabel: "Reading App.tsx",
    });

    expect(markup).toContain(">Reading App.tsx<");
    expect(markup).not.toContain(">Reading files…<");
  });

  it("falls back to the completed summary when no step label exists", () => {
    const markup = renderHeader({
      minimal: true,
      isActive: false,
      summary: "Read 3 files, ran 1 command",
    });

    expect(markup).toContain(">Read 3 files, ran 1 command<");
  });
});
