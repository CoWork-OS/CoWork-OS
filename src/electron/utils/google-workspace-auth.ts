/**
 * Google Workspace OAuth helpers (token refresh)
 */

import { GoogleWorkspaceSettingsData } from "../../shared/types";
import {
  getActiveGoogleWorkspaceAccount,
  getGoogleWorkspaceSettingsForAccount,
  hasGoogleWorkspaceTokens,
  upsertGoogleWorkspaceAccount,
} from "../../shared/google-workspace";
import { GoogleWorkspaceSettingsManager } from "../settings/google-workspace-manager";
import { getBundledGoogleWorkspaceOAuthClientId } from "./google-workspace-oauth-client";

const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const TOKEN_REFRESH_BUFFER_MS = 2 * 60 * 1000;
const RECONNECT_HINT = "Reconnect Google Workspace in Settings > Integrations > Google Workspace.";
const inFlightRefreshes = new Map<string, Promise<string>>();
const recentTokenCache = new Map<string, { accessToken: string; expiresAt: number }>();

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

function getRefreshDedupeKey(settings: GoogleWorkspaceSettingsData): string {
  const activeAccount = getActiveGoogleWorkspaceAccount(settings);
  const effectiveSettings = getGoogleWorkspaceSettingsForAccount(settings);
  return [
    effectiveSettings.clientId || getBundledGoogleWorkspaceOAuthClientId() || "",
    activeAccount?.email || effectiveSettings.loginHint || settings.loginHint || "default",
    effectiveSettings.refreshToken || "",
  ].join("\n");
}

export async function refreshGoogleWorkspaceAccessToken(
  settings: GoogleWorkspaceSettingsData,
): Promise<string> {
  const key = getRefreshDedupeKey(settings);
  const existing = inFlightRefreshes.get(key);
  if (existing) return existing;

  const refreshPromise = refreshGoogleWorkspaceAccessTokenUncached(settings).finally(() => {
    inFlightRefreshes.delete(key);
  });
  inFlightRefreshes.set(key, refreshPromise);
  return refreshPromise;
}

async function refreshGoogleWorkspaceAccessTokenUncached(
  settings: GoogleWorkspaceSettingsData,
): Promise<string> {
  const activeAccount = getActiveGoogleWorkspaceAccount(settings);
  const effectiveSettings = getGoogleWorkspaceSettingsForAccount(settings);

  if (!effectiveSettings.refreshToken) {
    throw new Error(
      "Google Workspace refresh token not configured. Reconnect in Settings > Integrations > Google Workspace.",
    );
  }
  const clientId = effectiveSettings.clientId || getBundledGoogleWorkspaceOAuthClientId();
  if (!clientId) {
    throw new Error(
      "Google Workspace client ID not configured. Add it in Settings > Integrations > Google Workspace.",
    );
  }

  const params = new URLSearchParams({
    client_id: clientId,
    grant_type: "refresh_token",
    refresh_token: effectiveSettings.refreshToken,
  });

  if (effectiveSettings.clientSecret) {
    params.set("client_secret", effectiveSettings.clientSecret);
  }

  const response = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  const rawText = typeof response.text === "function" ? await response.text() : "";
  const data = rawText ? parseJsonSafe(rawText) : undefined;

  if (!response.ok) {
    const oauthError = typeof data?.error === "string" ? data.error : undefined;
    const message =
      data?.error_description || oauthError || response.statusText || "Token refresh failed";
    const normalizedMessage = String(message)
      .trim()
      .replace(/[.\s]+$/u, "");
    const shouldClearBrokenTokens =
      response.status === 400 &&
      (!oauthError ||
        oauthError === "invalid_grant" ||
        oauthError === "invalid_client" ||
        oauthError === "unauthorized_client");

    if (shouldClearBrokenTokens) {
      const clearedAccount = activeAccount
        ? upsertGoogleWorkspaceAccount(settings, {
            ...activeAccount,
            accessToken: undefined,
            refreshToken: undefined,
            tokenExpiresAt: undefined,
          })
        : undefined;
      const nextSettings: GoogleWorkspaceSettingsData = clearedAccount ?? {
        ...settings,
        accessToken: undefined,
        refreshToken: undefined,
        tokenExpiresAt: undefined,
      };
      GoogleWorkspaceSettingsManager.saveSettings(nextSettings);
      GoogleWorkspaceSettingsManager.clearCache();
      recentTokenCache.delete(getRefreshDedupeKey(settings));
    }

    throw Object.assign(
      new Error(`Google Workspace token refresh failed: ${normalizedMessage}. ${RECONNECT_HINT}`),
      {
        status: response.status,
        oauthError,
      },
    );
  }

  const accessToken = data?.access_token as string | undefined;
  if (!accessToken) {
    throw new Error("Google Workspace token refresh did not return an access_token");
  }

  const expiresIn = typeof data?.expires_in === "number" ? data.expires_in : undefined;
  let nextSettings: GoogleWorkspaceSettingsData = {
    ...settings,
    accessToken,
    tokenExpiresAt: expiresIn ? Date.now() + expiresIn * 1000 : effectiveSettings.tokenExpiresAt,
  };

  if (data?.refresh_token) {
    nextSettings.refreshToken = data.refresh_token;
  }

  const scopes = parseScopeList(data?.scope);
  if (scopes) {
    nextSettings.scopes = scopes;
  }

  if (activeAccount) {
    nextSettings = upsertGoogleWorkspaceAccount(settings, {
      ...activeAccount,
      accessToken,
      refreshToken: data?.refresh_token ?? activeAccount.refreshToken,
      tokenExpiresAt: nextSettings.tokenExpiresAt,
      scopes: scopes ?? activeAccount.scopes,
    });
  }

  GoogleWorkspaceSettingsManager.saveSettings(nextSettings);
  GoogleWorkspaceSettingsManager.clearCache();

  recentTokenCache.set(getRefreshDedupeKey(settings), {
    accessToken,
    expiresAt: nextSettings.tokenExpiresAt ?? 0,
  });

  return accessToken;
}

export async function getGoogleWorkspaceAccessToken(
  settings: GoogleWorkspaceSettingsData,
): Promise<string> {
  const effectiveSettings = getGoogleWorkspaceSettingsForAccount(settings);
  if (!hasGoogleWorkspaceTokens(settings)) {
    throw new Error(
      "Google Workspace access token not configured. Connect in Settings > Integrations > Google Workspace.",
    );
  }

  const now = Date.now();

  // Check in-memory token cache first — the settings object passed by callers
  // may be stale (captured before a previous refresh in the same sync loop).
  const cacheKey = getRefreshDedupeKey(settings);
  const cached = recentTokenCache.get(cacheKey);
  if (cached && (!cached.expiresAt || now < cached.expiresAt - TOKEN_REFRESH_BUFFER_MS)) {
    return cached.accessToken;
  }

  if (effectiveSettings.accessToken) {
    if (
      !effectiveSettings.tokenExpiresAt ||
      now < effectiveSettings.tokenExpiresAt - TOKEN_REFRESH_BUFFER_MS
    ) {
      return effectiveSettings.accessToken;
    }
  }

  if (effectiveSettings.refreshToken) {
    return refreshGoogleWorkspaceAccessToken(settings);
  }

  throw new Error(
    "Google Workspace access token expired. Reconnect in Settings > Integrations > Google Workspace.",
  );
}
