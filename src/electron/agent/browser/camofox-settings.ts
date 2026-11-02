/**
 * Settings for the opt-in Camofox browser provider.
 *
 * Stored in its own encrypted SecureSettingsRepository category so the Camofox keys never
 * leave the main process. The server must be on this Mac's loopback interface, and CoWork only
 * uses it with an access key: Camofox has no authentication unless CAMOFOX_ACCESS_KEY is set,
 * so without one any local process (or a page that can reach loopback) could drive the
 * signed-in sessions CoWork loads into it.
 */

import { isIP } from "net";
import { SecureSettingsRepository } from "../../database/SecureSettingsRepository";
import { createLogger } from "../../utils/logger";
import {
  CAMOFOX_DEFAULT_PROXY_PORT,
  CAMOFOX_DEFAULT_SERVER_URL,
  type CamofoxDisplaySettings,
  type CamofoxSettingsUpdate,
} from "../../../shared/camofox";

const log = createLogger("CamofoxSettings");

export interface CamofoxSettings {
  enabled: boolean;
  serverUrl: string;
  proxyPort: number;
  persistentIdentity: boolean;
  /** CAMOFOX_ACCESS_KEY: bearer token for every route. Encrypted at rest. */
  accessKey?: string;
  /** CAMOFOX_API_KEY: bearer token for cookie import. Encrypted at rest. */
  apiKey?: string;
}

const DEFAULT_SETTINGS: CamofoxSettings = {
  enabled: false,
  serverUrl: CAMOFOX_DEFAULT_SERVER_URL,
  proxyPort: CAMOFOX_DEFAULT_PROXY_PORT,
  persistentIdentity: false,
};

const MAX_KEY_LENGTH = 512;

// Literal addresses only: a name (even "localhost") is resolved, and could point elsewhere.
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(host) === 4) return host.startsWith("127.");
  if (isIP(host) === 6) return host === "::1";
  return false;
}

/** The Camofox origin, or an error saying why the URL is not acceptable. */
export function resolveCamofoxOrigin(serverUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(String(serverUrl || "").trim());
  } catch {
    throw new Error("Camofox server URL is not a valid URL.");
  }
  if (parsed.protocol !== "http:") {
    throw new Error("Camofox server URL must use http:// on this Mac (loopback).");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Camofox server URL must not embed credentials; set the keys instead.");
  }
  if (!isLoopbackHost(parsed.hostname)) {
    throw new Error(
      "Camofox must run on this Mac: use 127.0.0.1 or [::1]. " +
        "A Camofox server on the network would let anyone there drive your sessions.",
    );
  }
  if ((parsed.pathname && parsed.pathname !== "/") || parsed.search || parsed.hash) {
    throw new Error("Camofox server URL must be an origin, such as http://127.0.0.1:9377.");
  }
  return parsed.origin;
}

function serverPortOf(serverUrl: string): number | null {
  try {
    const parsed = new URL(serverUrl);
    return Number(parsed.port || 80);
  } catch {
    return null;
  }
}

export function validateCamofoxProxyPort(port: unknown, serverUrl: string): number {
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("The policy proxy port must be a whole number from 1024 to 65535.");
  }
  if (serverPortOf(serverUrl) === port) {
    throw new Error("The policy proxy port must differ from the Camofox server port.");
  }
  return port;
}

function readKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= MAX_KEY_LENGTH ? trimmed : undefined;
}

function normalize(value: unknown): CamofoxSettings {
  const raw = (value && typeof value === "object" ? value : {}) as Partial<CamofoxSettings>;
  const accessKey = readKey(raw.accessKey);
  const apiKey = readKey(raw.apiKey);
  return {
    enabled: raw.enabled === true,
    serverUrl:
      typeof raw.serverUrl === "string" && raw.serverUrl.trim()
        ? raw.serverUrl.trim()
        : DEFAULT_SETTINGS.serverUrl,
    proxyPort:
      typeof raw.proxyPort === "number" && Number.isInteger(raw.proxyPort)
        ? raw.proxyPort
        : DEFAULT_SETTINGS.proxyPort,
    persistentIdentity: raw.persistentIdentity === true,
    ...(accessKey ? { accessKey } : {}),
    ...(apiKey ? { apiKey } : {}),
  };
}

function originOf(url: string): string | null {
  try {
    return new URL(url.trim()).origin;
  } catch {
    return null;
  }
}

export class CamofoxSettingsManager {
  private static cached: CamofoxSettings | null = null;

  static load(): CamofoxSettings {
    if (this.cached) return this.cached;
    let settings = { ...DEFAULT_SETTINGS };
    try {
      if (SecureSettingsRepository.isInitialized()) {
        settings = normalize(SecureSettingsRepository.getInstance().load("camofox"));
      }
    } catch (error) {
      log.error("Failed to load Camofox settings:", error);
    }
    this.cached = settings;
    return settings;
  }

  /**
   * Persist settings. An omitted key keeps the stored one, but only while the server origin
   * is unchanged, so a URL edit never carries a key to another server. `null` clears it.
   */
  static save(update: CamofoxSettingsUpdate): void {
    if (!SecureSettingsRepository.isInitialized()) {
      throw new Error("SecureSettingsRepository not initialized");
    }
    const current = this.load();
    const serverUrl = update.serverUrl ?? current.serverUrl;
    const sameOrigin = originOf(serverUrl) === originOf(current.serverUrl);
    const next = normalize({
      enabled: update.enabled ?? current.enabled,
      serverUrl,
      proxyPort: update.proxyPort ?? current.proxyPort,
      persistentIdentity: update.persistentIdentity ?? current.persistentIdentity,
      accessKey:
        update.accessKey === null
          ? undefined
          : (update.accessKey ?? (sameOrigin ? current.accessKey : undefined)),
      apiKey:
        update.apiKey === null
          ? undefined
          : (update.apiKey ?? (sameOrigin ? current.apiKey : undefined)),
    });
    resolveCamofoxOrigin(next.serverUrl);
    validateCamofoxProxyPort(next.proxyPort, next.serverUrl);
    if (next.enabled && !next.accessKey) {
      throw new Error(
        "Set an access key first, and start Camofox with the same CAMOFOX_ACCESS_KEY.",
      );
    }
    if (!SecureSettingsRepository.getInstance().save("camofox", next)) {
      throw new Error("Camofox settings were not saved: secure storage refused the write.");
    }
    this.cached = next;
  }

  /** Enabled settings with a usable loopback origin and an access key, or null. */
  static loadEnabled(): (CamofoxSettings & { origin: string; accessKey: string }) | null {
    const settings = this.load();
    if (!settings.enabled || !settings.accessKey) return null;
    try {
      const origin = resolveCamofoxOrigin(settings.serverUrl);
      validateCamofoxProxyPort(settings.proxyPort, settings.serverUrl);
      return { ...settings, origin, accessKey: settings.accessKey };
    } catch {
      return null;
    }
  }

  static getDisplaySettings(): CamofoxDisplaySettings {
    const settings = this.load();
    return {
      enabled: settings.enabled,
      serverUrl: settings.serverUrl,
      proxyPort: settings.proxyPort,
      persistentIdentity: settings.persistentIdentity,
      accessKeyConfigured: Boolean(settings.accessKey),
      apiKeyConfigured: Boolean(settings.apiKey),
    };
  }

  static clearCache(): void {
    this.cached = null;
  }
}
