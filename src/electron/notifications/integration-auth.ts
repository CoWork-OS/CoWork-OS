import type { NotificationService } from "./service";
import { createLogger } from "../utils/logger";

const log = createLogger("IntegrationAuth");

const DEFAULT_DEDUPE_WINDOW_MS = 60 * 60 * 1000;
const MAX_REASON_LENGTH = 180;

let notificationServiceProvider: (() => NotificationService | null) | null = null;
const lastNotificationAtByKey = new Map<string, number>();

export interface IntegrationAuthNotificationInput {
  integrationId: string;
  integrationName: string;
  settingsPath?: string;
  reason?: string;
  taskId?: string;
  workspaceId?: string;
  dedupeKey?: string;
}

export interface IntegrationAuthIssueDetection {
  integrationId: string;
  integrationName: string;
  settingsPath: string;
  dedupeKey: string;
}

export function setIntegrationAuthNotificationServiceProvider(
  provider: (() => NotificationService | null) | null,
): void {
  notificationServiceProvider = provider;
}

export function resetIntegrationAuthNotificationDedupe(): void {
  lastNotificationAtByKey.clear();
}

export function isLikelyIntegrationAuthError(error: unknown): boolean {
  const status = Number((error as Any)?.status ?? (error as Any)?.statusCode ?? NaN);
  const message = String((error as Any)?.message ?? error ?? "");

  if (status === 401) return true;
  if (
    status === 403 &&
    /(insufficient authentication scopes|forbidden|unauthori[sz]ed|invalid token|token|scope|permission)/i.test(
      message,
    )
  ) {
    return true;
  }

  return (
    /token refresh failed|refresh token (?:is )?not configured|access token (?:is )?not configured|access token expired/i.test(
      message,
    ) ||
    /expired or revoked|invalid_grant|invalid_client|unauthorized_client/i.test(message) ||
    /authentication required|authentication failed|not authenticated|login required/i.test(
      message,
    ) ||
    /sign in to continue|invalid token|unauthori[sz]ed|oauth|credential/i.test(message)
  );
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error ?? "");
}

export function detectIntegrationAuthIssue(error: unknown): IntegrationAuthIssueDetection | null {
  const message = errorText(error);
  const lower = message.toLowerCase();

  if (/\b(google workspace|gmail)\b/.test(lower) && isLikelyIntegrationAuthError(error)) {
    return {
      integrationId: "google-workspace",
      integrationName: "Google Workspace",
      settingsPath: "Settings > Integrations > Google Workspace",
      dedupeKey: "google-workspace-auth",
    };
  }

  if (
    /\b(microsoft graph|microsoft outlook|outlook|hotmail|msn|live\.com|microsoft email)\b/.test(
      lower,
    )
  ) {
    if (
      isLikelyIntegrationAuthError(error) ||
      /\b(reconnect|mail\.readwrite|oauth|permission failed|refresh token)\b/i.test(message)
    ) {
      return {
        integrationId: "outlook-email",
        integrationName: "Outlook Email",
        settingsPath: "Settings > Email",
        dedupeKey: "outlook-email-auth",
      };
    }
  }

  if (/\bwhatsapp\b/.test(lower)) {
    if (
      /\b(re-authenticate|logged out|credentials became unreadable|stored credentials are unreadable|session logged out|max reconnection attempts|reconnect whatsapp|linked devices|qr code)\b/i.test(
        message,
      )
    ) {
      return {
        integrationId: "whatsapp",
        integrationName: "WhatsApp",
        settingsPath: "Settings > WhatsApp",
        dedupeKey: "whatsapp-auth",
      };
    }
  }

  if (/\bdropbox\b/.test(lower) && isLikelyIntegrationAuthError(error)) {
    return {
      integrationId: "dropbox",
      integrationName: "Dropbox",
      settingsPath: "Settings > Integrations > Dropbox",
      dedupeKey: "dropbox-auth",
    };
  }

  if (/\bbox\b/.test(lower) && isLikelyIntegrationAuthError(error)) {
    return {
      integrationId: "box",
      integrationName: "Box",
      settingsPath: "Settings > Integrations > Box",
      dedupeKey: "box-auth",
    };
  }

  if (/\bonedrive\b/.test(lower) && isLikelyIntegrationAuthError(error)) {
    return {
      integrationId: "onedrive",
      integrationName: "OneDrive",
      settingsPath: "Settings > Integrations > OneDrive",
      dedupeKey: "onedrive-auth",
    };
  }

  if (/\bsharepoint\b/.test(lower) && isLikelyIntegrationAuthError(error)) {
    return {
      integrationId: "sharepoint",
      integrationName: "SharePoint",
      settingsPath: "Settings > Integrations > SharePoint",
      dedupeKey: "sharepoint-auth",
    };
  }

  return null;
}

function sanitizeReason(reason?: string): string | undefined {
  const normalized = reason
    ?.trim()
    .replace(/\s+/g, " ")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]")
    .replace(/\b(access|refresh|id)[_-]?token=([^&\s]+)/gi, "$1_token=[redacted]")
    .replace(/\b(sk-[A-Za-z0-9]{12,})\b/g, "[redacted-token]")
    // Redact JWT-shaped tokens (three base64url segments separated by dots)
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[redacted-jwt]")
    // Redact long hex/base64 strings that look like API keys or tokens
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted-key]");
  if (!normalized) return undefined;
  return normalized.length > MAX_REASON_LENGTH
    ? `${normalized.slice(0, MAX_REASON_LENGTH - 3)}...`
    : normalized;
}

export async function notifyIntegrationAuthIssue(
  input: IntegrationAuthNotificationInput,
): Promise<boolean> {
  const notificationService = notificationServiceProvider?.() ?? null;
  if (!notificationService) {
    return false;
  }

  const dedupeKey = `${input.integrationId}:${input.dedupeKey || "auth"}`;
  const now = Date.now();

  const settingsPath = input.settingsPath || `Settings > Integrations > ${input.integrationName}`;
  const reason = sanitizeReason(input.reason);
  const message = reason
    ? `${input.integrationName} needs attention in ${settingsPath}. Reconnect or resync it before automated work can continue. ${reason}`
    : `${input.integrationName} needs attention in ${settingsPath}. Reconnect or resync it before automated work can continue.`;
  const title = `Reconnect ${input.integrationName}`;
  const listNotifications =
    typeof (notificationService as Partial<Pick<NotificationService, "list">>).list === "function"
      ? (notificationService as Pick<NotificationService, "list">).list.bind(notificationService)
      : null;

  if (listNotifications) {
    const existing = listNotifications().find((notification) => {
      return (
        notification.type === "warning" &&
        notification.title === title &&
        notification.message.includes(
          `${input.integrationName} needs attention in ${settingsPath}.`,
        )
      );
    });
    if (existing) return false;
  } else {
    const lastNotificationAt = lastNotificationAtByKey.get(dedupeKey) ?? 0;
    if (now - lastNotificationAt < DEFAULT_DEDUPE_WINDOW_MS) {
      return false;
    }
  }

  try {
    await notificationService.add({
      type: "warning",
      title,
      message,
      taskId: input.taskId,
      workspaceId: input.workspaceId,
    });
    lastNotificationAtByKey.set(dedupeKey, now);
    return true;
  } catch (error) {
    log.warn("Failed to add integration auth notification", sanitizeReason(String(error)));
    return false;
  }
}

export async function notifyDetectedIntegrationAuthIssue(error: unknown): Promise<boolean> {
  const detected = detectIntegrationAuthIssue(error);
  if (!detected) return false;
  return notifyIntegrationAuthIssue({
    ...detected,
    reason: errorText(error),
  });
}
