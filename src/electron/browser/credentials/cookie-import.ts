/**
 * Turning another browser's cookies into cookies for one CoWork browser profile.
 * Every cookie is validated first; anything odd is skipped and counted, never guessed at.
 */

import type { ExternalCookie } from "./external-browsers";

export const MAX_COOKIES = 20_000;
const MAX_COOKIE_VALUE = 4096;
const MAX_COOKIE_NAME = 256;
const HOST_PATTERN = /^\.?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
// Cookie names and values may not hold control characters, spaces in names, or separators.
const BAD_NAME = /[\u0000- \u007f()<>@,;:\\"/[\]?={}]/;
const BAD_VALUE = /[\u0000-\u001f\u007f;]/;

export interface CookieSetDetails {
  url: string;
  name: string;
  value: string;
  domain?: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  expirationDate?: number;
  sameSite: "unspecified" | "no_restriction" | "lax" | "strict";
}

export interface CookieMapResult {
  cookies: CookieSetDetails[];
  skipped: { invalid: number; expired: number; tooMany: number };
}

export function mapCookies(input: ExternalCookie[], nowSeconds: number): CookieMapResult {
  const cookies: CookieSetDetails[] = [];
  const skipped = { invalid: 0, expired: 0, tooMany: 0 };
  for (const cookie of input) {
    if (cookies.length >= MAX_COOKIES) {
      skipped.tooMany += 1;
      continue;
    }
    const host = cookie.host.toLowerCase();
    const bare = host.replace(/^\./, "");
    if (
      !HOST_PATTERN.test(host) ||
      (!bare.includes(".") && bare !== "localhost") ||
      !cookie.name ||
      cookie.name.length > MAX_COOKIE_NAME ||
      BAD_NAME.test(cookie.name) ||
      cookie.value.length > MAX_COOKIE_VALUE ||
      BAD_VALUE.test(cookie.value) ||
      !cookie.path.startsWith("/") ||
      /[\u0000-\u001f\u007f;]/.test(cookie.path)
    ) {
      skipped.invalid += 1;
      continue;
    }
    if (cookie.expiresAt !== undefined && cookie.expiresAt <= nowSeconds) {
      skipped.expired += 1;
      continue;
    }
    const secureOnly =
      cookie.secure || cookie.name.startsWith("__Secure-") || cookie.name.startsWith("__Host-");
    const isHostPrefixed = cookie.name.startsWith("__Host-");
    if (isHostPrefixed && (host.startsWith(".") || cookie.path !== "/")) {
      skipped.invalid += 1;
      continue;
    }
    // Browsers refuse SameSite=None without Secure.
    const sameSite =
      cookie.sameSite === "no_restriction" && !secureOnly ? "unspecified" : cookie.sameSite;
    cookies.push({
      url: `${secureOnly ? "https" : "http"}://${bare}${cookie.path}`,
      name: cookie.name,
      value: cookie.value,
      // A leading dot means "this host and its subdomains"; host-only cookies carry no domain.
      domain: host.startsWith(".") ? host : undefined,
      path: cookie.path,
      secure: secureOnly,
      httpOnly: cookie.httpOnly,
      expirationDate: cookie.expiresAt,
      sameSite,
    });
  }
  return { cookies, skipped };
}

export interface CookieJar {
  set(details: CookieSetDetails): Promise<void>;
}

/** Applies cookies to a profile's session; returns how many the browser accepted. */
export async function applyCookies(
  jar: CookieJar,
  cookies: CookieSetDetails[],
): Promise<{ imported: number; rejected: number }> {
  let imported = 0;
  let rejected = 0;
  for (const cookie of cookies) {
    try {
      await jar.set(cookie);
      imported += 1;
    } catch {
      rejected += 1;
    }
  }
  return { imported, rejected };
}
