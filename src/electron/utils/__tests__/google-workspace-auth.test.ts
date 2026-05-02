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
