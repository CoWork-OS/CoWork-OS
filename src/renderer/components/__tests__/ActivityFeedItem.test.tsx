import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ActivityData } from "../../../electron/preload";
import { ActivityFeedItem } from "../ActivityFeedItem";

function renderActivity(activityType: string): string {
  const activity = {
    id: "activity-1",
    workspaceId: "ws-1",
    actorType: "system",
    activityType,
    title: "Escalated exchange",
    isRead: true,
    isPinned: false,
    createdAt: Date.now(),
  } as unknown as ActivityData;
  return renderToStaticMarkup(
    React.createElement(ActivityFeedItem, {
      activity,
      onMarkRead: () => {},
      onPin: () => {},
      onDelete: () => {},
    }),
  );
}

describe("ActivityFeedItem", () => {
  it("renders a retired activity type with the info icon and color", () => {
    const retired = renderActivity("supervisor_exchange");
    const info = renderActivity("info");
    const iconOf = (markup: string) =>
      markup.match(/<div class="activity-icon"[^>]*>.*?<\/div>/)?.[0] ?? "";

    expect(iconOf(retired)).not.toBe("");
    expect(iconOf(retired)).toContain("background-color:#3b82f6");
    expect(iconOf(retired)).toBe(iconOf(info));
  });
});
