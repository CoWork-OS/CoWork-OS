import { beforeEach, describe, expect, it, vi } from "vitest";
import { refreshGoogleWorkspaceAccessToken } from "../google-workspace-auth";

const settingsManagerMock = vi.hoisted(() => ({
  saveSettings: vi.fn(),
  clearCache: vi.fn(),
}));

vi.mock("../../settings/google-workspace-manager", () => ({
  GoogleWorkspaceSettingsManager: settingsManagerMock,
}));

const fetchMock = vi.fn();
(globalThis as Any).fetch = fetchMock;

describe("refreshGoogleWorkspaceAccessToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deduplicates concurrent refreshes for the same account", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      text: vi.fn().mockResolvedValue(
        JSON.stringify({
          access_token: "new-access",
          expires_in: 3600,
        }),
      ),
    });

    const settings = {
      enabled: true,
      clientId: "client",
      clientSecret: "secret",
      accessToken: "old-access",
      refreshToken: "old-refresh",
      tokenExpiresAt: Date.now() - 1000,
    };

    await expect(
      Promise.all([
        refreshGoogleWorkspaceAccessToken(settings),
        refreshGoogleWorkspaceAccessToken(settings),
        refreshGoogleWorkspaceAccessToken(settings),
      ]),
    ).resolves.toEqual(["new-access", "new-access", "new-access"]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(settingsManagerMock.saveSettings).toHaveBeenCalledTimes(1);
    expect(settingsManagerMock.clearCache).toHaveBeenCalledTimes(1);
  });

  it("clears broken OAuth tokens and asks the user to reconnect on invalid refresh token", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      text: vi.fn().mockResolvedValue(
        JSON.stringify({
          error: "invalid_grant",
          error_description: "Token has been expired or revoked.",
        }),
      ),
    });

    await expect(
      refreshGoogleWorkspaceAccessToken({
        enabled: true,
        clientId: "client",
        clientSecret: "secret",
        accessToken: "old-access",
        refreshToken: "old-refresh",
        tokenExpiresAt: Date.now() - 1000,
      }),
    ).rejects.toThrow(
      "Google Workspace token refresh failed: Token has been expired or revoked. Reconnect Google Workspace",
    );

    expect(settingsManagerMock.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        clientId: "client",
        clientSecret: "secret",
        accessToken: undefined,
        refreshToken: undefined,
        tokenExpiresAt: undefined,
      }),
    );
    expect(settingsManagerMock.clearCache).toHaveBeenCalled();
  });
});
