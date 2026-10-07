import { credentialFingerprint, recordOAuthRefresh } from "../security/oauth-refresh-proof";
import type { MCPAuthConfig } from "../mcp/types";
/**
 * Box API helpers
 */

import { BoxConnectionTestResult, BoxSettingsData } from "../../shared/types";
import { BoxSettingsManager } from "../settings/box-manager";

export const BOX_API_BASE = "https://api.box.com/2.0";
export const BOX_UPLOAD_BASE = "https://upload.box.com/api/2.0";
export const BOX_TOKEN_URL = "https://api.box.com/oauth2/token";
const DEFAULT_TIMEOUT_MS = 20000;
const boxRefreshPromises = new Map<string, Promise<BoxSettingsData>>();
function boxCredential(settings: BoxSettingsData): MCPAuthConfig {
  return {
    type: "bearer",
    token: settings.accessToken,
    refreshToken: settings.refreshToken,
    clientId: settings.clientId,
    clientSecret: settings.clientSecret,
    tokenUrl: settings.refreshToken ? BOX_TOKEN_URL : undefined,
    expiresAt: settings.tokenExpiresAt,
  };
}

function parseJsonSafe(text: string): Any | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function formatBoxError(status: number, data: Any, fallback?: string): string {
  const message =
    data?.message || data?.error?.message || data?.error_description || fallback || "Box API error";
  return `Box API error ${status}: ${message}`;
}

export interface BoxRequestOptions {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: Record<string, Any>;
  timeoutMs?: number;
  beforeSend?: () => void | Promise<void>;
}

export interface BoxRequestResult {
  status: number;
  data?: Any;
  raw?: string;
}

export async function getBoxAccessToken(settings: BoxSettingsData): Promise<string> {
  if (!settings.accessToken && !settings.refreshToken) {
    throw new Error("Box access token not configured. Add it in Settings > Integrations > Box.");
  }

  const refreshBeforeMs = 60_000;
  const tokenIsFresh =
    Boolean(settings.accessToken) &&
    (!settings.tokenExpiresAt || settings.tokenExpiresAt > Date.now() + refreshBeforeMs);
  if (tokenIsFresh) {
    return settings.accessToken!;
  }

  if (!settings.refreshToken || !settings.clientId || !settings.clientSecret) {
    if (settings.accessToken) return settings.accessToken;
    throw new Error("Box OAuth credentials are incomplete. Reconnect Box with OAuth.");
  }

  const source = structuredClone(settings);
  const before = boxCredential(source);
  const key = credentialFingerprint(before);
  let refresh = boxRefreshPromises.get(key);
  if (!refresh) {
    if (boxRefreshPromises.size >= 32)
      throw new Error("Too many concurrent Box credential refreshes");
    refresh = (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), source.timeoutMs || DEFAULT_TIMEOUT_MS);

      try {
        const response = await fetch(BOX_TOKEN_URL, {
          method: "POST",
          redirect: "manual",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: source.clientId!,
            client_secret: source.clientSecret!,
            refresh_token: source.refreshToken!,
          }).toString(),
          signal: controller.signal,
        });
        const rawText = await response.text();
        const data = rawText ? parseJsonSafe(rawText) : undefined;
        if (!response.ok) {
          throw new Error(formatBoxError(response.status, data, response.statusText));
        }
        if (
          typeof data?.access_token !== "string" ||
          !data.access_token.trim() ||
          (data.refresh_token !== undefined &&
            (typeof data.refresh_token !== "string" || !data.refresh_token.trim()))
        ) {
          throw new Error("Box OAuth refresh did not return an access token");
        }

        const current = BoxSettingsManager.loadSettings();
        if (credentialFingerprint(boxCredential(current)) !== key)
          throw new Error("Box credentials changed during token refresh");
        const refreshed: BoxSettingsData = {
          ...current,
          accessToken: data.access_token,
          refreshToken: data.refresh_token || source.refreshToken,
          tokenExpiresAt:
            typeof data.expires_in === "number" ? Date.now() + data.expires_in * 1000 : undefined,
        };
        BoxSettingsManager.saveSettings(refreshed);
        recordOAuthRefresh(before, boxCredential(refreshed));
        return refreshed;
      } catch (error: Any) {
        if (error?.name === "AbortError") {
          throw new Error("Box OAuth refresh timed out");
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    })().finally(() => {
      if (boxRefreshPromises.get(key) === refresh) boxRefreshPromises.delete(key);
    });
    boxRefreshPromises.set(key, refresh);
  }
  const refreshed = await refresh;
  Object.assign(settings, refreshed);
  return refreshed.accessToken!;
}

export async function boxRequest(
  settings: BoxSettingsData,
  options: BoxRequestOptions,
): Promise<BoxRequestResult> {
  const accessToken = await getBoxAccessToken(settings);

  const params = new URLSearchParams();
  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) {
      if (value === undefined || value === null) continue;
      params.set(key, String(value));
    }
  }
  const queryString = params.toString();
  const url = `${BOX_API_BASE}${options.path}${queryString ? `?${queryString}` : ""}`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
  };

  if (options.method !== "GET" && options.method !== "DELETE") {
    headers["Content-Type"] = "application/json";
  }

  const timeoutMs = options.timeoutMs ?? settings.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  await options.beforeSend?.();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: options.method,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });

    const rawText = typeof response.text === "function" ? await response.text() : "";
    const data = rawText ? parseJsonSafe(rawText) : undefined;

    if (!response.ok) {
      throw new Error(formatBoxError(response.status, data, response.statusText));
    }

    return {
      status: response.status,
      data: data ?? undefined,
      raw: rawText || undefined,
    };
  } catch (error: Any) {
    if (error?.name === "AbortError") {
      throw new Error("Box API request timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function boxUploadFile(
  settings: BoxSettingsData,
  opts: {
    fileName: string;
    parentId: string;
    data: Uint8Array;
    timeoutMs?: number;
    beforeSend?: () => Promise<void>;
  },
): Promise<BoxRequestResult> {
  const fileName = opts.fileName,
    parentId = opts.parentId;
  const fileData = new Uint8Array(opts.data);
  const beforeSend = opts.beforeSend;
  const accessToken = await getBoxAccessToken(settings);

  if (typeof FormData === "undefined") {
    throw new Error("FormData not available in this environment");
  }

  const form = new FormData();
  form.append("attributes", JSON.stringify({ name: fileName, parent: { id: parentId } }));
  // Create a copy with a regular ArrayBuffer to satisfy BlobPart type requirements
  form.append("file", new Blob([fileData]), fileName);

  const url = `${BOX_UPLOAD_BASE}/files/content`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
  };

  const timeoutMs = opts.timeoutMs ?? settings.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    await beforeSend?.();
    const response = await fetch(url, {
      method: "POST",
      redirect: "manual",
      headers,
      body: form,
      signal: controller.signal,
    });

    const rawText = typeof response.text === "function" ? await response.text() : "";
    const data = rawText ? parseJsonSafe(rawText) : undefined;

    if (!response.ok) {
      throw new Error(formatBoxError(response.status, data, response.statusText));
    }

    return {
      status: response.status,
      data: data ?? undefined,
      raw: rawText || undefined,
    };
  } catch (error: Any) {
    if (error?.name === "AbortError") {
      throw new Error("Box upload request timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function extractUserInfo(data: Any): { name?: string; userId?: string } {
  if (!data || typeof data !== "object") return {};
  const name = data.name || data.login || undefined;
  const userId = data.id || data.user_id || undefined;
  return { name, userId };
}

export async function testBoxConnection(
  settings: BoxSettingsData,
): Promise<BoxConnectionTestResult> {
  try {
    const result = await boxRequest(settings, { method: "GET", path: "/users/me" });
    const extracted = extractUserInfo(result.data);
    return {
      success: true,
      name: extracted.name,
      userId: extracted.userId,
    };
  } catch (error: Any) {
    return {
      success: false,
      error: error?.message || "Failed to connect to Box",
    };
  }
}
