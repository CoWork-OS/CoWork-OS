import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BotCapabilitySection } from "../BotCapabilitySection";
import { capabilitySummary } from "../../utils/__tests__/bot-capability-fixtures";

describe("BotCapabilitySection", () => {
  it("renders one collapsed row per capability", () => {
    const markup = renderToStaticMarkup(
      React.createElement(BotCapabilitySection, { summary: capabilitySummary() }),
    );
    expect(markup).toContain('aria-label="What it can do"');
    for (const label of ["Works on", "Files", "Services", "Schedules", "Memory", "Needs your OK"]) {
      expect(markup).toContain(`>${label}<`);
    }
    expect(markup.match(/aria-expanded="false"/g)).toHaveLength(6);
    expect(markup).not.toContain("bot-capability-details");
  });

  it("shows a failed section without its details", () => {
    const markup = renderToStaticMarkup(
      React.createElement(BotCapabilitySection, {
        summary: capabilitySummary({ partial: ["schedules"] }),
      }),
    );
    expect(markup).toContain("Couldn&#x27;t read this right now");
    expect(markup.match(/aria-expanded="false"/g)).toHaveLength(5);
  });

  it("renders nothing before the first read and a notice when it failed", () => {
    expect(renderToStaticMarkup(React.createElement(BotCapabilitySection, { summary: null }))).toBe(
      "",
    );
    expect(
      renderToStaticMarkup(
        React.createElement(BotCapabilitySection, { summary: null, failed: true }),
      ),
    ).toContain("Couldn&#x27;t read this bot&#x27;s setup.");
  });
});
