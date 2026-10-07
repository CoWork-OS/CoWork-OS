import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { DatabaseManager } from "../../database/schema";
import { ApprovalStore, TaskStore, WorkspaceStore } from "../../database/repositories";
import { AgentRoleStore } from "../../agents/AgentRoleRepository";
import { SchedulerLeaseStore, type SchedulerFence } from "../scheduler-lease-store";
import { BOT_RECEIPT_RETENTION_MS, BotReceiptRetentionStore } from "../receipt-retention";
import { CHANNEL_DECISION_SCHEMA } from "../../gateway/ChannelDecisionStore";

describe("settled bot receipt retention", () => {
  let directory: string;
  let manager: DatabaseManager;
  let db: Database.Database;
  let workspaceId: string;
  let botId: string;
  let taskId: string;
  let fence: SchedulerFence;
  const now = Date.UTC(2026, 9, 6, 12);
  const old = now - BOT_RECEIPT_RETENTION_MS - 1000;
  const recent = now - 1000;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-receipt-retention-"));
    manager = new DatabaseManager({ dbPath: path.join(directory, "test.db") });
    db = manager.getDatabase();
    db.exec(CHANNEL_DECISION_SCHEMA);
    const permissions = { read: true, write: false, delete: false, network: false, shell: false };
    workspaceId = new WorkspaceStore(db).create("Current", directory, permissions).id;
    botId = new AgentRoleStore(db).create({
      name: randomUUID(),
      displayName: "Any bot",
      capabilities: [],
    }).id;
    taskId = new TaskStore(db).create({
      workspaceId,
      assignedAgentRoleId: botId,
      title: "Retention fixture",
      prompt: "Metadata only",
      status: "completed",
    }).id;
    fence = new SchedulerLeaseStore(db).acquire({ owner: "retention", now, leaseMs: 60_000 })!;
  });
  afterEach(() => {
    manager.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function intent(state: string, createdAt: number, intentTaskId = taskId) {
    db.prepare(`INSERT INTO bot_notification_intents
      (id, workspace_id, agent_role_id, task_id, kind, source_key, route_version, destination, due_at, created_at, state)
      VALUES (?, ?, ?, ?, 'result', ?, 1, 'inbox', ?, ?, ?)`).run(
      randomUUID(),
      workspaceId,
      botId,
      intentTaskId,
      randomUUID(),
      createdAt,
      createdAt,
      state,
    );
  }
  const remaining = (table: string) =>
    (db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;

  it("prunes old delivery history for finished work and keeps anything still binding", () => {
    const tasks = new TaskStore(db);
    const waiting = tasks.create({
      workspaceId,
      assignedAgentRoleId: botId,
      title: "Still waiting",
      prompt: "Metadata only",
      status: "paused",
    }).id;
    const finishedWithDecision = tasks.create({
      workspaceId,
      assignedAgentRoleId: botId,
      title: "Finished with an open input",
      prompt: "Metadata only",
      status: "completed",
    }).id;
    db.prepare(
      "INSERT INTO input_requests (id, task_id, questions, status, requested_at) VALUES (?, ?, '[]', 'pending', ?)",
    ).run(randomUUID(), finishedWithDecision, old);
    intent("stored_in_inbox", old);
    intent("cancelled", old);
    intent("delivery_unknown", old);
    intent("queued", old);
    intent("stored_in_inbox", recent);
    intent("stored_in_inbox", old, waiting);
    intent("stored_in_inbox", old, finishedWithDecision);
    // Idempotency receipts for user requests are retained regardless of age.
    db.prepare(
      "INSERT INTO bot_notification_retry_requests(request_id,request_json,response_json,created_at) VALUES (?, '{}', '{}', ?)",
    ).run(randomUUID(), old);
    db.prepare(
      "INSERT INTO bot_work_control_receipts(workspace_id,agent_role_id,request_id,request_json,receipt_json) VALUES(?,?,?,?,?)",
    ).run(
      workspaceId,
      botId,
      randomUUID(),
      "{}",
      JSON.stringify({ status: "settled", updatedAt: old }),
    );

    const approval = new ApprovalStore(db).create({
      taskId,
      type: "run_command",
      description: "Synthetic",
      details: {},
      status: "approved",
      requestedAt: old,
    });
    const route = db.prepare(`INSERT INTO channel_decision_routes
      (id, approval_id, payload_json, state, created_at, updated_at) VALUES (?, ?, '{}', ?, ?, ?)`);
    route.run("handled-old", randomUUID(), "handled", old, old);
    route.run("unknown-old", randomUUID(), "delivery_unknown", old, old);
    route.run("consumed-old", approval.id, "handled", old, old);
    route.run("handled-new", randomUUID(), "handled", recent, recent);
    db.prepare(
      "INSERT INTO channel_approval_consumption(approval_id, route_id, claim_id, revision_hash) VALUES (?, 'consumed-old', 'claim', 'hash')",
    ).run(approval.id);

    const result = new BotReceiptRetentionStore(db).prune(now, fence);
    expect(result).toEqual({ notificationIntents: 2, channelDecisionRoutes: 1 });
    expect(
      (
        db
          .prepare("SELECT state, task_id FROM bot_notification_intents ORDER BY state, task_id")
          .all() as Array<{
          state: string;
          task_id: string;
        }>
      )
        .map(
          (row) =>
            `${row.state}:${row.task_id === taskId ? "done" : row.task_id === waiting ? "waiting" : "decision"}`,
        )
        .sort(),
    ).toEqual([
      "delivery_unknown:done",
      "queued:done",
      "stored_in_inbox:decision",
      "stored_in_inbox:done",
      "stored_in_inbox:waiting",
    ]);
    expect(
      (
        db.prepare("SELECT id FROM channel_decision_routes ORDER BY id").all() as Array<{
          id: string;
        }>
      ).map((row) => row.id),
    ).toEqual(["consumed-old", "handled-new", "unknown-old"]);
    expect(remaining("bot_notification_retry_requests")).toBe(1);
    expect(remaining("bot_work_control_receipts")).toBe(1);
    expect(remaining("approvals")).toBe(1);
    // Repeating the policy is idempotent.
    expect(new BotReceiptRetentionStore(db).prune(now, fence)).toEqual({
      notificationIntents: 0,
      channelDecisionRoutes: 0,
    });
  });

  it("refuses to prune without current scheduler ownership", () => {
    intent("stored_in_inbox", old);
    const takeover = new SchedulerLeaseStore(db).acquire({
      owner: "other",
      now: now + 120_000,
      leaseMs: 60_000,
    })!;
    expect(takeover.generation).toBeGreaterThan(fence.generation);
    expect(() => new BotReceiptRetentionStore(db).prune(now + 120_000, fence)).toThrow();
    expect(remaining("bot_notification_intents")).toBe(1);
  });
});
