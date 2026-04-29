import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ParallelGroupProjection } from "../parallel-group-projection";
import { ParallelGroupFeed } from "../ParallelGroupFeed";

function render(element: React.ReactElement): string {
  return renderToStaticMarkup(element);
}

function makeGroup(
  overrides: Partial<ParallelGroupProjection> = {},
): ParallelGroupProjection {
  return {
    groupId: "tools:step:build:1",
    label: "Tool batch (2)",
    status: "in_progress",
    anchorEventId: "event-1",
    startedAt: 1000,
    lanes: [
      {
        laneKey: "use-1",
        toolUseId: "use-1",
        toolCallIndex: 1,
        title: "Fetching a web page",
        status: "completed",
        startedAt: 1001,
      },
      {
        laneKey: "use-2",
        toolUseId: "use-2",
        toolCallIndex: 2,
        title: "Searching the web",
        status: "in_progress",
        startedAt: 1002,
      },
    ],
    ...overrides,
  };
}

describe("ParallelGroupFeed", () => {
  it("renders active groups expanded with lane rows", () => {
    const markup = render(
      React.createElement(ParallelGroupFeed, {
        group: makeGroup(),
        timeLabel: "12:01",
        formatTime: () => "12:01",
      }),
    );

    expect(markup).toContain("Running 2 tasks in parallel");
    expect(markup).toContain("Fetching a web page");
    expect(markup).toContain("Searching the web");
  });

  it("renders an image generation frame while generate_image is running", () => {
    const markup = render(
      React.createElement(ParallelGroupFeed, {
        group: makeGroup({
          lanes: [
            {
              laneKey: "use-1",
              toolUseId: "use-1",
              toolName: "generate_image",
              toolCallIndex: 1,
              title: "Using generate_image",
              status: "in_progress",
              startedAt: 1001,
            },
            {
              laneKey: "use-2",
              toolUseId: "use-2",
              toolName: "task_history",
              toolCallIndex: 2,
              title: "Loaded task history",
              status: "completed",
              startedAt: 1002,
            },
          ],
        }),
        timeLabel: "12:01",
        formatTime: () => "12:01",
      }),
    );

    expect(markup).toContain("Using generate_image");
    expect(markup).toContain("parallel-group-feed-image-frame");
    expect(markup).toContain('aria-label="Generating image"');
  });

  it("does not render the image generation frame after generate_image completes", () => {
    const markup = render(
      React.createElement(ParallelGroupFeed, {
        group: makeGroup({
          status: "completed",
          lanes: [
            {
              laneKey: "use-1",
              toolUseId: "use-1",
              toolName: "generate_image",
              toolCallIndex: 1,
              title: "Generated image",
              status: "completed",
              startedAt: 1001,
              finishedAt: 1200,
            },
          ],
        }),
        timeLabel: "12:03",
        formatTime: () => "12:03",
      }),
    );

    expect(markup).toContain("Generated image");
    expect(markup).not.toContain("parallel-group-feed-image-frame");
  });

  it("renders completed groups collapsed by default", () => {
    const markup = render(
      React.createElement(ParallelGroupFeed, {
        group: makeGroup({
          status: "completed",
          lanes: [
            {
              laneKey: "use-1",
              toolName: "web_fetch",
              title: "Fetched ccunpacked.dev",
              status: "completed",
              startedAt: 1001,
            },
          ],
        }),
        timeLabel: "12:03",
        formatTime: () => "12:03",
      }),
    );

    expect(markup).toContain("Fetched ccunpacked.dev");
    expect(markup).toContain("parallel-group-feed-single");
    expect(markup).toContain("parallel-group-feed-single-lane");
    expect(markup).not.toContain("event-expand-icon");
    expect(markup).not.toContain("event-title-meta");
    expect(markup).not.toContain('class="parallel-group-feed-details"');
  });

  it("renders completed groups expanded when the parent block is active", () => {
    const markup = render(
      React.createElement(ParallelGroupFeed, {
        group: makeGroup({
          status: "completed",
          lanes: [
            {
              laneKey: "use-1",
              toolName: "web_fetch",
              title: "Fetched ccunpacked.dev",
              status: "completed",
              startedAt: 1001,
            },
          ],
        }),
        timeLabel: "12:03",
        formatTime: () => "12:03",
        defaultExpanded: true,
      }),
    );

    expect(markup).toContain("Fetched ccunpacked.dev");
    expect(markup).toContain("parallel-group-feed-single");
    expect(markup).not.toContain("event-expand-icon");
    expect(markup).not.toContain("event-title-meta");
    expect(markup).not.toContain('class="parallel-group-feed-details"');
  });

  it("prefers semantic group labels when available", () => {
    const markup = render(
      React.createElement(ParallelGroupFeed, {
        group: makeGroup({
          label: "Read Claude Code docs",
          status: "completed",
          lanes: [
            {
              laneKey: "use-1",
              toolName: "web_fetch",
              title: "Fetched ccunpacked.dev",
              status: "completed",
              startedAt: 1001,
            },
            {
              laneKey: "use-2",
              toolName: "web_search",
              title: "Searched: Claude Code docs",
              status: "completed",
              startedAt: 1002,
            },
          ],
        }),
        timeLabel: "12:03",
        formatTime: () => "12:03",
      }),
    );

    expect(markup).toContain("Read Claude Code docs");
    expect(markup).not.toContain("2 parallel tasks completed");
  });

  it("uses the single lane title instead of a stored semantic label", () => {
    const markup = render(
      React.createElement(ParallelGroupFeed, {
        group: makeGroup({
          label: "Exit Status Is 0",
          status: "completed",
          lanes: [
            {
              laneKey: "use-1",
              toolName: "task_history",
              title: "Loaded task history",
              status: "completed",
              startedAt: 1001,
            },
          ],
        }),
        timeLabel: "12:03",
        formatTime: () => "12:03",
      }),
    );

    expect(markup).toContain("Loaded task history");
    expect(markup).toContain("parallel-group-feed-single");
    expect(markup).not.toContain("event-expand-icon");
    expect(markup).not.toContain("event-title-meta");
    expect(markup).not.toContain('class="parallel-group-feed-details"');
    expect(markup).not.toContain("Exit Status Is 0");
  });
});
