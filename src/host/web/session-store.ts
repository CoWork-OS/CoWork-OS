/**
 * What the host keeps about a browser sign-in so it can outlive a host restart.
 *
 * Only a SHA-256 of the cookie value is kept, never the value itself, so a copy of the
 * store cannot be replayed as a cookie. CSRF tokens, WebSocket tickets, pairing codes and
 * every file, artifact and terminal handle stay in memory and end with the process.
 */
export interface PersistedWebSession {
  /** SHA-256 (hex) of the session cookie value. */
  key: string;
  /** Listener the sign-in belongs to. */
  audience: string;
  installationId: string;
  profileId: string;
  /** Host kind that issued it ("electron" or "node"); the two never share sign-ins. */
  runtime: string;
  /** How browsers reached the host: "loopback", or "https-proxy:<origin>". */
  deployment: string;
  createdAt: number;
  lastUsedAt: number;
  expiresAt: number;
}

/**
 * Durable storage for browser sign-ins. Each call is one atomic change, so two hosts
 * sharing a profile do not overwrite each other. A call may throw; the caller decides
 * whether that is safe to ignore.
 */
export interface WebSessionStore {
  load(): PersistedWebSession[];
  /** Records a new sign-in. */
  add(session: PersistedWebSession): void;
  /**
   * Updates when sign-ins were last used. A key the store no longer holds is skipped, so a
   * sign-in that was signed out elsewhere is never written back.
   */
  touch(updates: Array<{ key: string; lastUsedAt: number }>): void;
  remove(keys: string[]): void;
  /** Forgets every sign-in, or only one listener's. */
  clear(audience?: string): void;
}

/** Upper bound on stored records, matching the in-memory session cap. */
export const MAX_PERSISTED_WEB_SESSIONS = 256;

const KEY_PATTERN = /^[0-9a-f]{64}$/;

function isBoundedText(value: unknown, max = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * Keeps only well-formed records, one per key, up to the cap. Stored data is read back as
 * untrusted input: a malformed record is dropped rather than repaired.
 */
export function sanitizePersistedWebSessions(value: unknown): PersistedWebSession[] {
  if (!Array.isArray(value)) return [];
  const byKey = new Map<string, PersistedWebSession>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (
      typeof record.key !== "string" ||
      !KEY_PATTERN.test(record.key) ||
      !isBoundedText(record.audience, 128) ||
      !isBoundedText(record.installationId, 128) ||
      !isBoundedText(record.profileId, 256) ||
      !isBoundedText(record.runtime, 32) ||
      !isBoundedText(record.deployment, 2100) ||
      !isTimestamp(record.createdAt) ||
      !isTimestamp(record.lastUsedAt) ||
      !isTimestamp(record.expiresAt)
    ) {
      continue;
    }
    byKey.set(record.key, {
      key: record.key,
      audience: record.audience,
      installationId: record.installationId,
      profileId: record.profileId,
      runtime: record.runtime,
      deployment: record.deployment,
      createdAt: record.createdAt,
      lastUsedAt: record.lastUsedAt,
      expiresAt: record.expiresAt,
    });
  }
  // Most recently used first, so the cap drops the stalest sign-ins.
  return [...byKey.values()]
    .sort((left, right) => right.lastUsedAt - left.lastUsedAt)
    .slice(0, MAX_PERSISTED_WEB_SESSIONS);
}
