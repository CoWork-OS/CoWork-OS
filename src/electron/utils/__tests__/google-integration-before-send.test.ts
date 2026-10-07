import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GoogleWorkspaceSettingsData, NotionSettingsData } from "../../../shared/types";
import { gmailRequest } from "../gmail-api";
import { googleCalendarRequest } from "../google-calendar-api";
import { notionRequest } from "../notion-api";
import {
  getGoogleWorkspaceAccessToken,
  refreshGoogleWorkspaceAccessToken,
} from "../google-workspace-auth";

vi.mock("../google-workspace-auth", () => ({
  getGoogleWorkspaceAccessToken: vi.fn().mockResolvedValue("access-token"),
  refreshGoogleWorkspaceAccessToken: vi.fn().mockResolvedValue("refreshed-token"),
}));

const settings = {
  enabled: true,
  accessToken: "access-token",
  refreshToken: "refresh-token",
  clientId: "client-id",
  timeoutMs: 5000,
} as GoogleWorkspaceSettingsData;

function response(status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 401 ? "Unauthorized" : "OK",
    text: async () => (status === 401 ? '{"error":{"message":"Unauthorized"}}' : "{}"),
  };
}

describe("Google Workspace effect send callbacks", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getGoogleWorkspaceAccessToken).mockResolvedValue("access-token");
    vi.mocked(refreshGoogleWorkspaceAccessToken).mockResolvedValue("refreshed-token");
    fetchMock = vi.fn().mockResolvedValue(response());
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("awaits the Gmail authority callback and prevents fetch when it rejects", async () => {
    const order: string[] = [];
    const beforeSend = vi.fn(async () => {
      order.push("review");
      throw new Error("authority revoked");
    });

    await expect(
      gmailRequest(settings, {
        method: "POST",
        path: "/users/me/messages/send",
        body: { raw: "reviewed" },
        beforeSend,
      }),
    ).rejects.toThrow("authority revoked");

    expect(order).toEqual(["review"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("awaits the Calendar authority callback and prevents fetch when it rejects", async () => {
    const beforeSend = vi.fn().mockRejectedValue(new Error("authority revoked"));

    await expect(
      googleCalendarRequest(settings, {
        method: "DELETE",
        path: "/calendars/primary/events/event-1",
        beforeSend,
      }),
    ).rejects.toThrow("authority revoked");

    expect(beforeSend).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("awaits the Notion authority callback and prevents fetch when it rejects", async () => {
    const beforeSend = vi.fn().mockRejectedValue(new Error("authority revoked"));

    await expect(
      notionRequest({ enabled: true, apiKey: "notion-token" } as NotionSettingsData, {
        method: "PATCH",
        path: "/pages/page-1",
        body: { archived: true },
        beforeSend,
      }),
    ).rejects.toThrow("authority revoked");

    expect(beforeSend).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rechecks Gmail authority for a retry after token refresh", async () => {
    fetchMock.mockResolvedValueOnce(response(401)).mockResolvedValueOnce(response(200));
    const beforeSend = vi.fn();

    await gmailRequest(settings, {
      method: "POST",
      path: "/users/me/messages/send",
      body: { raw: "reviewed" },
      beforeSend,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(beforeSend).toHaveBeenCalledTimes(2);
  });
});
