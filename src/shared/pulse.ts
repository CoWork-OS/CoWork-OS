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
  pendingPackage: PulseDailyPackage | null;
}

export interface PulseMutationResult {
  success: boolean;
  settings: PulsePublicSettings;
  error?: string;
}
