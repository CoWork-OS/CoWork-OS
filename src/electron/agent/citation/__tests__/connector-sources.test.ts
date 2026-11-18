import { describe, expect, it } from "vitest";
import { MAX_SOURCES_PER_CALL, extractConnectorSources } from "../connector-sources";
import { CitationTracker } from "../CitationTracker";

describe("extractConnectorSources", () => {
  it("credits Google Calendar events by their own links", () => {
    const sources = extractConnectorSources(
      "calendar_action",
      { action: "list_events" },
      {
        success: true,
        data: {
          items: [
            {
              summary: "Proposal review",
              htmlLink: "https://www.google.com/calendar/event?eid=abc",
              start: { dateTime: "2026-11-17T09:30:00-08:00" },
            },
            { summary: "No link" },
          ],
        },
      },
    );
    expect(sources).toEqual([
      {
        url: "https://www.google.com/calendar/event?eid=abc",
        title: "Proposal review",
        snippet: "2026-11-17T09:30:00-08:00",
        sourceLabel: "Google Calendar",
      },
    ]);
  });

  it("reads single Drive files and Notion page titles", () => {
    expect(
      extractConnectorSources(
        "google_drive_action",
        { action: "get_file" },
        { success: true, data: { name: "Q4 plan", webViewLink: "https://docs.google.com/d/1" } },
      )[0],
    ).toMatchObject({ title: "Q4 plan", sourceLabel: "Google Drive" });
    expect(
      extractConnectorSources(
        "notion_action",
        { action: "search" },
        {
          success: true,
          data: {
            results: [
              {
                url: "https://www.notion.so/Board-prep-1",
                properties: {
                  Name: {
                    type: "title",
                    title: [{ plain_text: "Board " }, { plain_text: "prep" }],
                  },
                },
              },
            ],
          },
        },
      )[0],
    ).toMatchObject({ title: "Board prep", sourceLabel: "Notion" });
  });

  it("ignores writes, failures, other tools and non-https links", () => {
    const event = { summary: "x", htmlLink: "https://calendar.google.com/e" };
    expect(
      extractConnectorSources(
        "calendar_action",
        { action: "create_event" },
        { success: true, data: event },
      ),
    ).toEqual([]);
    expect(
      extractConnectorSources(
        "calendar_action",
        { action: "get_event" },
        { success: false, data: event },
      ),
    ).toEqual([]);
    expect(
      extractConnectorSources(
        "gmail_action",
        { action: "get_event" },
        { success: true, data: event },
      ),
    ).toEqual([]);
    for (const htmlLink of [
      "http://calendar.google.com/e",
      "javascript:alert(1)",
      "https://u:p@x.com/",
    ]) {
      expect(
        extractConnectorSources(
          "calendar_action",
          { action: "get_event" },
          { success: true, data: { summary: "x", htmlLink } },
        ),
      ).toEqual([]);
    }
  });

  it("caps one listing", () => {
    const items = Array.from({ length: 30 }, (_, index) => ({
      summary: `Event ${index}`,
      htmlLink: `https://calendar.google.com/e/${index}`,
    }));
    expect(
      extractConnectorSources(
        "calendar_action",
        { action: "list_events" },
        { success: true, data: { items } },
      ),
    ).toHaveLength(MAX_SOURCES_PER_CALL);
  });
});

describe("CitationTracker connector sources", () => {
  it("indexes connector records after web sources and names the connector in the prompt", () => {
    const tracker = new CitationTracker("task-1");
    tracker.addFromSearch([{ title: "Web page", url: "https://example.com/a" }]);
    tracker.addFromConnector("calendar_action", [
      {
        url: "https://calendar.google.com/e/1",
        title: "Proposal review",
        snippet: "",
        sourceLabel: "Google Calendar",
      },
    ]);
    expect(tracker.getCitations()[1]).toMatchObject({
      index: 2,
      sourceTool: "calendar_action",
      sourceLabel: "Google Calendar",
    });
    expect(tracker.formatForPrompt()).toContain("[2] Proposal review — Google Calendar");
    expect(tracker.formatForPrompt()).toContain("[1] Web page — example.com");
  });
});
