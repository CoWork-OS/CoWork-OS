import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TaskEvent } from "../../../shared/types";
import { FIRST_TURN_KEY, type TurnChangeSet } from "../../../shared/turn-changes";
import { collectTurnOutputSummaries } from "../MainContent/turn-outputs";
import {
  TurnOutputsRow,
  describeUndoBlock,
  summarizeLineChanges,
} from "../MainContent/TurnOutputsRow";

vi.mock("../FileActionMenu", () => ({
  useFileActionMenu: () => ({ openFileActionMenu: () => {}, menu: null }),
}));

const event = (id: string, type: string, payload: Record<string, unknown> = {}): TaskEvent =>
  ({ id, taskId: "t", timestamp: 0, type, payload }) as TaskEvent;

const changeSet = (overrides: Partial<TurnChangeSet> = {}): TurnChangeSet => ({
  turnKey: "msg-1",
  canUndo: true,
  files: [
    { path: "/w/a.ts", displayPath: "a.ts", kind: "modified", added: 3, removed: 1 },
    { path: "/w/b.md", displayPath: "b.md", kind: "created", added: 2, removed: 0 },
  ],
  ...overrides,
});

describe("turn change keys", () => {
  it("keys the first turn as the first turn and later turns by their user message", () => {
    const summaries = collectTurnOutputSummaries(
      [
        event("start", "log"),
        event("w1", "file_created", { path: "a.md" }),
        event("msg-2", "user_message", { message: "more" }),
        event("w2", "file_modified", { path: "a.md" }),
      ],
      { isTaskWorking: false },
    );
    expect(summaries.map((summary) => summary.changeKey)).toEqual([FIRST_TURN_KEY, "msg-2"]);
  });
});

describe("summarizeLineChanges and describeUndoBlock", () => {
  it("adds up line counts when there are any", () => {
    expect(summarizeLineChanges(changeSet().files)).toEqual({ added: 5, removed: 1 });
    expect(
      summarizeLineChanges([{ path: "/w/x.bin", displayPath: "x.bin", kind: "modified" }]),
    ).toBeNull();
  });

  it("names the first file in the way", () => {
    expect(describeUndoBlock(changeSet())).toBeNull();
    expect(
      describeUndoBlock(
        changeSet({
          canUndo: false,
          files: [
            {
              path: "/w/src/a.ts",
              displayPath: "src/a.ts",
              kind: "modified",
              blocked: "changed_since",
            },
            { path: "/w/b.md", displayPath: "b.md", kind: "created", blocked: "changed_since" },
          ],
        }),
      ),
    ).toBe("Can't undo: a.ts was changed after this turn (and 1 more)");
    expect(describeUndoBlock(changeSet({ undoneAt: 5, canUndo: false }))).toBe("Already undone");
  });
});

describe("TurnOutputsRow with recorded changes", () => {
  const render = (props: Partial<React.ComponentProps<typeof TurnOutputsRow>>) =>
    renderToStaticMarkup(
      React.createElement(TurnOutputsRow, {
        files: [{ path: "a.ts", action: "updated" }],
        workspacePath: "/w",
        onOpenFile: () => {},
        ...props,
      }),
    );

  it("shows line counts and Undo", () => {
    const markup = render({
      changeSet: changeSet(),
      onUndo: async () => ({ ok: true, restored: [] }),
    });
    expect(markup).toContain("+5");
    expect(markup).toContain("−1");
    expect(markup).toContain("turn-outputs-undo");
    expect(markup).toContain("Put the files this turn changed back as they were");
  });

  it("says Undone instead of offering Undo again", () => {
    const markup = render({
      changeSet: changeSet({ undoneAt: 10, canUndo: false }),
      onUndo: async () => ({ ok: true, restored: [] }),
    });
    expect(markup).toContain("Undone");
    expect(markup).not.toContain('class="turn-outputs-undo"');
  });

  it("stays the plain file line without recorded changes", () => {
    const markup = render({});
    expect(markup).not.toContain("turn-outputs-undo");
    expect(markup).not.toContain("turn-outputs-lines");
  });
});
