/**
 * macOS permission helpers for computer use (Accessibility + Screen Recording).
 */

import * as os from "os";

function getElectronSystemPreferences(): Any {
  try {
    // oxlint-disable-next-line typescript/no-require-imports
    const electron = require("electron") as Any;
    return electron?.systemPreferences;
  } catch {
    return undefined;
  }
}

export type MacScreenCaptureStatus = "granted" | "denied" | "not-determined" | "unknown";

/**
 * Screen Recording / screen capture consent (macOS). May stay stale until app restart after grant.
 */
export function getMacScreenCaptureAccessStatus(): MacScreenCaptureStatus {
  if (os.platform() !== "darwin") return "unknown";
  const sp = getElectronSystemPreferences();
  if (typeof sp?.getMediaAccessStatus !== "function") return "unknown";
  try {
    const raw = sp.getMediaAccessStatus("screen") as string;
    if (raw === "granted") return "granted";
    if (raw === "denied") return "denied";
    if (raw === "not-determined" || raw === "restricted") return "not-determined";
    return "unknown";
  } catch {
    return "unknown";
  }
}

export function checkAccessibilityTrusted(prompt: boolean): boolean {
  if (os.platform() !== "darwin") return false;
  const sp = getElectronSystemPreferences();
  if (!sp?.isTrustedAccessibilityClient) return false;
  return sp.isTrustedAccessibilityClient({ prompt }) as boolean;
}
