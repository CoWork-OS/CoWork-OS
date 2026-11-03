/**
 * A strict reader for Netscape cookies.txt files (the format curl, wget, yt-dlp and the
 * "cookies.txt" browser extensions write). Each cookie is one tab-separated line:
 *
 *   domain  includeSubdomains  path  secure  expiry  name  value
 *
 * Lines that start with `#HttpOnly_` are HttpOnly cookies; any other `#` line is a comment.
 * Anything malformed is skipped and counted, never guessed at. Cookie names, values and
 * hosts are validated again by mapCookies before they are used.
 */

import type { ExternalCookie } from "./external-browsers";

export const MAX_COOKIES_TXT_BYTES = 5 * 1024 * 1024;
export const MAX_COOKIES_TXT_COOKIES = 5_000;

const HTTP_ONLY_PREFIX = "#HttpOnly_";
const EXPIRY_PATTERN = /^\d{1,15}(\.\d+)?$/;

export class CookiesTxtError extends Error {
  constructor(
    readonly code: "too_large" | "not_text",
    message: string,
  ) {
    super(message);
    this.name = "CookiesTxtError";
  }
}

export interface NetscapeCookiesResult {
  cookies: ExternalCookie[];
  skipped: { invalid: number; tooMany: number };
}

function flag(value: string): boolean | null {
  const upper = value.toUpperCase();
  return upper === "TRUE" ? true : upper === "FALSE" ? false : null;
}

function parseLine(line: string): ExternalCookie | null {
  const httpOnly = line.startsWith(HTTP_ONLY_PREFIX);
  const fields = (httpOnly ? line.slice(HTTP_ONLY_PREFIX.length) : line).split("\t");
  if (fields.length !== 7) return null;
  const [domain, subdomains, path, secureFlag, expiry, name, value] = fields;
  const includeSubdomains = flag(subdomains);
  const secure = flag(secureFlag);
  if (includeSubdomains === null || secure === null || !EXPIRY_PATTERN.test(expiry)) return null;
  const bare = domain.toLowerCase().replace(/^\./, "");
  // A leading dot already means "and subdomains"; a file that says otherwise is contradictory.
  if (!bare || (domain.startsWith(".") && !includeSubdomains)) return null;
  const expiresAt = Math.floor(Number(expiry));
  return {
    // mapCookies reads a leading dot as a domain cookie, like Chromium's host_key.
    host: includeSubdomains ? `.${bare}` : bare,
    name,
    value,
    path,
    secure,
    httpOnly,
    sameSite: "unspecified",
    // 0 marks a session cookie.
    expiresAt: expiresAt > 0 ? expiresAt : undefined,
  };
}

/** Parse the text of a cookies.txt file. Throws only when the whole file is unusable. */
export function parseNetscapeCookies(text: string): NetscapeCookiesResult {
  if (Buffer.byteLength(text, "utf8") > MAX_COOKIES_TXT_BYTES) {
    throw new CookiesTxtError("too_large", "The file is too large.");
  }
  if (text.includes("\0")) throw new CookiesTxtError("not_text", "The file is not a text file.");
  // A byte-order mark is not part of the first line.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const cookies: ExternalCookie[] = [];
  const skipped = { invalid: 0, tooMany: 0 };
  for (const line of text.split(/\r\n|\n|\r/)) {
    if (!line.trim()) continue;
    if (line.startsWith("#") && !line.startsWith(HTTP_ONLY_PREFIX)) continue;
    const cookie = parseLine(line);
    if (!cookie) {
      skipped.invalid += 1;
    } else if (cookies.length >= MAX_COOKIES_TXT_COOKIES) {
      skipped.tooMany += 1;
    } else {
      cookies.push(cookie);
    }
  }
  return { cookies, skipped };
}
