import { beforeEach, describe, expect, it } from "vitest";
import { HookSessionRepository } from "../HookSessionRepository";

describe("HookSessionRepository", () => {
  let nowMs = 1_700_000_000_000;
  let repo: HookSessionRepository;
  let db: {
    sessions: Map<string, { taskId: string; createdAt: number }>;
    locks: Map<string, { createdAt: number; expiresAt: number }>;
    prepare: (sql: string) => {
      get?: (sessionKey: string) => { session_key: string; task_id: string; created_at: number } | undefined;
      run?: (...args: Any[]) => { changes: number };
    };
  };

  beforeEach(() => {
    nowMs = 1_700_000_000_000;
    db = {
      sessions: new Map(),
      locks: new Map(),
      prepare(sql: string) {
        if (sql.includes("SELECT session_key, task_id, created_at")) {
          return {
            get: (sessionKey: string) => {
              const found = db.sessions.get(sessionKey);
              if (!found) return undefined;
              return {
                session_key: sessionKey,
                task_id: found.taskId,
                created_at: found.createdAt,
              };
            },
          };
        }
        if (sql.includes("INSERT OR IGNORE INTO hook_sessions")) {
          return {
            run: (sessionKey: string, taskId: string, createdAt: number) => {
              if (db.sessions.has(sessionKey)) {
                return { changes: 0 };
              }
              db.sessions.set(sessionKey, { taskId, createdAt });
              return { changes: 1 };
            },
          };
        }
        if (sql.includes("DELETE FROM hook_session_locks WHERE expires_at <=")) {
          return {
            run: (expiresBefore: number) => {
              let changes = 0;
              for (const [key, value] of Array.from(db.locks.entries())) {
                if (value.expiresAt <= expiresBefore) {
                  db.locks.delete(key);
                  changes += 1;
                }
              }
              return { changes };
            },
          };
        }
        if (sql.includes("INSERT OR IGNORE INTO hook_session_locks")) {
          return {
            run: (sessionKey: string, createdAt: number, expiresAt: number) => {
              if (db.locks.has(sessionKey)) {
                return { changes: 0 };
              }
              db.locks.set(sessionKey, { createdAt, expiresAt });
              return { changes: 1 };
            },
          };
        }
        if (sql.includes("DELETE FROM hook_session_locks WHERE session_key = ?")) {
          return {
            run: (sessionKey: string) => {
              const existed = db.locks.delete(sessionKey);
              return { changes: existed ? 1 : 0 };
            },
          };
        }
        throw new Error(`Unexpected SQL in test double: ${sql}`);
      },
    };

    repo = new HookSessionRepository(db as Any);
  });

  it("creates and finds a session mapping", () => {
    const created = repo.create("xmention:123", "task-1");
    expect(created).toBe(true);

    const found = repo.findBySessionKey("xmention:123");
    expect(found).not.toBeNull();
    expect(found?.taskId).toBe("task-1");
  });

  it("is idempotent for duplicate session keys", () => {
    const first = repo.create("xmention:dup", "task-1");
    const second = repo.create("xmention:dup", "task-2");
    expect(first).toBe(true);
    expect(second).toBe(false);

    const found = repo.findBySessionKey("xmention:dup");
    expect(found?.taskId).toBe("task-1");
  });

  it("acquires and releases lock keys", () => {
    const realDateNow = Date.now;
    Date.now = () => nowMs;
    let first = false;
    let second = false;
    let third = false;
    try {
      first = repo.acquireLock("xmention:lock");
      second = repo.acquireLock("xmention:lock");
      repo.releaseLock("xmention:lock");
      Date.now = () => nowMs + 10_000;
      third = repo.acquireLock("xmention:lock");
    } finally {
      Date.now = realDateNow;
    }
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(third).toBe(true);
  });
});
