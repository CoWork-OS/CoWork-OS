import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { DatabaseManager } from "../schema";
import { ApprovalStore, TaskStore, WorkspaceStore } from "../repositories";
import { AgentRoleStore } from "../../agents/AgentRoleRepository";
import { DispatchBudgetStore } from "../../automation/dispatch-budget-store";
import { BotOutcomeMetricsStore } from "../bot-outcome-metrics-store";
import { BotOutcomeMetricsService } from "../../agents/BotOutcomeMetricsService";

describe("bot outcome metrics baseline", () => {
  let directory: string;
  let manager: DatabaseManager;
  let db: Database.Database;
  let workspaceId: string;
  let foreignWorkspaceId: string;
  let botId: string;
  let otherBotId: string;
  let tasks: TaskStore;
  const now = Date.UTC(2026, 9, 6, 12);

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-bot-metrics-"));
    manager = new DatabaseManager({ dbPath: path.join(directory, "test.db") });
    db = manager.getDatabase();
    const permissions = { read: true, write: false, delete: false, network: false, shell: false };
    const workspaces = new WorkspaceStore(db);
    workspaceId = workspaces.create("Current", directory, permissions).id;
    foreignWorkspaceId = workspaces.create("Other", path.join(directory, "o"), permissions).id;
    const roles = new AgentRoleStore(db);
    botId = roles.create({ name: randomUUID(), displayName: "Any bot", capabilities: [] }).id;
    otherBotId = roles.create({ name: randomUUID(), displayName: "Other", capabilities: [] }).id;
    tasks = new TaskStore(db);
  });
  afterEach(() => {
    manager.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function task(overrides: Record<string, unknown> = {}) {
    return tasks.create({
      workspaceId,
      assignedAgentRoleId: botId,
      title: "Metric fixture",
      prompt: "Metadata only",
      status: "completed",
      ...overrides,
    } as Parameters<TaskStore["create"]>[0]);
  }

  it("counts recorded outcomes, waits, effects and delivery within the bot's lineage", () => {
    const verified = task({ verificationVerdict: "PASS" });
    db.prepare("UPDATE tasks SET completed_at=? WHERE id=?").run(now - 1000, verified.id);
    const plain = task();
    db.prepare("UPDATE tasks SET completed_at=? WHERE id=?").run(now - 2000, plain.id);
    const child = task({
      parentTaskId: plain.id,
      assignedAgentRoleId: otherBotId,
      status: "failed",
    });
    db.prepare("UPDATE tasks SET updated_at=? WHERE id=?").run(now - 3000, child.id);
    const waiting = task({ status: "blocked" });
    task({ status: "interrupted" });
    task({ assignedAgentRoleId: otherBotId, status: "failed" });
    task({ workspaceId: foreignWorkspaceId, status: "failed" });
    new ApprovalStore(db).create({
      taskId: waiting.id,
      type: "run_command",
      description: "Synthetic",
      details: {},
      status: "pending",
      requestedAt: now - 5000,
    });
    db.prepare(
      "INSERT INTO input_requests (id, task_id, questions, status, requested_at) VALUES (?, ?, '[]', 'pending', ?)",
    ).run(randomUUID(), waiting.id, now - 7000);
    const intent = db.prepare(`INSERT INTO bot_notification_intents
      (id, workspace_id, agent_role_id, task_id, kind, source_key, route_version, destination, due_at, created_at, state)
      VALUES (?, ?, ?, ?, 'result', ?, 1, 'inbox', ?, ?, ?)`);
    intent.run(randomUUID(), workspaceId, botId, plain.id, "a", now, now - 100, "stored_in_inbox");
    intent.run(randomUUID(), workspaceId, botId, plain.id, "b", now, now - 100, "delivery_unknown");
    intent.run(
      randomUUID(),
      workspaceId,
      otherBotId,
      plain.id,
      "c",
      now,
      now - 100,
      "delivery_unknown",
    );
    db.prepare(
      "INSERT INTO llm_call_events (id, timestamp, workspace_id, task_id, source_kind, input_tokens, output_tokens) VALUES (?, ?, ?, ?, 'task', 40, 10)",
    ).run(randomUUID(), now - 100, workspaceId, plain.id);
    db.prepare(
      "INSERT INTO llm_call_events (id, timestamp, workspace_id, task_id, source_kind, input_tokens, output_tokens) VALUES (?, ?, ?, NULL, 'heartbeat', 7, 3)",
    ).run(randomUUID(), now - 100, workspaceId);

    const metrics = new BotOutcomeMetricsStore(db).summary(
      { workspaceId, agentRoleId: botId, windowDays: 7 },
      now,
    );
    expect(metrics.outcomes).toEqual({ completed: 2, verified: 1, failed: 1, cancelled: 0 });
    expect(metrics.unresolvedWaits).toEqual({
      approvals: 1,
      inputRequests: 1,
      oldestRequestedAt: now - 7000,
    });
    expect(metrics.recovery.interruptedTasks).toBe(1);
    expect(metrics.recovery.uncertainTriggerOutcomes).toBe(0);
    expect(metrics.delivery).toEqual({ storedInInbox: 1, unknown: 1, cancelled: 0 });
    expect(metrics.modelUsage).toEqual({
      taskCalls: 1,
      taskTokens: 50,
      unattachedCalls: 1,
      unattachedTokens: 10,
    });
    expect(metrics.effects).toEqual({ committed: 0, uncertain: 0 });

    const workspace = new BotOutcomeMetricsStore(db).summary({ workspaceId, windowDays: 7 }, now);
    expect(workspace.scope.agentRoleId).toBeNull();
    expect(workspace.outcomes.failed).toBe(2);
    expect(workspace.delivery.unknown).toBe(2);
  });

  it("excludes records outside the window and rejects unknown scope", () => {
    const old = task();
    db.prepare("UPDATE tasks SET completed_at=?, updated_at=? WHERE id=?").run(
      now - 30 * 86_400_000,
      now - 30 * 86_400_000,
      old.id,
    );
    const store = new BotOutcomeMetricsStore(db);
    expect(
      store.summary({ workspaceId, agentRoleId: botId, windowDays: 7 }, now).outcomes.completed,
    ).toBe(0);
    expect(
      store.summary({ workspaceId, agentRoleId: botId, windowDays: 31 }, now).outcomes.completed,
    ).toBe(1);
    expect(() => store.summary({ workspaceId: "missing", windowDays: 7 }, now)).toThrow(
      "Workspace not found",
    );
    expect(() =>
      store.summary({ workspaceId, agentRoleId: "missing", windowDays: 7 }, now),
    ).toThrow("Bot not found");
  });

  it("records dispatch denials in a daily aggregate and reports prevented duplicates", () => {
    const budget = new DispatchBudgetStore(db);
    const params = { now: now - 1000, dayStart: now - 86_400_000, maxPerDay: 1, cooldownMs: 0 };
    const first = budget.reserve(
      { workspaceId, source: "heartbeat", occurrenceKey: "occurrence:1" },
      params,
      "ticket-1",
    );
    expect(first.allowed).toBe(true);
    const replay = budget.reserve(
      { workspaceId, source: "heartbeat", occurrenceKey: "occurrence:1" },
      params,
      "ticket-2",
    );
    expect(replay).toMatchObject({ allowed: false, reason: "duplicate_occurrence" });
    const exhausted = budget.reserve({ workspaceId, source: "autonomy" }, params, "ticket-3");
    expect(exhausted).toMatchObject({ allowed: false, reason: "workspace_budget_exhausted" });
    budget.reserve({ workspaceId, source: "autonomy" }, params, "ticket-4");
    const metrics = new BotOutcomeMetricsStore(db).summary({ workspaceId, windowDays: 7 }, now);
    expect(metrics.dispatch).toEqual({
      reservations: 1,
      committed: 0,
      refunded: 0,
      duplicateAdmissions: 0,
      denials: { duplicate_occurrence: 1, workspace_budget_exhausted: 2 },
    });
    expect(db.prepare("SELECT COUNT(*) n FROM background_dispatch_denials").get()).toEqual({
      n: 2,
    });
  });

  it("validates requests and adds process work-view latency", async () => {
    const service = new BotOutcomeMetricsService(db, () => now);
    await expect(service.summary({ workspaceId, windowDays: 0 })).rejects.toThrow();
    await expect(
      service.summary({ workspaceId, windowDays: 7, extra: true } as never),
    ).rejects.toThrow();
    const summary = await service.summary({ workspaceId, agentRoleId: botId });
    expect(summary.window.days).toBe(7);
    expect(summary.workView).toMatchObject({ samples: expect.any(Number) });
  });
});
