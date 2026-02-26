/**
 * Notion API helpers
 */

import { NotionConnectionTestResult, NotionSettingsData } from "../../shared/types";

export const NOTION_API_BASE = "https://api.notion.com/v1";
export const DEFAULT_NOTION_VERSION = "2025-09-03";
const DEFAULT_TIMEOUT_MS = 20000;

function getNotionVersion(settings: NotionSettingsData): string {
  return settings.notionVersion || DEFAULT_NOTION_VERSION;
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

function formatNotionError(status: number, data: Any, fallback?: string): string {
  const message = data?.message || data?.error || data?.details || fallback || "Notion API error";
  return `Notion API error ${status}: ${message}`;
}

export interface NotionRequestOptions {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  body?: Record<string, Any>;
  timeoutMs?: number;
}

export interface NotionRequestResult {
  status: number;
  data?: Any;
  raw?: string;
}

export async function notionRequest(
  settings: NotionSettingsData,
  options: NotionRequestOptions,
): Promise<NotionRequestResult> {
  if (!settings.apiKey) {
    throw new Error("Notion API key not configured. Add it in Settings > Integrations > Notion.");
  }

  const url = `${NOTION_API_BASE}${options.path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${settings.apiKey}`,
    "Notion-Version": getNotionVersion(settings),
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
      throw new Error(formatNotionError(response.status, data, response.statusText));
    }

    return {
      status: response.status,
      data: data ?? undefined,
      raw: rawText || undefined,
    };
  } catch (error: Any) {
    if (error?.name === "AbortError") {
      throw new Error("Notion API request timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function extractUserInfo(data: Any): { name?: string; userId?: string } {
  if (!data || typeof data !== "object") return {};
  const name = data.name || data?.bot?.owner?.user?.name || data?.person?.name || undefined;
  const userId = data.id || data.user_id || undefined;
  return { name, userId };
}

export async function testNotionConnection(
  settings: NotionSettingsData,
): Promise<NotionConnectionTestResult> {
  try {
    const result = await notionRequest(settings, { method: "GET", path: "/users/me" });
    const extracted = extractUserInfo(result.data);
    return {
      success: true,
      name: extracted.name,
      userId: extracted.userId,
    };
  } catch (error: Any) {
    return {
      success: false,
      error: error?.message || "Failed to connect to Notion",
    };
  }
}
