import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Task } from "../../../shared/types";
import { SessionProgressCard } from "../SessionProgressCard";

describe("interrupted turn recovery", () => {
  it("shows recovery controls from the task even without a progress projection", () => {
    const task = {
      id: "task-1",
      status: "interrupted",
      terminalStatus: "resume_available",
      updatedAt: 1,
      error: "Runtime connection was lost.",
    } as Task;
    const markup = renderToStaticMarkup(React.createElement(SessionProgressCard, { task }));
    expect(markup).toContain('aria-label="Session recovery"');
    expect(markup).toContain("Turn interrupted");
    expect(markup).toContain("Runtime connection was lost.");
    expect(markup).toContain("Discard turn");
    expect(markup).toContain("Resume");
    expect(markup).toContain("Progress and saved outputs are preserved.");
  });
  it("does not show interrupted controls for a completed session", () => {
    const task = { id: "task-1", status: "completed", updatedAt: 1 } as Task;
    expect(renderToStaticMarkup(React.createElement(SessionProgressCard, { task }))).toBe("");
  });
});
