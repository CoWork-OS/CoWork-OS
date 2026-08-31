import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Check, Circle, Loader2 } from "lucide-react";

import { StepFeed } from "../StepFeed";
import type { TimelineIndicatorSpec } from "../timeline-indicators";

function render(element: React.ReactElement): string {
  return renderToStaticMarkup(element);
}

function makeIndicator(overrides: Partial<TimelineIndicatorSpec> = {}): TimelineIndicatorSpec {
  return {
    icon: Circle,
    tone: "neutral",
    label: "Event",
    ...overrides,
  };
}

describe("StepFeed UX snapshots", () => {
  it("renders summary-first collapsed step card by default", () => {
    const markup = render(
      React.createElement(StepFeed, {
        title: "Researching common NDA redlines",
        timeLabel: "12:04",
        indicator: makeIndicator({
          icon: Loader2,
          tone: "active",
          spin: true,
          label: "In progress",
        }),
        showConnectorBelow: true,
        expandable: true,
        expanded: false,
        details: React.createElement(
          "div",
          { className: "timeline-step-details" },
          "hidden details",
        ),
      }),
    );

    expect(markup).not.toContain("hidden details");
    expect(markup).toMatchSnapshot();
  });

  it("renders expanded command + evidence details", () => {
    const details = React.createElement(
      "div",
      { className: "timeline-step-details" },
      React.createElement(
        "pre",
        { key: "cmd", className: "timeline-command-snippet" },
        "cd /workspace && node contract_training_v2.js",
      ),
      React.createElement(
        "div",
        { key: "evidence", className: "timeline-evidence-chips" },
        React.createElement("span", { className: "chip" }, "levels.fyi"),
        React.createElement("span", { className: "chip" }, "comp survey 2026"),
      ),
    );

    const markup = render(
      React.createElement(StepFeed, {
        title: "Building compensation analysis",
        timeLabel: "12:12",
        indicator: makeIndicator({
          icon: Check,
          tone: "success",
          label: "Step completed",
        }),
        showConnectorAbove: true,
        showConnectorBelow: true,
        expandable: true,
        expanded: true,
        details,
      }),
    );

    expect(markup).toContain("timeline-command-snippet");
    expect(markup).toContain("timeline-evidence-chips");
    expect(markup).toMatchSnapshot();
  });

  it("renders visual QA subagent card with severity totals", () => {
    const details = React.createElement(
      "div",
      { className: "timeline-step-details" },
      React.createElement(
        "p",
        null,
        "Visual QA Report — Commercial Contract Negotiation Training Deck",
      ),
      React.createElement("p", null, "41 issues found — 8 High, 19 Medium, 14 Low"),
      React.createElement("p", null, "Slide 05 — Content cut off at slide bottom edge"),
    );

    const markup = render(
      React.createElement(StepFeed, {
        title: "Visual QA of contract training slides (subagent)",
        timeLabel: "12:19",
        indicator: makeIndicator({
          tone: "warning",
          label: "Verification requires attention",
        }),
        showConnectorAbove: true,
        showConnectorBelow: true,
        showBranchStub: true,
        expandable: true,
        expanded: true,
        details,
      }),
    );

    expect(markup).toContain("41 issues found");
    expect(markup).toContain("8 High");
    expect(markup).toMatchSnapshot();
  });

  it("renders artifact card and aligned final delivery mention", () => {
    const artifactCard = React.createElement(StepFeed, {
      title: "Sharing negotiation_cheat_sheet.pdf",
      timeLabel: "12:26",
      indicator: makeIndicator({
        icon: Check,
        tone: "success",
        label: "Output ready",
      }),
      showConnectorAbove: true,
      expandable: true,
      expanded: true,
      details: React.createElement(
        "div",
        { className: "timeline-step-details" },
        React.createElement(
          "a",
          { href: "/workspace/negotiation_cheat_sheet.pdf" },
          "/workspace/negotiation_cheat_sheet.pdf",
        ),
      ),
    });

    const finalMessage = React.createElement(
      "section",
      { className: "final-delivery-summary" },
      React.createElement("h3", null, "Deliverables"),
      React.createElement(
        "ul",
        null,
        React.createElement("li", null, "negotiation_cheat_sheet.pdf"),
      ),
    );

    const markup = render(React.createElement("div", null, artifactCard, finalMessage));

    expect(markup).toContain("Sharing negotiation_cheat_sheet.pdf");
    expect(markup).toContain("negotiation_cheat_sheet.pdf");
    expect(markup).toMatchSnapshot();
  });
});
