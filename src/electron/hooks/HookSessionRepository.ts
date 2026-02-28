import Database from "better-sqlite3";

export interface HookSessionRecord {
  sessionKey: string;
  taskId: string;
  createdAt: number;
}

/**
 * Persists hook/mention session keys to make task creation idempotent.
 */
export class HookSessionRepository {
  constructor(private db: Database.Database) {}

  findBySessionKey(sessionKey: string): HookSessionRecord | null {
    const normalized = String(sessionKey || "").trim();
    if (!normalized) return null;

    const stmt = this.db.prepare(
      `SELECT session_key, task_id, created_at
       FROM hook_sessions
       WHERE session_key = ?`,
    );
    const row = stmt.get(normalized) as
      | { session_key: string; task_id: string; created_at: number }
      | undefined;
    if (!row) return null;

    return {
      sessionKey: row.session_key,
      taskId: row.task_id,
      createdAt: row.created_at,
    };
  }

  create(sessionKey: string, taskId: string): boolean {
    const normalizedSessionKey = String(sessionKey || "").trim();
    const normalizedTaskId = String(taskId || "").trim();
    if (!normalizedSessionKey || !normalizedTaskId) return false;

    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO hook_sessions (session_key, task_id, created_at)
       VALUES (?, ?, ?)`,
    );
    const result = stmt.run(normalizedSessionKey, normalizedTaskId, Date.now());
    return result.changes > 0;
  }

  acquireLock(sessionKey: string, ttlMs = 120000): boolean {
    const normalizedSessionKey = String(sessionKey || "").trim();
    if (!normalizedSessionKey) return false;

    const now = Date.now();
    const normalizedTtl = Math.max(1000, Math.floor(ttlMs));
    this.cleanupExpiredLocks(now);

    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO hook_session_locks (session_key, created_at, expires_at)
       VALUES (?, ?, ?)`,
    );
    const result = stmt.run(normalizedSessionKey, now, now + normalizedTtl);
    return result.changes > 0;
  }

  releaseLock(sessionKey: string): void {
    const normalizedSessionKey = String(sessionKey || "").trim();
    if (!normalizedSessionKey) return;

    this.db
      .prepare(`DELETE FROM hook_session_locks WHERE session_key = ?`)
      .run(normalizedSessionKey);
  }

  private cleanupExpiredLocks(nowMs = Date.now()): void {
    this.db.prepare(`DELETE FROM hook_session_locks WHERE expires_at <= ?`).run(nowMs);
  }
}
