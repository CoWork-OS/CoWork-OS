/**
 * Keeps browser sign-ins in the host's encrypted settings, so they outlive a host restart.
 * The records hold a hash of each session cookie and nothing a browser could present.
 */
import {
  DELETE_SECURE_SETTINGS,
  SecureSettingsRepository,
} from "../../electron/database/SecureSettingsRepository";
import {
  sanitizePersistedWebSessions,
  type PersistedWebSession,
  type WebSessionStore,
} from "../web/session-store";

const CATEGORY = "browser-sessions" as const;
const STORE_VERSION = 1;

interface StoredSessions {
  version: number;
  sessions: PersistedWebSession[];
}

/** The part of the encrypted settings repository this store needs. */
export interface BrowserSessionSettings {
  load(category: typeof CATEGORY): object | undefined;
  update(
    category: typeof CATEGORY,
    mutate: (
      current: StoredSessions | undefined,
    ) => StoredSessions | undefined | typeof DELETE_SECURE_SETTINGS,
    options?: { replaceUnreadable?: boolean },
  ): unknown;
  delete(category: typeof CATEGORY): boolean;
}

function readSessions(value: unknown): PersistedWebSession[] {
  if (!value || typeof value !== "object") return [];
  const stored = value as Partial<StoredSessions>;
  if (stored.version !== STORE_VERSION) return [];
  return sanitizePersistedWebSessions(stored.sessions);
}

export function createBrowserSessionStore(settings: BrowserSessionSettings): WebSessionStore {
  const rewrite = (change: (sessions: PersistedWebSession[]) => PersistedWebSession[]) => {
    settings.update(
      CATEGORY,
      (current) => {
        const before = readSessions(current);
        const after = sanitizePersistedWebSessions(change(before));
        if (after.length === 0) return current ? DELETE_SECURE_SETTINGS : undefined;
        // Nothing to write when the change left every record as it was.
        if (JSON.stringify(after) === JSON.stringify(before)) return undefined;
        return { version: STORE_VERSION, sessions: after };
      },
      // A row this host can no longer read holds no sign-in it could honour.
      { replaceUnreadable: true },
    );
  };

  /** A sign-out must never be lost: if the edit fails, forget every sign-in instead. */
  const rewriteOrForgetAll = (
    change: (sessions: PersistedWebSession[]) => PersistedWebSession[],
  ) => {
    try {
      rewrite(change);
    } catch (error) {
      settings.delete(CATEGORY);
      throw error;
    }
  };

  return {
    load: () => readSessions(settings.load(CATEGORY)),
    add(session) {
      rewrite((current) => [...current.filter((entry) => entry.key !== session.key), session]);
    },
    touch(updates) {
      if (updates.length === 0) return;
      const lastUsed = new Map(updates.map((update) => [update.key, update.lastUsedAt]));
      rewrite((current) =>
        current.map((session) => {
          const lastUsedAt = lastUsed.get(session.key);
          return lastUsedAt !== undefined && lastUsedAt > session.lastUsedAt
            ? { ...session, lastUsedAt }
            : session;
        }),
      );
    },
    remove(keys) {
      if (keys.length === 0) return;
      const removed = new Set(keys);
      rewriteOrForgetAll((current) => current.filter((session) => !removed.has(session.key)));
    },
    clear(audience) {
      if (audience === undefined) {
        settings.delete(CATEGORY);
        return;
      }
      rewriteOrForgetAll((current) => current.filter((session) => session.audience !== audience));
    },
  };
}

/**
 * The store over this host's encrypted settings. The settings are looked up on each call,
 * so a call made before they are ready fails loudly instead of silently storing nothing.
 */
export function createHostBrowserSessionStore(): WebSessionStore {
  const settings = () => SecureSettingsRepository.getInstance();
  return createBrowserSessionStore({
    load: (category) => settings().load(category),
    update: (category, mutate, options) => settings().update(category, mutate, options),
    delete: (category) => settings().delete(category),
  });
}

/**
 * Forgets the sign-ins one kind of host stored, for a host that starts with the browser
 * app off: turning the app off signs its browsers out. Another kind of host sharing the
 * profile keeps its own.
 */
export function forgetStoredBrowserSessions(
  runtime: string,
  settings: BrowserSessionSettings | undefined = SecureSettingsRepository.isInitialized()
    ? SecureSettingsRepository.getInstance()
    : undefined,
): void {
  if (!settings) return;
  try {
    settings.update(
      CATEGORY,
      (current) => {
        const before = readSessions(current);
        const after = before.filter((session) => session.runtime !== runtime);
        if (after.length === before.length) return undefined;
        return after.length === 0
          ? DELETE_SECURE_SETTINGS
          : { version: STORE_VERSION, sessions: after };
      },
      { replaceUnreadable: true },
    );
  } catch {
    // The sign-out comes first: if the edit fails, forget every sign-in.
    settings.delete(CATEGORY);
  }
}
