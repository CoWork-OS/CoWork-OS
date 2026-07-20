/**
 * Google Workspace API helpers (Drive)
 */

import {
  GoogleWorkspaceConnectionTestResult,
  GoogleWorkspaceSettingsData,
} from "../../shared/types";
import {
  getGoogleWorkspaceAccessToken,
  refreshGoogleWorkspaceAccessToken,
} from "./google-workspace-auth";
import { gmailRequest } from "./gmail-api";
import {
  getMissingGoogleScopesForMode,
  getGoogleWorkspaceSettingsForAccount,
  inferGoogleWorkspaceConnectionMode,
} from "../../shared/google-workspace";
import {
  isLikelyIntegrationAuthError,
  notifyIntegrationAuthIssue,
} from "../notifications/integration-auth";

export const GOOGLE_DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";
export const GOOGLE_DRIVE_UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3";
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

function formatDriveError(status: number, data: Any, fallback?: string): string {
  const message = data?.error?.message || data?.message || fallback || "Google Drive API error";
  return `Google Drive API error ${status}: ${message}`;
}

export interface GoogleDriveRequestOptions {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: Record<string, Any>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface GoogleDriveRequestResult {
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

export async function googleDriveRequest(
  settings: GoogleWorkspaceSettingsData,
  options: GoogleDriveRequestOptions,
): Promise<GoogleDriveRequestResult> {
  const params = new URLSearchParams();
  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) {
      if (value === undefined || value === null) continue;
      params.set(key, String(value));
    }
  }
  const queryString = params.toString();
  const url = `${GOOGLE_DRIVE_API_BASE}${options.path}${queryString ? `?${queryString}` : ""}`;

  const timeoutMs = options.timeoutMs ?? settings.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const requestOnce = async (accessToken: string): Promise<GoogleDriveRequestResult> => {
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
          new Error(formatDriveError(response.status, data, response.statusText)),
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
            : new Error("Google Drive API request was cancelled");
        }
        throw new Error("Google Drive API request timed out");
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

export async function googleDriveUpload(
  settings: GoogleWorkspaceSettingsData,
  fileId: string,
  data: Uint8Array,
  contentType: string,
  signal?: AbortSignal,
): Promise<GoogleDriveRequestResult> {
  const url = `${GOOGLE_DRIVE_UPLOAD_BASE}/files/${fileId}?uploadType=media`;

  const timeoutMs = settings.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const requestOnce = async (accessToken: string): Promise<GoogleDriveRequestResult> => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": contentType,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });

    try {
      const response = await fetch(url, {
        method: "PATCH",
        headers,
        body: Buffer.from(data),
        signal: controller.signal,
      });

      const rawText = typeof response.text === "function" ? await response.text() : "";
      const dataJson = rawText ? parseJsonSafe(rawText) : undefined;

      if (!response.ok) {
        throw Object.assign(
          new Error(formatDriveError(response.status, dataJson, response.statusText)),
          {
            status: response.status,
            data: dataJson,
          },
        );
      }

      return {
        status: response.status,
        data: dataJson ?? undefined,
        raw: rawText || undefined,
      };
    } catch (error: Any) {
      if (error?.name === "AbortError") {
        if (signal?.aborted) {
          throw signal.reason instanceof Error
            ? signal.reason
            : new Error("Google Drive upload was cancelled");
        }
        throw new Error("Google Drive upload request timed out");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
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

function extractUserInfo(data: Any): { name?: string; userId?: string; email?: string } {
  if (!data || typeof data !== "object") return {};
  const user = data.user || data;
  const name = user.displayName || user.name || undefined;
  const userId = user.permissionId || user.userId || user.id || undefined;
  const email = user.emailAddress || user.email || undefined;
  return { name, userId, email };
}

export async function testGoogleWorkspaceConnection(
  settings: GoogleWorkspaceSettingsData,
): Promise<GoogleWorkspaceConnectionTestResult> {
  const effectiveSettings = getGoogleWorkspaceSettingsForAccount(settings);
  const connectionMode = inferGoogleWorkspaceConnectionMode(
    effectiveSettings.connectionMode,
    effectiveSettings.scopes,
  );
  const missingScopes = getMissingGoogleScopesForMode(effectiveSettings.scopes, connectionMode);
  if (missingScopes.length > 0) {
    return {
      success: false,
      error: `${connectionMode === "workspace" ? "Google Workspace" : "Gmail"} is missing required scopes for the current connector surface: ${missingScopes.join(", ")}. Reconnect ${connectionMode === "workspace" ? "Google Workspace" : "Gmail"} in Settings > Integrations > Google Workspace.`,
      missingScopes,
    };
  }

  try {
    const profile = await gmailRequest(effectiveSettings, {
      method: "GET",
      path: "/users/me/profile",
    });
    const email = profile.data?.emailAddress as string | undefined;
    return {
      success: true,
      name: email,
      userId: profile.data?.historyId as string | undefined,
      email,
    };
  } catch {
    // Fall back to Drive if Gmail scope is unavailable
  }

  try {
    const result = await googleDriveRequest(effectiveSettings, {
      method: "GET",
      path: "/about",
      query: { fields: "user" },
    });
    const extracted = extractUserInfo(result.data);
    return {
      success: true,
      name: extracted.name,
      userId: extracted.userId,
      email: extracted.email,
    };
  } catch (error: Any) {
    return {
      success: false,
      error: error?.message || "Failed to connect to Google Workspace",
    };
  }
}
