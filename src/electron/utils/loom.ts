/**
 * Shared LOOM/Email protocol helpers
 */

import { isLoopbackHostname } from "../security/address-classes";

export type EmailProtocol = "imap-smtp" | "loom";

export const LOOM_BASE_URL_SECURITY_MESSAGE =
  "LOOM base URL must use HTTPS unless it points to localhost/127.0.0.1/::1";

/**
 * True for `localhost`, `127.0.0.1` or `::1`, in any case and with or without
 * IPv6 brackets: the hosts that may receive the LOOM token over plain HTTP.
 *
 * Uses the shared narrow check rather than isLoopbackAddress. A trailing root
 * dot (`localhost.`) goes to the system resolver and `*.localhost`, the rest of
 * 127.0.0.0/8 and IPv4-mapped forms are outside what the error message
 * promises, so none of them is a guaranteed loopback host here. The parser
 * keeps IPv6 hostnames bracketed (`new URL("http://[::1]").hostname ===
 * "[::1]"`), which a bare `::1` comparison used to reject (issue #602).
 */
export function isLocalhostHost(hostname: string): boolean {
  return isLoopbackHostname(String(hostname || "").trim());
}

export function isSecureOrLocalLoomUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === "https:") return true;
    // Plain HTTP to loopback only; any other scheme fails here rather than at
    // the first poll.
    return parsed.protocol === "http:" && isLocalhostHost(parsed.hostname);
  } catch {
    return false;
  }
}

export function assertSafeLoomBaseUrl(rawBaseUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(String(rawBaseUrl || "").trim());
  } catch {
    throw new Error("LOOM base URL must be a valid URL");
  }

  if (!isSecureOrLocalLoomUrl(parsed.toString())) {
    throw new Error(LOOM_BASE_URL_SECURITY_MESSAGE);
  }

  return parsed;
}

export function normalizeLoomBaseUrl(raw: string | URL): URL {
  const baseUrl = new URL(raw.toString());
  const normalizedPath = baseUrl.pathname.replace(/\/+$/, "");
  baseUrl.pathname = normalizedPath || "/";
  return baseUrl;
}

export function normalizeEmailProtocol(rawProtocol: unknown): EmailProtocol {
  return String(rawProtocol || "")
    .trim()
    .toLowerCase() === "loom"
    ? "loom"
    : "imap-smtp";
}

const LOOM_MAILBOX_FOLDER_PATTERN = /^[A-Za-z0-9 ._+()\-/]+$/;

export function assertSafeLoomMailboxFolder(rawFolder: unknown): string {
  const folder = String(rawFolder || "INBOX").trim() || "INBOX";
  const hasTraversal = folder.includes("..");
  if (!LOOM_MAILBOX_FOLDER_PATTERN.test(folder) || hasTraversal) {
    throw new Error("LOOM mailbox folder contains invalid characters");
  }
  return folder;
}
