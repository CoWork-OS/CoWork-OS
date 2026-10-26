/**
 * One-use sign-in links for the browser app.
 *
 * The pairing code rides in the URL fragment, which browsers never send to the server, so it
 * stays out of request lines, proxy logs and Referer headers. The browser entry reads it once,
 * removes it from the address bar, and redeems it. A code works once and expires in seconds,
 * so a copy left in browser history is useless.
 */
import { WEB_APP_PATH } from "./host-api/contracts";

/** Fragment parameter that carries the one-use code: `/app/#pair=<code>`. */
export const BROWSER_APP_SIGN_IN_PARAM = "pair";

/** Pairing codes are base64url; anything else in the fragment is ignored. */
const SIGN_IN_CODE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

/** The browser app's address on a listener origin such as `http://127.0.0.1:3847`. */
export function browserAppUrl(origin: string): string {
  return new URL(WEB_APP_PATH, origin).toString();
}

export function buildBrowserAppSignInUrl(origin: string, code: string): string {
  if (!SIGN_IN_CODE_PATTERN.test(code)) throw new Error("Invalid browser sign-in code.");
  const url = new URL(WEB_APP_PATH, origin);
  url.hash = `${BROWSER_APP_SIGN_IN_PARAM}=${code}`;
  return url.toString();
}

/** The one-use code in a location hash, or null when the hash carries none. */
export function readBrowserAppSignInCode(hash: string): string | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) return null;
  const code = new URLSearchParams(raw).get(BROWSER_APP_SIGN_IN_PARAM)?.trim();
  return code && SIGN_IN_CODE_PATTERN.test(code) ? code : null;
}
