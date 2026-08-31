/**
 * Box API helpers
 */

import { BoxConnectionTestResult, BoxSettingsData } from "../../shared/types";
import { BoxSettingsManager } from "../settings/box-manager";

export const BOX_API_BASE = "https://api.box.com/2.0";
export const BOX_UPLOAD_BASE = "https://upload.box.com/api/2.0";
export const BOX_TOKEN_URL = "https://api.box.com/oauth2/token";
const DEFAULT_TIMEOUT_MS = 20000;
let boxRefreshPromise: Promise<string> | null = null;

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

  if (boxRefreshPromise) return boxRefreshPromise;

  boxRefreshPromise = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), settings.timeoutMs || DEFAULT_TIMEOUT_MS);

    try {
      const response = await fetch(BOX_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: settings.clientId!,
          client_secret: settings.clientSecret!,
          refresh_token: settings.refreshToken!,
        }).toString(),
        signal: controller.signal,
      });
      const rawText = await response.text();
      const data = rawText ? parseJsonSafe(rawText) : undefined;
      if (!response.ok) {
        throw new Error(formatBoxError(response.status, data, response.statusText));
      }
      if (!data?.access_token) {
        throw new Error("Box OAuth refresh did not return an access token");
      }

      const refreshed: BoxSettingsData = {
        ...settings,
        accessToken: data.access_token,
        refreshToken: data.refresh_token || settings.refreshToken,
        tokenExpiresAt:
          typeof data.expires_in === "number" ? Date.now() + data.expires_in * 1000 : undefined,
      };
      BoxSettingsManager.saveSettings(refreshed);
      Object.assign(settings, refreshed);
      return data.access_token as string;
    } catch (error: Any) {
      if (error?.name === "AbortError") {
        throw new Error("Box OAuth refresh timed out");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  })().finally(() => {
    boxRefreshPromise = null;
  });

  return boxRefreshPromise;
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
  opts: { fileName: string; parentId: string; data: Uint8Array; timeoutMs?: number },
): Promise<BoxRequestResult> {
  const accessToken = await getBoxAccessToken(settings);

  if (typeof FormData === "undefined") {
    throw new Error("FormData not available in this environment");
  }

  const form = new FormData();
  form.append("attributes", JSON.stringify({ name: opts.fileName, parent: { id: opts.parentId } }));
  // Create a copy with a regular ArrayBuffer to satisfy BlobPart type requirements
  const fileData = new Uint8Array(opts.data);
  form.append("file", new Blob([fileData]), opts.fileName);

  const url = `${BOX_UPLOAD_BASE}/files/content`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
  };

  const timeoutMs = opts.timeoutMs ?? settings.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
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
