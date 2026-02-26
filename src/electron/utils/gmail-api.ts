/**
 * Gmail API helpers
 */

import { GoogleWorkspaceSettingsData } from "../../shared/types";
import {
  getGoogleWorkspaceAccessToken,
  refreshGoogleWorkspaceAccessToken,
} from "./google-workspace-auth";

export const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1";
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

function formatGmailError(status: number, data: Any, fallback?: string): string {
  const message = data?.error?.message || data?.message || fallback || "Gmail API error";
  return `Gmail API error ${status}: ${message}`;
}

export interface GmailRequestOptions {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string | number | boolean | string[] | undefined>;
  body?: Any;
  timeoutMs?: number;
}

export interface GmailRequestResult {
  status: number;
  data?: Any;
  raw?: string;
}

export async function gmailRequest(
  settings: GoogleWorkspaceSettingsData,
  options: GmailRequestOptions,
): Promise<GmailRequestResult> {
  const params = new URLSearchParams();
  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        value.forEach((item) => {
          if (item !== undefined && item !== null) params.append(key, String(item));
        });
        continue;
      }
      params.set(key, String(value));
    }
  }
  const queryString = params.toString();
  const url = `${GMAIL_API_BASE}${options.path}${queryString ? `?${queryString}` : ""}`;

  const timeoutMs = options.timeoutMs ?? settings.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const requestOnce = async (accessToken: string): Promise<GmailRequestResult> => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
    };

    if (options.method !== "GET" && options.method !== "DELETE") {
      headers["Content-Type"] = "application/json";
    }

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
        throw Object.assign(
          new Error(formatGmailError(response.status, data, response.statusText)),
          {
            status: response.status,
            data,
          },
        );
      }

      return {
        status: response.status,
        data: data ?? undefined,
        raw: rawText || undefined,
      };
    } catch (error: Any) {
      if (error?.name === "AbortError") {
        throw new Error("Gmail API request timed out");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  };

  try {
    const accessToken = await getGoogleWorkspaceAccessToken(settings);
    return await requestOnce(accessToken);
  } catch (error: Any) {
    if (error?.status === 401 && settings.refreshToken) {
      const refreshedToken = await refreshGoogleWorkspaceAccessToken(settings);
      return await requestOnce(refreshedToken);
    }
    throw error;
  }
}
