/**
 * Saved logins for the in-app browser.
 *
 * - Each password is sealed on its own with the OS keychain (Electron safeStorage) before it
 *   is stored; the whole record is then encrypted again by the settings store. Without OS
 *   encryption nothing is stored (there is no weaker fallback for passwords).
 * - Passwords never leave this module as values: callers get a secret only inside
 *   `withSecret`, and the listing has sites and user names only. There is no way to read,
 *   copy or export a password from the app.
 * - A login belongs to one exact origin (see login-origin.ts) and one browser profile.
 */

import { randomUUID } from "crypto";
import { SecureSettingsRepository } from "../../database/SecureSettingsRepository";
import { getSafeStorage } from "../../utils/safe-storage";
import type { ImportedLogin } from "./password-csv";

const CATEGORY = "browser-vault" as const;
const SEALED_PREFIX = "os1:";
export const MAX_VAULT_ENTRIES_PER_PROFILE = 20_000;

export type VaultErrorCode = "encryption_unavailable" | "too_many" | "storage_failed" | "not_found";

export class VaultError extends Error {
  constructor(
    readonly code: VaultErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "VaultError";
  }
}

export interface Sealer {
  /** True when passwords can be sealed with OS-level encryption. */
  available(): boolean;
  seal(plain: string): string;
  open(sealed: string): string;
}

/** Seals with Electron safeStorage; unavailable when it would only obfuscate (Linux basic_text). */
export function safeStorageSealer(): Sealer {
  const storage = () => getSafeStorage();
  return {
    available() {
      const current = storage();
      if (!current) return false;
      try {
        if (!current.isEncryptionAvailable()) return false;
        const backend = (current as Any).getSelectedStorageBackend?.();
        return backend !== "basic_text" && backend !== "unknown";
      } catch {
        return false;
      }
    },
    seal(plain) {
      const current = storage();
      if (!current) throw new VaultError("encryption_unavailable", "OS encryption is unavailable.");
      return SEALED_PREFIX + current.encryptString(plain).toString("base64");
    },
    open(sealed) {
      const current = storage();
      if (!current || !sealed.startsWith(SEALED_PREFIX)) {
        throw new VaultError("encryption_unavailable", "OS encryption is unavailable.");
      }
      return current.decryptString(Buffer.from(sealed.slice(SEALED_PREFIX.length), "base64"));
    },
  };
}

export interface VaultStore {
  load(): VaultFile | undefined;
  save(value: VaultFile): void;
}

export function secureSettingsVaultStore(): VaultStore {
  return {
    load: () =>
      SecureSettingsRepository.isInitialized()
        ? SecureSettingsRepository.getInstance().load<VaultFile>(CATEGORY)
        : undefined,
    save: (value) => {
      if (!SecureSettingsRepository.isInitialized()) {
        throw new VaultError("storage_failed", "Settings storage is not ready.");
      }
      SecureSettingsRepository.getInstance().save(CATEGORY, value);
    },
  };
}

interface StoredEntry {
  id: string;
  origin: string;
  username: string;
  sealed: string;
  createdAt: number;
  lastUsedAt?: number;
}

export interface VaultFile {
  version: 1;
  profiles: Record<string, StoredEntry[]>;
}

/** What the app may show about a saved login. */
export interface VaultListing {
  id: string;
  origin: string;
  username: string;
  createdAt: number;
  lastUsedAt?: number;
}

export interface VaultAddResult {
  added: number;
  updated: number;
}

function listingOf(entry: StoredEntry): VaultListing {
  return {
    id: entry.id,
    origin: entry.origin,
    username: entry.username,
    createdAt: entry.createdAt,
    ...(entry.lastUsedAt ? { lastUsedAt: entry.lastUsedAt } : {}),
  };
}

export class BrowserVault {
  constructor(
    private readonly store: VaultStore = secureSettingsVaultStore(),
    private readonly sealer: Sealer = safeStorageSealer(),
    private readonly now: () => number = Date.now,
    private readonly newId: () => string = randomUUID,
  ) {}

  /** Passwords can only be saved when OS-level encryption is available. */
  canStore(): boolean {
    return this.sealer.available();
  }

  list(profileKey: string): VaultListing[] {
    return this.entries(this.read(), profileKey)
      .map(listingOf)
      .sort((a, b) => a.origin.localeCompare(b.origin) || a.username.localeCompare(b.username));
  }

  forOrigin(profileKey: string, origin: string): VaultListing[] {
    return this.list(profileKey).filter((entry) => entry.origin === origin);
  }

  count(profileKey: string): number {
    return this.entries(this.read(), profileKey).length;
  }

  addMany(profileKey: string, logins: ImportedLogin[]): VaultAddResult {
    if (!this.sealer.available()) {
      throw new VaultError("encryption_unavailable", "OS encryption is unavailable.");
    }
    const file = this.read();
    const entries = [...this.entries(file, profileKey)];
    let added = 0;
    let updated = 0;
    for (const login of logins) {
      const index = entries.findIndex(
        (entry) => entry.origin === login.origin && entry.username === login.username,
      );
      const sealed = this.sealer.seal(login.password);
      if (index >= 0) {
        entries[index] = { ...entries[index], sealed };
        updated += 1;
      } else {
        if (entries.length >= MAX_VAULT_ENTRIES_PER_PROFILE) {
          throw new VaultError("too_many", "There are too many saved logins.");
        }
        entries.push({
          id: this.newId(),
          origin: login.origin,
          username: login.username,
          sealed,
          createdAt: this.now(),
        });
        added += 1;
      }
    }
    this.write({ ...file, profiles: { ...file.profiles, [profileKey]: entries } });
    return { added, updated };
  }

  remove(profileKey: string, id: string): boolean {
    const file = this.read();
    const entries = this.entries(file, profileKey);
    const next = entries.filter((entry) => entry.id !== id);
    if (next.length === entries.length) return false;
    this.write({ ...file, profiles: { ...file.profiles, [profileKey]: next } });
    return true;
  }

  clear(profileKey: string): number {
    const file = this.read();
    const count = this.entries(file, profileKey).length;
    if (count === 0) return 0;
    const profiles = { ...file.profiles };
    delete profiles[profileKey];
    this.write({ ...file, profiles });
    return count;
  }

  /**
   * Run `use` with one login's secret. The secret exists only for the duration of the call
   * and is not returned; `use`'s own result is.
   */
  async withSecret<T>(
    profileKey: string,
    id: string,
    use: (secret: { origin: string; username: string; password: string }) => Promise<T> | T,
  ): Promise<T> {
    const file = this.read();
    const entry = this.entries(file, profileKey).find((candidate) => candidate.id === id);
    if (!entry) throw new VaultError("not_found", "That saved login no longer exists.");
    const password = this.sealer.open(entry.sealed);
    const result = await use({ origin: entry.origin, username: entry.username, password });
    try {
      const fresh = this.read();
      const entries = this.entries(fresh, profileKey).map((candidate) =>
        candidate.id === id ? { ...candidate, lastUsedAt: this.now() } : candidate,
      );
      this.write({ ...fresh, profiles: { ...fresh.profiles, [profileKey]: entries } });
    } catch {
      // Remembering when it was last used is optional.
    }
    return result;
  }

  private read(): VaultFile {
    const loaded = this.store.load();
    if (!loaded || loaded.version !== 1 || typeof loaded.profiles !== "object") {
      return { version: 1, profiles: {} };
    }
    return loaded;
  }

  private entries(file: VaultFile, profileKey: string): StoredEntry[] {
    const list = file.profiles[profileKey];
    return Array.isArray(list) ? list : [];
  }

  private write(file: VaultFile): void {
    try {
      this.store.save(file);
    } catch (error) {
      if (error instanceof VaultError) throw error;
      throw new VaultError("storage_failed", "Saved logins could not be stored.");
    }
  }
}

let sharedVault: BrowserVault | null = null;

export function getBrowserVault(): BrowserVault {
  sharedVault ??= new BrowserVault();
  return sharedVault;
}
