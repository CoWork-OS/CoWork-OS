/**
 * Dropbox API helpers
 */

import { DropboxConnectionTestResult, DropboxSettingsData } from "../../shared/types";

export const DROPBOX_API_BASE = "https://api.dropboxapi.com/2";
export const DROPBOX_CONTENT_BASE = "https://content.dropboxapi.com/2";
const DEFAULT_TIMEOUT_MS = 20000;

function parseJsonSafe(text: string): Any | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function formatDropboxError(status: number, data: Any, fallback?: string): string {
  const message =
    data?.error_summary || data?.error?.summary || data?.message || fallback || "Dropbox API error";
  return `Dropbox API error ${status}: ${message}`;
}

export interface DropboxRequestOptions {
  method: "POST";
  path: string;
  body?: Record<string, Any>;
  timeoutMs?: number;
}

export interface DropboxRequestResult {
  status: number;
  data?: Any;
  raw?: string;
}

export async function dropboxRequest(
  settings: DropboxSettingsData,
  options: DropboxRequestOptions,
): Promise<DropboxRequestResult> {
  if (!settings.accessToken) {
    throw new Error(
      "Dropbox access token not configured. Add it in Settings > Integrations > Dropbox.",
    );
  }

  const url = `${DROPBOX_API_BASE}${options.path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${settings.accessToken}`,
    "Content-Type": "application/json",
  };

  const timeoutMs = options.timeoutMs ?? settings.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: options.method,
      headers,
      body: JSON.stringify(options.body || {}),
      signal: controller.signal,
    });

    const rawText = typeof response.text === "function" ? await response.text() : "";
    const data = rawText ? parseJsonSafe(rawText) : undefined;

    if (!response.ok) {
      throw new Error(formatDropboxError(response.status, data, response.statusText));
    }

    return {
      status: response.status,
      data: data ?? undefined,
      raw: rawText || undefined,
    };
  } catch (error: Any) {
    if (error?.name === "AbortError") {
      throw new Error("Dropbox API request timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function dropboxContentUpload(
  settings: DropboxSettingsData,
  opts: { path: string; data: Uint8Array; timeoutMs?: number },
): Promise<DropboxRequestResult> {
  if (!settings.accessToken) {
    throw new Error(
      "Dropbox access token not configured. Add it in Settings > Integrations > Dropbox.",
    );
  }

  const url = `${DROPBOX_CONTENT_BASE}/files/upload`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${settings.accessToken}`,
    "Content-Type": "application/octet-stream",
    "Dropbox-API-Arg": JSON.stringify({
      path: opts.path,
      mode: "add",
      autorename: true,
      mute: false,
      strict_conflict: false,
    }),
  };

  const timeoutMs = opts.timeoutMs ?? settings.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: Buffer.from(opts.data),
      signal: controller.signal,
    });

    const rawText = typeof response.text === "function" ? await response.text() : "";
    const data = rawText ? parseJsonSafe(rawText) : undefined;

    if (!response.ok) {
      throw new Error(formatDropboxError(response.status, data, response.statusText));
    }

    return {
      status: response.status,
      data: data ?? undefined,
      raw: rawText || undefined,
    };
  } catch (error: Any) {
    if (error?.name === "AbortError") {
      throw new Error("Dropbox upload request timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function extractAccountInfo(data: Any): { name?: string; userId?: string; email?: string } {
  if (!data || typeof data !== "object") return {};
  const name = data?.name?.display_name || data?.name?.abbreviated_name || undefined;
  const userId = data?.account_id || data?.id || undefined;
  const email = data?.email || undefined;
  return { name, userId, email };
}

export async function testDropboxConnection(
  settings: DropboxSettingsData,
): Promise<DropboxConnectionTestResult> {
  try {
    const result = await dropboxRequest(settings, {
      method: "POST",
      path: "/users/get_current_account",
    });
    const extracted = extractAccountInfo(result.data);
    return {
      success: true,
      name: extracted.name,
      userId: extracted.userId,
      email: extracted.email,
    };
  } catch (error: Any) {
    return {
      success: false,
      error: error?.message || "Failed to connect to Dropbox",
    };
  }
}
