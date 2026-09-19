/**
 * Single gate for handing a URL to the OS via shell.openExternal.
 *
 * openExternal invokes the registered protocol handler for whatever scheme it
 * is given, so `smb://host/share/payload.exe`, `file:///Applications/...`, or
 * any app-registered scheme becomes a one-click launch. Renderer content is
 * not trustworthy enough for that: .docx previews render mammoth output
 * verbatim and mammoth performs no href scheme validation, and the update
 * banner renders a release URL fetched from a remote endpoint.
 *
 * The IPC channel already restricted schemes; the window-open and will-navigate
 * paths did not. Everything routes through here now so the three cannot drift.
 */
import { shell } from "electron";
import { createLogger } from "../utils/logger";

const log = createLogger("SafeExternalUrl");

const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

export function isSafeExternalUrl(url: string): boolean {
  try {
    return ALLOWED_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

/**
 * Open `url` in the user's browser when its scheme is allowed. Returns whether
 * the URL was opened, so callers can surface a rejection if they want to.
 */
export async function openExternalIfSafe(url: string): Promise<boolean> {
  if (!isSafeExternalUrl(url)) {
    log.warn(`Refused to open external URL with disallowed scheme: ${url}`);
    return false;
  }
  try {
    await shell.openExternal(url);
    return true;
  } catch (error) {
    log.warn(`Failed to open external URL: ${error instanceof Error ? error.message : error}`);
    return false;
  }
}
