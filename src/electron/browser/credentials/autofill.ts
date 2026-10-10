/**
 * Filling a saved login into the page the user is looking at.
 *
 * - The user starts it (the key button in the toolbar). The agent has no tool for it.
 * - The page's address must be exactly the login's origin (https, or loopback http). The
 *   check happens here against the live page address, not against anything the renderer sent.
 * - Only the top page is filled, never a frame inside it.
 * - The fill runs in an isolated JavaScript world, so the page's own scripts cannot read
 *   the secret out of the script or its variables (the field value is, of course, visible
 *   to the page once filled, as with any password manager).
 * - Anything the agent reads back from that page afterwards has the password masked.
 */

import { loginOriginFor } from "./login-origin";

export const AUTOFILL_WORLD_ID = 1971;

export type FillOutcome =
  | { ok: true; filledUsername: boolean; filledPassword: boolean }
  | { ok: false; reason: "origin_mismatch" | "no_page" | "no_password_field" | "failed" };

/** Runs in the page's isolated world. Never returns the values it was given. */
export function buildFillScript(username: string, password: string, origin: string): string {
  return `(() => {
  const creds = ${JSON.stringify({ username, password })};
  // The page may have moved on since the address was checked: fill nothing unless it is still the same origin.
  if (location.origin !== ${JSON.stringify(origin)}) return { passwordField: false, usernameField: false };
  const sameOriginForm = (el) => { try { return !el.form || new URL(el.form.action, location.href).origin === location.origin; } catch { return false; } };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && !el.disabled && !el.readOnly;
  };
  const setValue = (el, value) => {
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    el.focus();
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const passwords = [...document.querySelectorAll('input[type="password"]')].filter((el) => visible(el) && sameOriginForm(el));
  const password = passwords[0];
  if (!password) return { passwordField: false, usernameField: false };
  const scope = password.form || document;
  const candidates = [...scope.querySelectorAll('input:not([type]), input[type="text"], input[type="email"], input[type="tel"]')].filter(visible);
  let user = null;
  for (const el of candidates) {
    if (el.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING) user = el;
  }
  let filledUsername = false;
  if (user && creds.username) { setValue(user, creds.username); filledUsername = true; }
  setValue(password, creds.password);
  return { passwordField: true, usernameField: filledUsername };
})()`;
}

export interface FillTarget {
  getURL(): string;
  isDestroyed(): boolean;
  executeJavaScriptInIsolatedWorld(
    worldId: number,
    scripts: Array<{ code: string }>,
  ): Promise<unknown>;
}

export async function fillLogin(
  contents: FillTarget | null,
  login: { origin: string; username: string; password: string },
  register: (password: string) => void,
): Promise<FillOutcome> {
  if (!contents || contents.isDestroyed()) return { ok: false, reason: "no_page" };
  const pageOrigin = loginOriginFor(contents.getURL());
  if (!pageOrigin || pageOrigin !== login.origin) return { ok: false, reason: "origin_mismatch" };
  try {
    // Mask the password in anything the agent reads before the page can echo it back.
    register(login.password);
    const result = (await contents.executeJavaScriptInIsolatedWorld(AUTOFILL_WORLD_ID, [
      { code: buildFillScript(login.username, login.password, login.origin) },
    ])) as { passwordField?: boolean; usernameField?: boolean } | undefined;
    // The page may have navigated while the script ran; the address must still match.
    if (contents.isDestroyed() || loginOriginFor(contents.getURL()) !== login.origin) {
      return { ok: false, reason: "origin_mismatch" };
    }
    if (!result?.passwordField) return { ok: false, reason: "no_password_field" };
    return { ok: true, filledUsername: result.usernameField === true, filledPassword: true };
  } catch {
    return { ok: false, reason: "failed" };
  }
}

/* ---------- Masking filled passwords in what the agent reads ---------- */

export const MASK = "[saved password]";
/** How long after a fill the agent may not take screenshots or run page scripts on that tab. */
const SENSITIVE_WINDOW_MS = 2 * 60_000;

const filled = new Map<string, { secrets: Set<string>; filledAt: number }>();

const keyOf = (taskId: string, sessionId: string) => `${taskId}\u0000${sessionId}`;

export function registerFilledPassword(taskId: string, sessionId: string, password: string): void {
  if (!password) return;
  const key = keyOf(taskId, sessionId);
  const entry = filled.get(key) ?? { secrets: new Set<string>(), filledAt: 0 };
  entry.secrets.add(password);
  entry.filledAt = Date.now();
  filled.set(key, entry);
}

export function forgetFilledPasswords(taskId: string, sessionId?: string): void {
  if (sessionId !== undefined) {
    filled.delete(keyOf(taskId, sessionId));
    return;
  }
  for (const key of filled.keys()) if (key.startsWith(`${taskId}\u0000`)) filled.delete(key);
}

/** Masking lasts as long as the tab session does (it is dropped when the session ends). */
export function hasFilledPasswords(taskId: string, sessionId: string): boolean {
  return filled.has(keyOf(taskId, sessionId));
}

/** True shortly after a fill, while the password may still be showing on the page. */
export function passwordRecentlyFilled(taskId: string, sessionId: string): boolean {
  const entry = filled.get(keyOf(taskId, sessionId));
  return Boolean(entry && Date.now() - entry.filledAt < SENSITIVE_WINDOW_MS);
}

function maskString(text: string, secrets: Set<string>): string {
  let out = text;
  // Longest first so one password that contains another is masked whole.
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (out.includes(secret)) out = out.split(secret).join(MASK);
  }
  return out;
}

/** A copy of a tool result with every filled password replaced; unchanged when none was filled. */
export function maskFilledPasswords<T>(taskId: string, sessionId: string, value: T): T {
  if (!hasFilledPasswords(taskId, sessionId)) return value;
  const secrets = filled.get(keyOf(taskId, sessionId))!.secrets;
  const walk = (node: unknown, depth: number): unknown => {
    if (typeof node === "string") return maskString(node, secrets);
    if (depth > 24 || node === null || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map((item) => walk(item, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(node))
      out[maskString(key, secrets)] = walk(item, depth + 1);
    return out;
  };
  return walk(value, 0) as T;
}
