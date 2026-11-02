/**
 * Event Gate Settings Manager
 *
 * Holds the semantic event gate's configuration: the user's natural-language event
 * policies, a mode per trigger source and a mode per gateway chat (see EventGateMode).
 * Stored in encrypted settings storage; every value is validated on load and save.
 */

import { randomUUID } from "crypto";
import { SecureSettingsRepository } from "../database/SecureSettingsRepository";
import type { EventGateMode, EventGatePolicy, EventGateSettings } from "../../shared/types";
import { createLogger } from "../utils/logger";

const logger = createLogger("EventGateSettings");

export const EVENT_GATE_MAX_POLICIES = 50;
export const EVENT_GATE_MAX_POLICY_LENGTH = 500;
const MAX_CHAT_MODES = 500;
const MAX_KEY_LENGTH = 300;

/** Trigger sources a mode can be set for (mirrors TriggerSource). */
export const EVENT_GATE_SOURCES = [
  "channel_message",
  "email",
  "mailbox_event",
  "webhook",
  "connector_event",
  "mcp_event",
  "github_event",
  "file_change",
  "cron_event",
] as const;

const MODES: readonly EventGateMode[] = ["explicit_only", "candidate", "ignore"];
// Built from an escaped string so formatting never writes the characters into the source.
const CONTROL_CHARACTERS = "[\\u0000-\\u001f\\u007f]";

const DEFAULT_SETTINGS: EventGateSettings = { policies: [], sourceModes: {}, chatModes: {} };

export function isEventGateMode(value: unknown): value is EventGateMode {
  return typeof value === "string" && (MODES as readonly string[]).includes(value);
}

function isGateSource(value: unknown): boolean {
  return typeof value === "string" && (EVENT_GATE_SOURCES as readonly string[]).includes(value);
}

function cleanPolicyText(value: unknown): string {
  if (typeof value !== "string") return "";
  // Strip control characters, collapse whitespace; one rule per policy.
  return value
    .replace(new RegExp(`${CONTROL_CHARACTERS}+`, "g"), " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, EVENT_GATE_MAX_POLICY_LENGTH);
}

/** `<channelType>:<chatId>`, the key of a gateway chat's mode. */
export function eventGateChatKey(channelType: string, chatId: string): string {
  return `${channelType}:${chatId}`;
}

function isValidChatKey(key: string): boolean {
  if (!key || key.length > MAX_KEY_LENGTH) return false;
  if (new RegExp(CONTROL_CHARACTERS).test(key)) return false;
  const separator = key.indexOf(":");
  return separator > 0 && separator < key.length - 1;
}

export function normalizeEventGateSettings(value: unknown): EventGateSettings {
  const raw = (value && typeof value === "object" ? value : {}) as Partial<EventGateSettings>;
  const policies: EventGatePolicy[] = [];
  const seenIds = new Set<string>();
  for (const entry of Array.isArray(raw.policies) ? raw.policies : []) {
    if (!entry || typeof entry !== "object") continue;
    const text = cleanPolicyText((entry as EventGatePolicy).text);
    const id = typeof entry.id === "string" ? entry.id.trim().slice(0, 64) : "";
    if (!text || !id || seenIds.has(id)) continue;
    seenIds.add(id);
    policies.push({
      id,
      text,
      enabled: entry.enabled !== false,
      createdAt: Number.isFinite(entry.createdAt) ? Number(entry.createdAt) : 0,
    });
    if (policies.length >= EVENT_GATE_MAX_POLICIES) break;
  }
  const sourceModes: Record<string, EventGateMode> = {};
  if (raw.sourceModes && typeof raw.sourceModes === "object") {
    for (const [source, mode] of Object.entries(raw.sourceModes)) {
      if (isGateSource(source) && isEventGateMode(mode) && mode !== "explicit_only") {
        sourceModes[source] = mode;
      }
    }
  }
  const chatModes: Record<string, EventGateMode> = {};
  if (raw.chatModes && typeof raw.chatModes === "object") {
    for (const [key, mode] of Object.entries(raw.chatModes)) {
      if (Object.keys(chatModes).length >= MAX_CHAT_MODES) break;
      if (isValidChatKey(key) && isEventGateMode(mode)) chatModes[key] = mode;
    }
  }
  return { policies, sourceModes, chatModes };
}

export class EventGateSettingsManager {
  private static cachedSettings: EventGateSettings | null = null;

  static loadSettings(): EventGateSettings {
    if (this.cachedSettings) return this.cachedSettings;
    let stored: unknown;
    try {
      if (SecureSettingsRepository.isInitialized()) {
        stored = SecureSettingsRepository.getInstance().load<EventGateSettings>("event-gate");
      }
    } catch (error) {
      logger.warn("Failed to load event gate settings:", error);
    }
    const settings = normalizeEventGateSettings(stored ?? DEFAULT_SETTINGS);
    this.cachedSettings = settings;
    return settings;
  }

  static saveSettings(settings: EventGateSettings): EventGateSettings {
    if (!SecureSettingsRepository.isInitialized()) {
      throw new Error("SecureSettingsRepository not initialized");
    }
    const normalized = normalizeEventGateSettings(settings);
    SecureSettingsRepository.getInstance().save("event-gate", normalized);
    this.cachedSettings = normalized;
    return normalized;
  }

  static clearCache(): void {
    this.cachedSettings = null;
  }

  static addPolicy(text: unknown): EventGateSettings {
    const cleaned = cleanPolicyText(text);
    if (!cleaned) throw new Error("Policy text is required.");
    const current = this.loadSettings();
    if (current.policies.length >= EVENT_GATE_MAX_POLICIES) {
      throw new Error(`At most ${EVENT_GATE_MAX_POLICIES} event policies are allowed.`);
    }
    return this.saveSettings({
      ...current,
      policies: [
        ...current.policies,
        { id: randomUUID(), text: cleaned, enabled: true, createdAt: Date.now() },
      ],
    });
  }

  static removePolicy(id: unknown): EventGateSettings {
    if (typeof id !== "string" || !id) throw new Error("Policy id is required.");
    const current = this.loadSettings();
    return this.saveSettings({
      ...current,
      policies: current.policies.filter((policy) => policy.id !== id),
    });
  }

  /** Flip a policy on or off; `enabled` sets it explicitly. */
  static togglePolicy(id: unknown, enabled?: unknown): EventGateSettings {
    if (typeof id !== "string" || !id) throw new Error("Policy id is required.");
    const current = this.loadSettings();
    if (!current.policies.some((policy) => policy.id === id)) {
      throw new Error("Event policy not found.");
    }
    return this.saveSettings({
      ...current,
      policies: current.policies.map((policy) =>
        policy.id === id
          ? { ...policy, enabled: typeof enabled === "boolean" ? enabled : !policy.enabled }
          : policy,
      ),
    });
  }

  static setSourceMode(source: unknown, mode: unknown): EventGateSettings {
    if (!isGateSource(source)) throw new Error("Unknown event source.");
    if (!isEventGateMode(mode)) throw new Error("Unknown event gate mode.");
    const current = this.loadSettings();
    const sourceModes = { ...current.sourceModes };
    if (mode === "explicit_only") delete sourceModes[source as string];
    else sourceModes[source as string] = mode;
    return this.saveSettings({ ...current, sourceModes });
  }

  /** Set a gateway chat's mode; `null` returns the chat to its source's mode. */
  static setChatMode(chatKey: unknown, mode: unknown): EventGateSettings {
    if (typeof chatKey !== "string" || !isValidChatKey(chatKey.trim())) {
      throw new Error("Chat key must be <channelType>:<chatId>.");
    }
    if (mode !== null && !isEventGateMode(mode)) throw new Error("Unknown event gate mode.");
    const current = this.loadSettings();
    const chatModes = { ...current.chatModes };
    if (mode === null) delete chatModes[chatKey.trim()];
    else chatModes[chatKey.trim()] = mode;
    return this.saveSettings({ ...current, chatModes });
  }

  static enabledPolicyTexts(): string[] {
    return this.loadSettings()
      .policies.filter((policy) => policy.enabled)
      .map((policy) => policy.text);
  }

  /** The mode of one gateway chat: its own mode, else the channel_message source mode. */
  static resolveChatMode(channelType: string, chatId: string): EventGateMode {
    const settings = this.loadSettings();
    return (
      settings.chatModes[eventGateChatKey(channelType, chatId)] ??
      settings.sourceModes.channel_message ??
      "explicit_only"
    );
  }

  /** The mode for one trigger event: a gateway chat's own mode wins over its source's. */
  static resolveEventMode(event: {
    source: string;
    fields: Record<string, unknown>;
  }): EventGateMode {
    const settings = this.loadSettings();
    if (event.source === "channel_message") {
      const channelType =
        typeof event.fields.channelType === "string" ? event.fields.channelType : "";
      const chatId = typeof event.fields.chatId === "string" ? event.fields.chatId : "";
      const chatMode =
        channelType && chatId
          ? settings.chatModes[eventGateChatKey(channelType, chatId)]
          : undefined;
      if (chatMode) return chatMode;
    }
    return settings.sourceModes[event.source] ?? "explicit_only";
  }
}
