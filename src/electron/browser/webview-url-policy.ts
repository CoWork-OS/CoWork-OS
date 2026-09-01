import * as path from "path";

const LOCAL_HTML_EXTENSIONS = new Set([".html", ".htm", ".xhtml"]);

function parseUrl(value: string): URL | null {
  try {
    return new URL(String(value || "").trim());
  } catch {
    return null;
  }
}

export function normalizeWebviewUrl(value: string): string {
  return parseUrl(value)?.href || "";
}

export function isLocalHtmlFileUrl(value: string): boolean {
  const parsed = parseUrl(value);
  if (!parsed) return false;
  if (parsed.protocol !== "file:") return false;
  if (parsed.hostname && parsed.hostname !== "localhost") return false;
  const extension = path.extname(parsed.pathname).toLowerCase();
  return LOCAL_HTML_EXTENSIONS.has(extension);
}

/**
 * Local preview servers are loopback HTTP origins, not local HTML files.
 * Registration in the browser session manager is still required before use.
 */
export function isLoopbackHttpUrl(value: string): boolean {
  const parsed = parseUrl(value);
  if (!parsed || parsed.protocol !== "http:") return false;
  if (parsed.username || parsed.password || !parsed.port) return false;
  return (
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "::1" ||
    parsed.hostname === "[::1]"
  );
}

export function isAllowedWebviewUrl(value: string): boolean {
  const raw = String(value || "").trim();
  if (!raw) {
    return false;
  }
  if (raw === "about:blank") {
    return true;
  }

  try {
    const parsed = parseUrl(raw);
    if (!parsed) return false;
    return (
      parsed.protocol === "https:" || parsed.protocol === "http:" || parsed.protocol === "canvas:"
    );
  } catch {
    return false;
  }
}
