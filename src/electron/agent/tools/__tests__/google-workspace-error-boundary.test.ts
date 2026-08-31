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

function gmailResult(data: Any, status = 200): Any {
  return { status, data };
}

function decodeGmailRaw(raw: string): string {
  const normalized = raw.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf8");
}

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

  it("maps Gmail scope errors to reconnect guidance", async () => {
    const daemon = buildDaemon();
    const tools = new GmailTools(workspace, daemon as Any, taskId);
    const gmailRequestMock = gmailRequest as unknown as ReturnType<typeof vi.fn>;
    gmailRequestMock.mockRejectedValueOnce(
      Object.assign(
        new Error("Gmail API error 403: Request had insufficient authentication scopes."),
        {
          status: 403,
        },
      ),
    );

    await expect(
      tools.executeAction({ action: "archive_thread", thread_id: "thread-1" }),
    ).rejects.toThrow(
      "Google Workspace authorization failed (403): Gmail modify scope is missing.",
    );

    expect(daemon.logEvent).toHaveBeenCalledWith(
      taskId,
      "tool_error",
      expect.objectContaining({
        tool: "gmail_action",
        action: "archive_thread",
        message: expect.stringContaining("Gmail modify scope is missing"),
        status: 403,
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

  it("searches Gmail with Codex-style summaries", async () => {
    const daemon = buildDaemon();
    const tools = new GmailTools(workspace, daemon as Any, taskId);
    const gmailRequestMock = gmailRequest as unknown as ReturnType<typeof vi.fn>;
    gmailRequestMock
      .mockResolvedValueOnce(
        gmailResult({
          messages: [{ id: "msg-1", threadId: "thread-1" }],
          nextPageToken: "next-1",
          resultSizeEstimate: 1,
        }),
      )
      .mockResolvedValueOnce(
        gmailResult({
          id: "msg-1",
          threadId: "thread-1",
          labelIds: ["INBOX", "UNREAD"],
          snippet: "Latest snippet",
          payload: {
            headers: [
              { name: "Subject", value: "Status update" },
              { name: "From", value: "Pat <pat@example.com>" },
              { name: "To", value: "me@example.com" },
              { name: "Date", value: "Mon, 18 May 2026 10:00:00 +0000" },
            ],
          },
        }),
      );

    const result = await tools.executeCodexStyleTool("gmail_search_emails", {
      query: "in:inbox newer_than:7d",
      label_ids: ["INBOX"],
      max_results: 20,
    });

    expect(gmailRequestMock).toHaveBeenNthCalledWith(
      1,
      expect.any(Object),
      expect.objectContaining({
        method: "GET",
        path: "/users/me/messages",
        query: expect.objectContaining({
          q: "in:inbox newer_than:7d",
          labelIds: ["INBOX"],
          maxResults: 20,
        }),
      }),
    );
    expect(result).toMatchObject({
      success: true,
      next_page_token: "next-1",
      emails: [
        {
          id: "msg-1",
          thread_id: "thread-1",
          subject: "Status update",
          from: "Pat <pat@example.com>",
          label_ids: ["INBOX", "UNREAD"],
        },
      ],
    });
  });

  it("resolves a message ID before reading a Codex-style Gmail thread", async () => {
    const daemon = buildDaemon();
    const tools = new GmailTools(workspace, daemon as Any, taskId);
    const gmailRequestMock = gmailRequest as unknown as ReturnType<typeof vi.fn>;
    gmailRequestMock
      .mockResolvedValueOnce(gmailResult({ id: "msg-1", threadId: "thread-1", payload: {} }))
      .mockResolvedValueOnce(
        gmailResult({
          id: "thread-1",
          messages: [
            {
              id: "msg-1",
              threadId: "thread-1",
              snippet: "Hello",
              payload: {
                headers: [{ name: "Subject", value: "Thread" }],
                parts: [
                  {
                    mimeType: "text/plain",
                    body: { data: Buffer.from("Full body").toString("base64url") },
                  },
                ],
              },
            },
          ],
        }),
      );

    const result = await tools.executeCodexStyleTool("gmail_read_email_thread", {
      id: "msg-1",
    });

    expect(gmailRequestMock).toHaveBeenNthCalledWith(
      2,
      expect.any(Object),
      expect.objectContaining({
        method: "GET",
        path: "/users/me/threads/thread-1",
        query: { format: "full" },
      }),
    );
    expect(result.messages[0]).toMatchObject({
      id: "msg-1",
      body: "Full body",
    });
  });

  it("applies Gmail labels by display name with explicit approval", async () => {
    const daemon = buildDaemon();
    const tools = new GmailTools(workspace, daemon as Any, taskId);
    const gmailRequestMock = gmailRequest as unknown as ReturnType<typeof vi.fn>;
    gmailRequestMock
      .mockResolvedValueOnce(
        gmailResult({
          labels: [{ id: "Label_1", name: "Waiting" }],
        }),
      )
      .mockResolvedValueOnce(gmailResult({}, 204));

    const result = await tools.executeCodexStyleTool("gmail_apply_labels_to_emails", {
      message_ids: ["msg-1"],
      add_label_names: ["Waiting"],
    });

    expect(daemon.requestApproval).toHaveBeenCalledWith(
      taskId,
      "external_service",
      "Apply Gmail labels to selected messages",
      expect.objectContaining({
        tool: "gmail_apply_labels_to_emails",
        message_ids: ["msg-1"],
      }),
    );
    expect(await daemon.requestApproval.mock.results[0]?.value).toBe(true);
    expect(gmailRequestMock).toHaveBeenNthCalledWith(
      2,
      expect.any(Object),
      expect.objectContaining({
        method: "POST",
        path: "/users/me/messages/batchModify",
        body: {
          ids: ["msg-1"],
          addLabelIds: ["Label_1"],
          removeLabelIds: [],
        },
      }),
    );
    expect(result).toMatchObject({ success: true, status: 204 });
  });

  it("requests approval before Codex-style Gmail send", async () => {
    const daemon = buildDaemon();
    const tools = new GmailTools(workspace, daemon as Any, taskId);
    const gmailRequestMock = gmailRequest as unknown as ReturnType<typeof vi.fn>;
    gmailRequestMock.mockResolvedValueOnce(gmailResult({ id: "sent-1" }));

    await tools.executeCodexStyleTool("gmail_send_email", {
      to: "test@example.com",
      subject: "Hello",
      body: "Olá email",
    });

    expect(daemon.requestApproval).toHaveBeenCalledWith(
      taskId,
      "external_service",
      "Send a Gmail message",
      expect.objectContaining({
        tool: "gmail_send_email",
        to: "test@example.com",
        subject: "Hello",
      }),
    );
    const sendRequest = gmailRequestMock.mock.calls[0]?.[1] as Any;
    const rawMessage = decodeGmailRaw(sendRequest.body.raw);
    expect(rawMessage).toContain("Content-Transfer-Encoding: base64");
    expect(rawMessage).not.toContain("Olá email");
    expect(Buffer.from(rawMessage.split("\r\n\r\n")[1], "base64").toString("utf8")).toBe(
      "Olá email",
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
