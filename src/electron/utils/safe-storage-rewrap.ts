/**
 * Startup rewrap: re-encrypt values still sealed by the OS keychain directly with the data
 * key (see safe-storage.ts). Decryption uses the asynchronous OS call, so this keeps working
 * once Electron drops the synchronous one. Every write is conditional on the stored value
 * being unchanged, and a value the keychain cannot read is left as it is.
 */

import { encryptedChannelConfigs } from "./mac-safe-storage-migration";
import { isDataKeySealed, type SafeStorageLike } from "./safe-storage";

export type OsSealedDecrypt = (sealed: Buffer) => Promise<string | null>;

interface RewrapLogger {
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
}

/** Prefix of individually encrypted values inside settings (MCP, hooks, tunnels...). */
const ENCRYPTED_VALUE_PREFIX = "encrypted:";

/** Decode `prefix + base64`; null for anything else (plaintext, masked values). */
function sealedPayload(value: string, prefix: string): Buffer | null {
  if (!value.startsWith(prefix)) return null;
  const payload = Buffer.from(value.slice(prefix.length), "base64");
  return payload.length > 0 ? payload : null;
}

/** Re-encrypt one `prefix + base64` value; returns the value unchanged when it cannot. */
async function rewrapValue(
  value: string,
  prefix: string,
  decrypt: OsSealedDecrypt,
  storage: SafeStorageLike,
): Promise<string> {
  const sealed = sealedPayload(value, prefix);
  if (!sealed || isDataKeySealed(sealed)) return value;
  const plaintext = await decrypt(sealed);
  if (plaintext === null) return value;
  return prefix + storage.encryptString(plaintext).toString("base64");
}

/** Rewrap every `encrypted:` string inside a settings value; `changed` when any moved. */
export async function rewrapEncryptedValues(
  value: unknown,
  decrypt: OsSealedDecrypt,
  storage: SafeStorageLike,
): Promise<{ value: unknown; changed: boolean }> {
  if (typeof value === "string") {
    const next = await rewrapValue(value, ENCRYPTED_VALUE_PREFIX, decrypt, storage);
    return { value: next, changed: next !== value };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next: unknown[] = [];
    for (const item of value) {
      const result = await rewrapEncryptedValues(item, decrypt, storage);
      changed ||= result.changed;
      next.push(result.value);
    }
    return { value: next, changed };
  }
  if (value && typeof value === "object") {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const result = await rewrapEncryptedValues(item, decrypt, storage);
      changed ||= result.changed;
      next[key] = result.value;
    }
    return { value: next, changed };
  }
  return { value, changed: false };
}

const CHANNEL_CONFIG_PREFIX = "enc:";

/** Rewrap encrypted channel configs (`channels.config` = `enc:` + base64). */
export async function rewrapChannelConfigs(options: {
  database: Parameters<typeof encryptedChannelConfigs>[0];
  storage: SafeStorageLike;
  decrypt: OsSealedDecrypt;
  logger: RewrapLogger;
}): Promise<number> {
  const channels = encryptedChannelConfigs(options.database);
  let rewrapped = 0;
  for (const row of channels.list()) {
    if (typeof row?.id !== "string" || typeof row.config !== "string") continue;
    const next = await rewrapValue(
      row.config,
      CHANNEL_CONFIG_PREFIX,
      options.decrypt,
      options.storage,
    );
    if (next === row.config) continue;
    if (channels.replaceIfUnchanged(row.id, next, row.config)) rewrapped += 1;
  }
  if (rewrapped > 0) {
    options.logger.info("Re-encrypted channel configs with the data key.", { rewrapped });
  }
  return rewrapped;
}

const MAILBOX_OS_PREFIX = "mbox:os:";

/** Mailbox values still sealed by the OS keychain, through the mailbox statement catalog. */
export interface MailboxRewrapStore<Target extends string = string> {
  targets: readonly Target[];
  list(target: Target): Promise<Array<{ key: string; value: string }>>;
  replaceIfUnchanged(target: Target, key: string, next: string, previous: string): Promise<boolean>;
}

/** Rewrap mailbox values (`mbox:os:` + base64); run after the window is up. */
export async function rewrapMailboxValues<Target extends string>(options: {
  store: MailboxRewrapStore<Target>;
  storage: SafeStorageLike;
  decrypt: OsSealedDecrypt;
  logger: RewrapLogger;
}): Promise<number> {
  let rewrapped = 0;
  for (const target of options.store.targets) {
    for (const { key, value } of await options.store.list(target)) {
      const next = await rewrapValue(value, MAILBOX_OS_PREFIX, options.decrypt, options.storage);
      if (next === value) continue;
      if (await options.store.replaceIfUnchanged(target, key, next, value)) rewrapped += 1;
    }
  }
  if (rewrapped > 0) {
    options.logger.info("Re-encrypted mailbox values with the data key.", { rewrapped });
  }
  return rewrapped;
}
