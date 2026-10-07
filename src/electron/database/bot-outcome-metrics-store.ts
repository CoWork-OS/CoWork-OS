import type Database from "better-sqlite3";
import type { BotOutcomeMetrics } from "../../shared/bot-outcome-metrics";
import { botWorkOwnedScope } from "./bot-work-store";

type Count = { n: number | null };
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Read-only baseline counters over existing records. Runs in the storage domain,
 * including the DB worker; tables created lazily by optional services may be absent
 * in older profiles and then count as zero.
 */
export class BotOutcomeMetricsStore {
  constructor(private db: Database.Database) {}

  summary(
    request: { workspaceId: string; agentRoleId?: string; windowDays: number },
    now: number,
  ): Omit<BotOutcomeMetrics, "workView"> {
    if (!this.db.prepare("SELECT id FROM workspaces WHERE id = ?").get(request.workspaceId))
      throw new Error("Workspace not found");
    if (
      request.agentRoleId &&
      !this.db.prepare("SELECT id FROM agent_roles WHERE id = ?").get(request.agentRoleId)
    )
      throw new Error("Bot not found");
    const since = now - request.windowDays * DAY_MS;
    const has = (table: string) =>
      !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
    // Bot scope matches the work view's visible lineage; workspace scope covers all tasks.
    const owned = request.agentRoleId
      ? botWorkOwnedScope({ workspaceId: request.workspaceId, agentRoleId: request.agentRoleId })
      : {
          sql: "WITH owned(id) AS (SELECT id FROM tasks WHERE workspace_id=?)",
          args: [request.workspaceId],
        };
    const count = (sql: string, args: unknown[] = []) =>
      Number((this.db.prepare(`${owned.sql} ${sql}`).get(...owned.args, ...args) as Count).n ?? 0);

    const outcome = (status: string) =>
      count(
        `SELECT COUNT(*) n FROM tasks t JOIN owned o ON o.id=t.id
         WHERE t.status=? AND COALESCE(t.completed_at,t.updated_at,t.created_at)>=?`,
        [status, since],
      );
    const verified = count(
      `SELECT COUNT(*) n FROM tasks t JOIN owned o ON o.id=t.id
       WHERE t.status='completed' AND COALESCE(t.completed_at,t.updated_at,t.created_at)>=?
         AND (UPPER(COALESCE(t.verification_verdict,''))='PASS'
           OR EXISTS (SELECT 1 FROM work_session_outcome_contracts c
             WHERE c.task_id=t.id AND c.status='satisfied'))`,
      [since],
    );
    const oldest = (this.db
      .prepare(
        `${owned.sql} SELECT MIN(requested_at) n FROM (
           SELECT a.requested_at FROM approvals a JOIN owned o ON o.id=a.task_id WHERE a.status='pending'
           UNION ALL
           SELECT i.requested_at FROM input_requests i JOIN owned o ON o.id=i.task_id WHERE i.status='pending')`,
      )
      .get(...owned.args) ?? { n: null }) as Count;

    const claims = (outcomeName: string) =>
      has("responsibility_action_review_claims")
        ? count(
            `SELECT COUNT(*) n FROM responsibility_action_review_claims c JOIN owned o ON o.id=c.task_id
             WHERE c.outcome=? AND c.consumed_at>=?`,
            [outcomeName, since],
          )
        : 0;
    const uncertainTriggers = has("event_trigger_occurrences")
      ? Number(
          (
            this.db
              .prepare(
                `SELECT COUNT(*) n FROM event_trigger_occurrences
                 WHERE status='outcome_unknown' AND updated_at>=?
                   AND json_valid(trigger_snapshot_json)
                   AND json_extract(trigger_snapshot_json,'$.workspaceId')=?`,
              )
              .get(since, request.workspaceId) as Count
          ).n ?? 0,
        )
      : 0;
    const intents = (state: string) =>
      has("bot_notification_intents")
        ? Number(
            (
              this.db
                .prepare(
                  `SELECT COUNT(*) n FROM bot_notification_intents
                   WHERE workspace_id=? AND (? IS NULL OR agent_role_id=?) AND state=? AND created_at>=?`,
                )
                .get(
                  request.workspaceId,
                  request.agentRoleId ?? null,
                  request.agentRoleId ?? null,
                  state,
                  since,
                ) as Count
            ).n ?? 0,
          )
        : 0;
    const reservations = has("background_dispatch_reservations")
      ? (this.db
          .prepare(
            `SELECT state, COUNT(*) n FROM background_dispatch_reservations
             WHERE workspace_id=? AND reserved_at>=? GROUP BY state`,
          )
          .all(request.workspaceId, since) as Array<{ state: string; n: number }>)
      : [];
    const duplicateAdmissions = has("background_dispatch_reservations")
      ? Number(
          (
            this.db
              .prepare(
                `SELECT COUNT(*) n FROM (SELECT occurrence_key FROM background_dispatch_reservations
                 WHERE workspace_id=? AND occurrence_key IS NOT NULL AND state='committed' AND reserved_at>=?
                 GROUP BY occurrence_key HAVING COUNT(*)>1)`,
              )
              .get(request.workspaceId, since) as Count
          ).n ?? 0,
        )
      : 0;
    const denials: Record<string, number> = {};
    if (has("background_dispatch_denials"))
      for (const row of this.db
        .prepare(
          `SELECT reason, SUM(count) n FROM background_dispatch_denials
           WHERE workspace_id=? AND last_at>=? GROUP BY reason`,
        )
        .all(request.workspaceId, since) as Array<{ reason: string; n: number }>)
        denials[row.reason] = Number(row.n ?? 0);
    const usage = (taskScoped: boolean) =>
      (has("llm_call_events")
        ? taskScoped
          ? this.db
              .prepare(
                `${owned.sql} SELECT COUNT(*) calls, COALESCE(SUM(e.input_tokens+e.output_tokens),0) tokens
                 FROM llm_call_events e JOIN owned o ON o.id=e.task_id WHERE e.timestamp>=?`,
              )
              .get(...owned.args, since)
          : this.db
              .prepare(
                `SELECT COUNT(*) calls, COALESCE(SUM(input_tokens+output_tokens),0) tokens
                 FROM llm_call_events WHERE workspace_id=? AND task_id IS NULL AND timestamp>=?`,
              )
              .get(request.workspaceId, since)
        : { calls: 0, tokens: 0 }) as { calls: number; tokens: number };
    const taskUsage = usage(true);
    const unattached = usage(false);
    const reservationState = (state: string) =>
      Number(reservations.find((row) => row.state === state)?.n ?? 0);

    return {
      scope: { workspaceId: request.workspaceId, agentRoleId: request.agentRoleId ?? null },
      window: { since, until: now, days: request.windowDays },
      outcomes: {
        completed: outcome("completed"),
        verified,
        failed: outcome("failed"),
        cancelled: outcome("cancelled"),
      },
      unresolvedWaits: {
        approvals: count(
          "SELECT COUNT(*) n FROM approvals a JOIN owned o ON o.id=a.task_id WHERE a.status='pending'",
        ),
        inputRequests: count(
          "SELECT COUNT(*) n FROM input_requests i JOIN owned o ON o.id=i.task_id WHERE i.status='pending'",
        ),
        oldestRequestedAt: oldest.n === null ? null : Number(oldest.n),
      },
      effects: { committed: claims("committed"), uncertain: claims("uncertain") },
      recovery: {
        interruptedTasks: count(
          `SELECT COUNT(*) n FROM tasks t JOIN owned o ON o.id=t.id
           WHERE t.status='interrupted' OR t.terminal_status='resume_available'`,
        ),
        uncertainTriggerOutcomes: uncertainTriggers,
      },
      delivery: {
        storedInInbox: intents("stored_in_inbox"),
        unknown: intents("delivery_unknown"),
        cancelled: intents("cancelled"),
      },
      dispatch: {
        reservations: reservations.reduce((total, row) => total + Number(row.n), 0),
        committed: reservationState("committed"),
        refunded: reservationState("refunded"),
        duplicateAdmissions,
        denials,
      },
      modelUsage: {
        taskCalls: Number(taskUsage.calls),
        taskTokens: Number(taskUsage.tokens),
        unattachedCalls: Number(unattached.calls),
        unattachedTokens: Number(unattached.tokens),
      },
    };
  }
}
