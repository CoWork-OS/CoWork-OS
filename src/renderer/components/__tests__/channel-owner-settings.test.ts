import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChannelOwnerSettings } from "../ChannelOwnerSettings";

describe("ChannelOwnerSettings", () => {
  it("shows saved owner ids and a 'This is me' shortcut for allowed users", () => {
    const html = renderToStaticMarkup(
      React.createElement(ChannelOwnerSettings, {
        channel: { id: "channel-1", type: "telegram", config: { ownerUserIds: ["111"] } },
        users: [
          {
            id: "u1",
            channelId: "channel-1",
            channelUserId: "111",
            displayName: "Owner",
            allowed: true,
            lastSeenAt: 1,
          },
          {
            id: "u2",
            channelId: "channel-1",
            channelUserId: "222",
            displayName: "Friend",
            allowed: true,
            lastSeenAt: 1,
          },
          {
            id: "u3",
            channelId: "channel-1",
            channelUserId: "pending_ABC_1",
            displayName: "Pending User",
            allowed: false,
            lastSeenAt: 1,
          },
        ],
      }),
    );

    expect(html).toContain("Your account IDs on this channel");
    expect(html).toContain("numeric Telegram user ID");
    expect(html).toContain(">111</textarea>");
    expect(html).toContain("Not me");
    expect(html).toContain("This is me");
    expect(html).not.toContain("pending_ABC_1");
  });
});
