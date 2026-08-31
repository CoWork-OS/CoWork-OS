/**
 * Sanitize email HTML before rendering it in a srcdoc iframe.
 *
 * The iframe is intentionally sandboxed without script execution. Stripping
 * noisy-but-inert tags here keeps Chromium from logging parser/CSP warnings for
 * common email boilerplate such as malformed viewport meta tags and remote web
 * fonts.
 */
const TRANSPARENT_PIXEL_DATA_URL = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";

export function normalizeEmailExternalWebUrl(rawHref: string | null | undefined): string | null {
  const value = rawHref?.trim();
  if (!value || value.startsWith("#")) return null;

  const candidate = value.startsWith("//") ? `https:${value}` : value;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

export function sanitizeEmailHtml(raw: string): string {
  return (
    raw
      // Remove executable and embeddable content.
      .replace(/<script\b[\s\S]*?<\/script>/gi, "")
      .replace(/<script\b[^>]*(?:\/>|>)/gi, "")
      .replace(/<(?:iframe|object|embed)\b[\s\S]*?<\/(?:iframe|object|embed)>/gi, "")
      .replace(/<(?:base|link)\b[^>]*>/gi, "")
      // The host document supplies its own metadata; email meta tags can trigger
      // noisy viewport/CSP parser warnings when injected into srcdoc.
      .replace(/<meta\b[^>]*>/gi, "")
      // Remove inline event handlers so the sandbox does not log blocked script
      // execution for attributes such as onload/onclick.
      .replace(/\s+on[a-z][\w:-]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
      // Neutralize javascript: URLs in navigational/resource attributes.
      .replace(
        /\s+(href|src|xlink:href|action|formaction)\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*'|\s*javascript:[^\s>]+)/gi,
        "",
      )
      // Remote font CSS is blocked by the app CSP; remove it before Chromium logs
      // one violation per font face.
      .replace(/@import\s+(?:url\([^)]*\)|["'][^"']*["'])[^;]*;?/gi, "")
      .replace(/@font-face\s*{[^{}]*}/gi, "")
      .replace(/url\(\s*(['"]?)https?:\/\/[^'")]+\1\s*\)/gi, `url("${TRANSPARENT_PIXEL_DATA_URL}")`)
      // Keep images so HTTPS previews load (renderer CSP allows img-src https:).
      .replace(/<img\b([^>]*)>/gi, (_match, attrs: string) => `<img${attrs}>`)
      // Neutralize forms without adding inline onsubmit handlers.
      .replace(/<form\b([^>]*)>/gi, (_match, attrs: string) => {
        const sanitizedAttrs = attrs
          .replace(/\baction\s*=\s*(?:"[^"]*"|'[^']*'|\S+)/gi, "")
          .replace(/\bmethod\s*=\s*(?:"[^"]*"|'[^']*'|\S+)/gi, "");
        return `<form${sanitizedAttrs}>`;
      })
  );
}
