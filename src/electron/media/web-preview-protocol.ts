import { createHash, randomUUID } from "crypto";

/**
 * Serves in-app web page previews (the HTML artifact viewer) from their own
 * origin so their scripts can run.
 *
 * The viewer used to render previews with `srcdoc`, and a srcdoc document
 * inherits the app's Content Security Policy (`script-src 'self'`), so every
 * inline script in a generated page was blocked. Documents served here get the
 * policy below instead, and the renderer frames them with
 * `sandbox="allow-scripts …"` (no `allow-same-origin`), so they run in an
 * opaque origin with no access to the app, its storage or the preload API.
 *
 * Only HTML the main process built itself (from a path the viewer handler has
 * already resolved inside the workspace) is registered, behind an unguessable
 * one-hour token.
 */
const WEB_PREVIEW_SCHEME = "cowork-preview";
const TOKEN_TTL_MS = 60 * 60 * 1000;
/** Bounds memory: previews are re-registered whenever the viewer reloads. */
const MAX_ENTRIES = 64;

/**
 * Inline scripts and styles plus data/blob assets are allowed; every network
 * fetch, navigation target and form submission is not, so a preview cannot
 * load remote code or send data anywhere.
 */
export const WEB_PREVIEW_CSP =
  "default-src 'none'; " +
  "script-src 'unsafe-inline' blob:; " +
  "style-src 'unsafe-inline'; " +
  "img-src data: blob:; " +
  "font-src data:; " +
  "media-src data: blob:; " +
  "worker-src blob:; " +
  "connect-src 'none'; " +
  "frame-src 'none'; " +
  "form-action 'none'; " +
  "base-uri 'none'";

type PreviewRecord = { html: string; expiresAt: number };

const previewStore = new Map<string, PreviewRecord>();
/** Content hash → live token, so reopening the same page reuses its URL. */
const tokenByContent = new Map<string, string>();

function getElectronProtocol(): typeof import("electron").protocol {
  return require("electron").protocol as typeof import("electron").protocol;
}

function dropToken(token: string): void {
  previewStore.delete(token);
  for (const [hash, mapped] of tokenByContent) {
    if (mapped === token) tokenByContent.delete(hash);
  }
}

function purgeExpired(now = Date.now()): void {
  for (const [token, record] of previewStore) {
    if (record.expiresAt <= now) dropToken(token);
  }
}

function textResponse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export function registerWebPreviewScheme(): void {
  getElectronProtocol().registerSchemesAsPrivileged([
    // No fetch/CORS privileges: the page must not be able to read anything.
    { scheme: WEB_PREVIEW_SCHEME, privileges: { standard: true, secure: true } },
  ]);
}

/**
 * Registers preview HTML and returns the URL the viewer frames. The same
 * content keeps one live token (its expiry is extended) rather than minting a
 * new one on every viewer reload.
 */
export function createWebPreviewUrl(html: string): string {
  purgeExpired();
  const hash = createHash("sha256").update(html).digest("hex");
  const existing = tokenByContent.get(hash);
  const existingRecord = existing ? previewStore.get(existing) : undefined;
  if (existing && existingRecord) {
    existingRecord.expiresAt = Date.now() + TOKEN_TTL_MS;
    return `${WEB_PREVIEW_SCHEME}://local/${existing}`;
  }
  while (previewStore.size >= MAX_ENTRIES) {
    const oldest = previewStore.keys().next().value;
    if (oldest === undefined) break;
    dropToken(oldest);
  }
  const token = randomUUID();
  previewStore.set(token, { html, expiresAt: Date.now() + TOKEN_TTL_MS });
  tokenByContent.set(hash, token);
  return `${WEB_PREVIEW_SCHEME}://local/${token}`;
}

export function resolveWebPreviewRequest(rawUrl: string): Response {
  purgeExpired();
  let token = "";
  try {
    token = new URL(rawUrl).pathname.replace(/^\/+/, "");
  } catch {
    return textResponse(400, "Invalid preview URL");
  }
  const record = token ? previewStore.get(token) : undefined;
  if (!record) return textResponse(404, "This preview has expired. Reopen the page.");
  return new Response(record.html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": WEB_PREVIEW_CSP,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/**
 * Registered on the default session only, on purpose: the in-app browser and
 * Canvas partitions cannot resolve cowork-preview:// URLs, so pages there
 * cannot read preview content even with a token. Do not add this handler to
 * other sessions.
 */
export function registerWebPreviewProtocol(): void {
  getElectronProtocol().handle(WEB_PREVIEW_SCHEME, async (request) =>
    resolveWebPreviewRequest(request.url),
  );
}
