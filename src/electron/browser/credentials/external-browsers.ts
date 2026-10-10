/**
 * Reading another browser's cookies and saved logins, only when the user asks for it (macOS).
 *
 * - Chrome-family browsers keep cookies and logins encrypted with a key held in the macOS
 *   Keychain ("<Browser> Safe Storage"). Reading that key makes macOS ask the user to allow
 *   it; if they refuse, nothing is read.
 * - Databases are copied to a private temporary folder and read there with the system
 *   `sqlite3` tool in read-only mode, so the other browser's files are never written to and
 *   a running browser's locks don't matter. The copies are removed afterwards.
 * - Everything returned stays in memory for the caller (the main process); nothing is logged.
 */

import { execFile } from "child_process";
import { createDecipheriv, createHash, pbkdf2Sync } from "crypto";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";
import type { ImportedLogin } from "./password-csv";
import { MAX_PASSWORD_CHARS, MAX_USERNAME_CHARS } from "./password-csv";
import { loginOriginFor } from "./login-origin";

const execFileAsync = promisify(execFile);

export type ImportErrorCode =
  | "unsupported_platform"
  | "not_found"
  | "keychain_denied"
  | "read_failed"
  | "decrypt_failed";

export class ImportError extends Error {
  constructor(
    readonly code: ImportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ImportError";
  }
}

export interface ExternalCookie {
  host: string;
  name: string;
  value: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: "unspecified" | "no_restriction" | "lax" | "strict";
  /** Unix seconds; undefined for a session cookie. */
  expiresAt?: number;
}

export interface ChromiumBrowserDef {
  id: string;
  name: string;
  /** Under ~/Library/Application Support. */
  dir: string;
  keychainService: string;
  keychainAccount: string;
}

export const CHROMIUM_BROWSERS: ChromiumBrowserDef[] = [
  {
    id: "chrome",
    name: "Google Chrome",
    dir: "Google/Chrome",
    keychainService: "Chrome Safe Storage",
    keychainAccount: "Chrome",
  },
  {
    id: "edge",
    name: "Microsoft Edge",
    dir: "Microsoft Edge",
    keychainService: "Microsoft Edge Safe Storage",
    keychainAccount: "Microsoft Edge",
  },
  {
    id: "brave",
    name: "Brave",
    dir: "BraveSoftware/Brave-Browser",
    keychainService: "Brave Safe Storage",
    keychainAccount: "Brave",
  },
  {
    id: "chromium",
    name: "Chromium",
    dir: "Chromium",
    keychainService: "Chromium Safe Storage",
    keychainAccount: "Chromium",
  },
  {
    id: "vivaldi",
    name: "Vivaldi",
    dir: "Vivaldi",
    keychainService: "Vivaldi Safe Storage",
    keychainAccount: "Vivaldi",
  },
  {
    id: "arc",
    name: "Arc",
    dir: "Arc/User Data",
    keychainService: "Arc Safe Storage",
    keychainAccount: "Arc",
  },
];

export interface DetectedBrowser {
  id: string;
  name: string;
  kind: "chromium" | "firefox";
  profiles: Array<{ id: string; name: string }>;
}

export interface ExternalBrowserDeps {
  platform: NodeJS.Platform;
  /** The user's home directory. */
  homeDir: string;
  /** A private folder for temporary database copies (created with owner-only access). */
  makeTempDir: () => Promise<string>;
  /** Rows of a read-only query against a database file. */
  querySqlite: (dbPath: string, sql: string) => Promise<Array<Record<string, unknown>>>;
  /** The Keychain secret for a browser's cookie and login key. */
  keychainSecret: (service: string, account: string) => Promise<Buffer>;
  now: () => number;
}

export function defaultExternalBrowserDeps(): ExternalBrowserDeps {
  return {
    platform: process.platform,
    homeDir: os.homedir(),
    makeTempDir: async () => {
      // Copies left by a crashed import are removed first.
      for (const name of await fs.readdir(os.tmpdir()).catch(() => [] as string[])) {
        if (!name.startsWith("cowork-import-")) continue;
        const stale = path.join(os.tmpdir(), name);
        const stat = await fs.stat(stale).catch(() => null);
        if (stat && Date.now() - stat.mtimeMs > 3_600_000) {
          await fs.rm(stale, { recursive: true, force: true }).catch(() => undefined);
        }
      }
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-import-"));
      await fs.chmod(dir, 0o700);
      return dir;
    },
    querySqlite: async (dbPath, sql) => {
      try {
        const { stdout } = await execFileAsync(
          "/usr/bin/sqlite3",
          ["-readonly", "-json", dbPath, sql],
          {
            maxBuffer: 256 * 1024 * 1024,
            timeout: 60_000,
          },
        );
        const text = stdout.trim();
        return text ? (JSON.parse(text) as Array<Record<string, unknown>>) : [];
      } catch {
        throw new ImportError("read_failed", "The other browser's data could not be read.");
      }
    },
    keychainSecret: async (service, account) => {
      try {
        const { stdout } = await execFileAsync(
          "/usr/bin/security",
          ["find-generic-password", "-w", "-s", service, "-a", account],
          { timeout: 120_000 },
        );
        return Buffer.from(stdout.replace(/\r?\n$/, ""), "utf8");
      } catch {
        throw new ImportError(
          "keychain_denied",
          "Access to the browser's saved key was not allowed.",
        );
      }
    },
    now: Date.now,
  };
}

const APP_SUPPORT = "Library/Application Support";

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function readJson(file: string): Promise<Any | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

/** Browsers installed on this Mac, with their profiles (names only; nothing secret is read). */
export async function detectBrowsers(deps: ExternalBrowserDeps): Promise<DetectedBrowser[]> {
  if (deps.platform !== "darwin") return [];
  const found: DetectedBrowser[] = [];
  const support = path.join(deps.homeDir, APP_SUPPORT);
  for (const browser of CHROMIUM_BROWSERS) {
    const root = path.join(support, browser.dir);
    if (!(await exists(root))) continue;
    const state = await readJson(path.join(root, "Local State"));
    const cache = (state?.profile?.info_cache ?? {}) as Record<string, { name?: string }>;
    const profiles: DetectedBrowser["profiles"] = [];
    for (const [dir, info] of Object.entries(cache)) {
      if (!/^(Default|Profile \d+)$/.test(dir)) continue;
      profiles.push({ id: dir, name: String(info?.name || dir).slice(0, 80) });
    }
    if (profiles.length === 0 && (await exists(path.join(root, "Default")))) {
      profiles.push({ id: "Default", name: "Default" });
    }
    if (profiles.length > 0) {
      found.push({ id: browser.id, name: browser.name, kind: "chromium", profiles });
    }
  }
  const firefoxRoot = path.join(support, "Firefox");
  try {
    const ini = await fs.readFile(path.join(firefoxRoot, "profiles.ini"), "utf8");
    const profiles: DetectedBrowser["profiles"] = [];
    for (const block of ini.split(/\r?\n\s*\r?\n/)) {
      const name = /^Name=(.+)$/m.exec(block)?.[1]?.trim();
      const dir = /^Path=(.+)$/m.exec(block)?.[1]?.trim();
      if (!name || !dir || !/^Profiles\/[\w.-]+$/.test(dir)) continue;
      if (await exists(path.join(firefoxRoot, dir, "cookies.sqlite"))) {
        profiles.push({ id: dir.slice("Profiles/".length), name: name.slice(0, 80) });
      }
    }
    if (profiles.length > 0) {
      found.push({ id: "firefox", name: "Firefox", kind: "firefox", profiles });
    }
  } catch {
    // Firefox is not installed.
  }
  return found;
}

/* ---------- Chrome-family decryption ---------- */

/** The AES key Chrome derives from its Keychain secret on macOS (PBKDF2-SHA1, "saltysalt"). */
export function deriveChromiumKey(secret: Buffer): Buffer {
  return pbkdf2Sync(secret, "saltysalt", 1003, 16, "sha1");
}

/** Decrypt a Chrome "v10" value (AES-128-CBC, space IV). Null when it is not decryptable. */
export function decryptChromiumValue(encrypted: Buffer, key: Buffer): Buffer | null {
  if (encrypted.length < 4 || encrypted.subarray(0, 3).toString("latin1") !== "v10") return null;
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
    return Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
  } catch {
    return null;
  }
}

function fromHex(value: unknown): Buffer {
  return typeof value === "string" && /^[0-9a-fA-F]*$/.test(value)
    ? Buffer.from(value, "hex")
    : Buffer.alloc(0);
}

/** Chrome 130+ prefixes a cookie's value with SHA-256 of its host; the prefix is dropped when present. */
function stripHostHash(plain: Buffer, host: string): Buffer {
  if (
    plain.length >= 32 &&
    plain.subarray(0, 32).equals(createHash("sha256").update(host).digest())
  ) {
    return plain.subarray(32);
  }
  return plain;
}

/** Copy a database (and its write-ahead files) into a private folder so it can be read while the browser runs. */
async function copyDatabase(
  deps: ExternalBrowserDeps,
  source: string,
): Promise<{ dir: string; db: string }> {
  const dir = await deps.makeTempDir();
  const db = path.join(dir, "data.sqlite");
  try {
    await fs.copyFile(source, db);
    for (const suffix of ["-wal", "-shm"]) {
      if (await exists(source + suffix)) await fs.copyFile(source + suffix, db + suffix);
    }
    await fs.chmod(db, 0o600);
  } catch {
    await fs.rm(dir, { recursive: true, force: true });
    throw new ImportError("read_failed", "The other browser's data could not be read.");
  }
  return { dir, db };
}

async function withDatabaseCopy<T>(
  deps: ExternalBrowserDeps,
  source: string,
  use: (db: string) => Promise<T>,
): Promise<T> {
  if (!(await exists(source)))
    throw new ImportError("not_found", "That browser has no data to import.");
  const copy = await copyDatabase(deps, source);
  try {
    return await use(copy.db);
  } finally {
    await fs.rm(copy.dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function chromiumProfileDir(
  deps: ExternalBrowserDeps,
  browser: ChromiumBrowserDef,
  profileId: string,
): string {
  if (!/^(Default|Profile \d+)$/.test(profileId)) {
    throw new ImportError("not_found", "That browser profile was not found.");
  }
  return path.join(deps.homeDir, APP_SUPPORT, browser.dir, profileId);
}

const SAME_SITE: Record<number, ExternalCookie["sameSite"]> = {
  [-1]: "unspecified",
  0: "no_restriction",
  1: "lax",
  2: "strict",
};

/** Chrome stores expiry as microseconds since 1601-01-01. */
function chromeExpiryToUnix(value: unknown): number | undefined {
  const micros = Number(value);
  if (!Number.isFinite(micros) || micros <= 0) return undefined;
  return Math.floor(micros / 1_000_000 - 11_644_473_600);
}

export async function readChromiumCookies(
  deps: ExternalBrowserDeps,
  browser: ChromiumBrowserDef,
  profileId: string,
): Promise<ExternalCookie[]> {
  const profile = chromiumProfileDir(deps, browser, profileId);
  const key = deriveChromiumKey(
    await deps.keychainSecret(browser.keychainService, browser.keychainAccount),
  );
  try {
    const source = (await exists(path.join(profile, "Network", "Cookies")))
      ? path.join(profile, "Network", "Cookies")
      : path.join(profile, "Cookies");
    return await withDatabaseCopy(deps, source, async (db) => {
      const columns =
        "host_key, name, value, hex(encrypted_value) AS enc, path, expires_utc, is_secure, is_httponly, samesite";
      let rows: Array<Record<string, unknown>>;
      try {
        // Partitioned cookies (CHIPS) belong to one embedding site and are not imported.
        rows = await deps.querySqlite(
          db,
          `SELECT ${columns} FROM cookies WHERE top_frame_site_key = ''`,
        );
      } catch {
        rows = await deps.querySqlite(db, `SELECT ${columns} FROM cookies`);
      }
      const cookies: ExternalCookie[] = [];
      for (const row of rows) {
        const host = String(row.host_key || "");
        let value = typeof row.value === "string" ? row.value : "";
        if (!value) {
          const plain = decryptChromiumValue(fromHex(row.enc), key);
          if (!plain) continue;
          value = stripHostHash(plain, host).toString("utf8");
        }
        cookies.push({
          host,
          name: String(row.name || ""),
          value,
          path: String(row.path || "/"),
          secure: Number(row.is_secure) === 1,
          httpOnly: Number(row.is_httponly) === 1,
          sameSite: SAME_SITE[Number(row.samesite)] ?? "unspecified",
          expiresAt: chromeExpiryToUnix(row.expires_utc),
        });
      }
      return cookies;
    });
  } finally {
    key.fill(0);
  }
}

export async function readChromiumLogins(
  deps: ExternalBrowserDeps,
  browser: ChromiumBrowserDef,
  profileId: string,
): Promise<ImportedLogin[]> {
  const profile = chromiumProfileDir(deps, browser, profileId);
  const key = deriveChromiumKey(
    await deps.keychainSecret(browser.keychainService, browser.keychainAccount),
  );
  try {
    return await withDatabaseCopy(deps, path.join(profile, "Login Data"), async (db) => {
      const rows = await deps.querySqlite(
        db,
        "SELECT origin_url, username_value, hex(password_value) AS enc FROM logins WHERE blacklisted_by_user = 0",
      );
      const logins: ImportedLogin[] = [];
      for (const row of rows) {
        const origin = loginOriginFor(String(row.origin_url || ""));
        const username = String(row.username_value || "").trim();
        const plain = decryptChromiumValue(fromHex(row.enc), key);
        if (!origin || !plain || plain.length === 0) continue;
        const password = plain.toString("utf8");
        if (username.length > MAX_USERNAME_CHARS || password.length > MAX_PASSWORD_CHARS) continue;
        logins.push({ origin, username, password });
      }
      return logins;
    });
  } finally {
    key.fill(0);
  }
}

/* ---------- Firefox ---------- */

const FIREFOX_SAME_SITE: Record<number, ExternalCookie["sameSite"]> = {
  0: "no_restriction",
  1: "lax",
  2: "strict",
};

export async function readFirefoxCookies(
  deps: ExternalBrowserDeps,
  profileId: string,
): Promise<ExternalCookie[]> {
  if (!/^[\w.-]+$/.test(profileId) || profileId === "." || profileId === "..")
    throw new ImportError("not_found", "That browser profile was not found.");
  const source = path.join(
    deps.homeDir,
    APP_SUPPORT,
    "Firefox",
    "Profiles",
    profileId,
    "cookies.sqlite",
  );
  return withDatabaseCopy(deps, source, async (db) => {
    const rows = await deps.querySqlite(
      db,
      "SELECT host, name, value, path, expiry, isSecure, isHttpOnly, sameSite, originAttributes FROM moz_cookies",
    );
    const cookies: ExternalCookie[] = [];
    for (const row of rows) {
      // Containers, private windows and partitioned cookies carry origin attributes: skipped.
      if (String(row.originAttributes || "") !== "") continue;
      const expiry = Number(row.expiry);
      cookies.push({
        host: String(row.host || ""),
        name: String(row.name || ""),
        value: String(row.value ?? ""),
        path: String(row.path || "/"),
        secure: Number(row.isSecure) === 1,
        httpOnly: Number(row.isHttpOnly) === 1,
        sameSite: FIREFOX_SAME_SITE[Number(row.sameSite)] ?? "unspecified",
        // Newer Firefox stores milliseconds.
        expiresAt:
          Number.isFinite(expiry) && expiry > 0
            ? expiry > 1e11
              ? Math.floor(expiry / 1000)
              : expiry
            : undefined,
      });
    }
    return cookies;
  });
}

export function chromiumBrowserById(id: string): ChromiumBrowserDef | undefined {
  return CHROMIUM_BROWSERS.find((browser) => browser.id === id);
}
