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

  it("renders completed groups collapsed by default", () => {
    const markup = render(
      React.createElement(ParallelGroupFeed, {
        group: makeGroup({
          status: "completed",
          lanes: [
            {
              laneKey: "use-1",
              toolName: "web_fetch",
              title: "Fetching a web page",
              status: "completed",
              startedAt: 1001,
            },
          ],
        }),
        timeLabel: "12:03",
        formatTime: () => "12:03",
      }),
    );

    expect(markup).toContain("Fetched 1 page");
    expect(markup).not.toContain("Fetching a web page");
  });
});
