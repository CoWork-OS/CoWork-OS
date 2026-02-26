/**
 * OneDrive API helpers (Microsoft Graph)
 */

import { OneDriveConnectionTestResult, OneDriveSettingsData } from "../../shared/types";

export const ONEDRIVE_API_BASE = "https://graph.microsoft.com/v1.0";
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

function formatGraphError(status: number, data: Any, fallback?: string): string {
  const message = data?.error?.message || data?.message || fallback || "Microsoft Graph error";
  return `Microsoft Graph error ${status}: ${message}`;
}

export interface OneDriveRequestOptions {
  method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: Any;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface OneDriveRequestResult {
  status: number;
  data?: Any;
  raw?: string;
}

export async function onedriveRequest(
  settings: OneDriveSettingsData,
  options: OneDriveRequestOptions,
): Promise<OneDriveRequestResult> {
  if (!settings.accessToken) {
    throw new Error(
      "OneDrive access token not configured. Add it in Settings > Integrations > OneDrive.",
    );
  }

  const params = new URLSearchParams();
  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) {
      if (value === undefined || value === null) continue;
      params.set(key, String(value));
    }
  }
  const queryString = params.toString();
  const url = `${ONEDRIVE_API_BASE}${options.path}${queryString ? `?${queryString}` : ""}`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${settings.accessToken}`,
    ...options.headers,
  };

  const isBinaryBody =
    options.body instanceof Uint8Array ||
    options.body instanceof ArrayBuffer ||
    Buffer.isBuffer(options.body);
  if (options.body && !isBinaryBody && options.method !== "GET" && options.method !== "DELETE") {
    headers["Content-Type"] = headers["Content-Type"] || "application/json";
  }

  const timeoutMs = options.timeoutMs ?? settings.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: options.method,
      headers,
      body: options.body ? (isBinaryBody ? options.body : JSON.stringify(options.body)) : undefined,
      signal: controller.signal,
    });

    const rawText = typeof response.text === "function" ? await response.text() : "";
    const data = rawText ? parseJsonSafe(rawText) : undefined;

    if (!response.ok) {
      throw new Error(formatGraphError(response.status, data, response.statusText));
    }

    return {
      status: response.status,
      data: data ?? undefined,
      raw: rawText || undefined,
    };
  } catch (error: Any) {
    if (error?.name === "AbortError") {
      throw new Error("OneDrive API request timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function extractDriveOwner(data: Any): { name?: string; userId?: string; driveId?: string } {
  if (!data || typeof data !== "object") return {};
  const name = data?.owner?.user?.displayName || data?.owner?.user?.id || undefined;
  const userId = data?.owner?.user?.id || undefined;
  const driveId = data?.id || undefined;
  return { name, userId, driveId };
}

export async function testOneDriveConnection(
  settings: OneDriveSettingsData,
): Promise<OneDriveConnectionTestResult> {
  try {
    const result = await onedriveRequest(settings, { method: "GET", path: "/me/drive" });
    const extracted = extractDriveOwner(result.data);
    return {
      success: true,
      name: extracted.name,
      userId: extracted.userId,
      driveId: extracted.driveId,
    };
  } catch (error: Any) {
    return {
      success: false,
      error: error?.message || "Failed to connect to OneDrive",
    };
  }
}
