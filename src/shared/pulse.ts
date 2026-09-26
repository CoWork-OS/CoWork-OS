export const PULSE_SCHEMA_VERSION = 1 as const;
export const PULSE_CONSENT_VERSION = "2026-09-04" as const;
export const DEFAULT_PULSE_ENDPOINT = "https://pulse.coworkosapp.com";

export type PulseConsentState = "unset" | "enabled" | "disabled";

export interface PulseToolCounts {
  shell: number;
  filesystem: number;
  browser: number;
  connector: number;
  code: number;
  other: number;
}

export interface PulseDailyPackage {
  schemaVersion: typeof PULSE_SCHEMA_VERSION;
  packageId: string;
  installationId: string;
  period: { start: string; end: string };
  client: {
    version: string;
    platform: "macos" | "windows" | "linux" | "other";
    architecture: "arm64" | "x64" | "other";
    runtime: "desktop" | "daemon" | "cli";
  };
  activity: {
    sessionsStarted: number;
    tasksStarted: number;
    tasksCompleted: number;
    usefulTasks: number;
    activeMinutesBucket: "0" | "1-15" | "16-60" | "61-240" | "240+";
  };
  tools: PulseToolCounts;
  reliability: {
    failedTasks: number;
    cancelledTasks: number;
    approvalRequests: number;
    approvalDenials: number;
    toolErrors: number;
    llmErrors: number;
  };
}

/**
 * What the Settings preview and `cowork telemetry show` describe.
 *
 * - `queued`: the exact payload that the next send attempt submits, byte for byte,
 *   provided consent is still enabled when the attempt starts.
 * - `candidate`: an estimate for the eligible UTC day; nothing has been queued yet.
 * - `ineligible`: nothing can be sent right now, with the reason.
 * - `already_sent`: the collector acknowledged this day; Send now will not resend it.
 */
export type PulsePreviewState =
  | { state: "queued"; package: PulseDailyPackage }
  | { state: "candidate"; package: PulseDailyPackage }
  | {
      state: "ineligible";
      reason: "disabled" | "deletion_pending" | "incomplete_consent_day";
      /** First UTC day start (ISO) that becomes eligible, when known. */
      eligibleFrom?: string | null;
    }
  | { state: "already_sent"; periodStart: string; acknowledgedAt: number };

export interface PulseDeletionStatus {
  /** `pending`: reporting is off and the server has not yet acknowledged deletion. */
  state: "none" | "pending";
  requestedAt: number | null;
  lastAttemptAt: number | null;
  lastErrorCode: string | null;
}

export interface PulsePublicSettings {
  consentState: PulseConsentState;
  enabled: boolean;
  consentVersion: string;
  installationId: string | null;
  endpoint: string;
  enabledAt: number | null;
  disabledAt: number | null;
  lastSentAt: number | null;
  lastAttemptAt: number | null;
  lastErrorCode: string | null;
  /** Monotonic consent/identity revision. Increments on every user decision. */
  revision: number;
  deletion: PulseDeletionStatus;
  preview: PulsePreviewState;
  /**
   * Compatibility projection of `preview` for older callers: the queued or candidate
   * package, otherwise null. New UI and CLI code must read `preview`.
   */
  pendingPackage: PulseDailyPackage | null;
}

export interface PulseMutationResult {
  success: boolean;
  settings: PulsePublicSettings;
  error?: string;
}

export type PulseSendOutcome =
  | "sent"
  | "busy"
  | "already_sent"
  | "no_eligible_day"
  | "cancelled_by_state_change"
  | "error";

export interface PulseSendResult {
  outcome: PulseSendOutcome;
  settings: PulsePublicSettings;
  error?: string;
}
