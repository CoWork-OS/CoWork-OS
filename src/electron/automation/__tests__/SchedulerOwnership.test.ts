import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseManager } from "../../database/schema";
import { WorkspaceStore } from "../../database/repositories";
import { TaskRepository } from "../../database/repository-facades";
import { SchedulerOwnership } from "../SchedulerOwnership";
import { PersistentDispatchBudget } from "../PersistentDispatchBudget";
import { AutomationRuntime } from "../AutomationRuntime";
import { SchedulerLeaseStore, assertSchedulerFence } from "../scheduler-lease-store";
describe("persistent scheduler fencing", () => {
  let directory: string;
  let manager: DatabaseManager;
  let peer: Database.Database;
  let now: number;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-scheduler-"));
    manager = new DatabaseManager({ dbPath: path.join(directory, "fixture.db") });
    peer = new Database(path.join(directory, "fixture.db"));
    now = Date.now();
  });
  afterEach(() => {
    peer.close();
    manager.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  it("elects one owner and persists a monotonic fencing generation across takeover and release", async () => {
    const first = new SchedulerOwnership(manager.getDatabase(), { now: () => now, leaseMs: 1000 });
    const second = new SchedulerOwnership(peer, { now: () => now, leaseMs: 1000 });
    const lease = await first.acquire();
    expect(lease).not.toBeNull();
    expect(await second.acquire()).toBeNull();
    expect(await first.acquire()).toEqual(lease);
    now += 1001;
    const takeover = await second.acquire();
    expect(takeover?.generation).toBe(lease!.generation + 1);
    await first.release(lease!);
    expect(await second.validate(takeover!)).toBe(true);
    expect(await first.validate(lease!)).toBe(false);
    await second.release(takeover!);
    const next = await first.acquire();
    expect(next?.generation).toBe(takeover!.generation + 1);
  });
  it("rejects stale task admission atomically and strips a valid fence from reusable config", async () => {
    const db = manager.getDatabase();
    const leaseStore = new SchedulerLeaseStore(db);
    const workspace = new WorkspaceStore(db).create("Fixture", directory, {
      read: true,
      write: false,
      delete: false,
      shell: false,
      network: false,
    });
    const lease = leaseStore.acquire({ owner: "first", now, leaseMs: 60000 })!;
    const tasks = new TaskRepository(db);
    const created = await tasks.create({
      title: "Valid",
      prompt: "Fixture",
      workspaceId: workspace.id,
      status: "pending",
      agentConfig: { backgroundSchedulerFence: lease, allowUserInput: false },
    });
    expect(created.agentConfig).toEqual({ allowUserInput: false });
    leaseStore.release(lease);
    leaseStore.acquire({ owner: "second", now, leaseMs: 60000 });
    await expect(
      tasks.create({
        title: "Stale",
        prompt: "Fixture",
        workspaceId: workspace.id,
        status: "pending",
        agentConfig: { backgroundSchedulerFence: lease },
      }),
    ).rejects.toThrow("ownership expired or changed");
    expect(db.prepare("SELECT COUNT(*) AS count FROM tasks").get()).toEqual({ count: 1 });
  });
  it("cannot redeem an old reservation using a new scheduler generation", async () => {
    const db = manager.getDatabase();
    const leaseStore = new SchedulerLeaseStore(db);
    const lease = leaseStore.acquire({ owner: "first", now, leaseMs: 60000 })!;
    const workspace = new WorkspaceStore(db).create("Fixture", directory, {
      read: true,
      write: false,
      delete: false,
      shell: false,
      network: false,
    });
    const budget = new PersistentDispatchBudget(db, { getSchedulerFence: () => lease });
    const grant = await budget.tryConsume({ workspaceId: workspace.id, source: "heartbeat" });
    leaseStore.release(lease);
    const current = leaseStore.acquire({ owner: "second", now, leaseMs: 60000 })!;
    await expect(
      new TaskRepository(db).create({
        title: "Stale reservation",
        prompt: "Fixture",
        workspaceId: workspace.id,
        status: "pending",
        agentConfig: { backgroundDispatchTicket: grant.ticket, backgroundSchedulerFence: current },
      }),
    ).rejects.toThrow("ownership expired or changed");
    expect(db.prepare("SELECT COUNT(*) AS count FROM tasks").get()).toEqual({ count: 0 });
    await budget.refund(grant.ticket);
    expect((await budget.snapshot(workspace.id)).dispatchesToday).toBe(0);
  });
  it("rejects reservations under a stale owner before consuming a budget slot", async () => {
    const db = manager.getDatabase();
    const leaseStore = new SchedulerLeaseStore(db);
    const lease = leaseStore.acquire({ owner: "first", now, leaseMs: 60000 })!;
    leaseStore.release(lease);
    leaseStore.acquire({ owner: "second", now, leaseMs: 60000 });
    const budget = new PersistentDispatchBudget(db, { getSchedulerFence: () => lease });
    await expect(budget.tryConsume({ workspaceId: "fixture", source: "autonomy" })).rejects.toThrow(
      "ownership expired or changed",
    );
    expect((await budget.snapshot("fixture")).dispatchesToday).toBe(0);
    expect(() => assertSchedulerFence(db, lease)).toThrow();
  });
  it("reclaims abandoned fenced reservations on takeover without refunding committed or legacy work", async () => {
    const db = manager.getDatabase();
    const leases = new SchedulerLeaseStore(db);
    const first = leases.acquire({ owner: "first", now, leaseMs: 1000 })!;
    const workspace = new WorkspaceStore(db).create("Fixture", directory, {
      read: true,
      write: false,
      delete: false,
      shell: false,
      network: false,
    });
    const budget = new PersistentDispatchBudget(db, {
      now: () => now,
      maxPerWorkspacePerDay: 3,
      getSchedulerFence: () => first,
    });
    const abandoned = await budget.tryConsume({
      workspaceId: workspace.id,
      source: "heartbeat",
      occurrenceKey: "event:abandoned",
    });
    const committed = await budget.tryConsume({
      workspaceId: workspace.id,
      source: "autonomy",
      occurrenceKey: "event:committed",
    });
    await new TaskRepository(db).create({
      title: "Committed",
      prompt: "Fixture",
      workspaceId: workspace.id,
      status: "pending",
      agentConfig: { backgroundDispatchTicket: committed.ticket },
    });
    const legacy = await new PersistentDispatchBudget(db, {
      now: () => now,
      maxPerWorkspacePerDay: 3,
    }).tryConsume({ workspaceId: workspace.id, source: "heartbeat" });
    expect((await budget.snapshot(workspace.id)).dispatchesToday).toBe(3);
    now += 1001;
    const second = leases.acquire({ owner: "second", now, leaseMs: 1000 })!;
    const current = new PersistentDispatchBudget(peer, {
      now: () => now,
      maxPerWorkspacePerDay: 3,
      getSchedulerFence: () => second,
    });
    expect((await current.snapshot(workspace.id)).dispatchesToday).toBe(2);
    const state = (ticket: string | undefined) =>
      db.prepare("SELECT state FROM background_dispatch_reservations WHERE ticket = ?").get(ticket);
    expect(state(abandoned.ticket)).toEqual({ state: "refunded" });
    expect(state(committed.ticket)).toEqual({ state: "committed" });
    expect(state(legacy.ticket)).toEqual({ state: "reserved" });
    const retry = await current.tryConsume({
      workspaceId: workspace.id,
      source: "heartbeat",
      occurrenceKey: "event:abandoned",
    });
    expect(retry.allowed).toBe(true);
    expect(
      await current.tryConsume({
        workspaceId: workspace.id,
        source: "autonomy",
        occurrenceKey: "event:committed",
        manual: true,
      }),
    ).toMatchObject({ allowed: false, reason: "duplicate_occurrence" });
    await expect(
      new TaskRepository(db).create({
        title: "Old writer",
        prompt: "Fixture",
        workspaceId: workspace.id,
        status: "pending",
        agentConfig: { backgroundDispatchTicket: abandoned.ticket },
      }),
    ).rejects.toThrow("ownership expired or changed");
    expect(db.prepare("SELECT COUNT(*) AS count FROM tasks").get()).toEqual({ count: 1 });
  });
  it("preserves live reservations during renewal and refused takeover, then recovers after release", async () => {
    const db = manager.getDatabase();
    const leases = new SchedulerLeaseStore(db);
    const first = leases.acquire({ owner: "first", now, leaseMs: 1000 })!;
    const budget = new PersistentDispatchBudget(db, {
      now: () => now,
      getSchedulerFence: () => first,
    });
    const grant = await budget.tryConsume({ workspaceId: "fixture", source: "heartbeat" });
    expect(leases.acquire({ owner: "second", now, leaseMs: 1000 })).toBeNull();
    expect(leases.acquire({ owner: "first", now, leaseMs: 1000 })?.generation).toBe(
      first.generation,
    );
    expect((await budget.snapshot("fixture")).dispatchesToday).toBe(1);
    leases.release(first);
    const next = leases.acquire({ owner: "first", now, leaseMs: 1000 })!;
    expect(next.generation).toBe(first.generation + 1);
    expect((await budget.snapshot("fixture")).dispatchesToday).toBe(0);
    await budget.refund(grant.ticket);
    expect((await budget.snapshot("fixture")).dispatchesToday).toBe(0);
  });
  it("recovers a reservation left by an interrupted profile after database reopen", async () => {
    const first = new SchedulerOwnership(manager.getDatabase(), { now: () => now, leaseMs: 1000 });
    const lease = (await first.acquire())!;
    const before = new PersistentDispatchBudget(manager.getDatabase(), {
      now: () => now,
      maxPerWorkspacePerDay: 1,
      getSchedulerFence: () => lease,
    });
    await before.tryConsume({
      workspaceId: "fixture",
      source: "heartbeat",
      occurrenceKey: "event:restart",
    });
    manager.close();
    manager = new DatabaseManager({ dbPath: path.join(directory, "fixture.db") });
    now += 1001;
    const recovered = (await new SchedulerOwnership(manager.getDatabase(), {
      now: () => now,
      leaseMs: 1000,
    }).acquire())!;
    const after = new PersistentDispatchBudget(manager.getDatabase(), {
      now: () => now,
      maxPerWorkspacePerDay: 1,
      getSchedulerFence: () => recovered,
    });
    expect(
      await after.tryConsume({
        workspaceId: "fixture",
        source: "heartbeat",
        occurrenceKey: "event:restart",
      }),
    ).toMatchObject({ allowed: true, dispatchesToday: 1 });
    expect(recovered.generation).toBe(lease.generation + 1);
  });
  it("starts only one runtime on one profile, then hands over after a clean shutdown", async () => {
    const first = new AutomationRuntime("desktop");
    const second = new AutomationRuntime("node");
    first.attachOwnership(new SchedulerOwnership(manager.getDatabase()));
    second.attachOwnership(new SchedulerOwnership(peer));
    const a = { start: vi.fn(), stop: vi.fn() };
    const b = { start: vi.fn(), stop: vi.fn() };
    first.register("cron", a);
    second.register("cron", b);
    try {
      await first.start("cron");
      await second.start("cron");
      expect(a.start).toHaveBeenCalledOnce();
      expect(b.start).not.toHaveBeenCalled();
      expect(second.snapshot().producers.find((p) => p.id === "cron")?.state).toBe(
        "waiting_for_owner",
      );
      await first.shutdown();
      await second.refreshOwnership();
      expect(b.start).toHaveBeenCalledOnce();
      expect(second.snapshot().scheduler).toBe("owned");
    } finally {
      await first.shutdown();
      await second.shutdown();
    }
  });
});
