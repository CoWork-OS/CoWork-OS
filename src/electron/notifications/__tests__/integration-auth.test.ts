import { afterEach, describe, expect, it, vi } from "vitest";
import {
  detectIntegrationAuthIssue,
  isLikelyIntegrationAuthError,
  notifyDetectedIntegrationAuthIssue,
  notifyIntegrationAuthIssue,
  resetIntegrationAuthNotificationDedupe,
  setIntegrationAuthNotificationServiceProvider,
} from "../integration-auth";

describe("integration auth notifications", () => {
  afterEach(() => {
    setIntegrationAuthNotificationServiceProvider(null);
    resetIntegrationAuthNotificationDedupe();
    vi.useRealTimers();
  });

  it("recognizes token and authorization failures", () => {
    expect(
      isLikelyIntegrationAuthError(Object.assign(new Error("Unauthorized"), { status: 401 })),
    ).toBe(true);
    expect(isLikelyIntegrationAuthError(new Error("Google Workspace token refresh failed"))).toBe(
      true,
    );
    expect(isLikelyIntegrationAuthError(new Error("request timed out"))).toBe(false);
  });

  it("maps logged integration failures to the right reconnect target", () => {
    expect(
      detectIntegrationAuthIssue(
        new Error("Gmail autosync paused: Google Workspace access token is not configured."),
      ),
    ).toMatchObject({
      integrationId: "google-workspace",
      settingsPath: "Settings > Integrations > Google Workspace",
    });

    expect(
      detectIntegrationAuthIssue(
        new Error(
          "Microsoft Outlook permission failed (403): missing scope. Reconnect the Outlook email channel.",
        ),
      ),
    ).toMatchObject({
      integrationId: "outlook-email",
      settingsPath: "Settings > Email",
    });

    expect(
      detectIntegrationAuthIssue(new Error("WhatsApp session logged out. Please re-authenticate.")),
    ).toMatchObject({
      integrationId: "whatsapp",
      settingsPath: "Settings > WhatsApp",
    });
  });

  it("adds one deduped warning notification per integration auth issue", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-11T12:00:00Z"));
    const add = vi.fn().mockResolvedValue({ id: "notification-1" });
    setIntegrationAuthNotificationServiceProvider(() => ({ add }) as Any);

    const first = await notifyIntegrationAuthIssue({
      integrationId: "google-workspace",
      integrationName: "Google Workspace",
      settingsPath: "Settings > Integrations > Google Workspace",
      reason: "Token has been expired or revoked.",
      dedupeKey: "auth",
    });
    const second = await notifyIntegrationAuthIssue({
      integrationId: "google-workspace",
      integrationName: "Google Workspace",
      settingsPath: "Settings > Integrations > Google Workspace",
      reason: "Token has been expired or revoked.",
      dedupeKey: "auth",
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(add).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "warning",
        title: "Reconnect Google Workspace",
        message: expect.stringContaining("Settings > Integrations > Google Workspace"),
      }),
    );
  });

  it("suppresses reconnect warnings while an earlier matching notification is still stored", async () => {
    const add = vi.fn().mockResolvedValue({ id: "notification-2" });
    const list = vi.fn(() => [
      {
        id: "notification-1",
        type: "warning",
        title: "Reconnect Google Workspace",
        message:
          "Google Workspace needs attention in Settings > Integrations > Google Workspace. Reconnect or resync it before automated work can continue.",
        read: false,
        createdAt: Date.now(),
      },
    ]);
    setIntegrationAuthNotificationServiceProvider(() => ({ add, list }) as Any);

    const result = await notifyIntegrationAuthIssue({
      integrationId: "google-workspace",
      integrationName: "Google Workspace",
      settingsPath: "Settings > Integrations > Google Workspace",
      reason: "Token has been expired or revoked.",
      dedupeKey: "auth",
    });

    expect(result).toBe(false);
    expect(add).not.toHaveBeenCalled();
  });

  it("allows a reconnect warning immediately after earlier matching notifications are cleared", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-11T12:00:00Z"));
    const add = vi.fn().mockResolvedValue({ id: "notification-1" });
    const list = vi.fn(() => []);
    setIntegrationAuthNotificationServiceProvider(() => ({ add, list }) as Any);

    await notifyIntegrationAuthIssue({
      integrationId: "google-workspace",
      integrationName: "Google Workspace",
      settingsPath: "Settings > Integrations > Google Workspace",
      reason: "Token has been expired or revoked.",
      dedupeKey: "auth",
    });
    const second = await notifyIntegrationAuthIssue({
      integrationId: "google-workspace",
      integrationName: "Google Workspace",
      settingsPath: "Settings > Integrations > Google Workspace",
      reason: "Token has been expired or revoked.",
      dedupeKey: "auth",
    });

    expect(second).toBe(true);
    expect(add).toHaveBeenCalledTimes(2);
  });

  it("adds a warning from a detected log/error message", async () => {
    const add = vi.fn().mockResolvedValue({ id: "notification-1" });
    setIntegrationAuthNotificationServiceProvider(() => ({ add }) as Any);

    const result = await notifyDetectedIntegrationAuthIssue(
      new Error("WhatsApp session logged out. Please re-authenticate."),
    );

    expect(result).toBe(true);
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "warning",
        title: "Reconnect WhatsApp",
        message: expect.stringContaining("Reconnect or resync"),
      }),
    );
  });
});
