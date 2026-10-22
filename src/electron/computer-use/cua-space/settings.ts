/**
 * Settings for running Computer Use inside a Cua Space instead of on the host desktop.
 *
 * Stored in its own encrypted SecureSettingsRepository category (not in builtin tool
 * settings, which round-trip whole to the renderer) so the Space bearer token never
 * leaves the main process.
 */

import { isIP } from "net";
import { SecureSettingsRepository } from "../../database/SecureSettingsRepository";
import { createLogger } from "../../utils/logger";
import type { CuaSpaceDisplaySettings, CuaSpaceSettingsUpdate } from "../../../shared/cua-space";

const log = createLogger("CuaSpaceSettings");

export interface CuaSpaceSettings {
  /** When true, Computer Use tools drive the Space instead of the host desktop. */
  enabled: boolean;
  /** cua-spacesd base URL, e.g. http://192.168.64.5:3211 */
  url: string;
  /** Bearer token for cua-spacesd (CUA_ENV_TOKEN). Encrypted at rest. */
  token?: string;
}

export interface CuaSpaceEndpoint {
  origin: string;
  mcpUrl: string;
  healthUrl: string;
  /** True for loopback hosts, where cua-spacesd may run without a token. */
  loopback: boolean;
}

const DEFAULT_SETTINGS: CuaSpaceSettings = { enabled: false, url: "" };

/**
 * Strip IPv6 brackets and unwrap IPv4-mapped IPv6. WHATWG URL parsing already
 * canonicalizes decimal/octal/hex IPv4 forms and rewrites `::ffff:127.0.0.1` to
 * `::ffff:7f00:1`, so only the hex-mapped form needs unwrapping here.
 */
function canonicalHost(hostname: string): string {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (mapped) {
    const high = parseInt(mapped[1], 16);
    const low = parseInt(mapped[2], 16);
    return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
  }
  return host.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, "");
}

// Trust is decided from the literal host only. DNS names are always treated as
// public (https + token), so a name that resolves to a private IP cannot relax it.
function isLoopbackHost(hostname: string): boolean {
  const host = canonicalHost(hostname);
  // Literal "localhost" only: a *.localhost name may still reach a DNS resolver.
  if (host === "localhost") return true;
  if (isIP(host) === 4) return host.startsWith("127.");
  if (isIP(host) === 6) return host === "::1";
  return false;
}

function isPrivateHost(hostname: string): boolean {
  const host = canonicalHost(hostname);
  if (isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number);
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (isIP(host) === 6) {
    // fc00::/7 unique-local and fe80::/10 link-local.
    return /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host);
  }
  return false;
}

/**
 * Validate a configured Space URL. Plain http is only accepted for loopback and
 * private-network hosts (a Space on this Mac or an owned machine on the LAN); anything else
 * must use https so the bearer token is not sent in the clear. A token is required
 * for every non-loopback host because cua-spacesd refuses non-loopback binds without one.
 */
export function resolveCuaSpaceEndpoint(url: string, token: string | undefined): CuaSpaceEndpoint {
  let parsed: URL;
  try {
    parsed = new URL(String(url || "").trim());
  } catch {
    throw new Error("Cua Space URL is not a valid URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Cua Space URL must use http:// or https://.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Cua Space URL must not embed credentials; configure the token instead.");
  }
  const loopback = isLoopbackHost(parsed.hostname);
  if (parsed.protocol === "http:" && !loopback && !isPrivateHost(parsed.hostname)) {
    throw new Error("Cua Space URL must use https:// for hosts outside the local network.");
  }
  if (!loopback && !token) {
    throw new Error("Cua Space token is required for non-loopback Spaces.");
  }
  const origin = parsed.origin;
  return { origin, mcpUrl: `${origin}/mcp`, healthUrl: `${origin}/health`, loopback };
}

function originOf(url: string): string | null {
  try {
    return new URL(url.trim()).origin;
  } catch {
    return null;
  }
}

function normalize(value: unknown): CuaSpaceSettings {
  const raw = (value && typeof value === "object" ? value : {}) as Partial<CuaSpaceSettings>;
  const token = typeof raw.token === "string" && raw.token.trim() ? raw.token.trim() : undefined;
  return {
    enabled: raw.enabled === true,
    url: typeof raw.url === "string" ? raw.url.trim() : "",
    ...(token ? { token } : {}),
  };
}

export class CuaSpaceSettingsManager {
  private static cached: CuaSpaceSettings | null = null;

  static load(): CuaSpaceSettings {
    if (this.cached) return this.cached;
    let settings = { ...DEFAULT_SETTINGS };
    try {
      if (SecureSettingsRepository.isInitialized()) {
        settings = normalize(SecureSettingsRepository.getInstance().load("cua-space"));
      }
    } catch (error) {
      log.error("Failed to load Cua Space settings:", error);
    }
    this.cached = settings;
    return settings;
  }

  /**
   * Persist settings. `token: undefined` keeps the stored token, but only while the
   * Space origin is unchanged, so a URL edit can never carry the token to another
   * host. `token: null` clears it.
   */
  static save(update: CuaSpaceSettingsUpdate): void {
    if (!SecureSettingsRepository.isInitialized()) {
      throw new Error("SecureSettingsRepository not initialized");
    }
    const current = this.load();
    const url = update.url ?? current.url;
    const keptToken = originOf(url) === originOf(current.url) ? current.token : undefined;
    const next = normalize({
      enabled: update.enabled ?? current.enabled,
      url,
      token: update.token === null ? undefined : (update.token ?? keptToken),
    });
    if (next.enabled) {
      resolveCuaSpaceEndpoint(next.url, next.token);
    }
    if (!SecureSettingsRepository.getInstance().save("cua-space", next)) {
      throw new Error("Cua Space settings were not saved: secure storage refused the write.");
    }
    this.cached = next;
  }

  static getDisplaySettings(): CuaSpaceDisplaySettings {
    const settings = this.load();
    return {
      enabled: settings.enabled,
      url: settings.url,
      tokenConfigured: Boolean(settings.token),
    };
  }

  static clearCache(): void {
    this.cached = null;
  }
}
