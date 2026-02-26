/**
 * Google Workspace OAuth helpers (token refresh)
 */

import { GoogleWorkspaceSettingsData } from "../../shared/types";
import { GoogleWorkspaceSettingsManager } from "../settings/google-workspace-manager";

const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const TOKEN_REFRESH_BUFFER_MS = 2 * 60 * 1000;

function parseJsonSafe(text: string): Any | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function parseScopeList(scope?: string): string[] | undefined {
  if (!scope) return undefined;
  return scope
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function refreshGoogleWorkspaceAccessToken(
  settings: GoogleWorkspaceSettingsData,
): Promise<string> {
  if (!settings.refreshToken) {
    throw new Error(
      "Google Workspace refresh token not configured. Reconnect in Settings > Integrations > Google Workspace.",
    );
  }
  if (!settings.clientId) {
    throw new Error(
      "Google Workspace client ID not configured. Add it in Settings > Integrations > Google Workspace.",
    );
  }

  const params = new URLSearchParams({
    client_id: settings.clientId,
    grant_type: "refresh_token",
    refresh_token: settings.refreshToken,
  });

  if (settings.clientSecret) {
    params.set("client_secret", settings.clientSecret);
  }

  const response = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  const rawText = typeof response.text === "function" ? await response.text() : "";
  const data = rawText ? parseJsonSafe(rawText) : undefined;

  if (!response.ok) {
    const message =
      data?.error_description || data?.error || response.statusText || "Token refresh failed";
    throw new Error(`Google Workspace token refresh failed: ${message}`);
  }

  const accessToken = data?.access_token as string | undefined;
  if (!accessToken) {
    throw new Error("Google Workspace token refresh did not return an access_token");
  }

  const expiresIn = typeof data?.expires_in === "number" ? data.expires_in : undefined;
  const nextSettings: GoogleWorkspaceSettingsData = {
    ...settings,
    accessToken,
    tokenExpiresAt: expiresIn ? Date.now() + expiresIn * 1000 : settings.tokenExpiresAt,
  };

  if (data?.refresh_token) {
    nextSettings.refreshToken = data.refresh_token;
  }

  const scopes = parseScopeList(data?.scope);
  if (scopes) {
    nextSettings.scopes = scopes;
  }

  GoogleWorkspaceSettingsManager.saveSettings(nextSettings);
  GoogleWorkspaceSettingsManager.clearCache();

  return accessToken;
}

export async function getGoogleWorkspaceAccessToken(
  settings: GoogleWorkspaceSettingsData,
): Promise<string> {
  if (!settings.accessToken && !settings.refreshToken) {
    throw new Error(
      "Google Workspace access token not configured. Connect in Settings > Integrations > Google Workspace.",
    );
  }

  const now = Date.now();
  if (settings.accessToken) {
    if (!settings.tokenExpiresAt || now < settings.tokenExpiresAt - TOKEN_REFRESH_BUFFER_MS) {
      return settings.accessToken;
    }
  }

  if (settings.refreshToken) {
    return refreshGoogleWorkspaceAccessToken(settings);
  }

  throw new Error(
    "Google Workspace access token expired. Reconnect in Settings > Integrations > Google Workspace.",
  );
}
