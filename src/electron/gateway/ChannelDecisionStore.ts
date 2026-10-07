import { assertApprovalDraftsCurrent } from "../database/approval-drafts";
import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { approvalRequestRevisionHash } from "../agent/approval-revision";
import { APPROVAL_REQUEST_TIMEOUT_MS } from "../agent/approval-timeouts";

export const CHANNEL_DECISION_SCHEMA = `
CREATE TABLE IF NOT EXISTS channel_decision_routes (
 id TEXT PRIMARY KEY, approval_id TEXT NOT NULL UNIQUE, payload_json TEXT NOT NULL,
 state TEXT NOT NULL, message_id TEXT, callback_id TEXT, action TEXT,
 claim_id TEXT, delivery_claim_id TEXT, outcome TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_channel_decision_state ON channel_decision_routes(state, updated_at);
CREATE TABLE IF NOT EXISTS channel_approval_consumption (
 approval_id TEXT PRIMARY KEY, route_id TEXT NOT NULL UNIQUE, claim_id TEXT NOT NULL, revision_hash TEXT NOT NULL,
 FOREIGN KEY (approval_id) REFERENCES approvals(id) ON DELETE CASCADE,
 FOREIGN KEY (route_id) REFERENCES channel_decision_routes(id)
);
`;
export interface ChannelDecisionRoute {
  id: string;
  approvalId: string;
  taskId: string;
  rootTaskId: string;
  workspaceId: string;
  botId: string | null;
  sessionId: string;
  channelId: string;
  channelType: "slack" | "teams";
  chatId: string;
  actorId: string;
  approvalRevisionHash: string;
  policyHash: string;
  expiresAt: number;
  state: "queued" | "delivering" | "sent" | "delivery_unknown" | "claimed" | "handled";
  messageId: string | null;
  claimId: string | null;
  deliveryClaimId: string | null;
  outcome: string | null;
}
export interface ChannelDecisionCallback {
  routeId: string;
  channelId: string;
  channelType: "slack" | "teams";
  chatId: string;
  messageId: string;
  actorId: string;
  callbackId: string;
  action: "approve" | "deny";
  /** Supplied only by the authenticated adapter ingress, never by message text. */
  transport: "slack_socket" | "teams_botframework";
}
export interface ChannelDecisionResolutionGuard {
  routeId: string;
  claimId: string;
}
type Row = {
  id: string;
  payload_json: string;
  state: ChannelDecisionRoute["state"];
  message_id: string | null;
  claim_id: string | null;
  delivery_claim_id: string | null;
  outcome: string | null;
};
function bounded(value: unknown, name: string, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > max)
    throw new Error(`Invalid ${name}`);
  return value;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  return value;
}
function hash(value: unknown): string {
  const serialized = JSON.stringify(canonical(value));
  if (serialized.length > 256_000) throw new Error("Decision authority exceeds limit");
  return createHash("sha256").update(serialized).digest("hex");
}
function parse(value: string | null): unknown {
  return JSON.parse(value || "null");
}

/** Transport state only. ApprovalStore and the daemon remain the execution authority. */
export class ChannelDecisionStore {
  constructor(private readonly db: Database.Database) {}
  initialize(): void {
    this.db.exec(CHANNEL_DECISION_SCHEMA);
  }
  private decode(row: Row): ChannelDecisionRoute {
    return {
      ...JSON.parse(row.payload_json),
      id: row.id,
      state: row.state,
      messageId: row.message_id,
      claimId: row.claim_id,
      deliveryClaimId: row.delivery_claim_id,
      outcome: row.outcome,
    };
  }
  get(id: string): ChannelDecisionRoute | null {
    bounded(id, "route ID");
    const row = this.db.prepare("SELECT * FROM channel_decision_routes WHERE id = ?").get(id) as
      | Row
      | undefined;
    return row ? this.decode(row) : null;
  }
  private authority(
    approvalId: string,
    sessionId: string,
    actorId: string,
    now: number,
    status: "pending" | "approved" = "pending",
  ) {
    const approval = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(approvalId) as
      | {
          task_id: string;
          type: string;
          description: string;
          details: string;
          status: string;
          requested_at: number;
        }
      | undefined;
    if (!approval || approval.status !== status) throw new Error("Approval is no longer " + status);
    const expiresAt = approval.requested_at + APPROVAL_REQUEST_TIMEOUT_MS;
    if (!Number.isSafeInteger(expiresAt) || now >= expiresAt) throw new Error("Approval expired");
    const task = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(approval.task_id) as
      | {
          id: string;
          workspace_id: string;
          assigned_agent_role_id: string | null;
          parent_task_id: string | null;
          agent_config: string | null;
          status: string;
        }
      | undefined;
    if (!task || ["completed", "failed", "cancelled"].includes(task.status))
      throw new Error("Task is not actionable");
    const session = this.db
      .prepare(
        `SELECT s.*, c.type AS channel_type, c.enabled, c.config AS channel_config, c.security_config FROM channel_sessions s JOIN channels c ON c.id = s.channel_id WHERE s.id = ?`,
      )
      .get(sessionId) as
      | {
          channel_id: string;
          channel_type: string;
          chat_id: string;
          workspace_id: string | null;
          task_id: string | null;
          context: string | null;
          enabled: number;
          channel_config: string;
          security_config: string;
        }
      | undefined;
    if (
      !session ||
      !session.enabled ||
      !["slack", "teams"].includes(session.channel_type) ||
      session.workspace_id !== task.workspace_id ||
      !session.task_id
    )
      throw new Error("Channel session scope changed");
    const sender = this.db
      .prepare("SELECT allowed FROM channel_users WHERE channel_id = ? AND channel_user_id = ?")
      .get(session.channel_id, actorId) as { allowed: number } | undefined;
    if (sender?.allowed !== 1) throw new Error("Channel requester is not authorized");
    const lineage: Array<{ id: string; bot: string | null; config: unknown }> = [];
    let current: typeof task = task;
    while (current && lineage.length < 32 && !lineage.some((entry) => entry.id === current?.id)) {
      lineage.push({
        id: current.id,
        bot: current.assigned_agent_role_id,
        config: parse(current.agent_config),
      });
      if (current.id === session.task_id) break;
      if (!current.parent_task_id) break;
      current = this.db
        .prepare("SELECT * FROM tasks WHERE id = ? AND workspace_id = ?")
        .get(current.parent_task_id, task.workspace_id) as typeof task;
    }
    if (lineage.at(-1)?.id !== session.task_id)
      throw new Error("Approval is not descended from the channel task");
    const originConfig = lineage.at(-1)?.config;
    if (
      !originConfig ||
      typeof originConfig !== "object" ||
      Array.isArray(originConfig) ||
      (originConfig as Record<string, unknown>).gatewayContext !== "private"
    )
      throw new Error("Channel decisions require a private owner session");
    const sessionContext = parse(session.context);
    if (
      !sessionContext ||
      typeof sessionContext !== "object" ||
      Array.isArray(sessionContext) ||
      (sessionContext as Record<string, unknown>).taskRequesterUserId !== actorId
    )
      throw new Error("Channel decision requester does not match the session owner");
    const bots = lineage
      .filter((entry) => entry.bot)
      .map((entry) => {
        const bot = this.db
          .prepare(
            "SELECT id, is_active, capabilities, tool_restrictions FROM agent_roles WHERE id = ?",
          )
          .get(entry.bot) as
          | {
              id: string;
              is_active: number;
              capabilities: string;
              tool_restrictions: string | null;
            }
          | undefined;
        if (!bot || bot.is_active !== 1) throw new Error("Bot authority changed");
        return bot;
      });
    const workspace = this.db
      .prepare("SELECT permissions FROM workspaces WHERE id = ?")
      .get(task.workspace_id) as { permissions: string } | undefined;
    if (!workspace) throw new Error("Workspace unavailable");
    const rules = this.db
      .prepare(
        "SELECT * FROM workspace_permission_rules WHERE workspace_id = ? ORDER BY id LIMIT 1001",
      )
      .all(task.workspace_id);
    if (rules.length > 1000) throw new Error("Policy exceeds decision limit");
    assertApprovalDraftsCurrent(this.db, {
      taskId: approval.task_id,
      type: approval.type as Parameters<typeof assertApprovalDraftsCurrent>[1]["type"],
      details: parse(approval.details),
    });
    return {
      approvalId,
      taskId: task.id,
      rootTaskId: session.task_id,
      workspaceId: task.workspace_id,
      botId: lineage.find((entry) => entry.bot)?.bot ?? null,
      sessionId,
      channelId: session.channel_id,
      channelType: session.channel_type as "slack" | "teams",
      chatId: session.chat_id,
      actorId,
      expiresAt,
      approvalRevisionHash: approvalRequestRevisionHash({
        taskId: task.id,
        type: approval.type as Parameters<typeof approvalRequestRevisionHash>[0]["type"],
        description: approval.description,
        details: parse(approval.details),
        requestedAt: approval.requested_at,
      }),
      policyHash: hash({
        permissions: parse(workspace.permissions),
        rules,
        lineage,
        bots,
        channelSecurity: parse(session.security_config),
        channelConfigHash: hash(session.channel_config),
      }),
    };
  }
  create(
    input: { approvalId: string; sessionId: string; actorId: string },
    now = Date.now(),
  ): ChannelDecisionRoute {
    for (const key of ["approvalId", "sessionId", "actorId"] as const) bounded(input[key], key);
    return this.db
      .transaction(() => {
        const authority = this.authority(input.approvalId, input.sessionId, input.actorId, now);
        const existing = this.db
          .prepare("SELECT * FROM channel_decision_routes WHERE approval_id = ?")
          .get(input.approvalId) as Row | undefined;
        if (existing) {
          const route = this.decode(existing);
          for (const [key, value] of Object.entries(authority))
            if (route[key as keyof ChannelDecisionRoute] !== value)
              throw new Error("Approval route already bound to another revision or requester");
          return route;
        }
        const id = randomUUID();
        this.db
          .prepare(
            "INSERT INTO channel_decision_routes (id, approval_id, payload_json, state, created_at, updated_at) VALUES (?, ?, ?, 'queued', ?, ?)",
          )
          .run(id, input.approvalId, JSON.stringify(authority), now, now);
        return this.get(id)!;
      })
      .immediate();
  }
  beginDelivery(id: string, now = Date.now()): ChannelDecisionRoute {
    return this.db
      .transaction(() => {
        const route = this.get(id);
        if (!route || route.state !== "queued") throw new Error("Delivery is no longer queued");
        const authority = this.authority(route.approvalId, route.sessionId, route.actorId, now);
        for (const [key, value] of Object.entries(authority))
          if (route[key as keyof ChannelDecisionRoute] !== value)
            throw new Error("Delivery authority changed");
        this.db
          .prepare(
            "UPDATE channel_decision_routes SET state = 'delivering', delivery_claim_id = ?, updated_at = ? WHERE id = ? AND state = 'queued'",
          )
          .run(randomUUID(), now, id);
        return this.get(id)!;
      })
      .immediate();
  }
  delivered(
    id: string,
    deliveryClaimId: string,
    messageId: string,
    now = Date.now(),
  ): ChannelDecisionRoute {
    bounded(messageId, "message ID");
    bounded(deliveryClaimId, "delivery claim ID");
    const changed = this.db
      .prepare(
        "UPDATE channel_decision_routes SET state = 'sent', message_id = ?, updated_at = ? WHERE id = ? AND state = 'delivering' AND delivery_claim_id = ?",
      )
      .run(messageId, now, id, deliveryClaimId).changes;
    if (!changed) throw new Error("Delivery claim changed");
    return this.get(id)!;
  }
  deliveryUnknown(id: string, deliveryClaimId: string, now = Date.now()): void {
    bounded(deliveryClaimId, "delivery claim ID");
    if (
      !this.db
        .prepare(
          "UPDATE channel_decision_routes SET state = 'delivery_unknown', updated_at = ? WHERE id = ? AND state = 'delivering' AND delivery_claim_id = ?",
        )
        .run(now, id, deliveryClaimId).changes
    )
      throw new Error("Delivery claim changed");
  }
  claim(input: ChannelDecisionCallback, now = Date.now()): ChannelDecisionRoute {
    for (const key of [
      "routeId",
      "channelId",
      "chatId",
      "messageId",
      "actorId",
      "callbackId",
    ] as const)
      bounded(input[key], key);
    if (!["approve", "deny"].includes(input.action)) throw new Error("Unsupported decision action");
    return this.db
      .transaction(() => {
        const route = this.get(input.routeId);
        if (!route || route.state !== "sent") throw new Error("Decision is no longer actionable");
        for (const key of ["channelId", "channelType", "chatId", "messageId", "actorId"] as const)
          if (input[key] !== route[key]) throw new Error("Callback destination or actor mismatch");
        if (
          input.transport !==
          (route.channelType === "slack" ? "slack_socket" : "teams_botframework")
        )
          throw new Error("Unauthenticated decision transport");
        const authority = this.authority(route.approvalId, route.sessionId, route.actorId, now);
        for (const [key, value] of Object.entries(authority))
          if (route[key as keyof ChannelDecisionRoute] !== value)
            throw new Error("Approval revision or authority changed");
        const claimId = randomUUID();
        this.db
          .prepare(
            "UPDATE channel_decision_routes SET state = 'claimed', claim_id = ?, callback_id = ?, action = ?, updated_at = ? WHERE id = ? AND state = 'sent'",
          )
          .run(claimId, input.callbackId, input.action, now, route.id);
        return this.get(route.id)!;
      })
      .immediate();
  }
  /** Called inside ApprovalStore's writer transaction, before the pending transition. */
  assertResolution(
    guard: ChannelDecisionResolutionGuard,
    approvalId: string,
    status: "approved" | "denied",
    requestRevisionHash: string,
    now: number,
  ): void {
    bounded(guard.routeId, "route ID");
    bounded(guard.claimId, "claim ID");
    const route = this.get(guard.routeId);
    const response = this.db
      .prepare("SELECT action FROM channel_decision_routes WHERE id = ?")
      .get(guard.routeId) as { action: string } | undefined;
    if (
      !route ||
      route.state !== "claimed" ||
      route.claimId !== guard.claimId ||
      route.approvalId !== approvalId ||
      route.approvalRevisionHash !== requestRevisionHash ||
      response?.action !== (status === "approved" ? "approve" : "deny")
    )
      throw new Error("Channel decision resolution claim changed");
    const authority = this.authority(route.approvalId, route.sessionId, route.actorId, now);
    for (const [key, value] of Object.entries(authority))
      if (route[key as keyof ChannelDecisionRoute] !== value)
        throw new Error("Channel decision resolution authority changed");
  }

  /** Written only in the winning approval transaction, never inferred from a card. */
  recordApprovedResolution(
    guard: ChannelDecisionResolutionGuard,
    approvalId: string,
    revisionHash: string,
  ): void {
    const route = this.get(guard.routeId);
    const response = this.db
      .prepare("SELECT action FROM channel_decision_routes WHERE id = ?")
      .get(guard.routeId) as { action: string } | undefined;
    if (
      !route ||
      route.approvalId !== approvalId ||
      route.state !== "claimed" ||
      route.claimId !== guard.claimId ||
      route.approvalRevisionHash !== revisionHash ||
      response?.action !== "approve"
    )
      throw new Error("Channel resolution binding changed");
    this.db
      .prepare(
        "INSERT INTO channel_approval_consumption (approval_id,route_id,claim_id,revision_hash) VALUES (?,?,?,?)",
      )
      .run(approvalId, guard.routeId, guard.claimId, revisionHash);
  }

  /** Fresh route authority for a recorded channel winner at daemon resumption. */
  assertApprovedConsumption(approvalId: string, revisionHash: string, now = Date.now()): void {
    const hasTable = this.db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='channel_approval_consumption'",
      )
      .get();
    if (!hasTable) {
      // Minimal/legacy local-only stores have no channel origin. A broken channel
      // schema cannot be interpreted as an ordinary local permission decision.
      const hasRoutes = this.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='channel_decision_routes'",
        )
        .get();
      if (
        hasRoutes &&
        this.db
          .prepare("SELECT 1 FROM channel_decision_routes WHERE approval_id = ?")
          .get(approvalId)
      )
        throw new Error("Channel consumption schema unavailable");
      return;
    }
    const binding = this.db
      .prepare(
        "SELECT route_id,claim_id,revision_hash FROM channel_approval_consumption WHERE approval_id = ?",
      )
      .get(approvalId) as { route_id: string; claim_id: string; revision_hash: string } | undefined;
    if (!binding) return; // Local winners never acquire channel authority from an unrelated card.
    const route = this.get(binding.route_id);
    const response = this.db
      .prepare("SELECT action FROM channel_decision_routes WHERE id = ?")
      .get(binding.route_id) as { action: string } | undefined;
    if (
      !route ||
      route.approvalId !== approvalId ||
      !["claimed", "handled"].includes(route.state) ||
      !route.messageId ||
      !route.claimId ||
      route.claimId !== binding.claim_id ||
      binding.revision_hash !== revisionHash ||
      route.approvalRevisionHash !== revisionHash ||
      response?.action !== "approve" ||
      (route.state === "handled" && !["handled", "duplicate"].includes(route.outcome || ""))
    )
      throw new Error("Approved channel decision binding changed");
    const authority = this.authority(approvalId, route.sessionId, route.actorId, now, "approved");
    for (const [key, value] of Object.entries(authority))
      if (route[key as keyof ChannelDecisionRoute] !== value)
        throw new Error("Approved channel decision authority changed");
  }

  finish(
    id: string,
    claimId: string,
    outcome: "handled" | "duplicate" | "not_found" | "delivery_unknown",
    now = Date.now(),
  ): void {
    bounded(claimId, "claim ID");
    if (!["handled", "duplicate", "not_found", "delivery_unknown"].includes(outcome))
      throw new Error("Invalid decision outcome");
    const current = this.get(id);
    if (!current || current.state !== "claimed" || current.claimId !== claimId)
      throw new Error("Decision claim changed");
    if (outcome === "handled" || outcome === "duplicate") {
      const route = this.get(id);
      const approval = route
        ? (this.db.prepare("SELECT status FROM approvals WHERE id = ?").get(route.approvalId) as
            | { status: string }
            | undefined)
        : undefined;
      if (!approval || !["approved", "denied"].includes(approval.status))
        throw new Error("Approval resolution not persisted");
    }
    if (
      !this.db
        .prepare(
          "UPDATE channel_decision_routes SET state = 'handled', outcome = ?, updated_at = ? WHERE id = ? AND state = 'claimed' AND claim_id = ?",
        )
        .run(outcome, now, id, claimId).changes
    )
      throw new Error("Decision claim changed");
  }
}
