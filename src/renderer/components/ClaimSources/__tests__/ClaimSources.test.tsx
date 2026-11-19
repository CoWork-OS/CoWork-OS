import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ClaimSources, claimSourcesLabel, type ClaimSource } from "../ClaimSources";

const calendar: ClaimSource = {
  index: 1,
  url: "https://calendar.google.com/event?eid=a",
  title: "Proposal review",
  domain: "calendar.google.com",
  sourceLabel: "Google Calendar",
};
const web: ClaimSource = {
  index: 2,
  url: "https://example.com/a",
  title: "Report",
  domain: "example.com",
};

describe("claimSourcesLabel", () => {
  it("names the connector, a single web page's domain, or a mix", () => {
    expect(claimSourcesLabel([calendar])).toBe("Google Calendar");
    expect(claimSourcesLabel([web])).toBe("example.com");
    expect(claimSourcesLabel([calendar, web])).toBe("Google Calendar and web");
    expect(
      claimSourcesLabel([
        calendar,
        web,
        { ...web, index: 3, sourceLabel: "Notion" },
        { ...web, index: 4, sourceLabel: "Google Drive" },
      ]),
    ).toBe("Google Calendar, web and 2 more");
  });
});

describe("ClaimSources", () => {
  it("renders a collapsed row with the count and nothing for no sources", () => {
    const html = renderToStaticMarkup(createElement(ClaimSources, { sources: [calendar, web] }));
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("2 sources");
    expect(html).not.toContain("claim-sources-list");
    expect(renderToStaticMarkup(createElement(ClaimSources, { sources: [] }))).toBe("");
  });

  it("renders source titles as text", () => {
    const html = renderToStaticMarkup(
      createElement(ClaimSources, { sources: [{ ...web, sourceLabel: "<b>x</b>" }] }),
    );
    expect(html).not.toContain("<b>x</b>");
  });
});
