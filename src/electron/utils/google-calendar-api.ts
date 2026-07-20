/**
 * Google Calendar API helpers
 */

import { GoogleWorkspaceSettingsData } from "../../shared/types";
import {
  getGoogleWorkspaceAccessToken,
  refreshGoogleWorkspaceAccessToken,
} from "./google-workspace-auth";
import {
  isLikelyIntegrationAuthError,
  notifyIntegrationAuthIssue,
} from "../notifications/integration-auth";

export const GOOGLE_CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";
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

function formatCalendarError(status: number, data: Any, fallback?: string): string {
  const message = data?.error?.message || data?.message || fallback || "Google Calendar API error";
  return `Google Calendar API error ${status}: ${message}`;
}

export interface GoogleCalendarRequestOptions {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: Any;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface GoogleCalendarRequestResult {
  status: number;
  data?: Any;
  raw?: string;
}

async function notifyGoogleWorkspaceAuthIssue(error: unknown): Promise<void> {
  if (!isLikelyIntegrationAuthError(error)) return;
  await notifyIntegrationAuthIssue({
    integrationId: "google-workspace",
    integrationName: "Google Workspace",
    settingsPath: "Settings > Integrations > Google Workspace",
    reason: error instanceof Error ? error.message : String(error),
    dedupeKey: "google-workspace-auth",
  });
}

export async function googleCalendarRequest(
  settings: GoogleWorkspaceSettingsData,
  options: GoogleCalendarRequestOptions,
): Promise<GoogleCalendarRequestResult> {
  const params = new URLSearchParams();
  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) {
      if (value === undefined || value === null) continue;
      params.set(key, String(value));
    }
  }
  const queryString = params.toString();
  const url = `${GOOGLE_CALENDAR_API_BASE}${options.path}${queryString ? `?${queryString}` : ""}`;

  const timeoutMs = options.timeoutMs ?? settings.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const requestOnce = async (accessToken: string): Promise<GoogleCalendarRequestResult> => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
    };

    if (options.method !== "GET" && options.method !== "DELETE") {
      headers["Content-Type"] = "application/json";
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abort, { once: true });

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
          new Error(formatCalendarError(response.status, data, response.statusText)),
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
        if (options.signal?.aborted) {
          throw options.signal.reason instanceof Error
            ? options.signal.reason
            : new Error("Google Calendar API request was cancelled");
        }
        throw new Error("Google Calendar API request timed out");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
    }
  };

  try {
    const accessToken = await getGoogleWorkspaceAccessToken(settings);
    return await requestOnce(accessToken);
  } catch (error: Any) {
    if (error?.status === 401 && settings.refreshToken) {
      try {
        const refreshedToken = await refreshGoogleWorkspaceAccessToken(settings);
        return await requestOnce(refreshedToken);
      } catch (refreshError) {
        await notifyGoogleWorkspaceAuthIssue(refreshError);
        throw refreshError;
      }
    }
    await notifyGoogleWorkspaceAuthIssue(error);
    throw error;
  }
}
