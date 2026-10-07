import type Database from "better-sqlite3";
export interface SchedulerFence {
  owner: string;
  generation: number;
}
export interface SchedulerLease extends SchedulerFence {
  expiresAt: number;
}
export const SCHEDULER_LEASE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS automation_scheduler_lease (
    scope TEXT PRIMARY KEY, owner TEXT NOT NULL, generation INTEGER NOT NULL, expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS automation_dispatch_fences (
    ticket TEXT PRIMARY KEY, owner TEXT NOT NULL, generation INTEGER NOT NULL
  );
`;
interface Row {
  owner: string;
  generation: number;
  expires_at: number;
}
export function assertSchedulerFence(
  db: Database.Database,
  fence: SchedulerFence,
  now = Date.now(),
): void {
  const row = db
    .prepare(
      "SELECT owner, generation, expires_at FROM automation_scheduler_lease WHERE scope = 'profile'",
    )
    .get() as Row | undefined;
  if (
    !row ||
    row.owner !== fence.owner ||
    row.generation !== fence.generation ||
    row.expires_at <= now
  ) {
    throw new Error("Automation scheduler ownership expired or changed");
  }
}
export class SchedulerLeaseStore {
  constructor(private readonly db: Database.Database) {}
  acquire(request: { owner: string; now: number; leaseMs: number }): SchedulerLease | null {
    if (
      !request.owner ||
      request.owner.length > 200 ||
      !Number.isSafeInteger(request.now) ||
      request.leaseMs < 1000 ||
      request.leaseMs > 300000
    )
      throw new Error("Invalid scheduler lease request");
    return this.db
      .transaction(() => {
        const row = this.db
          .prepare(
            "SELECT owner, generation, expires_at FROM automation_scheduler_lease WHERE scope = 'profile'",
          )
          .get() as Row | undefined;
        if (row && row.owner !== request.owner && row.expires_at > request.now) return null;
        const generation =
          row && row.owner === request.owner && row.expires_at > request.now
            ? row.generation
            : (row?.generation ?? 0) + 1;
        const expiresAt = request.now + request.leaseMs;
        this.db
          .prepare(`INSERT INTO automation_scheduler_lease (scope, owner, generation, expires_at) VALUES ('profile', ?, ?, ?)
        ON CONFLICT(scope) DO UPDATE SET owner = excluded.owner, generation = excluded.generation, expires_at = excluded.expires_at`)
          .run(request.owner, generation, expiresAt);
        // A previous generation cannot admit a task after this transaction commits.
        // Reclaim only its uncommitted reservations; task creation commits the task
        // and reservation together, so committed work must keep its budget charge.
        // Legacy unfenced reservations have no provable owner and stay untouched.
        if (!row || generation !== row.generation) {
          this.db
            .prepare(`UPDATE background_dispatch_reservations
              SET state = 'refunded', refunded_at = ?
              WHERE state = 'reserved' AND task_id IS NULL
                AND ticket IN (SELECT ticket FROM automation_dispatch_fences WHERE generation < ?)`)
            .run(request.now, generation);
        }
        return { owner: request.owner, generation, expiresAt };
      })
      .immediate();
  }
  release(fence: SchedulerFence): boolean {
    return (
      this.db
        .prepare(
          "UPDATE automation_scheduler_lease SET expires_at = 0 WHERE scope = 'profile' AND owner = ? AND generation = ?",
        )
        .run(fence.owner, fence.generation).changes === 1
    );
  }
  validate(fence: SchedulerFence, now: number): boolean {
    try {
      assertSchedulerFence(this.db, fence, now);
      return true;
    } catch {
      return false;
    }
  }
}
