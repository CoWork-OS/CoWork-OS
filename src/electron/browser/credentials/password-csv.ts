/**
 * Password exports from browsers and password managers, normalized to one shape. Column
 * names differ (Chrome and Edge: name,url,username,password; Firefox: url,username,password,...;
 * Safari and 1Password: Title,URL,Username,Password,...; Bitwarden: login_uri,login_username,
 * login_password), so columns are matched by header name.
 */

import { loginOriginFor } from "./login-origin";
import { parseCsv } from "./csv";

export interface ImportedLogin {
  origin: string;
  username: string;
  password: string;
}

export type SkipReason = "not_a_web_login" | "no_password" | "too_long" | "duplicate";

export interface PasswordCsvResult {
  logins: ImportedLogin[];
  skipped: Record<SkipReason, number>;
  /** Rows read (not counting the header). */
  rows: number;
}

export const MAX_USERNAME_CHARS = 512;
export const MAX_PASSWORD_CHARS = 1024;

const URL_COLUMNS = ["url", "login_uri", "website", "web site", "origin", "site", "hostname"];
const USER_COLUMNS = ["username", "login_username", "user", "login", "email", "user name"];
const PASSWORD_COLUMNS = ["password", "login_password", "pass"];

function findColumn(header: string[], names: string[]): number {
  const lowered = header.map((cell) => cell.trim().toLowerCase());
  for (const name of names) {
    const index = lowered.indexOf(name);
    if (index >= 0) return index;
  }
  return -1;
}

/** Firefox exports `hostname` as an origin, other exports a full address; a bare host is https. */
function addressOf(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  return /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
}

export function parsePasswordCsv(text: string): PasswordCsvResult {
  const table = parseCsv(text);
  const skipped: Record<SkipReason, number> = {
    not_a_web_login: 0,
    no_password: 0,
    too_long: 0,
    duplicate: 0,
  };
  if (table.length === 0) return { logins: [], skipped, rows: 0 };
  const [header, ...body] = table;
  const urlColumn = findColumn(header, URL_COLUMNS);
  const userColumn = findColumn(header, USER_COLUMNS);
  const passwordColumn = findColumn(header, PASSWORD_COLUMNS);
  if (urlColumn < 0 || passwordColumn < 0) {
    throw new Error(
      "This file does not look like a password export (no URL and password columns).",
    );
  }
  const logins: ImportedLogin[] = [];
  const seen = new Map<string, number>();
  for (const row of body) {
    const origin = loginOriginFor(addressOf(row[urlColumn] || ""));
    const username = userColumn >= 0 ? (row[userColumn] || "").trim() : "";
    const password = row[passwordColumn] || "";
    if (!origin) {
      skipped.not_a_web_login += 1;
    } else if (!password) {
      skipped.no_password += 1;
    } else if (username.length > MAX_USERNAME_CHARS || password.length > MAX_PASSWORD_CHARS) {
      skipped.too_long += 1;
    } else {
      const key = `${origin}\0${username}`;
      const existing = seen.get(key);
      if (existing !== undefined) {
        // The later row wins, as when a site's password was changed.
        logins[existing] = { origin, username, password };
        skipped.duplicate += 1;
      } else {
        seen.set(key, logins.length);
        logins.push({ origin, username, password });
      }
    }
  }
  return { logins, skipped, rows: body.length };
}
