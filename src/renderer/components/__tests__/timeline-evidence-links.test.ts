import React from "react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { TaskEvent } from "../../../shared/types";
import { renderEventDetails } from "../MainContent/timeline-event-rendering";

const mainContentStylesPath = fileURLToPath(
  new URL("../MainContent/main-content.css", import.meta.url),
);

function makeEvidenceEvent(payload: Record<string, unknown>): TaskEvent {
  return {
    id: "event-1",
    taskId: "task-1",
    type: "timeline_evidence_attached",
    timestamp: 1,
    payload,
  } as TaskEvent;
}

function makeAssistantEvent(): TaskEvent {
  return {
    id: "assistant-1",
    taskId: "task-1",
    type: "assistant_message",
    timestamp: 1,
    payload: { message: "Assistant reply" },
  } as TaskEvent;
}

describe("timeline evidence links", () => {
  it("renders web evidence as compact local-icon rows instead of full snippet anchors", () => {
    const event = makeEvidenceEvent({
      evidenceRefs: [
        {
          evidenceId: "citation-1",
          sourceType: "url",
          sourceUrlOrPath: "https://www.example.com/research?id=1",
          snippet: "A long source title that should be constrained to a single compact line.",
          capturedAt: 1,
        },
      ],
    });

    const markup = renderToStaticMarkup(
      React.createElement(React.Fragment, null, renderEventDetails(event, false, {})),
    );

    expect(markup).toContain('class="evidence-event-link"');
    expect(markup).toContain('class="evidence-event-favicon"');
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("/favicon.ico");
    expect(markup).toContain('class="evidence-event-domain"');
    expect(markup).toContain("example.com");
    expect(markup).toContain('class="evidence-event-link-title"');
  });

  it("hides subdomains in the compact site label", () => {
    const event = makeEvidenceEvent({
      evidenceRefs: [
        {
          evidenceId: "citation-1",
          sourceType: "url",
          sourceUrlOrPath: "https://blog.google/products/gemini",
          snippet: "Google Gemini update",
          capturedAt: 1,
        },
        {
          evidenceId: "citation-2",
          sourceType: "url",
          sourceUrlOrPath: "https://research.example.com/paper",
          snippet: "Example research",
          capturedAt: 1,
        },
      ],
    });

    const markup = renderToStaticMarkup(
      React.createElement(React.Fragment, null, renderEventDetails(event, false, {})),
    );

    expect(markup).toContain(">google</span>");
    expect(markup).not.toContain(">blog.google</span>");
    expect(markup).toContain(">example.com</span>");
    expect(markup).not.toContain(">research.example.com</span>");
  });

  it("caps the expanded evidence viewport to five compact rows", () => {
    const source = readFileSync(mainContentStylesPath, "utf8");

    expect(source).toMatch(
      /\.evidence-event-details-scroll\s*\{[^}]*max-height:\s*calc\(\(18px \* 5\) \+ \(4px \* 4\)\);/s,
    );
    expect(source).toMatch(/\.evidence-event-details-scroll\s*\{[^}]*overflow-y:\s*auto;/s);
  });

  it("renders Fork only for the latest assistant message", () => {
    const event = makeAssistantEvent();
    const options = {
      onForkTaskSession: () => {},
    };

    const earlierMarkup = renderToStaticMarkup(
      React.createElement(
        React.Fragment,
        null,
        renderEventDetails(event, false, {}, { ...options, isLastAssistantMessage: false }),
      ),
    );
    const latestMarkup = renderToStaticMarkup(
      React.createElement(
        React.Fragment,
        null,
        renderEventDetails(event, false, {}, { ...options, isLastAssistantMessage: true }),
      ),
    );

    expect(earlierMarkup).not.toContain("message-fork-btn");
    expect(latestMarkup).toContain("message-fork-btn");
  });
});
