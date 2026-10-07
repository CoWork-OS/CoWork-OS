import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { DatabaseManager } from "../../database/schema";
import { TaskStore, WorkspaceStore } from "../../database/repositories";
import { AgentRoleStore } from "../../agents/AgentRoleRepository";
import { SchedulerLeaseStore } from "../../automation/scheduler-lease-store";
import { BotNotificationStore } from "../BotNotificationStore";
import { BotNotificationRuntime } from "../BotNotificationRuntime";
import { NotificationService } from "../service";
import {
  DEFAULT_BOT_NOTIFICATION_OPTIONS,
  botNotificationDue,
  inBotQuietHours,
  type BotNotificationScope,
} from "../../../shared/bot-notification";
import type { AutomationRuntime } from "../../automation/AutomationRuntime";
describe("durable bot notifications", () => {
  let directory: string,
    manager: DatabaseManager,
    store: BotNotificationStore,
    scope: BotNotificationScope,
    tasks: TaskStore,
    now: number,
    fence: { owner: string; generation: number };
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "bot-notifications-"));
    manager = new DatabaseManager({ dbPath: path.join(directory, "test.db") });
    const db = manager.getDatabase();
    tasks = new TaskStore(db);
    const workspace = new WorkspaceStore(db).create("Here", directory, {
      read: true,
      write: false,
      delete: false,
      shell: false,
      network: false,
    });
    const bot = new AgentRoleStore(db).create({
      name: randomUUID(),
      displayName: "My private bot",
      capabilities: [],
    });
    scope = { workspaceId: workspace.id, agentRoleId: bot.id };
    store = new BotNotificationStore(db);
    now = Date.now();
    fence = new SchedulerLeaseStore(db).acquire({ owner: randomUUID(), now, leaseMs: 60000 })!;
  });
  afterEach(() => {
    manager.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const enable = (patch: Partial<typeof DEFAULT_BOT_NOTIFICATION_OPTIONS> = {}) =>
    store.update(
      {
        scope,
        requestId: randomUUID(),
        expectedVersion: store.get(scope).version,
        options: { ...DEFAULT_BOT_NOTIFICATION_OPTIONS, enabled: true, ...patch },
      },
      now,
    );
  const task = (status: "completed" | "failed" | "paused" = "completed") =>
    tasks.create({
      workspaceId: scope.workspaceId,
      assignedAgentRoleId: scope.agentRoleId,
      title: "Fixture",
      prompt: "PRIVATE",
      status,
      resultSummary: "A useful report",
    });
  it("requires strict scoped CAS preferences and replays the exact saved request", () => {
    expect(store.get(scope).enabled).toBe(false);
    const request = {
      scope,
      requestId: randomUUID(),
      expectedVersion: 0,
      options: { ...DEFAULT_BOT_NOTIFICATION_OPTIONS, enabled: true },
    };
    const saved = store.update(request, now);
    expect(store.update(request, now + 1)).toEqual(saved);
    expect(() =>
      store.update({ ...request, options: { ...request.options, destination: "desktop" } }, now),
    ).toThrow("reused");
    expect(() => store.update({ ...request, requestId: randomUUID() }, now)).toThrow(
      "version changed",
    );
    expect(() =>
      store.update({ ...request, options: { ...request.options, destination: "slack" } }, now),
    ).toThrow();
    expect(() => store.get({ ...scope, workspaceId: "missing" })).toThrow("Workspace not found");
  });
  it("admits meaningful results once, skips old history and never emits progress", () => {
    const old = task();
    manager
      .getDatabase()
      .prepare("UPDATE tasks SET updated_at=? WHERE id=?")
      .run(now - 1000, old.id);
    enable();
    const current = task();
    task("paused");
    expect(store.discover(now, fence)).toBe(1);
    expect(store.discover(now + 1, fence)).toBe(0);
    expect(store.list(scope)).toMatchObject([
      { taskId: current.id, kind: "result", state: "queued" },
    ]);
  });
  it("rechecks legacy preferences and current task scope before delivery", () => {
    enable();
    const current = task();
    store.discover(now, fence);
    manager
      .getDatabase()
      .prepare("INSERT INTO bot_notification_preferences VALUES(?,0,1,?)")
      .run(scope.agentRoleId, now);
    expect(store.claim(now, fence)).toEqual([]);
    expect(store.list(scope)[0].state).toBe("cancelled");
    manager.getDatabase().prepare("UPDATE bot_notification_preferences SET on_finish=1").run();
    const foreign = task();
    store.discover(now, fence);
    tasks.update(foreign.id, { assignedAgentRoleId: undefined });
    manager
      .getDatabase()
      .prepare("UPDATE tasks SET assigned_agent_role_id=NULL WHERE id=?")
      .run(foreign.id);
    expect(store.claim(now, fence)).toEqual([]);
    expect(store.list(scope).find((row) => row.taskId === foreign.id)?.state).toBe("cancelled");
    expect(current.id).toBeTruthy();
  });
  it("batches result/failure digest without mixing bot scopes and keeps decisions separate", () => {
    enable({ digestMinutes: 15 });
    const result = task(),
      failure = task("failed"),
      decision = task("paused");
    manager
      .getDatabase()
      .prepare(
        "INSERT INTO approvals(id,task_id,type,description,details,status,requested_at) VALUES(?,?,'network','PRIVATE','{}','pending',?)",
      )
      .run(randomUUID(), decision.id, now);
    store.discover(now, fence);
    const immediate = store.claim(now, fence);
    expect(immediate).toMatchObject([{ taskId: decision.id, kind: "decision" }]);
    const due = store.list(scope).find((row) => row.taskId === result.id)!.dueAt;
    expect(due).toBeGreaterThan(now);
    const digest = store.claim(due, fence);
    expect(new Set(digest.map((row) => row.taskId))).toEqual(new Set([result.id, failure.id]));
    expect(new Set(digest.map((row) => row.notificationId)).size).toBe(1);
  });
  it("cancels a resolved concrete decision instead of sending stale input requests", () => {
    enable();
    const current = task("paused");
    const id = randomUUID();
    manager
      .getDatabase()
      .prepare(
        "INSERT INTO approvals(id,task_id,type,description,details,status,requested_at) VALUES(?,?,'network','PRIVATE','{}','pending',?)",
      )
      .run(id, current.id, now);
    store.discover(now, fence);
    manager.getDatabase().prepare("UPDATE approvals SET status='approved' WHERE id=?").run(id);
    expect(store.claim(now, fence)).toEqual([]);
    expect(store.list(scope)[0].state).toBe("cancelled");
  });
  it("does not reroute queued deliveries when preferences change", () => {
    enable({ digestMinutes: 15 });
    task();
    store.discover(now, fence);
    enable({ destination: "desktop" });
    expect(store.list(scope)[0]).toMatchObject({
      state: "cancelled",
      destination: "inbox",
      reason: "route_changed",
    });
  });
  it("rechecks every digest member and drops reassigned work", () => {
    enable({ digestMinutes: 15 });
    const a = task(),
      b = task();
    store.discover(now, fence);
    const due = store.list(scope)[0].dueAt;
    manager
      .getDatabase()
      .prepare("UPDATE tasks SET assigned_agent_role_id=NULL WHERE id=?")
      .run(b.id);
    const batch = store.claim(due, fence);
    expect(batch.map((row) => row.taskId)).toEqual([a.id]);
    expect(store.list(scope).find((row) => row.taskId === b.id)?.state).toBe("cancelled");
  });
  it("detects a new pending decision even when the task timestamp did not change", () => {
    enable();
    const current = task("paused");
    expect(store.discover(now, fence)).toBe(0);
    const id = randomUUID();
    manager
      .getDatabase()
      .prepare(
        "INSERT INTO input_requests(id,task_id,questions,status,requested_at) VALUES(?,?,'[]','pending',?)",
      )
      .run(id, current.id, now);
    expect(store.discover(now, fence)).toBe(1);
    expect(store.list(scope)[0].kind).toBe("decision");
  });
  it("fences observers, claims and delivery receipts against ownership loss", () => {
    enable();
    task();
    store.discover(now, fence);
    const selected = store.claim(now, fence);
    manager
      .getDatabase()
      .prepare("UPDATE automation_scheduler_lease SET generation=generation+1")
      .run();
    expect(() => store.discover(now, fence)).toThrow("ownership");
    expect(() => store.claim(now, fence)).toThrow("ownership");
    expect(() =>
      store.settle(
        selected.map((row) => row.id),
        true,
        "not_requested",
        fence,
      ),
    ).toThrow("ownership");
    expect(store.list(scope)[0].state).toBe("delivering");
  });
  it("blocks a changed route after claim and before the inbox side effect", () => {
    enable();
    task();
    store.discover(now, fence);
    const rows = store.claim(now, fence);
    enable({ destination: "desktop" });
    expect(() =>
      store.assertDelivery(
        rows.map((row) => row.id),
        fence,
      ),
    ).toThrow("policy");
  });
  it("suppresses unchanged or nonactionable automation outcomes", () => {
    enable();
    const current = task();
    const db = manager.getDatabase();
    db.prepare(
      "INSERT INTO automation_run_outcomes(id,source,task_id,workspace_id,title,summary,usefulness,trigger,notification_recommended,created_at) VALUES(?,'heartbeat',?,?,'Quiet','No change','noop','heartbeat',0,?)",
    ).run(randomUUID(), current.id, scope.workspaceId, now);
    expect(store.discover(now, fence)).toBe(0);
    expect(store.list(scope)).toEqual([]);
  });
  it("stores a stable inbox identity and recovers interrupted effects without resending", async () => {
    enable();
    task();
    const inbox = new NotificationService({
      db: manager.getDatabase(),
      storePath: path.join(directory, "notifications.json"),
    });
    const runtime = {
      assertOwnership: async () => {},
      captureFence: () => fence,
    } as AutomationRuntime;
    const observer = new BotNotificationRuntime(manager.getDatabase(), runtime, () => inbox, false);
    await observer.start();
    await observer.stop();
    expect(inbox.list()).toHaveLength(1);
    expect(inbox.list()[0].desktopAlert).toBe(false);
    expect(store.list(scope)[0]).toMatchObject({
      state: "stored_in_inbox",
      desktop: "not_requested",
    });
    const next = task("failed");
    store.discover(now, fence);
    const interrupted = store.claim(now, fence);
    expect(interrupted).toHaveLength(1);
    const restarted = new BotNotificationRuntime(
      manager.getDatabase(),
      runtime,
      () => inbox,
      false,
    );
    await restarted.start();
    await restarted.stop();
    expect(inbox.list()).toHaveLength(1);
    expect(store.list(scope).find((row) => row.taskId === next.id)).toMatchObject({
      state: "delivery_unknown",
    });
  });
  it("retries unknown delivery once with exact request replay and current route", () => {
    enable();
    task();
    store.discover(now, fence);
    const [receipt] = store.claim(now, fence);
    store.settle([receipt.id], false, "not_requested", fence);
    const request = {
      scope,
      requestId: randomUUID(),
      intentId: receipt.id,
      expectedRouteVersion: store.get(scope).version,
    };
    const response = store.retry(request, now);
    expect(response.state).toBe("queued");
    expect(store.retry(request, now + 1)).toEqual(response);
    expect(() => store.retry({ ...request, intentId: "other" })).toThrow("reused");
    expect(() => store.retry({ ...request, requestId: randomUUID() })).toThrow("not an unknown");
    expect(store.claim(now, fence)).toHaveLength(1);
  });
  it("rejects stale policy, foreign scope and changed result retries", () => {
    enable();
    const current = task();
    store.discover(now, fence);
    const [receipt] = store.claim(now, fence);
    store.settle([receipt.id], false, "not_requested", fence);
    const request = {
      scope,
      requestId: randomUUID(),
      intentId: receipt.id,
      expectedRouteVersion: store.get(scope).version,
    };
    const foreign = new AgentRoleStore(manager.getDatabase()).create({
      name: randomUUID(),
      displayName: "Other private fixture",
      capabilities: [],
    });
    expect(() =>
      store.retry({
        ...request,
        scope: { ...scope, agentRoleId: foreign.id },
        expectedRouteVersion: 0,
      }),
    ).toThrow("not an unknown delivery in this scope");
    enable({ destination: "desktop" });
    expect(() => store.retry(request)).toThrow("version changed");
    const next = { ...request, expectedRouteVersion: store.get(scope).version };
    manager
      .getDatabase()
      .prepare("UPDATE tasks SET result_summary='Changed' WHERE id=?")
      .run(current.id);
    expect(() => store.retry(next)).toThrow("result or policy changed");
    expect(store.list(scope)[0].state).toBe("delivery_unknown");
  });
  it("rejects a resolved decision and a reassigned task on explicit retry", () => {
    enable();
    const current = task("paused"),
      approval = randomUUID();
    const db = manager.getDatabase();
    db.prepare(
      "INSERT INTO approvals(id,task_id,type,description,details,status,requested_at) VALUES(?,?,'network','PRIVATE','{}','pending',?)",
    ).run(approval, current.id, now);
    store.discover(now, fence);
    const [receipt] = store.claim(now, fence);
    store.settle([receipt.id], false, "not_requested", fence);
    const request = {
      scope,
      requestId: randomUUID(),
      intentId: receipt.id,
      expectedRouteVersion: store.get(scope).version,
    };
    db.prepare("UPDATE approvals SET status='approved' WHERE id=?").run(approval);
    expect(() => store.retry(request)).toThrow("no longer pending");
    db.prepare("UPDATE tasks SET assigned_agent_role_id=NULL WHERE id=?").run(current.id);
    expect(() => store.retry(request)).toThrow("scope changed");
  });
  it("reconciles stored retired identities instead of resending an unknown receipt", async () => {
    enable();
    task();
    store.discover(now, fence);
    const [receipt] = store.claim(now, fence);
    const inbox = new NotificationService({
      db: manager.getDatabase(),
      storePath: path.join(directory, "notifications.json"),
    });
    await inbox.addBotDelivery(
      {
        id: receipt.notificationId,
        type: "info",
        title: "Result",
        message: "Open work",
        workspaceId: scope.workspaceId,
        agentRoleId: scope.agentRoleId,
        taskId: receipt.taskId,
      },
      { ids: [receipt.id], fence },
    );
    await inbox.delete(receipt.notificationId!);
    store.settle([receipt.id], false, "not_requested", fence);
    const request = {
      scope,
      requestId: randomUUID(),
      intentId: receipt.id,
      expectedRouteVersion: store.get(scope).version,
    };
    expect(store.retry(request).state).toBe("stored_in_inbox");
    expect(store.claim(now, fence)).toEqual([]);
    await inbox.refresh();
    expect(inbox.list()).toEqual([]);
  });
  it("validates the fence and exact claimed inbox identity inside the writer transaction", async () => {
    enable();
    task();
    store.discover(now, fence);
    const rows = store.claim(now, fence);
    const inbox = new NotificationService({
      db: manager.getDatabase(),
      storePath: path.join(directory, "notifications.json"),
    });
    const params = {
      id: rows[0].notificationId,
      type: "info" as const,
      title: "Result",
      message: "Open work",
      workspaceId: scope.workspaceId,
      agentRoleId: scope.agentRoleId,
      taskId: rows[0].taskId,
    };
    await expect(
      inbox.addBotDelivery(
        { ...params, workspaceId: "foreign" },
        { ids: rows.map((row) => row.id), fence },
      ),
    ).rejects.toThrow("another scope");
    expect(await inbox.containsDeliveryIdentity(params.id!)).toBe(false);
    await expect(
      inbox.addBotDelivery(
        { ...params, taskId: "foreign" },
        { ids: rows.map((row) => row.id), fence },
      ),
    ).rejects.toThrow("another scope");
    await expect(
      inbox.addBotDelivery(params, { ids: [rows[0].id, rows[0].id], fence }),
    ).rejects.toThrow("authority");
    manager
      .getDatabase()
      .prepare("UPDATE automation_scheduler_lease SET generation=generation+1")
      .run();
    await expect(
      inbox.addBotDelivery(params, { ids: rows.map((row) => row.id), fence }),
    ).rejects.toThrow("ownership");
    expect(await inbox.containsDeliveryIdentity(params.id!)).toBe(false);
  });
  it("recognizes a deleted committed inbox identity during recovery without restoring or alerting", async () => {
    enable();
    task();
    const events: string[] = [];
    const inbox = new NotificationService({
      db: manager.getDatabase(),
      storePath: path.join(directory, "notifications.json"),
      onEvent: (event) => {
        events.push(event.type);
      },
    });
    const runtime = {
      assertOwnership: async () => {},
      captureFence: () => fence,
    } as AutomationRuntime;
    let observer = new BotNotificationRuntime(manager.getDatabase(), runtime, () => inbox, false);
    await observer.start();
    await observer.stop();
    const receipt = store.list(scope)[0];
    await inbox.delete(receipt.notificationId!);
    manager
      .getDatabase()
      .prepare("UPDATE bot_notification_intents SET state='delivering' WHERE id=?")
      .run(receipt.id);
    observer = new BotNotificationRuntime(manager.getDatabase(), runtime, () => inbox, false);
    await observer.start();
    await observer.stop();
    expect(store.list(scope)[0].state).toBe("stored_in_inbox");
    expect(inbox.list()).toEqual([]);
    expect(events).toEqual(["added", "removed"]);
  });
  it.each([true, false])(
    "records desktop request acknowledgment %s from the actual delivery callback",
    async (desktopRequested) => {
      enable({ destination: "desktop" });
      task();
      const inbox = new NotificationService({
        db: manager.getDatabase(),
        storePath: path.join(directory, "notifications.json"),
        onEvent: () => ({ desktopRequested }),
      });
      const observer = new BotNotificationRuntime(
        manager.getDatabase(),
        { assertOwnership: async () => {}, captureFence: () => fence } as AutomationRuntime,
        () => inbox,
        true,
      );
      await observer.start();
      await observer.stop();
      expect(store.list(scope)[0]).toMatchObject({
        state: "stored_in_inbox",
        desktop: desktopRequested ? "requested" : "unavailable",
      });
    },
  );
  it("reports desktop as unavailable on Node without pretending an alert appeared", async () => {
    enable({ destination: "desktop" });
    task();
    const inbox = new NotificationService({
      db: manager.getDatabase(),
      storePath: path.join(directory, "notifications.json"),
    });
    const observer = new BotNotificationRuntime(
      manager.getDatabase(),
      { assertOwnership: async () => {}, captureFence: () => fence } as AutomationRuntime,
      () => inbox,
      false,
    );
    await observer.start();
    await observer.stop();
    expect(store.list(scope)[0]).toMatchObject({
      state: "stored_in_inbox",
      desktop: "unavailable",
    });
  });
});
describe("quiet hours and digest clock", () => {
  it("handles overnight quiet hours, boundary minutes and DST using the chosen timezone", () => {
    const options = {
      ...DEFAULT_BOT_NOTIFICATION_OPTIONS,
      quietHours: { start: "22:00", end: "08:00", timeZone: "Europe/Lisbon" },
    };
    const start = Date.parse("2026-10-24T22:30:00Z");
    expect(inBotQuietHours(options, start)).toBe(true);
    expect(botNotificationDue(options, "decision", start)).toBe(Date.parse("2026-10-25T08:00:00Z"));
    expect(inBotQuietHours(options, Date.parse("2026-10-25T08:00:00Z"))).toBe(false);
  });
  it("does not defer a decision into a digest but defers ordinary results", () => {
    const options = { ...DEFAULT_BOT_NOTIFICATION_OPTIONS, digestMinutes: 15 };
    expect(botNotificationDue(options, "decision", 1000)).toBe(1000);
    expect(botNotificationDue(options, "result", 1000)).toBe(900000);
  });
});
