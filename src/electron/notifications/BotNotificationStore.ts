import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import {
  botNotificationRetrySchema,
  botNotificationScopeSchema,
  botNotificationUpdateSchema,
  botNotificationOptionsSchema,
  DEFAULT_BOT_NOTIFICATION_OPTIONS,
  botNotificationDue,
  inBotQuietHours,
  type BotNotificationScope,
  type BotNotificationRoute,
  type BotNotificationReceipt,
} from "../../shared/bot-notification";
import { assertSchedulerFence, type SchedulerFence } from "../automation/scheduler-lease-store";
export const BOT_NOTIFICATION_SCHEMA = `
 CREATE TABLE IF NOT EXISTS bot_notification_routes(workspace_id TEXT NOT NULL,agent_role_id TEXT NOT NULL,version INTEGER NOT NULL,options_json TEXT NOT NULL,activated_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(workspace_id,agent_role_id));
 CREATE TABLE IF NOT EXISTS bot_notification_route_requests(request_id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,agent_role_id TEXT NOT NULL,request_json TEXT NOT NULL,response_json TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS bot_notification_intents(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,agent_role_id TEXT NOT NULL,task_id TEXT NOT NULL,kind TEXT NOT NULL,source_key TEXT NOT NULL,route_version INTEGER NOT NULL,destination TEXT NOT NULL,due_at INTEGER NOT NULL,created_at INTEGER NOT NULL,state TEXT NOT NULL,notification_id TEXT,desktop TEXT NOT NULL DEFAULT 'not_requested',reason TEXT,UNIQUE(workspace_id,agent_role_id,source_key));
 CREATE INDEX IF NOT EXISTS idx_bot_notification_due ON bot_notification_intents(state,due_at);
 CREATE TABLE IF NOT EXISTS bot_notification_retry_requests(request_id TEXT PRIMARY KEY,request_json TEXT NOT NULL,response_json TEXT NOT NULL,created_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS bot_notification_observations(task_id TEXT PRIMARY KEY,signature TEXT NOT NULL);
`;
interface Intent {
  id: string;
  workspace_id: string;
  agent_role_id: string;
  task_id: string;
  kind: BotNotificationReceipt["kind"];
  source_key: string;
  route_version: number;
  destination: "inbox" | "desktop";
  due_at: number;
  created_at: number;
  state: BotNotificationReceipt["state"];
  notification_id: string | null;
  desktop: BotNotificationReceipt["desktop"];
  reason: string | null;
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export class BotNotificationStore {
  constructor(private db: Database.Database) {}
  private scope(raw: unknown): BotNotificationScope {
    const scope = botNotificationScopeSchema.parse(raw);
    if (!this.db.prepare("SELECT id FROM workspaces WHERE id=?").get(scope.workspaceId))
      throw Error("Workspace not found");
    if (!this.db.prepare("SELECT id FROM agent_roles WHERE id=?").get(scope.agentRoleId))
      throw Error("Bot not found");
    return scope;
  }
  get(raw: unknown): BotNotificationRoute {
    const scope = this.scope(raw);
    const row = this.db
      .prepare("SELECT * FROM bot_notification_routes WHERE workspace_id=? AND agent_role_id=?")
      .get(scope.workspaceId, scope.agentRoleId) as
      | { options_json: string; version: number; activated_at: number; updated_at: number }
      | undefined;
    const decoded = row
      ? botNotificationOptionsSchema.safeParse(JSON.parse(row.options_json))
      : null;
    if (decoded && !decoded.success) throw Error("Notification route is invalid");
    const legacy = this.db
      .prepare(
        "SELECT on_finish,on_input_required FROM bot_notification_preferences WHERE agent_role_id=?",
      )
      .get(scope.agentRoleId) as { on_finish: number; on_input_required: number } | undefined;
    return {
      ...(decoded?.success ? decoded.data : DEFAULT_BOT_NOTIFICATION_OPTIONS),
      scope,
      version: row?.version ?? 0,
      activatedAt: row?.activated_at ?? 0,
      updatedAt: row?.updated_at ?? 0,
      onFinish: legacy?.on_finish !== 0,
      onInputRequired: legacy?.on_input_required !== 0,
    };
  }
  update(raw: unknown, now = Date.now()): BotNotificationRoute {
    const input = botNotificationUpdateSchema.parse(raw);
    this.scope(input.scope);
    return this.db
      .transaction(() => {
        const replay = this.db
          .prepare("SELECT * FROM bot_notification_route_requests WHERE request_id=?")
          .get(input.requestId) as { request_json: string; response_json: string } | undefined;
        if (replay) {
          if (replay.request_json !== JSON.stringify(input))
            throw Error("Notification request identity was reused");
          return JSON.parse(replay.response_json) as BotNotificationRoute;
        }
        const current = this.get(input.scope);
        if (current.version !== input.expectedVersion)
          throw Error("Notification route version changed");
        const activatedAt = !current.enabled && input.options.enabled ? now : current.activatedAt;
        const result = {
          ...current,
          ...input.options,
          version: current.version + 1,
          activatedAt,
          updatedAt: now,
        };
        this.db
          .prepare(
            "INSERT INTO bot_notification_routes VALUES(?,?,?,?,?,?) ON CONFLICT(workspace_id,agent_role_id) DO UPDATE SET version=excluded.version,options_json=excluded.options_json,activated_at=excluded.activated_at,updated_at=excluded.updated_at",
          )
          .run(
            input.scope.workspaceId,
            input.scope.agentRoleId,
            result.version,
            JSON.stringify(input.options),
            activatedAt,
            now,
          );
        // A saved destination/time policy never silently sends already queued items elsewhere.
        this.db
          .prepare(
            "UPDATE bot_notification_intents SET state='cancelled',reason='route_changed' WHERE workspace_id=? AND agent_role_id=? AND state='queued'",
          )
          .run(input.scope.workspaceId, input.scope.agentRoleId);
        this.db
          .prepare("INSERT INTO bot_notification_route_requests VALUES(?,?,?,?,?)")
          .run(
            input.requestId,
            input.scope.workspaceId,
            input.scope.agentRoleId,
            JSON.stringify(input),
            JSON.stringify(result),
          );
        return result;
      })
      .immediate();
  }
  private map(row: Intent): BotNotificationReceipt {
    return {
      id: row.id,
      scope: { workspaceId: row.workspace_id, agentRoleId: row.agent_role_id },
      taskId: row.task_id,
      kind: row.kind,
      state: row.state,
      destination: row.destination,
      dueAt: row.due_at,
      createdAt: row.created_at,
      notificationId: row.notification_id ?? undefined,
      desktop: row.desktop,
      reason: row.reason ?? undefined,
    };
  }
  list(raw: unknown): BotNotificationReceipt[] {
    const scope = this.scope(raw);
    return (
      this.db
        .prepare(
          "SELECT * FROM bot_notification_intents WHERE workspace_id=? AND agent_role_id=? ORDER BY created_at DESC,id DESC LIMIT 100",
        )
        .all(scope.workspaceId, scope.agentRoleId) as Intent[]
    ).map((row) => this.map(row));
  }
  retry(raw: unknown, now = Date.now()): BotNotificationReceipt {
    const input = botNotificationRetrySchema.parse(raw);
    this.scope(input.scope);
    return this.db
      .transaction(() => {
        const replay = this.db
          .prepare(
            "SELECT request_json,response_json FROM bot_notification_retry_requests WHERE request_id=?",
          )
          .get(input.requestId) as { request_json: string; response_json: string } | undefined;
        if (replay) {
          if (replay.request_json !== JSON.stringify(input))
            throw Error("Notification retry identity was reused");
          return JSON.parse(replay.response_json) as BotNotificationReceipt;
        }
        const route = this.get(input.scope);
        if (route.version !== input.expectedRouteVersion)
          throw Error("Notification route version changed");
        const row = this.db
          .prepare(
            "SELECT * FROM bot_notification_intents WHERE id=? AND workspace_id=? AND agent_role_id=?",
          )
          .get(input.intentId, input.scope.workspaceId, input.scope.agentRoleId) as
          | Intent
          | undefined;
        if (!row || row.state !== "delivery_unknown")
          throw Error("Notification is not an unknown delivery in this scope");
        const known =
          row.notification_id &&
          this.db
            .prepare("SELECT id FROM notification_inbox_items WHERE id=?")
            .get(row.notification_id);
        if (known) {
          this.db
            .prepare(
              "UPDATE bot_notification_intents SET state='stored_in_inbox',reason=NULL WHERE workspace_id=? AND agent_role_id=? AND notification_id=? AND state='delivery_unknown'",
            )
            .run(row.workspace_id, row.agent_role_id, row.notification_id);
        } else {
          if (!route.enabled) throw Error("Notification routing is disabled");
          const task = this.db
            .prepare(
              `SELECT t.*,SUBSTR(t.result_summary,1,512) summary,(SELECT a.sha256 FROM work_session_artifact_revisions a WHERE a.task_id=t.id AND a.status='committed' ORDER BY created_at DESC,id DESC LIMIT 1) artifact FROM tasks t JOIN agent_roles b ON b.id=t.assigned_agent_role_id WHERE t.id=? AND t.workspace_id=? AND t.assigned_agent_role_id=? AND b.is_active=1 AND COALESCE(t.source,'manual')<>'side_chat' AND NOT EXISTS(SELECT 1 FROM task_session_metadata m WHERE m.session_id=COALESCE(NULLIF(t.session_id,''),t.id) AND m.archived_at IS NOT NULL)`,
            )
            .get(row.task_id, row.workspace_id, row.agent_role_id) as
            | Record<string, unknown>
            | undefined;
          if (!task) throw Error("Notification task scope changed");
          if (row.kind === "decision") {
            const [kind, key] = row.source_key.split(":");
            if (
              !route.onInputRequired ||
              !this.db
                .prepare(
                  kind === "approval"
                    ? "SELECT id FROM approvals WHERE id=? AND task_id=? AND status='pending'"
                    : "SELECT id FROM input_requests WHERE id=? AND task_id=? AND status='pending'",
                )
                .get(key, row.task_id)
            )
              throw Error("Decision is no longer pending");
          } else {
            const source =
              row.kind === "failure"
                ? `failure:${task.id}:${task.completed_at ?? ""}:${hash(String(task.summary ?? ""))}`
                : `result:${task.id}:${hash(JSON.stringify([task.completed_at, task.summary, task.artifact, task.verification_verdict]))}`;
            if (
              source !== row.source_key ||
              (row.kind === "result" && (!route.onFinish || task.status !== "completed")) ||
              (row.kind === "failure" && task.status !== "failed")
            )
              throw Error("Notification result or policy changed");
            if (row.kind === "result") {
              const outcome = this.db
                .prepare(
                  "SELECT usefulness,notification_recommended FROM automation_run_outcomes WHERE task_id=? ORDER BY created_at DESC LIMIT 1",
                )
                .get(row.task_id) as
                | { usefulness: string; notification_recommended: number }
                | undefined;
              if (
                outcome &&
                (outcome.notification_recommended === 0 ||
                  !["actionable", "failed"].includes(outcome.usefulness))
              )
                throw Error("Notification outcome is no longer actionable");
            }
          }
          this.db
            .prepare(
              "UPDATE bot_notification_intents SET state='queued',route_version=?,destination=?,due_at=?,notification_id=NULL,desktop='not_requested',reason='Explicit user retry' WHERE id=? AND state='delivery_unknown'",
            )
            .run(
              route.version,
              route.destination,
              botNotificationDue(route, row.kind, now),
              row.id,
            );
        }
        const updated = this.db
          .prepare("SELECT * FROM bot_notification_intents WHERE id=?")
          .get(row.id) as Intent;
        const result = this.map(updated);
        this.db
          .prepare("INSERT INTO bot_notification_retry_requests VALUES(?,?,?,?)")
          .run(input.requestId, JSON.stringify(input), JSON.stringify(result), now);
        return result;
      })
      .immediate();
  }
  discover(now: number, fence: SchedulerFence): number {
    return this.db
      .transaction(() => {
        assertSchedulerFence(this.db, fence);
        let count = 0;
        const dueByRoute = new Map<string, number>();
        // Discover from durable state, not renderer broadcasts. Skip old history on route activation.
        const tasks = this.db
          .prepare(`WITH candidates AS (SELECT t.id,t.workspace_id,t.assigned_agent_role_id,t.status,t.updated_at,t.completed_at,SUBSTR(t.result_summary,1,512) summary,t.verification_verdict,
    (SELECT a.id FROM approvals a WHERE a.task_id=t.id AND a.status='pending' ORDER BY requested_at DESC LIMIT 1) approval,
    (SELECT i.id FROM input_requests i WHERE i.task_id=t.id AND i.status='pending' ORDER BY requested_at DESC LIMIT 1) input,
    (SELECT a.sha256 FROM work_session_artifact_revisions a WHERE a.task_id=t.id AND a.status='committed' ORDER BY created_at DESC,id DESC LIMIT 1) artifact,
    o.signature previous
    FROM tasks t JOIN bot_notification_routes r ON r.workspace_id=t.workspace_id AND r.agent_role_id=t.assigned_agent_role_id JOIN agent_roles b ON b.id=r.agent_role_id
    LEFT JOIN bot_notification_observations o ON o.task_id=t.id
    WHERE json_extract(r.options_json,'$.enabled')=1 AND b.is_active=1 AND (t.updated_at>=r.activated_at OR t.status NOT IN ('completed','failed','cancelled')) AND COALESCE(t.source,'manual')<>'side_chat'
    AND NOT EXISTS(SELECT 1 FROM task_session_metadata m WHERE m.session_id=COALESCE(NULLIF(t.session_id,''),t.id) AND m.archived_at IS NOT NULL)
    ), versioned AS (SELECT *,json_array(status,completed_at,summary,verification_verdict,approval,input,artifact) signature FROM candidates) SELECT * FROM versioned WHERE previous IS NULL OR previous<>signature ORDER BY updated_at,id LIMIT 100`)
          .all() as Array<Record<string, unknown>>;
        for (const task of tasks) {
          const scope = {
            workspaceId: String(task.workspace_id),
            agentRoleId: String(task.assigned_agent_role_id),
          };
          const route = this.get(scope);
          this.db
            .prepare(
              "INSERT INTO bot_notification_observations VALUES(?,?) ON CONFLICT(task_id) DO UPDATE SET signature=excluded.signature",
            )
            .run(task.id, String(task.signature));
          const candidates: Array<{ kind: BotNotificationReceipt["kind"]; key: string }> = [];
          if (route.onInputRequired) {
            if (task.approval)
              candidates.push({ kind: "decision", key: `approval:${task.approval}` });
            if (task.input) candidates.push({ kind: "decision", key: `input:${task.input}` });
          }
          if (task.status === "failed")
            candidates.push({
              kind: "failure",
              key: `failure:${task.id}:${task.completed_at ?? ""}:${hash(String(task.summary ?? ""))}`,
            });
          if (route.onFinish && task.status === "completed" && (task.summary || task.artifact)) {
            const outcome = this.db
              .prepare("SELECT 1 FROM sqlite_master WHERE name='automation_run_outcomes'")
              .get()
              ? (this.db
                  .prepare(
                    "SELECT usefulness,notification_recommended FROM automation_run_outcomes WHERE task_id=? ORDER BY created_at DESC LIMIT 1",
                  )
                  .get(task.id) as
                  | { usefulness: string; notification_recommended: number }
                  | undefined)
              : undefined;
            if (
              !outcome ||
              (outcome.notification_recommended !== 0 &&
                ["actionable", "failed"].includes(outcome.usefulness))
            )
              candidates.push({
                kind: "result",
                key: `result:${task.id}:${hash(JSON.stringify([task.completed_at, task.summary, task.artifact, task.verification_verdict]))}`,
              });
          }
          for (const candidate of candidates) {
            const dueKey = JSON.stringify([scope, route.version, candidate.kind]);
            let due = dueByRoute.get(dueKey);
            if (due === undefined) {
              due = botNotificationDue(route, candidate.kind, now);
              dueByRoute.set(dueKey, due);
            }
            const inserted = this.db
              .prepare(
                "INSERT OR IGNORE INTO bot_notification_intents(id,workspace_id,agent_role_id,task_id,kind,source_key,route_version,destination,due_at,created_at,state) VALUES(?,?,?,?,?,?,?,?,?,?,'queued')",
              )
              .run(
                randomUUID(),
                scope.workspaceId,
                scope.agentRoleId,
                task.id,
                candidate.kind,
                candidate.key,
                route.version,
                route.destination,
                due,
                now,
              );
            count += inserted.changes;
          }
        }
        assertSchedulerFence(this.db, fence);
        return count;
      })
      .immediate();
  }
  claim(now: number, fence: SchedulerFence): BotNotificationReceipt[] {
    return this.db
      .transaction(() => {
        assertSchedulerFence(this.db, fence);
        for (let attempt = 0; attempt < 100; attempt++) {
          const first = this.db
            .prepare(
              "SELECT * FROM bot_notification_intents WHERE state='queued' AND due_at<=? ORDER BY due_at,created_at,id LIMIT 1",
            )
            .get(now) as Intent | undefined;
          if (!first) return [];
          const scope = { workspaceId: first.workspace_id, agentRoleId: first.agent_role_id };
          let route: BotNotificationRoute;
          try {
            route = this.get(scope);
          } catch {
            this.db
              .prepare(
                "UPDATE bot_notification_intents SET state='cancelled',reason='scope_unavailable' WHERE id=?",
              )
              .run(first.id);
            continue;
          }
          const task = this.db
            .prepare("SELECT assigned_agent_role_id,workspace_id FROM tasks WHERE id=?")
            .get(first.task_id) as
            | { assigned_agent_role_id: string; workspace_id: string }
            | undefined;
          const active = this.db
            .prepare("SELECT is_active FROM agent_roles WHERE id=?")
            .get(scope.agentRoleId) as { is_active: number } | undefined;
          if (
            !route.enabled ||
            route.version !== first.route_version ||
            !active?.is_active ||
            !task ||
            task.assigned_agent_role_id !== scope.agentRoleId ||
            task.workspace_id !== scope.workspaceId ||
            (first.kind === "result" && !route.onFinish) ||
            (first.kind === "decision" && !route.onInputRequired)
          ) {
            this.db
              .prepare(
                "UPDATE bot_notification_intents SET state='cancelled',reason='policy_or_scope_changed' WHERE id=?",
              )
              .run(first.id);
            continue;
          }
          if (inBotQuietHours(route, now)) {
            this.db
              .prepare("UPDATE bot_notification_intents SET due_at=? WHERE id=?")
              .run(botNotificationDue(route, first.kind, now), first.id);
            continue;
          }
          let rows =
            route.digestMinutes && first.kind !== "decision"
              ? (this.db
                  .prepare(
                    "SELECT * FROM bot_notification_intents WHERE workspace_id=? AND agent_role_id=? AND route_version=? AND state='queued' AND due_at=? AND kind<>'decision' ORDER BY id LIMIT 50",
                  )
                  .all(
                    scope.workspaceId,
                    scope.agentRoleId,
                    route.version,
                    first.due_at,
                  ) as Intent[])
              : [first];
          rows = rows.filter((row) => {
            const current = this.db
              .prepare(
                "SELECT t.status FROM tasks t WHERE t.id=? AND t.workspace_id=? AND t.assigned_agent_role_id=? AND COALESCE(t.source,'manual')<>'side_chat' AND NOT EXISTS(SELECT 1 FROM task_session_metadata m WHERE m.session_id=COALESCE(NULLIF(t.session_id,''),t.id) AND m.archived_at IS NOT NULL)",
              )
              .get(row.task_id, scope.workspaceId, scope.agentRoleId) as
              | { status: string }
              | undefined;
            let valid =
              !!current &&
              (row.kind !== "result" || (route.onFinish && current.status === "completed")) &&
              (row.kind !== "failure" || current.status === "failed") &&
              (row.kind !== "decision" || route.onInputRequired);
            if (valid && row.kind === "decision") {
              const [kind, id] = row.source_key.split(":");
              valid = !!this.db
                .prepare(
                  kind === "approval"
                    ? "SELECT id FROM approvals WHERE id=? AND task_id=? AND status='pending'"
                    : "SELECT id FROM input_requests WHERE id=? AND task_id=? AND status='pending'",
                )
                .get(id, row.task_id);
            }
            if (!valid)
              this.db
                .prepare(
                  "UPDATE bot_notification_intents SET state='cancelled',reason='policy_or_scope_changed' WHERE id=?",
                )
                .run(row.id);
            return valid;
          });
          if (!rows.length) continue;
          const notificationId =
            "bot-" +
            hash(
              rows
                .map((row) => row.id)
                .sort()
                .join(":"),
            );
          for (const row of rows)
            this.db
              .prepare(
                "UPDATE bot_notification_intents SET state='delivering',notification_id=? WHERE id=? AND state='queued'",
              )
              .run(notificationId, row.id);
          assertSchedulerFence(this.db, fence);
          return rows.map((row) =>
            this.map({ ...row, state: "delivering", notification_id: notificationId }),
          );
        }
        return [];
      })
      .immediate();
  }
  recover(fence: SchedulerFence): BotNotificationReceipt[] {
    assertSchedulerFence(this.db, fence);
    return (
      this.db
        .prepare(
          "SELECT * FROM bot_notification_intents WHERE state='delivering' ORDER BY created_at LIMIT 100",
        )
        .all() as Intent[]
    ).map((row) => this.map(row));
  }
  assertDelivery(ids: string[], fence: SchedulerFence): void {
    assertSchedulerFence(this.db, fence);
    for (const id of ids) {
      const row = this.db
        .prepare("SELECT * FROM bot_notification_intents WHERE id=? AND state='delivering'")
        .get(id) as Intent | undefined;
      if (!row) throw Error("Notification delivery claim changed");
      const route = this.get({ workspaceId: row.workspace_id, agentRoleId: row.agent_role_id });
      const task = this.db
        .prepare(
          "SELECT t.status FROM tasks t JOIN agent_roles b ON b.id=t.assigned_agent_role_id WHERE t.id=? AND t.workspace_id=? AND t.assigned_agent_role_id=? AND b.is_active=1 AND NOT EXISTS(SELECT 1 FROM task_session_metadata m WHERE m.session_id=COALESCE(NULLIF(t.session_id,''),t.id) AND m.archived_at IS NOT NULL)",
        )
        .get(row.task_id, row.workspace_id, row.agent_role_id) as { status: string } | undefined;
      if (
        !task ||
        !route.enabled ||
        route.version !== row.route_version ||
        inBotQuietHours(route, Date.now()) ||
        (row.kind === "result" && (!route.onFinish || task.status !== "completed")) ||
        (row.kind === "failure" && task.status !== "failed") ||
        (row.kind === "decision" && !route.onInputRequired)
      )
        throw Error("Notification policy or task scope changed");
      if (row.kind === "decision") {
        const [kind, key] = row.source_key.split(":");
        if (
          !this.db
            .prepare(
              kind === "approval"
                ? "SELECT id FROM approvals WHERE id=? AND task_id=? AND status='pending'"
                : "SELECT id FROM input_requests WHERE id=? AND task_id=? AND status='pending'",
            )
            .get(key, row.task_id)
        )
          throw Error("Decision is no longer pending");
      }
    }
  }
  settle(
    ids: string[],
    stored: boolean,
    desktop: BotNotificationReceipt["desktop"],
    fence: SchedulerFence,
  ): void {
    this.db
      .transaction(() => {
        assertSchedulerFence(this.db, fence);
        for (const id of ids)
          this.db
            .prepare(
              "UPDATE bot_notification_intents SET state=?,desktop=?,reason=? WHERE id=? AND state='delivering'",
            )
            .run(
              stored ? "stored_in_inbox" : "delivery_unknown",
              desktop,
              stored ? null : "Delivery was interrupted; no automatic resend",
              id,
            );
      })
      .immediate();
  }
}
