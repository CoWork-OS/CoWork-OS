/**
 * SharePoint API helpers (Microsoft Graph)
 */

import { SharePointConnectionTestResult, SharePointSettingsData } from "../../shared/types";

export const SHAREPOINT_API_BASE = "https://graph.microsoft.com/v1.0";
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

export interface SharePointRequestOptions {
  method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: Any;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface SharePointRequestResult {
  status: number;
  data?: Any;
  raw?: string;
}

export async function sharepointRequest(
  settings: SharePointSettingsData,
  options: SharePointRequestOptions,
): Promise<SharePointRequestResult> {
  if (!settings.accessToken) {
    throw new Error(
      "SharePoint access token not configured. Add it in Settings > Integrations > SharePoint.",
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
  const url = `${SHAREPOINT_API_BASE}${options.path}${queryString ? `?${queryString}` : ""}`;

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
      throw new Error("SharePoint API request timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function extractUserInfo(data: Any): { name?: string; userId?: string } {
  if (!data || typeof data !== "object") return {};
  const name = data.displayName || data.name || undefined;
  const userId = data.id || undefined;
  return { name, userId };
}

export async function testSharePointConnection(
  settings: SharePointSettingsData,
): Promise<SharePointConnectionTestResult> {
  try {
    const result = await sharepointRequest(settings, { method: "GET", path: "/me" });
    const extracted = extractUserInfo(result.data);
    return {
      success: true,
      name: extracted.name,
      userId: extracted.userId,
    };
  } catch (error: Any) {
    return {
      success: false,
      error: error?.message || "Failed to connect to SharePoint",
    };
  }
}
