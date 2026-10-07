import { beforeEach, describe, expect, it, vi } from "vitest";
import { refreshGoogleWorkspaceAccessToken } from "../google-workspace-auth";
import { isProvenOAuthRefresh } from "../../security/oauth-refresh-proof";

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

    const originalExpiry = Date.now() - 1000;
    const settings = {
      enabled: true,
      clientId: "client",
      clientSecret: "secret",
      accessToken: "old-access",
      refreshToken: "old-refresh",
      tokenExpiresAt: originalExpiry,
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
    expect(
      isProvenOAuthRefresh(
        {
          type: "bearer",
          token: "old-access",
          refreshToken: "old-refresh",
          clientId: "client",
          clientSecret: "secret",
          tokenUrl: "https://oauth2.googleapis.com/token",
          expiresAt: originalExpiry,
        },
        {
          type: "bearer",
          token: "new-access",
          refreshToken: "old-refresh",
          clientId: "client",
          clientSecret: "secret",
          tokenUrl: "https://oauth2.googleapis.com/token",
          expiresAt: settingsManagerMock.saveSettings.mock.calls[0][0].tokenExpiresAt,
        },
      ),
    ).toBe(true);
  });

  it("records trusted refreshes for Google's public OAuth client without a secret", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      text: vi.fn().mockResolvedValue(JSON.stringify({ access_token: "public-new-access" })),
    });
    await refreshGoogleWorkspaceAccessToken({
      enabled: true,
      clientId: "public-client",
      accessToken: "public-old-access",
      refreshToken: "public-refresh",
    });

    expect(
      isProvenOAuthRefresh(
        {
          type: "bearer",
          token: "public-old-access",
          refreshToken: "public-refresh",
          clientId: "public-client",
          tokenUrl: "https://oauth2.googleapis.com/token",
        },
        {
          type: "bearer",
          token: "public-new-access",
          refreshToken: "public-refresh",
          clientId: "public-client",
          tokenUrl: "https://oauth2.googleapis.com/token",
        },
      ),
    ).toBe(true);
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
