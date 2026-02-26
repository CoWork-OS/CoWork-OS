/**
 * Box API helpers
 */

import { BoxConnectionTestResult, BoxSettingsData } from "../../shared/types";

export const BOX_API_BASE = "https://api.box.com/2.0";
export const BOX_UPLOAD_BASE = "https://upload.box.com/api/2.0";
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

export async function boxRequest(
  settings: BoxSettingsData,
  options: BoxRequestOptions,
): Promise<BoxRequestResult> {
  if (!settings.accessToken) {
    throw new Error("Box access token not configured. Add it in Settings > Integrations > Box.");
  }

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
    Authorization: `Bearer ${settings.accessToken}`,
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
  if (!settings.accessToken) {
    throw new Error("Box access token not configured. Add it in Settings > Integrations > Box.");
  }

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
    Authorization: `Bearer ${settings.accessToken}`,
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
