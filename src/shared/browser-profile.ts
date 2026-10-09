/**
 * The in-app browser keeps one profile (cookies, storage, history, site
 * permissions) per workspace. The profile key is the sanitized workspace id;
 * the Electron partition is derived from it.
 */

export const BROWSER_PARTITION_PREFIX = "persist:cowork-browser-";

export function browserProfileKey(workspaceId?: string | null): string {
  const safe = (workspaceId || "default").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
  return safe || "default";
}

export function browserPartitionFor(workspaceId?: string | null): string {
  return `${BROWSER_PARTITION_PREFIX}${browserProfileKey(workspaceId)}`;
}

export function browserProfileKeyFromPartition(partition: string): string | null {
  return partition.startsWith(BROWSER_PARTITION_PREFIX)
    ? partition.slice(BROWSER_PARTITION_PREFIX.length) || null
    : null;
}

/** Query parameter names that carry credentials or one-time secrets (matched anywhere in the name). */
const SECRET_QUERY_NAMES =
  /token|secret|passw|pwd|auth|^code$|^state$|session|sig|key|jwt|otp|ticket|magic|reset|csrf|xsrf|nonce|credential|assertion|saml|hash|verif|invite/i;
/** A path segment that looks like an opaque secret (magic links, reset tokens, signed URLs). */
const OPAQUE_SEGMENT = /^(?=[A-Za-z0-9_.~-]{24,}$)(?=.*\d)(?=.*[A-Za-z]).*$/;

/**
 * The URL as stored in browsing history: http(s) only, without credentials,
 * fragment or secret-looking query parameters (OAuth codes, tokens). Returns
 * null for anything that must not be recorded.
 */
export function sanitizeHistoryUrl(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(String(rawUrl || "").trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";
  for (const name of Array.from(new Set(parsed.searchParams.keys()))) {
    if (SECRET_QUERY_NAMES.test(name)) parsed.searchParams.delete(name);
  }
  parsed.pathname = parsed.pathname
    .split("/")
    .map((segment) => (OPAQUE_SEGMENT.test(segment) ? "redacted" : segment))
    .join("/");
  const href = parsed.href;
  return href.length > 4096 ? null : href;
}
