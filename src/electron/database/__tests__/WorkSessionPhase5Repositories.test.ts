import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseManager } from "../schema";
import { TaskRepository } from "../repositories";
import { WorkSessionActivityLeaseRepository } from "../WorkSessionActivityLeaseRepository";
import { WorkSessionOperationalMetricsRepository } from "../WorkSessionOperationalMetricsRepository";
import { WorkSessionProjectionRepository } from "../WorkSessionProjectionRepository";
import { WorkSessionProtocolRepository } from "../WorkSessionProtocolRepository";
import { WorkSessionProtocolService } from "../../sessions/WorkSessionProtocolService";

const nativeSqliteAvailable = (() => {
  try {
    const probe = new Database(":memory:");
    probe.close();
    return true;
  } catch {
    return false;
  }
})();

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

describeWithSqlite("WorkSession Phase 5 repositories", () => {
  let tempDir: string;
  let previousUserDataDir: string | undefined;
  let manager: DatabaseManager;
  let db: Database.Database;
  let taskRepo: TaskRepository;
  let protocol: WorkSessionProtocolRepository;
  let now: number;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-work-session-phase5-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tempDir;
    manager = new DatabaseManager();
    db = manager.getDatabase();
    taskRepo = new TaskRepository(db);
    protocol = new WorkSessionProtocolRepository(db);
    now = 1_000_000;
    db.prepare(
      `INSERT INTO workspaces (id, name, path, created_at, permissions)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("workspace-1", "Workspace", path.join(tempDir, "workspace"), now, "{}");
  });

  afterEach(() => {
    manager.close();
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function createSession() {
    const task = taskRepo.create({
      title: "Phase 5 task",
      prompt: "Exercise incremental projections",
      status: "executing",
      workspaceId: "workspace-1",
      source: "test",
    });
    const aggregate = protocol.ensureForTask({
      taskId: task.id,
      workspaceId: task.workspaceId,
      sessionId: "phase5-session",
      status: "executing",
    });
    return { task, session: aggregate.session, turn: aggregate.turns[0] };
  }

  it("reduces only the suffix after the cursor and compares to a full rebuild", () => {
    const { session, turn } = createSession();
    for (let index = 0; index < 10_000; index += 1) {
      protocol.appendItem({
        sessionId: session.id,
        turnId: turn.id,
        kind: "status",
        actor: "agent",
        payload: { index },
        idempotencyKey: `phase5-item-${index}`,
      });
    }

    expect(protocol.listItems(session.id)).toHaveLength(10_000);
    const allItems = protocol.listAllItems(session.id);
    expect(allItems).toHaveLength(10_001);
    expect(allItems.at(-1)?.sequence).toBe(10_001);

    const projections = new WorkSessionProjectionRepository(db, { now: () => now });
    const options = {
      projectionName: "test-count",
      initialState: { count: 0, lastSequence: 0 },
      compareEveryItems: 10_000,
      compareEveryMs: 0,
      reduce: (state: { count: number; lastSequence: number }, item: { sequence: number }) => ({
        count: state.count + 1,
        lastSequence: item.sequence,
      }),
    };
    const first = projections.projectIncremental(session.id, options);
    expect(first.processed).toBe(10_001);
    expect(first.comparisonPerformed).toBe(true);
    expect(first.matches).toBe(true);

    for (let index = 10_000; index < 10_003; index += 1) {
      protocol.appendItem({
        sessionId: session.id,
        turnId: turn.id,
        kind: "status",
        payload: { index },
        idempotencyKey: `phase5-item-${index}`,
      });
    }
    const readSpy = vi.spyOn(projections, "readItemsAfterSequence");
    const second = projections.projectIncremental(session.id, options);
    expect(second.processed).toBe(3);
    expect(second.cursor.state.count).toBe(10_004);
    expect(readSpy).toHaveBeenCalledWith(session.id, 10_001);
    expect(projections.compareFullRebuild(session.id, options)).toMatchObject({ matches: true });
  });

  it("keeps leases provider-neutral, renews them, and expires stale work", () => {
    const { session, turn } = createSession();
    const leases = new WorkSessionActivityLeaseRepository(db, { now: () => now });
    const first = leases.acquire({
      sessionId: session.id,
      turnId: turn.id,
      kind: "llm",
      operationKey: "run-1",
      ttlMs: 5_000,
    });
    const retry = leases.acquire({
      sessionId: session.id,
      turnId: turn.id,
      kind: "tool",
      operationKey: "run-1",
    });
    expect(retry.id).toBe(first.id);
    expect(retry.kind).toBe("llm");
    expect(first.token).toBeTruthy();
    now += 4_000;
    expect(leases.renew(first.id, first.token!)).toMatchObject({ status: "active" });
    now += 31_000;
    expect(() => leases.renew(first.id, first.token!)).toThrow(/expired/i);
    expect(leases.listActive(session.id)).toHaveLength(0);
  });

  it("only reclaims a lease after its heartbeat is stale", () => {
    const { session, turn } = createSession();
    const leases = new WorkSessionActivityLeaseRepository(db, { now: () => now });
    const first = leases.acquire({
      sessionId: session.id,
      turnId: turn.id,
      kind: "llm",
      operationKey: "reconnect-1",
      ttlMs: 5_000,
    });
    now += 2_000;
    expect(() =>
      leases.reclaim({
        sessionId: session.id,
        turnId: turn.id,
        kind: "reconnect",
        operationKey: "reconnect-1",
        ttlMs: 5_000,
      }),
    ).toThrow(/still active/i);
    now += 1_000;
    const reclaimed = leases.reclaim({
      sessionId: session.id,
      turnId: turn.id,
      kind: "reconnect",
      operationKey: "reconnect-1",
      ttlMs: 5_000,
    });
    expect(reclaimed.id).toBe(first.id);
    expect(reclaimed.token).not.toBe(first.token);
    expect(reclaimed.status).toBe("active");
  });

  it("bounds operational metrics and removes credential-like dimensions", () => {
    const { session } = createSession();
    const metrics = new WorkSessionOperationalMetricsRepository(db, {
      now: () => now,
      retentionPerScope: 10,
    });
    const first = metrics.record({
      sessionId: session.id,
      workspaceId: "workspace-1",
      name: "work_session.event",
      value: 1,
      dimensions: { type: "tool_result", token: "secret-value", provider: "neutral" },
      idempotencyKey: "metric-0",
    });
    expect(first.dimensions).toEqual({ provider: "neutral", type: "tool_result" });
    expect(
      metrics.record({
        sessionId: session.id,
        workspaceId: "workspace-1",
        name: "work_session.event",
        value: 1,
        dimensions: { provider: "neutral", detail: "sk-live-secret-123456" },
        idempotencyKey: "metric-secret-value",
      }).dimensions,
    ).toEqual({ provider: "neutral" });
    for (let index = 1; index < 20; index += 1) {
      metrics.record({
        sessionId: session.id,
        workspaceId: "workspace-1",
        name: "work_session.event",
        value: index,
        idempotencyKey: `metric-${index}`,
      });
    }
    expect(metrics.list({ sessionId: session.id, limit: 100 })).toHaveLength(10);
    expect(metrics.summarize({ sessionId: session.id })[0]).toMatchObject({ count: 10 });
  });

  it("bounds unscoped operational diagnostics as well", () => {
    const metrics = new WorkSessionOperationalMetricsRepository(db, {
      now: () => now,
      retentionPerScope: 10,
    });
    for (let index = 0; index < 20; index += 1) {
      metrics.record({
        name: "daemon.heartbeat",
        value: index,
        idempotencyKey: `heartbeat-${index}`,
      });
    }
    expect(metrics.list({ name: "daemon.heartbeat", limit: 100 })).toHaveLength(10);
  });

  it("wires canonical events through the projection, lease, and metrics layer", () => {
    const task = taskRepo.create({
      title: "Reliability wiring",
      prompt: "Exercise activity",
      status: "executing",
      workspaceId: "workspace-1",
      source: "test",
    });
    const service = new WorkSessionProtocolService(db);
    const first = service.recordTaskEvent(task.id, {
      id: "event-tool-start",
      eventId: "event-tool-start",
      taskId: task.id,
      timestamp: now,
      type: "tool_call",
      schemaVersion: 2,
      payload: { toolCallId: "tool-1", tool: "write", status: "started" },
    });
    expect(first?.item).toBeDefined();
    expect(
      service.getReliabilityService().projectSession(first!.session.id).cursor.lastSequence,
    ).toBe(first!.session.lastSequence);
    expect(
      service
        .getReliabilityService()
        .metrics.list({ sessionId: first!.session.id })
        .some((metric) => metric.name === "work_session.event"),
    ).toBe(true);
    expect(
      service
        .getReliabilityService()
        .metrics.list({ sessionId: first!.session.id })
        .some((metric) => metric.name === "work_session.projection_compare"),
    ).toBe(true);

    service.recordTaskEvent(task.id, {
      id: "event-tool-result",
      eventId: "event-tool-result",
      taskId: task.id,
      timestamp: now + 1,
      type: "tool_result",
      schemaVersion: 2,
      payload: { toolCallId: "tool-1", ok: true },
    });
    expect(service.getReliabilityService().leases.listActive(first!.session.id)).toHaveLength(0);

    service.recordTaskEvent(task.id, {
      id: "event-log-telemetry",
      eventId: "event-log-telemetry",
      taskId: task.id,
      timestamp: now + 1.5,
      type: "log",
      schemaVersion: 2,
      payload: { message: "diagnostic telemetry" },
    });
    service.recordTaskEvent(task.id, {
      id: "event-step-telemetry",
      eventId: "event-step-telemetry",
      taskId: task.id,
      timestamp: now + 1.75,
      type: "step_started",
      schemaVersion: 2,
      payload: { stepId: "step-1" },
    });
    expect(service.getReliabilityService().leases.listActive(first!.session.id)).toHaveLength(0);
    expect(
      service
        .getReliabilityService()
        .metrics.list({ sessionId: first!.session.id })
        .find((metric) => metric.dimensions.type === "log")?.dimensions.leaseKind,
    ).toBeUndefined();

    service.recordTaskEvent(task.id, {
      id: "event-approval-request",
      eventId: "event-approval-request",
      taskId: task.id,
      timestamp: now + 2,
      type: "approval_requested",
      schemaVersion: 2,
      payload: { approval: { id: "approval-release" } },
    });
    expect(service.getReliabilityService().leases.listActive(first!.session.id)).toHaveLength(1);
    service.recordTaskEvent(task.id, {
      id: "event-approval-denied",
      eventId: "event-approval-denied",
      taskId: task.id,
      timestamp: now + 3,
      type: "approval_denied",
      schemaVersion: 2,
      payload: { approvalId: "approval-release" },
    });
    expect(service.getReliabilityService().leases.listActive(first!.session.id)).toHaveLength(0);

    service.recordTaskEvent(task.id, {
      id: "event-input-request",
      eventId: "event-input-request",
      taskId: task.id,
      timestamp: now + 4,
      type: "input_request_created",
      schemaVersion: 2,
      payload: { request: { id: "input-release" } },
    });
    service.recordTaskEvent(task.id, {
      id: "event-input-resolved",
      eventId: "event-input-resolved",
      taskId: task.id,
      timestamp: now + 5,
      type: "input_request_resolved",
      schemaVersion: 2,
      payload: { requestId: "input-release" },
    });
    expect(service.getReliabilityService().leases.listActive(first!.session.id)).toHaveLength(0);
  });
});
