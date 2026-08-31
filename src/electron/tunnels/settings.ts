import * as fs from "fs";
import * as path from "path";
import { randomBytes } from "crypto";
import { v4 as uuidv4 } from "uuid";
import {
  SecureSettingsRepository,
  type SettingsCategory,
} from "../database/SecureSettingsRepository";
import { getUserDataDir } from "../utils/user-data-dir";
import { getSafeStorage } from "../utils/safe-storage";
import { createLogger } from "../utils/logger";
import {
  DEFAULT_SECURE_MCP_TUNNEL_POLICY,
  DEFAULT_SECURE_MCP_TUNNEL_SETTINGS,
  SecureMcpTunnelConfig,
  SecureMcpTunnelCreateInput,
  SecureMcpTunnelDisplayConfig,
  SecureMcpTunnelDisplaySettings,
  SecureMcpTunnelSettings,
  SecureMcpTunnelUpdateInput,
} from "./types";

const SETTINGS_CATEGORY = "secure-mcp-tunnels" as SettingsCategory;
const LEGACY_SETTINGS_FILE = "secure-mcp-tunnels.json";
const ENCRYPTED_PREFIX = "encrypted:";
const MASKED_VALUE = "***configured***";
const logger = createLogger("SecureMcpTunnelSettings");

export class SecureMcpTunnelSettingsManager {
  private static cachedSettings: SecureMcpTunnelSettings | null = null;

  static initialize(): void {
    this.cachedSettings = null;
    this.loadSettings();
  }

  static loadSettings(): SecureMcpTunnelSettings {
    if (this.cachedSettings) {
      return this.cachedSettings;
    }

    const loaded =
      this.loadFromRepository() ?? this.loadFromFile() ?? DEFAULT_SECURE_MCP_TUNNEL_SETTINGS;
    this.cachedSettings = this.decryptSettings(this.normalizeSettings(loaded));
    return this.cachedSettings;
  }

  static getSettingsForDisplay(): SecureMcpTunnelDisplaySettings {
    return {
      tunnels: this.loadSettings().tunnels.map((tunnel) => this.toDisplayConfig(tunnel)),
    };
  }

  static addTunnel(input: SecureMcpTunnelCreateInput): SecureMcpTunnelDisplayConfig {
    const settings = this.loadSettings();
    const now = Date.now();
    const tunnel: SecureMcpTunnelConfig = {
      id: uuidv4(),
      name: input.name.trim(),
      enabled: input.enabled ?? false,
      relayUrl: input.relayUrl.trim(),
      targetType: input.targetType,
      targetUrl: input.targetUrl?.trim() || undefined,
      coworkHostPort: input.coworkHostPort ?? 3333,
      policy: {
        ...DEFAULT_SECURE_MCP_TUNNEL_POLICY,
        ...input.policy,
        allowedTools: sanitizeAllowedTools(input.policy?.allowedTools),
      },
      clientToken: input.clientToken?.trim() || undefined,
      callerToken: input.callerToken?.trim() || undefined,
      createdAt: now,
      updatedAt: now,
    };
    settings.tunnels.push(tunnel);
    this.saveSettings(settings);
    return this.toDisplayConfig(tunnel);
  }

  static updateTunnel(
    id: string,
    updates: SecureMcpTunnelUpdateInput,
  ): SecureMcpTunnelDisplayConfig | null {
    const settings = this.loadSettings();
    const index = settings.tunnels.findIndex((tunnel) => tunnel.id === id);
    if (index === -1) {
      return null;
    }

    const current = settings.tunnels[index];
    const next: SecureMcpTunnelConfig = {
      ...current,
      name: updates.name !== undefined ? updates.name.trim() : current.name,
      enabled: updates.enabled !== undefined ? updates.enabled : current.enabled,
      relayUrl: updates.relayUrl !== undefined ? updates.relayUrl.trim() : current.relayUrl,
      targetType: updates.targetType ?? current.targetType,
      targetUrl:
        updates.targetUrl !== undefined ? updates.targetUrl.trim() || undefined : current.targetUrl,
      coworkHostPort: updates.coworkHostPort ?? current.coworkHostPort,
      clientToken:
        updates.clientToken !== undefined
          ? updates.clientToken.trim() || undefined
          : current.clientToken,
      callerToken:
        updates.callerToken !== undefined
          ? updates.callerToken.trim() || undefined
          : current.callerToken,
      policy: {
        ...current.policy,
        ...updates.policy,
        allowedTools:
          updates.policy?.allowedTools !== undefined
            ? sanitizeAllowedTools(updates.policy.allowedTools)
            : current.policy.allowedTools,
      },
      updatedAt: Date.now(),
    };
    settings.tunnels[index] = next;
    this.saveSettings(settings);
    return this.toDisplayConfig(next);
  }

  static removeTunnel(id: string): boolean {
    const settings = this.loadSettings();
    const next = settings.tunnels.filter((tunnel) => tunnel.id !== id);
    if (next.length === settings.tunnels.length) {
      return false;
    }
    settings.tunnels = next;
    this.saveSettings(settings);
    return true;
  }

  static getTunnel(id: string): SecureMcpTunnelConfig | undefined {
    return this.loadSettings().tunnels.find((tunnel) => tunnel.id === id);
  }

  static markConnected(id: string): void {
    this.patchRuntimeState(id, { lastConnectedAt: Date.now(), lastError: undefined });
  }

  static markError(id: string, lastError: string): void {
    this.patchRuntimeState(id, { lastError });
  }

  static saveSettings(settings: SecureMcpTunnelSettings): void {
    const normalized = this.normalizeSettings(settings);
    this.cachedSettings = normalized;
    const encrypted = this.encryptSettings(normalized);
    if (this.saveToRepository(encrypted)) {
      return;
    }
    this.saveToFile(encrypted);
  }

  private static patchRuntimeState(
    id: string,
    patch: Pick<Partial<SecureMcpTunnelConfig>, "lastConnectedAt" | "lastError">,
  ): void {
    const settings = this.loadSettings();
    const tunnel = settings.tunnels.find((entry) => entry.id === id);
    if (!tunnel) return;
    Object.assign(tunnel, patch, { updatedAt: Date.now() });
    this.saveSettings(settings);
  }

  private static normalizeSettings(settings: SecureMcpTunnelSettings): SecureMcpTunnelSettings {
    return {
      tunnels: Array.isArray(settings.tunnels)
        ? settings.tunnels.map((tunnel) => ({
            ...tunnel,
            enabled: Boolean(tunnel.enabled),
            policy: {
              ...DEFAULT_SECURE_MCP_TUNNEL_POLICY,
              ...(tunnel.policy || {}),
              allowedTools: sanitizeAllowedTools(tunnel.policy?.allowedTools),
            },
            coworkHostPort: tunnel.coworkHostPort ?? 3333,
          }))
        : [],
    };
  }

  private static toDisplayConfig(tunnel: SecureMcpTunnelConfig): SecureMcpTunnelDisplayConfig {
    const { clientToken: _clientToken, callerToken: _callerToken, ...rest } = tunnel;
    return {
      ...rest,
      hasClientToken: Boolean(tunnel.clientToken),
      hasCallerToken: Boolean(tunnel.callerToken),
    };
  }

  private static encryptSettings(settings: SecureMcpTunnelSettings): SecureMcpTunnelSettings {
    return {
      tunnels: settings.tunnels.map((tunnel) => ({
        ...tunnel,
        clientToken: encryptSecret(tunnel.clientToken),
        callerToken: encryptSecret(tunnel.callerToken),
      })),
    };
  }

  private static decryptSettings(settings: SecureMcpTunnelSettings): SecureMcpTunnelSettings {
    return {
      tunnels: settings.tunnels.map((tunnel) => ({
        ...tunnel,
        clientToken: decryptSecret(tunnel.clientToken),
        callerToken: decryptSecret(tunnel.callerToken),
      })),
    };
  }

  private static loadFromRepository(): SecureMcpTunnelSettings | null {
    if (!SecureSettingsRepository.isInitialized()) {
      return null;
    }
    try {
      return (
        SecureSettingsRepository.getInstance().load<SecureMcpTunnelSettings>(SETTINGS_CATEGORY) ||
        null
      );
    } catch (error) {
      logger.warn("Failed to load tunnel settings from secure repository", error);
      return null;
    }
  }

  private static saveToRepository(settings: SecureMcpTunnelSettings): boolean {
    if (!SecureSettingsRepository.isInitialized()) {
      return false;
    }
    try {
      SecureSettingsRepository.getInstance().save(SETTINGS_CATEGORY, settings);
      return true;
    } catch (error) {
      logger.warn("Failed to save tunnel settings to secure repository", error);
      return false;
    }
  }

  private static loadFromFile(): SecureMcpTunnelSettings | null {
    const filePath = path.join(getUserDataDir(), LEGACY_SETTINGS_FILE);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf-8")) as SecureMcpTunnelSettings;
    } catch (error) {
      logger.warn("Failed to read tunnel settings file", error);
      return null;
    }
  }

  private static saveToFile(settings: SecureMcpTunnelSettings): void {
    const filePath = path.join(getUserDataDir(), LEGACY_SETTINGS_FILE);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(settings, null, 2), { mode: 0o600 });
  }
}

export function generateTunnelToken(prefix = "ctun"): string {
  return `${prefix}_${randomBytes(24).toString("base64url")}`;
}

function sanitizeAllowedTools(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(
    new Set(value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean)),
  );
}

function encryptSecret(value?: string): string | undefined {
  if (!value || !value.trim()) return undefined;
  if (value === MASKED_VALUE || value.startsWith(ENCRYPTED_PREFIX)) return value;
  try {
    const safeStorage = getSafeStorage();
    if (safeStorage?.isEncryptionAvailable()) {
      return ENCRYPTED_PREFIX + safeStorage.encryptString(value.trim()).toString("base64");
    }
  } catch {
    // Fall back below.
  }
  // No OS keyring available (common on headless Linux). The token is stored
  // unencrypted on disk; warn so operators know the credential is at rest in
  // plaintext rather than silently degrading.
  logger.warn(
    "safeStorage encryption unavailable — persisting secure MCP tunnel token in plaintext on disk",
  );
  return value.trim();
}

function decryptSecret(value?: string): string | undefined {
  if (!value) return undefined;
  if (value === MASKED_VALUE) return undefined;
  if (!value.startsWith(ENCRYPTED_PREFIX)) return value.trim() || undefined;
  try {
    const safeStorage = getSafeStorage();
    if (safeStorage?.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(value.slice(ENCRYPTED_PREFIX.length), "base64"));
    }
  } catch (error) {
    logger.warn("Failed to decrypt tunnel token", error);
  }
  return undefined;
}
