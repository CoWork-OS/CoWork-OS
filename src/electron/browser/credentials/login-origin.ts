/**
 * Which pages a saved login may be used on. A login belongs to one exact origin
 * (scheme, host and port): https only, or http for a local development server.
 */

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The origin a login is saved for, or null when the address is not one a login may belong to. */
export function loginOriginFor(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(String(rawUrl || "").trim());
  } catch {
    return null;
  }
  // Addresses with embedded credentials are never trusted as the place a login belongs to.
  if (url.username || url.password) return null;
  if (url.protocol === "https:") return url.origin;
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return url.origin;
  return null;
}

/** The current page's origin, if a saved login could be filled on it. */
export function fillableOrigin(pageUrl: string): string | null {
  return loginOriginFor(pageUrl);
}
