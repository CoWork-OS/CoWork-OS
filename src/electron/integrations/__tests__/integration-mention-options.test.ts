import { describe, expect, it } from "vitest";
import { buildIntegrationMentionOptionsFromState } from "../integration-mention-options";

describe("buildIntegrationMentionOptionsFromState", () => {
  it("splits configured Google Workspace into Gmail, Drive, and Calendar", () => {
    const options = buildIntegrationMentionOptionsFromState({
      builtins: {
        googleWorkspace: {
          enabled: true,
          clientId: "",
          clientSecret: "",
          refreshToken: "refresh",
          scopes: [],
          timeoutMs: 20000,
        },
      },
    });

    expect(options.map((option) => option.label)).toEqual([
      "Gmail",
      "Google Drive",
      "Google Calendar",
      "Inbox",
    ]);
    expect(options.some((option) => option.label === "Google Workspace")).toBe(false);
  });

  it("shows Inbox Agent when a mailbox backend is configured", () => {
    const googleBacked = buildIntegrationMentionOptionsFromState({
      builtins: {
        googleWorkspace: {
          enabled: true,
          refreshToken: "refresh",
          timeoutMs: 20000,
        },
      },
    });
    const channelBacked = buildIntegrationMentionOptionsFromState({
      channels: [
        {
          id: "email_1",
          type: "email",
          name: "Ops email",
          enabled: true,
          status: "connected",
          securityMode: "pairing",
          createdAt: 1,
        },
      ],
    });

    expect(googleBacked.some((option) => option.id === "builtin:inbox-agent")).toBe(true);
    expect(channelBacked.some((option) => option.id === "builtin:inbox-agent")).toBe(true);
  });

  it("hides enabled built-ins that do not have required credentials", () => {
    const options = buildIntegrationMentionOptionsFromState({
      builtins: {
        notion: { enabled: true, notionVersion: "2022-06-28", timeoutMs: 20000 },
        dropbox: { enabled: true, timeoutMs: 20000 },
      },
    });

    expect(options).toEqual([]);
  });

  it("returns connected Slack gateway channels", () => {
    const options = buildIntegrationMentionOptionsFromState({
      channels: [
        {
          id: "ch_1",
          type: "slack",
          name: "Workspace",
          enabled: true,
          status: "connected",
          securityMode: "pairing",
          createdAt: 1,
        },
      ],
    });

    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({
      id: "gateway:slack:ch_1",
      label: "Slack",
      iconKey: "slack",
      tools: ["channel_list_chats", "channel_history"],
    });
  });

  it("splits multi-service MCP Google Workspace tools by service", () => {
    const options = buildIntegrationMentionOptionsFromState({
      mcp: {
        settings: {
          toolNamePrefix: "mcp_",
          servers: [
            {
              id: "google-workspace",
              name: "Google Workspace",
              enabled: true,
              transport: "stdio",
              env: { GOOGLE_REFRESH_TOKEN: "refresh" },
            },
          ],
        },
        statuses: [
          {
            id: "google-workspace",
            name: "Google Workspace",
            status: "connected",
            tools: [
              { name: "drive_files_list", inputSchema: { type: "object" } },
              { name: "docs_create", inputSchema: { type: "object" } },
              { name: "sheets_create", inputSchema: { type: "object" } },
            ],
          },
        ],
      },
    });

    expect(options.map((option) => option.label)).toEqual([
      "Google Drive",
      "Google Docs",
      "Google Sheets",
    ]);
    expect(options.flatMap((option) => option.tools)).toContain("mcp_drive_files_list");
  });

  it("shows unknown MCP servers only when connected", () => {
    const disconnected = buildIntegrationMentionOptionsFromState({
      mcp: {
        settings: {
          toolNamePrefix: "mcp_",
          servers: [{ id: "custom", name: "Custom MCP", enabled: true, transport: "stdio" }],
        },
        statuses: [{ id: "custom", name: "Custom MCP", status: "disconnected", tools: [] }],
      },
    });
    const connected = buildIntegrationMentionOptionsFromState({
      mcp: {
        settings: {
          toolNamePrefix: "mcp_",
          servers: [{ id: "custom", name: "Custom MCP", enabled: true, transport: "stdio" }],
        },
        statuses: [
          {
            id: "custom",
            name: "Custom MCP",
            status: "connected",
            tools: [{ name: "custom_search", inputSchema: { type: "object" } }],
          },
        ],
      },
    });

    expect(disconnected).toEqual([]);
    expect(connected).toHaveLength(1);
    expect(connected[0].tools).toEqual(["mcp_custom_search"]);
  });
});
