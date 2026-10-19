import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TaskEvent } from "../../../shared/types";
import { renderEventTitle } from "../MainContent/timeline-event-rendering";
import { isImportantTaskEvent } from "../../utils/task-event-visibility";

function event(type: string, payload: Record<string, unknown>): TaskEvent {
  return { id: `${type}-1`, taskId: "task-1", type, timestamp: 1, payload } as TaskEvent;
}

const title = (value: TaskEvent) =>
  renderToStaticMarkup(React.createElement(React.Fragment, null, renderEventTitle(value)));

describe("point-at-the-result timeline rows", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows what changed where, with Undo while the change can be undone", () => {
    vi.stubGlobal("window", { electronAPI: { undoAnnotationChange: vi.fn() } });
    const changed = event("annotation_addressed", {
      annotationId: "ann-1",
      anchor: "report.xlsx · Q3!B2:B5",
      changed: true,
      undoToken: "token-1",
    });

    expect(isImportantTaskEvent(changed)).toBe(true);
    const html = title(changed);
    expect(html).toContain("Changed");
    expect(html).toContain("report.xlsx · Q3!B2:B5");
    expect(html).toContain(">Undo</button>");
  });

  it("has no Undo for a change that cannot be undone, or an annotation with no file change", () => {
    vi.stubGlobal("window", { electronAPI: { undoAnnotationChange: vi.fn() } });
    const html = title(
      event("annotation_addressed", { annotationId: "ann-2", anchor: "#cta", changed: false }),
    );
    expect(html).toContain("Addressed");
    expect(html).not.toContain("Undo");
  });

  it("records an undo in the timeline", () => {
    const undone = event("annotation_change_undone", { anchor: "report.xlsx · Q3!B2" });
    expect(isImportantTaskEvent(undone)).toBe(true);
    expect(title(undone)).toContain("Undid the change to");
  });
});
