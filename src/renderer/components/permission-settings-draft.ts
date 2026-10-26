import type { PermissionSettingsData } from "../../shared/types";

/**
 * Unsaved-edit bookkeeping for the Permissions panel. Edits stay local until saved, and main
 * (PermissionSettingsManager.saveSettings) is the only authority on whether they are valid.
 */

export type PermissionSettingsSave = (settings: PermissionSettingsData) => Promise<unknown>;

export interface FailedPermissionDraft {
  draft: PermissionSettingsData;
  error: string;
}

/** JSON with sorted object keys, so key order from spreads does not count as an edit. */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, nested: unknown) => {
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) return nested;
    return Object.fromEntries(
      Object.entries(nested as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
    );
  });
}

/** True when the panel's settings differ from what main last stored or returned. */
export function hasUnsavedPermissionChanges(
  saved: PermissionSettingsData,
  draft: PermissionSettingsData,
): boolean {
  return stableStringify(saved) !== stableStringify(draft);
}

/** The message of a save error from main, without Electron's "Error invoking remote method" prefix. */
export function permissionSaveErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const cleaned = raw
    .replace(/^Error invoking remote method '[^']+':\s*(?:\w*Error:\s*)?/, "")
    .trim();
  return cleaned || "Failed to save permission settings.";
}

let pendingLeaveSave: Promise<void> | null = null;
let failedLeaveDraft: FailedPermissionDraft | null = null;

/**
 * Save the edits the panel is left with (Settings tab switch, closing Settings, window close).
 * A save main rejects keeps the draft and the error, so the panel can bring both back the next
 * time it opens instead of losing the edits.
 */
export function saveUnsavedPermissionDraftOnLeave(
  draft: PermissionSettingsData,
  save: PermissionSettingsSave,
): Promise<void> {
  const attempt = (async () => {
    try {
      await save(draft);
      failedLeaveDraft = null;
    } catch (error) {
      failedLeaveDraft = { draft, error: permissionSaveErrorMessage(error) };
    }
  })();
  pendingLeaveSave = attempt;
  void attempt.finally(() => {
    if (pendingLeaveSave === attempt) pendingLeaveSave = null;
  });
  return attempt;
}

/** Wait for a save started on leave, then hand back (once) a draft main refused to store. */
export async function takeFailedPermissionDraft(): Promise<FailedPermissionDraft | null> {
  if (pendingLeaveSave) await pendingLeaveSave;
  const failed = failedLeaveDraft;
  failedLeaveDraft = null;
  return failed;
}
