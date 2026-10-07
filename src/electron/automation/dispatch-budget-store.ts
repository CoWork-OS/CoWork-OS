import { assertSchedulerFence, type SchedulerFence } from "./scheduler-lease-store";
import type Database from "better-sqlite3";
import type {
  BackgroundDispatchDecision,
  BackgroundDispatchRequest,
  BackgroundDispatchSource,
} from "../agents/BackgroundDispatchBudget";

export const DISPATCH_BUDGET_SCHEMA = `
CREATE TABLE IF NOT EXISTS background_dispatch_reservations (
  ticket TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  source TEXT NOT NULL,
  entity_key TEXT,
  occurrence_key TEXT,
  reserved_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved', 'committed', 'refunded')),
  task_id TEXT,
  committed_at INTEGER,
  refunded_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_background_dispatch_workspace_time
  ON background_dispatch_reservations(workspace_id, reserved_at);
CREATE INDEX IF NOT EXISTS idx_background_dispatch_entity_time
  ON background_dispatch_reservations(workspace_id, entity_key, reserved_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_background_dispatch_occurrence
  ON background_dispatch_reservations(workspace_id, occurrence_key)
  WHERE occurrence_key IS NOT NULL AND state <> 'refunded';
CREATE TABLE IF NOT EXISTS background_dispatch_denials (
  workspace_id TEXT NOT NULL,
  day_start INTEGER NOT NULL,
  source TEXT NOT NULL,
  reason TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  last_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, day_start, source, reason)
);
`;

export interface DispatchBudgetParams {
  now: number;
  dayStart: number;
  maxPerDay: number;
  cooldownMs: number;
  schedulerFence?: SchedulerFence;
}

/** Called inside task_create's write unit: task row and reservation commit together. */
export function commitDispatchReservation(
  db: Database.Database,
  ticket: string,
  taskId: string,
  workspaceId: string,
  now: number,
): void {
  const fence = db
    .prepare("SELECT owner, generation FROM automation_dispatch_fences WHERE ticket = ?")
    .get(ticket) as SchedulerFence | undefined;
  if (fence) assertSchedulerFence(db, fence, now);
  const result = db
    .prepare(`UPDATE background_dispatch_reservations SET state = 'committed', task_id = ?, committed_at = ?
    WHERE ticket = ? AND workspace_id = ? AND state = 'reserved' AND task_id IS NULL`)
    .run(taskId, now, ticket, workspaceId);
  if (result.changes !== 1)
    throw new Error(
      "Background dispatch reservation is unavailable or belongs to another workspace",
    );
}

export class DispatchBudgetStore {
  constructor(private db: Database.Database) {}
  check(
    request: BackgroundDispatchRequest,
    params: DispatchBudgetParams,
  ): BackgroundDispatchDecision {
    if (params.schedulerFence) assertSchedulerFence(this.db, params.schedulerFence, params.now);
    const count = this.db
      .prepare(`SELECT COUNT(*) n FROM background_dispatch_reservations
      WHERE workspace_id = ? AND state <> 'refunded' AND reserved_at >= ?`)
      .get(request.workspaceId, params.dayStart) as { n: number };
    const base = { dispatchesToday: count.n, maxPerDay: params.maxPerDay };
    if (
      request.occurrenceKey &&
      this.db
        .prepare(`SELECT ticket FROM background_dispatch_reservations
      WHERE workspace_id = ? AND occurrence_key = ? AND state <> 'refunded'`)
        .get(request.workspaceId, request.occurrenceKey)
    ) {
      return { allowed: false, reason: "duplicate_occurrence", ...base };
    }
    if (request.manual) return { allowed: true, ...base };
    if (count.n >= params.maxPerDay)
      return { allowed: false, reason: "workspace_budget_exhausted", ...base };
    if (request.entityKey) {
      const latest = this.db
        .prepare(`SELECT MAX(reserved_at) latest FROM background_dispatch_reservations
        WHERE workspace_id = ? AND entity_key = ? AND state <> 'refunded'`)
        .get(request.workspaceId, request.entityKey) as { latest: number | null };
      if (latest.latest !== null && params.now - latest.latest < params.cooldownMs)
        return {
          allowed: false,
          reason: "entity_cooldown",
          cooldownUntil: latest.latest + params.cooldownMs,
          ...base,
        };
    }
    return { allowed: true, ...base };
  }
  reserve(
    request: BackgroundDispatchRequest,
    params: DispatchBudgetParams,
    ticket: string,
  ): BackgroundDispatchDecision {
    return this.db
      .transaction(() => {
        const decision = this.check(request, params);
        if (!decision.allowed) {
          // Daily aggregate for the outcome baseline; it holds no request content.
          this.db
            .prepare(`INSERT INTO background_dispatch_denials (workspace_id, day_start, source, reason, count, last_at)
            VALUES (?, ?, ?, ?, 1, ?)
            ON CONFLICT(workspace_id, day_start, source, reason) DO UPDATE SET count = count + 1, last_at = excluded.last_at`)
            .run(
              request.workspaceId,
              params.dayStart,
              request.source,
              decision.reason ?? "denied",
              params.now,
            );
          return decision;
        }
        this.db
          .prepare(`INSERT INTO background_dispatch_reservations (ticket, workspace_id, source, entity_key, occurrence_key, reserved_at)
        VALUES (?, ?, ?, ?, ?, ?)`)
          .run(
            ticket,
            request.workspaceId,
            request.source,
            request.entityKey ?? null,
            request.occurrenceKey ?? null,
            params.now,
          );
        if (params.schedulerFence)
          this.db
            .prepare(
              "INSERT INTO automation_dispatch_fences (ticket, owner, generation) VALUES (?, ?, ?)",
            )
            .run(ticket, params.schedulerFence.owner, params.schedulerFence.generation);
        return {
          ...decision,
          ticket,
          durable: true,
          dispatchesToday: decision.dispatchesToday + 1,
        };
      })
      .immediate();
  }
  refund(ticket: string, now: number): boolean {
    // Committed work is never refunded, including when a caller throws after creation.
    return (
      this.db
        .prepare(`UPDATE background_dispatch_reservations SET state = 'refunded', refunded_at = ?
      WHERE ticket = ? AND state = 'reserved' AND task_id IS NULL`)
        .run(now, ticket).changes === 1
    );
  }
  snapshot(workspaceId: string, params: DispatchBudgetParams) {
    const rows = this.db
      .prepare(`SELECT source, COUNT(*) n FROM background_dispatch_reservations WHERE workspace_id = ?
      AND state <> 'refunded' AND reserved_at >= ? GROUP BY source`)
      .all(workspaceId, params.dayStart) as Array<{ source: BackgroundDispatchSource; n: number }>;
    const bySource: Partial<Record<BackgroundDispatchSource, number>> = {};
    let dispatchesToday = 0;
    for (const row of rows) {
      bySource[row.source] = row.n;
      dispatchesToday += row.n;
    }
    return { dispatchesToday, maxPerDay: params.maxPerDay, bySource };
  }
}
