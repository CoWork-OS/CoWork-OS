/**
 * The Memory Hub "Settings" tab: the per-workspace memory settings it edits and the pure
 * rules behind its switches (tested directly).
 */
import type { MemoryFeaturesSettings } from "../../../shared/types";

export type MemoryPrivacyMode = "normal" | "strict" | "disabled";

/** One workspace's memory settings (MemoryService), as `getMemorySettings` returns them. */
export interface WorkspaceMemorySettings {
  workspaceId: string;
  enabled: boolean;
  autoCapture: boolean;
  compressionEnabled: boolean;
  retentionDays: number;
  maxStorageMb: number;
  privacyMode: MemoryPrivacyMode;
  excludedPatterns?: string[];
}

/** The sections of the Settings tab, in order (Advanced is the collapsed last one). */
export const MEMORY_SETTINGS_SECTIONS = [
  { id: "workspace", title: "This workspace" },
  { id: "memory-folder", title: "Memory folder" },
  { id: "import", title: "Import" },
  { id: "connections", title: "Connections" },
  { id: "proactive", title: "Proactive" },
] as const;

export type MemorySettingsScope = { kind: "workspace"; name: string } | { kind: "all" };

/** The quiet caption next to a section heading. */
export function scopeCaption(scope: MemorySettingsScope): string {
  return scope.kind === "all" ? "all workspaces" : `this workspace: ${scope.name}`;
}

/**
 * "Use memory" is on only while memory is enabled and not in the retired privacy mode
 * "Disabled" (which also turned memory off).
 */
export function isMemoryInUse(settings: Pick<WorkspaceMemorySettings, "enabled" | "privacyMode">) {
  return settings.enabled && settings.privacyMode !== "disabled";
}

/** The update for the "Use memory" switch; turning it on also leaves privacy mode "Disabled". */
export function memoryInUsePatch(
  on: boolean,
  privacyMode: MemoryPrivacyMode,
): Partial<WorkspaceMemorySettings> {
  if (!on) return { enabled: false };
  return privacyMode === "disabled" ? { enabled: true, privacyMode: "normal" } : { enabled: true };
}

/** The update for the "Strict privacy" switch. */
export function strictPrivacyPatch(strict: boolean): Partial<WorkspaceMemorySettings> {
  return { privacyMode: strict ? "strict" : "normal" };
}

export const RETENTION_OPTIONS: ReadonlyArray<{ days: number; label: string }> = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 180, label: "180 days" },
  { days: 365, label: "1 year" },
];

export const STORAGE_CAP_MIN_MB = 10;
export const STORAGE_CAP_MAX_MB = 5000;

/** The storage cap typed into the field, kept in range; null when it is not a number. */
export function parseStorageCapMb(raw: string): number | null {
  const value = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.max(STORAGE_CAP_MIN_MB, Math.min(STORAGE_CAP_MAX_MB, value));
}

export const DEFAULT_COMPRESSION_DAILY_TOKEN_BUDGET = 20000;

/** The cost notice shown next to the AI memory compression switch. */
export function compressionCostNotice(dailyTokenBudget: number | null): string {
  const budget =
    typeof dailyTokenBudget === "number" && dailyTokenBudget > 0
      ? dailyTokenBudget
      : DEFAULT_COMPRESSION_DAILY_TOKEN_BUDGET;
  return `AI memory compression uses your model provider and costs tokens (up to ${budget.toLocaleString("en-US")} tokens/day across all workspaces). Private memories are never sent. Turn it off to keep only local summaries.`;
}

/** The compression budget typed into the field, kept in range; null when it is not a number. */
export function parseCompressionBudget(raw: string): number | null {
  const value = Math.floor(Number(raw.trim()));
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.max(1000, Math.min(1_000_000, value));
}

/** An awareness source's TTL typed into the grid, kept in range; null when it is not a number. */
export function parseAwarenessTtlMinutes(raw: string): number | null {
  const value = Math.floor(Number(raw.trim()));
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.max(5, Math.min(24 * 60, value));
}

/** Session recovery (durable runtime context) is on in either stored form. */
export function isSessionRecoveryOn(
  features: Pick<MemoryFeaturesSettings, "durableContextEnabled" | "durableContextMode">,
): boolean {
  return (
    features.durableContextEnabled === true ||
    features.durableContextMode === "experimental" ||
    features.durableContextMode === "on"
  );
}

/** The update for the "Session recovery" switch: both stored fields, nothing else. */
export function sessionRecoveryPatch(on: boolean): Partial<MemoryFeaturesSettings> {
  return on
    ? { durableContextEnabled: true, durableContextMode: "on" }
    : { durableContextEnabled: false, durableContextMode: "off" };
}

/** What "Clear this workspace's memory" removed, per store. */
export interface MemoryClearSummary {
  lines: string[];
  notes: string[];
  errors: string[];
}

/** Host workflows the browser preview may not have yet, named in the tab's notice. */
export const BROWSER_PENDING_FEATURES: ReadonlyArray<readonly [method: string, label: string]> = [
  ["getWorkspaceKitStatus", "workspace kit management"],
  ["getAwarenessConfig", "awareness"],
];
