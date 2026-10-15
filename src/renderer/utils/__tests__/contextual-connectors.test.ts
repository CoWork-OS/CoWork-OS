import { afterEach, describe, expect, it, vi } from "vitest";
import type { IntegrationMentionOption } from "../../../shared/types";
import {
  CONTEXTUAL_CONNECTORS,
  findContextualConnectors,
  hasConnectedMention,
  readConnectorReadiness,
} from "../contextual-connectors";

const target = (id: string) => CONTEXTUAL_CONNECTORS.find((connector) => connector.id === id)!;
afterEach(() => vi.unstubAllGlobals());

describe("contextual connector discovery", () => {
  it.each([
    ["Create an update from my Linear issues. Do not change issues.", ["linear"]],
    ["Triage my Gmail inbox. Do not send messages.", ["gmail"]],
    ["Read from Notion and from Google Drive", ["google-drive", "notion"]],
    ["Summarize @Jira issues", ["jira"]],
    ["Triage my inbox", []],
    ["Explain linear regression", []],
    ["Compare Jira and Asana", []],
    ["Build a client for Linear", []],
    ["Do not use my Gmail inbox; read from Notion instead", ["notion"]],
    ["Work without my Linear account", []],
    ["Search in my GmailBackup export", []],
    ["Summarize Gmail messages", ["gmail"]],
    ["Summarize my Linear export file", []],
  ])("suggests only intended sources for %s", (prompt, ids) => {
    expect(findContextualConnectors(prompt).map((connector) => connector.id)).toEqual(ids);
  });

  it("does not equate configured MCP credentials with a live connection", () => {
    const option = {
      id: "mcp:work-linear",
      label: "Work tracker",
      source: "mcp",
      providerKey: "work-linear",
      iconKey: "linear",
      status: "configured",
    } as IntegrationMentionOption;
    expect(hasConnectedMention(target("linear"), [option])).toBe(false);
    expect(hasConnectedMention(target("linear"), [{ ...option, status: "connected" }])).toBe(true);
  });
});

describe("connector readiness uses existing host status", () => {
  it("requires a live native status rather than a saved token", async () => {
    vi.stubGlobal("window", {
      electronAPI: {
        getNotionStatus: async () => ({
          configured: true,
          connected: false,
          error: "Token expired",
        }),
      },
    });
    expect(await readConnectorReadiness(target("notion"))).toEqual({
      connected: false,
      error: "Token expired",
      account: undefined,
    });
  });
  it("does not claim Drive is connected with Gmail-only permissions", async () => {
    vi.stubGlobal("window", {
      electronAPI: {
        getGoogleWorkspaceStatus: async () => ({
          connected: true,
          connectionMode: "gmail",
          name: "Selected account",
        }),
      },
    });
    expect((await readConnectorReadiness(target("google-drive"))).connected).toBe(false);
    expect(await readConnectorReadiness(target("gmail"))).toMatchObject({
      connected: true,
      account: "Selected account",
    });
  });
  it("requires missing Google permissions to be repaired", async () => {
    vi.stubGlobal("window", {
      electronAPI: {
        getGoogleWorkspaceStatus: async () => ({
          connected: true,
          connectionMode: "workspace",
          missingScopes: ["drive.readonly"],
        }),
      },
    });
    expect(await readConnectorReadiness(target("google-drive"))).toMatchObject({
      connected: false,
      error: expect.stringContaining("permissions"),
    });
  });
  it("keeps a failed status lookup actionable", async () => {
    vi.stubGlobal("window", {
      electronAPI: {
        getNotionStatus: async () => {
          throw new Error("Host unavailable");
        },
      },
    });
    expect(await readConnectorReadiness(target("notion"))).toEqual({
      connected: false,
      error: "Host unavailable",
    });
  });
  it("allows an existing MCP route for a native app", async () => {
    const getNotionStatus = vi.fn();
    vi.stubGlobal("window", {
      electronAPI: {
        getNotionStatus,
        listIntegrationMentionOptions: async () => [
          {
            id: "mcp:work-notion",
            iconKey: "notion",
            source: "mcp",
            label: "Work notes",
            status: "connected",
          },
        ],
      },
    });
    expect((await readConnectorReadiness(target("notion"))).connected).toBe(true);
    expect(getNotionStatus).not.toHaveBeenCalled();
  });
  it("bounds an unresponsive host check so the request can still be recovered", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("window", { electronAPI: { getNotionStatus: () => new Promise(() => {}) } });
      const pending = readConnectorReadiness(target("notion"));
      await vi.advanceTimersByTimeAsync(6000);
      expect(await pending).toMatchObject({
        connected: false,
        error: expect.stringContaining("timed out"),
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
