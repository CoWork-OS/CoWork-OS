/**
 * Tests for Google Workspace tool error boundaries
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../../../../shared/types";
import { GmailTools } from "../gmail-tools";
import { GoogleCalendarTools } from "../google-calendar-tools";
import { GoogleWorkspaceSettingsManager } from "../../../settings/google-workspace-manager";
import { gmailRequest } from "../../../utils/gmail-api";
import { googleCalendarRequest } from "../../../utils/google-calendar-api";

vi.mock("../../../utils/gmail-api", () => ({
  gmailRequest: vi.fn(),
}));

vi.mock("../../../utils/google-calendar-api", () => ({
  googleCalendarRequest: vi.fn(),
}));

const workspace: Workspace = {
  id: "workspace-1",
  name: "Test Workspace",
  path: "/tmp",
  createdAt: Date.now(),
  permissions: {
    read: true,
    write: true,
    delete: true,
    network: true,
    shell: true,
  },
};

const taskId = "task-123";

const buildDaemon = () => ({
  requestApproval: vi.fn().mockResolvedValue(true),
  logEvent: vi.fn(),
});

let settingsSpy: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  settingsSpy = vi.spyOn(GoogleWorkspaceSettingsManager, "loadSettings");
});

beforeEach(() => {
  vi.clearAllMocks();
  settingsSpy.mockReturnValue({
    enabled: true,
    accessToken: "token",
    refreshToken: "refresh",
    clientId: "client",
  });
});

describe("GmailTools error boundary", () => {
  it("maps 401 errors to reconnect guidance", async () => {
    const daemon = buildDaemon();
    const tools = new GmailTools(workspace, daemon as Any, taskId);
    const gmailRequestMock = gmailRequest as unknown as ReturnType<typeof vi.fn>;
    gmailRequestMock.mockRejectedValueOnce(
      Object.assign(new Error("Unauthorized"), { status: 401 }),
    );

    await expect(tools.executeAction({ action: "get_profile" })).rejects.toThrow(
      "Google Workspace authorization failed (401).",
    );

    expect(daemon.logEvent).toHaveBeenCalledWith(
      taskId,
      "tool_error",
      expect.objectContaining({
        tool: "gmail_action",
        action: "get_profile",
        message: expect.stringContaining("authorization failed"),
        status: 401,
      }),
    );
  });

  it("maps token refresh errors to auth guidance", async () => {
    const daemon = buildDaemon();
    const tools = new GmailTools(workspace, daemon as Any, taskId);
    const gmailRequestMock = gmailRequest as unknown as ReturnType<typeof vi.fn>;
    gmailRequestMock.mockRejectedValueOnce(
      new Error("Google Workspace token refresh failed: invalid_grant"),
    );

    await expect(tools.executeAction({ action: "get_profile" })).rejects.toThrow(
      "Google Workspace authorization error: Google Workspace token refresh failed: invalid_grant",
    );

    expect(daemon.logEvent).toHaveBeenCalledWith(
      taskId,
      "tool_error",
      expect.objectContaining({
        tool: "gmail_action",
        action: "get_profile",
        message: expect.stringContaining("authorization error"),
      }),
    );
  });

  it("logs and rethrows non-auth errors", async () => {
    const daemon = buildDaemon();
    const tools = new GmailTools(workspace, daemon as Any, taskId);
    const gmailRequestMock = gmailRequest as unknown as ReturnType<typeof vi.fn>;
    gmailRequestMock.mockRejectedValueOnce(new Error("Gmail API error 500: nope"));

    await expect(tools.executeAction({ action: "get_profile" })).rejects.toThrow(
      "Gmail API error 500: nope",
    );

    expect(daemon.logEvent).toHaveBeenCalledWith(
      taskId,
      "tool_error",
      expect.objectContaining({
        tool: "gmail_action",
        action: "get_profile",
        message: "Gmail API error 500: nope",
      }),
    );
  });
});

describe("GoogleCalendarTools error boundary", () => {
  it("maps 401 errors to reconnect guidance", async () => {
    const daemon = buildDaemon();
    const tools = new GoogleCalendarTools(workspace, daemon as Any, taskId);
    const calendarRequestMock = googleCalendarRequest as unknown as ReturnType<typeof vi.fn>;
    calendarRequestMock.mockRejectedValueOnce(
      Object.assign(new Error("Unauthorized"), { status: 401 }),
    );

    await expect(tools.executeAction({ action: "list_calendars" })).rejects.toThrow(
      "Google Workspace authorization failed (401).",
    );

    expect(daemon.logEvent).toHaveBeenCalledWith(
      taskId,
      "tool_error",
      expect.objectContaining({
        tool: "calendar_action",
        action: "list_calendars",
        message: expect.stringContaining("authorization failed"),
        status: 401,
      }),
    );
  });

  it("logs and rethrows non-auth errors", async () => {
    const daemon = buildDaemon();
    const tools = new GoogleCalendarTools(workspace, daemon as Any, taskId);
    const calendarRequestMock = googleCalendarRequest as unknown as ReturnType<typeof vi.fn>;
    calendarRequestMock.mockRejectedValueOnce(new Error("Google Calendar API error 500: nope"));

    await expect(tools.executeAction({ action: "list_calendars" })).rejects.toThrow(
      "Google Calendar API error 500: nope",
    );

    expect(daemon.logEvent).toHaveBeenCalledWith(
      taskId,
      "tool_error",
      expect.objectContaining({
        tool: "calendar_action",
        action: "list_calendars",
        message: "Google Calendar API error 500: nope",
      }),
    );
  });
});
