import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { SecureSettingsRepository } from "../database/SecureSettingsRepository";

/**
 * HMAC key for transcript checkpoints.
 *
 * Checkpoint files live in the workspace, so their contents cannot be trusted on
 * their own. Each checkpoint is signed with a per-profile key held in the
 * encrypted settings store (OS keychain via Electron safeStorage when available).
 * A checkpoint without a valid signature is never used for restore; callers fall
 * back to the conversation snapshot in the task database.
 *
 * When the settings store is not initialized (early startup, plain Node tools,
 * unit tests) a random per-process key is used. Signatures made with it are only
 * valid inside the same process, which fails closed after a restart.
 */

const CATEGORY = "checkpoint-signing" as const;
const KEY_BYTES = 32;

interface StoredCheckpointKey {
  version: 1;
  key: string;
  createdAt: number;
}

let overrideKey: Buffer | null = null;
let persistentKey: Buffer | null = null;
let processKey: Buffer | null = null;
let lastPersistentKeyFailureAt = 0;
const PERSISTENT_KEY_RETRY_MS = 60_000;

function decodeStoredKey(value: unknown): Buffer | null {
  if (!value || typeof value !== "object") return null;
  const raw = (value as Partial<StoredCheckpointKey>).key;
  if (typeof raw !== "string") return null;
  const key = Buffer.from(raw, "base64");
  return key.length === KEY_BYTES ? key : null;
}

function loadOrCreatePersistentKey(): Buffer | null {
  if (persistentKey) return persistentKey;
  if (Date.now() - lastPersistentKeyFailureAt < PERSISTENT_KEY_RETRY_MS) return null;
  try {
    if (!SecureSettingsRepository.isInitialized()) return null;
    const repository = SecureSettingsRepository.getInstance();
    const existing = decodeStoredKey(repository.load<StoredCheckpointKey>(CATEGORY));
    if (existing) {
      persistentKey = existing;
      return existing;
    }
    // Revision-checked create: when two runtimes race, both adopt the stored winner.
    const result = repository.update<StoredCheckpointKey>(CATEGORY, (current) =>
      decodeStoredKey(current)
        ? undefined
        : {
            version: 1,
            key: randomBytes(KEY_BYTES).toString("base64"),
            createdAt: Date.now(),
          },
    );
    const stored =
      decodeStoredKey(result.value) ??
      decodeStoredKey(repository.load<StoredCheckpointKey>(CATEGORY));
    if (stored) persistentKey = stored;
    else lastPersistentKeyFailureAt = Date.now();
    return stored;
  } catch {
    // Keychain changed or the store is unreadable: sign with the process key for now.
    lastPersistentKeyFailureAt = Date.now();
    return null;
  }
}

/** The key used to sign and verify checkpoints in this process. */
export function getCheckpointSigningKey(): Buffer {
  if (overrideKey) return overrideKey;
  const key = loadOrCreatePersistentKey();
  if (key) return key;
  if (!processKey) processKey = randomBytes(KEY_BYTES);
  return processKey;
}

/**
 * Inject a fixed key (tests and child-process test workers). `null` restores the
 * normal lookup and forgets any cached key.
 */
export function setCheckpointSigningKeyForTests(key: Buffer | string | null): void {
  persistentKey = null;
  processKey = null;
  lastPersistentKeyFailureAt = 0;
  if (key === null) {
    overrideKey = null;
    return;
  }
  const buffer = typeof key === "string" ? Buffer.from(key, "utf8") : Buffer.from(key);
  overrideKey = buffer.length > 0 ? buffer : null;
}

function signingInput(taskId: string, generation: number, body: string): string {
  return `cowork-checkpoint-v1\u0000${taskId}\u0000${generation}\u0000${body}`;
}

/** Hex HMAC-SHA256 over the task id, generation and serialized checkpoint body. */
export function signCheckpointBody(taskId: string, generation: number, body: string): string {
  return createHmac("sha256", getCheckpointSigningKey())
    .update(signingInput(taskId, generation, body))
    .digest("hex");
}

export function verifyCheckpointSignature(
  taskId: string,
  generation: number,
  body: string,
  signature: string,
): boolean {
  if (!/^[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = Buffer.from(signCheckpointBody(taskId, generation, body), "hex");
  const actual = Buffer.from(signature, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
