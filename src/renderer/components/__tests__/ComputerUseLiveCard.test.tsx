import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ComputerViewFrame, ComputerViewState } from "../../../shared/computer-view";
import {
  ComputerUseLiveCardView,
  isComputerUseLiveActive,
  nextFramesBehind,
  type ComputerUseLiveCardViewProps,
} from "../ComputerUseLiveCard";

const frame = (label: string, dataUrl = `data:${label}`): ComputerViewFrame => ({
  dataUrl,
  width: 960,
  height: 600,
  capturedAt: 1,
  surface: "this_computer",
  label,
});

const working: ComputerViewState = {
  taskId: "t1",
  status: "working",
  surface: "this_computer",
  frame: frame("Calculator — Untitled"),
  updatedAt: 1,
};

const render = (overrides: Partial<ComputerUseLiveCardViewProps> = {}) =>
  renderToStaticMarkup(
    React.createElement(ComputerUseLiveCardView, {
      state: working,
      behind: [],
      live: true,
      enlarged: false,
      collapsed: false,
      busy: false,
      error: null,
      agentName: "CoWork",
      onEnlarge: () => {},
      onCollapse: () => {},
      onTakeOver: () => {},
      onHandBack: () => {},
      ...overrides,
    }),
  );

describe("ComputerUseLiveCard", () => {
  it("shows only while a task works on, waits for, or is paused on this computer", () => {
    expect(isComputerUseLiveActive(working)).toBe(true);
    expect(isComputerUseLiveActive({ ...working, frame: undefined })).toBe(false);
    expect(isComputerUseLiveActive({ ...working, surface: "browser" })).toBe(false);
    expect(isComputerUseLiveActive({ ...working, status: "idle" })).toBe(false);
    expect(isComputerUseLiveActive({ ...working, status: "held", frame: undefined })).toBe(true);
    expect(isComputerUseLiveActive({ ...working, status: "waiting", frame: undefined })).toBe(true);
    expect(isComputerUseLiveActive(null)).toBe(false);
  });

  it("shows the live window with its name and a live dot", () => {
    const markup = render();
    expect(markup).toContain('src="data:Calculator — Untitled"');
    expect(markup).toContain("Calculator — Untitled");
    expect(markup).toContain("computer-use-live-dot is-live");
    expect(markup).toContain('aria-label="Take over"');
    expect(render({ live: false })).toContain("computer-use-live-dot is-quiet");
  });

  it("offers hand back while the person has control", () => {
    const markup = render({ state: { ...working, status: "held" } });
    expect(markup).toContain("You have control");
    expect(markup).toContain("Hand back");
    expect(markup).not.toContain('aria-label="Take over"');
  });

  it("raises the agent's request to take over", () => {
    const markup = render({
      state: { ...working, takeoverRequest: { reason: "Enter the one-time code.", at: 1 } },
    });
    expect(markup).toContain("CoWork needs you");
    expect(markup).toContain("Enter the one-time code.");
    expect(markup).toContain("computer-use-live-icon-button is-primary");
  });

  it("minimizes to one row", () => {
    const markup = render({ collapsed: true });
    expect(markup).toContain("computer-use-live-trigger");
    expect(markup).not.toContain("<img");
  });

  it("stacks the windows it used before behind the live one", () => {
    const calculator = frame("Calculator");
    const notes = frame("Notes");
    const safari = frame("Safari");
    let behind = nextFramesBehind([], undefined, calculator);
    expect(behind).toEqual([]);
    behind = nextFramesBehind(behind, calculator, frame("Calculator", "data:newer"));
    expect(behind).toEqual([]);
    behind = nextFramesBehind(behind, calculator, notes);
    expect(behind.map((each) => each.label)).toEqual(["Calculator"]);
    behind = nextFramesBehind(behind, notes, safari);
    expect(behind.map((each) => each.label)).toEqual(["Notes", "Calculator"]);
    behind = nextFramesBehind(behind, safari, frame("Calculator"));
    expect(behind.map((each) => each.label)).toEqual(["Safari", "Notes"]);
    expect(render({ behind })).toContain("computer-use-live-behind is-2");
  });
});
