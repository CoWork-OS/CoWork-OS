/**
 * The browser speaks to an existing CoWork host. These declarations intentionally
 * contain no Electron or Node imports so that the renderer can use them directly.
 */

export const WEB_API_VERSION = 1 as const;
export const WEB_APP_PATH = "/app/" as const;
export const WEB_API_PATH = "/api/web/v1" as const;
export const WEB_WORKSPACE_FILE_DOWNLOAD_PATH = `${WEB_API_PATH}/workspace-files/download` as const;
export const WEB_WORKSPACE_FILE_UPLOAD_PATH = `${WEB_API_PATH}/workspace-files/upload` as const;
export const WEB_WORKSPACE_FILE_MEDIA_PATH_PREFIX =
  `${WEB_API_PATH}/workspace-files/media/` as const;
export const WEB_ARTIFACT_DOWNLOAD_PATH = `${WEB_API_PATH}/artifacts/download` as const;

export const HOST_CAPABILITIES = [
  "tasks.read",
  "tasks.create",
  "tasks.followUp",
  "tasks.cancel",
  "tasks.events",
  "tasks.approvals",
  "tasks.inputRequests",
  "workspaces.read",
  "workspaces.select",
  "files.upload",
  "files.read",
  "artifacts.read",
  "terminal.attach",
  "git.read",
  "git.write",
  "notifications.read",
  "notifications.manage",
  "providers.read",
  "providers.configure",
  "connectors.configure",
  "automation.manage",
  "agents.manage",
  "memory.manage",
  "reports.read",
  "devices.manage",
  "mailbox.manage",
  "browser.interactive",
  "pact.manage",
] as const;

export type HostCapabilityName = (typeof HOST_CAPABILITIES)[number];
export type HostRuntimeKind = "electron" | "node";
export type ClientEnvironment = "desktop" | "browser";

export interface HostIdentity {
  /** Stable for the life of the host installation; never a filesystem path. */
  installationId: string;
  /** The profile owning every resource exposed through this endpoint. */
  profileId: string;
  /** Changes on host restart, so stale sessions and resource handles fail closed. */
  generation: string;
  runtime: HostRuntimeKind;
  /** OS of the host, independent of the browser client's OS. */
  platform: "darwin" | "linux" | "win32" | "other";
  appVersion: string;
}

export type HostCapability = { available: true } | { available: false; reason: string };

export type HostCapabilities = Record<HostCapabilityName, HostCapability>;

export interface WebPublicBootstrap {
  apiVersion: typeof WEB_API_VERSION;
  appVersion: string;
  authentication: "required";
}

export interface WebSessionBootstrap {
  apiVersion: typeof WEB_API_VERSION;
  host: HostIdentity;
  capabilities: HostCapabilities;
  /** Bound to the HttpOnly browser session and required on mutations. */
  csrfToken: string;
  /** Only readiness information belongs here, never provider credentials. */
  providerReady: boolean;
  onboardingCompleted: boolean;
  disclaimerAccepted: boolean;
  activeWorkspaceId: string | null;
  /** Exact reviewed desktop operations mounted by this host. */
  desktopMethods?: Record<string, { mutation: boolean }>;
}

export const WEB_ERROR_CODES = [
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "UNSUPPORTED_CAPABILITY",
  "HOST_UNAVAILABLE",
  "STALE_HOST",
  "STALE_STATE",
  "CONFLICT",
  "RATE_LIMITED",
  "OUTCOME_UNKNOWN",
  "INVALID_REQUEST",
  "INTERNAL_ERROR",
] as const;

export type WebErrorCode = (typeof WEB_ERROR_CODES)[number];

export interface WebError {
  code: WebErrorCode;
  message: string;
  retryable: boolean;
}

export interface WebRpcRequest {
  apiVersion: typeof WEB_API_VERSION;
  type: "request";
  id: string;
  method: string;
  params: unknown;
  /** Stable across transport retries; required for mutations. */
  operationKey?: string;
}

export type WebRpcResponse =
  | {
      apiVersion: typeof WEB_API_VERSION;
      type: "response";
      id: string;
      result: unknown;
    }
  | {
      apiVersion: typeof WEB_API_VERSION;
      type: "response";
      id: string;
      error: WebError;
    };

export interface WebRpcEvent {
  apiVersion: typeof WEB_API_VERSION;
  type: "event";
  topic: string;
  /** Present only for committed, replayable changes. */
  cursor?: string;
  payload: unknown;
}

export type WebRpcFrame = WebRpcRequest | WebRpcResponse | WebRpcEvent;
