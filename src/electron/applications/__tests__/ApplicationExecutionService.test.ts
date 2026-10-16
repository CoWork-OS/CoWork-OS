import Database from "better-sqlite3";
import { buildSync } from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApplicationOperationRequestSchema,
  ApplicationRouteSchema,
  projectApplicationOperation,
  type ApplicationOperationRequest,
  type ApplicationResult,
} from "../../../shared/application-execution";
import { ApplicationExecutionService } from "../ApplicationExecutionService";
import { ApplicationOperationRepository } from "../ApplicationOperationRepository";
import {
  ApplicationAdapterCatalog,
  ApplicationNotDispatchedError,
  type ApplicationAdapter,
  type ApplicationToolGateway,
} from "../ApplicationAdapterCatalog";
import { APPLICATION_EXECUTION_SCHEMA } from "../application-operation-store";
import { setStatementClient } from "../../database/statements/statement-route";
import { DatabaseClient } from "../../database/async/DatabaseClient";
import { registerApplicationExecutionMethods } from "../../control-plane/registerApplicationExecutionMethods";
import { Methods, ErrorCodes } from "../../control-plane/protocol";
import type { ControlPlaneServer } from "../../control-plane/server";
import type { AgentDaemon } from "../../agent/daemon";
import {
  APPLICATION_DECISION_PREFIX,
  resolveApplicationInput,
} from "../../agent/tools/application-tools";
import type { InputRequest } from "../../../shared/types";
import {
  ApplicationTaskToolGateway,
  createDaemonApplicationExecution,
} from "../daemon-application-execution";

// Real SQLite is required: these tests must fail rather than silently skip if it cannot load.
const LEGACY_SCHEMA = `
CREATE TABLE workspaces (id TEXT PRIMARY KEY);
CREATE TABLE tasks (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'executing');
CREATE TABLE work_sessions (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL);
CREATE TABLE work_session_task_bindings (task_id TEXT PRIMARY KEY, session_id TEXT NOT NULL);
INSERT INTO workspaces VALUES ('workspace');
INSERT INTO tasks (id, workspace_id) VALUES ('task', 'workspace'), ('task2', 'workspace');
INSERT INTO work_sessions VALUES ('session', 'workspace'), ('session2', 'workspace');
INSERT INTO work_session_task_bindings VALUES ('task', 'session'), ('task2', 'session2');
`;

describe("Application execution conformance", () => {
  let directory: string;
  let db: Database.Database;
  let repository: ApplicationOperationRepository;
  let now: number;
  let services: ApplicationExecutionService[];
  let clients: DatabaseClient[];
  let servers: http.Server[];

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-application-execution-"));
    db = new Database(path.join(directory, "profile.db"));
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.exec(LEGACY_SCHEMA);
    db.exec(APPLICATION_EXECUTION_SCHEMA);
    repository = new ApplicationOperationRepository(db);
    now = 1_000_000;
    services = [];
    clients = [];
    servers = [];
  });
  afterEach(async () => {
    for (const service of services) await service.stop();
    setStatementClient(null, null, null);
    for (const client of clients) await client.close();
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
    vi.useRealTimers();
  });

  const result = (summary = "Verified change"): ApplicationResult => ({
    kind: "record",
    summary,
    resources: [],
    unmetCriteria: [],
  });
  const route = (overrides: Record<string, unknown> = {}) =>
    ApplicationRouteSchema.parse({
      id: "fixture.api",
      adapterId: "fixture",
      adapterVersion: "1",
      capability: "fixture.change",
      protocol: "api",
      control: "structured",
      environment: {
        id: "fixture",
        kind: "service",
        locality: "remote",
        isolated: true,
        background: true,
      },
      resourceKinds: ["file", "native_project", "remote_entity", "query", "application_state"],
      effect: "write",
      replay: "never",
      supports: {
        prepare: false,
        observe: true,
        cancel: false,
        verify: true,
        conditionalWrite: true,
        remoteFencing: false,
      },
      qualified: true,
      description: "Controlled conformance adapter",
      ...overrides,
    });
  function adapter(overrides: Partial<ApplicationAdapter> = {}): ApplicationAdapter {
    return {
      route: route(),
      validateInput: () => undefined,
      readiness: async () => ({ ready: true }),
      execute: vi.fn(async () => ({ status: "completed" as const, result: result() })),
      observe: vi.fn(async () => ({ status: "completed" as const, result: result() })),
      verify: vi.fn(async () => ({
        status: "verified" as const,
        summary: "Authoritative readback matches",
        checkedAt: now,
        evidence: [{ source: "fixture:record:1", claim: "Expected field value is present" }],
      })),
      ...overrides,
    };
  }
  function service(
    a: ApplicationAdapter = adapter(),
    tools: ApplicationToolGateway = { call: vi.fn(async () => ({ ok: true })) },
  ) {
    const service = new ApplicationExecutionService(
      repository,
      tools,
      {},
      { now: () => now, leaseMs: 1_000, pollMs: 1_000 },
    );
    service.catalog.register(a);
    services.push(service);
    return service;
  }
  function request(overrides: Record<string, unknown> = {}): ApplicationOperationRequest {
    return ApplicationOperationRequestSchema.parse({
      schemaVersion: 1,
      taskId: "task",
      sessionId: "session",
      workspaceId: "workspace",
      idempotencyKey: "request",
      capability: "fixture.change",
      objective: "Update the requested record",
      input: { value: 7 },
      resources: [
        {
          kind: "remote_entity",
          system: "fixture",
          identity: "record-1",
          accountId: "account-a",
          version: "1",
        },
      ],
      ...overrides,
    });
  }

  it("does not spend the adapter deadline while waiting for approval", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const authorize = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const a = adapter({ authorize });
    const s = service(a);
    const operation = await s.create(request());
    const pending = s.execute(operation.id);
    await vi.waitFor(() => expect(authorize).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(180_000);
    expect((await s.get(operation.id)).execution).toBe("submitting");
    expect(a.execute).not.toHaveBeenCalled();
    release();
    expect((await pending).verification).toBe("verified");
  });

  it("releases the device resource when canceled before approval, without dispatch", async () => {
    const authorize = vi.fn(
      (context: Parameters<NonNullable<ApplicationAdapter["authorize"]>>[0]) =>
        new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener(
            "abort",
            () => reject(new Error("Approval review canceled")),
            { once: true },
          );
        }),
    );
    const a = adapter({ authorize });
    const s = service(a);
    const operation = await s.create(request());
    const pending = s.execute(operation.id);
    await vi.waitFor(() => expect(authorize).toHaveBeenCalledOnce());
    await s.cancelForTask("task");
    expect((await pending).execution).toBe("failed");
    expect(a.execute).not.toHaveBeenCalled();
    expect(db.prepare("SELECT count(*) n FROM application_resource_locks").get()).toEqual({ n: 0 });
  });

  it("completes clear authorized work without a decision and preserves ordered attempts/events", async () => {
    const a = adapter();
    const s = service(a);
    const operation = await s.create(request());
    const complete = await s.execute(operation.id);
    expect(s.projection(complete).status).toBe("complete");
    expect(complete.decision).toBeUndefined();
    expect(a.execute).toHaveBeenCalledTimes(1);
    expect(await repository.attempts(operation.id)).toMatchObject([
      { phase: "execute", status: "completed" },
      { phase: "verify", status: "completed" },
    ]);
    expect((await repository.events(operation.id)).map((e) => e.kind)).toEqual([
      "created",
      "dispatch.requested",
      "execute.started",
      "execute.completed",
      "verify.started",
      "verify.completed",
    ]);
    await s.execute(operation.id);
    expect(a.execute).toHaveBeenCalledTimes(1);
  });
  it("refreshes a settled partial result from fresh domain evidence without repeating its effect", async () => {
    const partial = { ...result(), unmetCriteria: ["Export is missing"] };
    let exported = false;
    const a = adapter({
      execute: vi.fn(async () => ({ status: "completed" as const, result: partial })),
      verify: vi.fn(async () => ({
        status: "verified" as const,
        summary: "Authoritative output readback",
        checkedAt: now,
        evidence: [{ source: "fixture:output", claim: "Fresh readback" }],
        result: exported ? result("Export is present") : partial,
      })),
    });
    const s = service(a);
    const op = await s.create(request());
    expect(s.projection(await s.execute(op.id)).status).toBe("partial");
    exported = true;
    now += 10;
    const refreshed = await s.reconcile(op.id);
    expect(s.projection(refreshed).status).toBe("complete");
    expect(refreshed.result?.summary).toBe("Export is present");
    expect(a.execute).toHaveBeenCalledTimes(1);
    expect(a.verify).toHaveBeenCalledTimes(2);
    expect(
      (await repository.attempts(op.id)).filter((attempt) => attempt.phase === "execute"),
    ).toHaveLength(1);
  });
  it("rejects stale refreshed evidence without replacing the known business result", async () => {
    const a = adapter();
    const s = service(a);
    const op = await s.create(request());
    await s.execute(op.id);
    a.verify = vi.fn(async () => ({
      status: "verified" as const,
      summary: "Stale output",
      checkedAt: now + 1,
      result: result("Unproven replacement"),
      evidence: [{ source: "fixture:record", claim: "Future evidence" }],
    }));
    // The catalog binds host implementations at registration; update the verifier's mock itself.
    const original = service(adapter({ verify: a.verify }));
    const refreshed = await original.reconcile(op.id);
    expect(refreshed.execution).toBe("completed");
    expect(refreshed.verification).toBe("unavailable");
    expect(refreshed.result?.summary).toBe("Verified change");
  });
  it("deduplicates admission but rejects an idempotency key with different inputs", async () => {
    const s = service();
    const original = await s.create(request());
    expect((await s.create(request())).id).toBe(original.id);
    await expect(s.create(request({ input: { value: 8 } }))).rejects.toThrow(
      "different application request",
    );
  });
  it("refuses forged task/session/workspace ownership and cross-task dependencies", async () => {
    const s = service();
    await expect(s.create(request({ sessionId: "session2" }))).rejects.toThrow("bound WorkSession");
    const other = await s.create(
      request({ taskId: "task2", sessionId: "session2", idempotencyKey: "other" }),
    );
    await expect(s.create(request({ dependsOn: [other.id] }))).rejects.toThrow(
      "same task and session",
    );
  });
  it("persists concrete feedback, rejects stale bindings, and dispatches once after restart and duplicate answers", async () => {
    const a = adapter({
      route: route({ supports: { ...route().supports, prepare: true } }),
      prepare: async () => ({
        kind: "preview",
        summary: "A cheap preview of the proposed output",
        references: ["fixture:preview"],
        expiresAt: now + 5_000,
      }),
    });
    const original = service(a);
    const op = await original.create(
      request({
        decision: {
          reason: "Expensive output",
          question: "Use this preview for the final output?",
        },
      }),
    );
    const paused = await original.execute(op.id);
    expect(original.projection(paused).status).toBe("needs_decision");
    expect(a.execute).not.toHaveBeenCalled();
    await expect(
      original.decide({
        operationId: op.id,
        decisionId: paused.decision!.id,
        binding: "wrong",
        resolutionKey: "answer",
        status: "accepted",
      }),
    ).rejects.toThrow("Stale application decision");
    await original.stop();
    const resumed = service(a);
    const answer = {
      operationId: op.id,
      decisionId: paused.decision!.id,
      binding: paused.decision!.binding,
      resolutionKey: "answer",
      status: "accepted" as const,
    };
    await resumed.decide(answer);
    await resumed.decide(answer);
    await Promise.all([resumed.execute(op.id), resumed.execute(op.id)]);
    expect(a.execute).toHaveBeenCalledTimes(1);
    expect((await resumed.get(op.id)).verification).toBe("verified");
  });
  it("expires accepted previews and leaves revisions unexecuted", async () => {
    const a = adapter({
      route: route({ supports: { ...route().supports, prepare: true } }),
      prepare: async () => ({
        kind: "summary",
        summary: "Proposed change",
        references: [],
        expiresAt: now + 100,
      }),
    });
    const s = service(a);
    const op = await s.create(request({ decision: { reason: "Choice", question: "Continue?" } }));
    const prepared = await s.prepare(op.id);
    now += 200;
    const expired = await s.decide({
      operationId: op.id,
      decisionId: prepared.decision!.id,
      binding: prepared.decision!.binding,
      resolutionKey: "late",
      status: "accepted",
    });
    expect(expired.decision?.status).toBe("expired");
    await s.execute(op.id);
    expect(a.execute).not.toHaveBeenCalled();
  });
  it("cancels an unsubmitted proposal without performing a remote action", async () => {
    const a = adapter();
    const s = service(a);
    const op = await s.create(request());
    const cancelled = await s.cancel(op.id);
    await s.execute(op.id);
    expect(cancelled).toMatchObject({ execution: "cancelled", cancellation: "confirmed" });
    expect(a.execute).not.toHaveBeenCalled();
  });
  it("enforces locality, background requirements, and explicit route selection", async () => {
    const s = service();
    await expect(s.create(request({ constraints: { localOnly: true } }))).rejects.toThrow(
      "No eligible",
    );
    s.catalog.register(
      adapter({ route: route({ id: "fixture.browser", protocol: "native", control: "browser" }) }),
    );
    await expect(s.create(request())).rejects.toThrow("explicit eligible");
    expect((await s.create(request({ routeId: "fixture.api" }))).route.control).toBe("structured");
  });
  it("rejects a write route falsely advertised as replayable read-only work", () => {
    const catalog = new ApplicationAdapterCatalog();
    expect(() => catalog.register(adapter({ route: route({ replay: "read_only" }) }))).toThrow(
      "Read replay",
    );
  });
  it("prevents dispatch when the original adapter version changes", async () => {
    const original = service();
    const op = await original.create(request());
    await original.stop();
    const changed = adapter({ route: route({ adapterVersion: "2" }) });
    const restarted = service(changed);
    await expect(restarted.execute(op.id)).rejects.toThrow("original application adapter");
    expect(changed.execute).not.toHaveBeenCalled();
  });
  it("requires fresh positive domain evidence rather than treating a tool result as completion", async () => {
    const s = service(
      adapter({
        route: route({ supports: { ...route().supports, verify: false } }),
        verify: undefined,
      }),
    );
    const op = await s.create(request());
    expect(s.projection(await s.execute(op.id)).status).toBe("unverified");
    const bad = service(
      adapter({
        route: route({ id: "no-evidence" }),
        verify: async () => ({ status: "verified", summary: "OK", checkedAt: now, evidence: [] }),
      }),
    );
    const other = await bad.create(request({ idempotencyKey: "other", routeId: "no-evidence" }));
    expect(bad.projection(await bad.execute(other.id)).status).toBe("unverified");
  });
  it("returns contradictions, partial effects, and stale evidence without upgrading them to success", async () => {
    const a = adapter({
      verify: async () => ({
        status: "contradicted",
        summary: "Unexpected field value",
        checkedAt: now,
        evidence: [{ source: "fixture:record", claim: "Field has a different value" }],
      }),
    });
    const s = service(a);
    const op = await s.create(request());
    expect(s.projection(await s.execute(op.id)).status).toBe("partial");
    const fresh = service(
      adapter({
        route: route({ id: "fresh" }),
        verify: async () => ({
          status: "verified",
          summary: "Checked",
          checkedAt: now,
          expiresAt: now + 10,
          evidence: [{ source: "fixture:record", claim: "Field matches" }],
        }),
      }),
    );
    const other = await fresh.create(request({ idempotencyKey: "fresh", routeId: "fresh" }));
    const complete = await fresh.execute(other.id);
    now += 20;
    expect(fresh.projection(complete).status).toBe("unverified");
  });
  it("blocks dependent work until the prior operation is verified and preserves partial cross-app outcomes", async () => {
    const a = adapter();
    const s = service(a);
    const first = await s.create(request());
    const second = await s.create(request({ idempotencyKey: "second", dependsOn: [first.id] }));
    expect((await s.execute(second.id)).execution).toBe("planned");
    await s.execute(first.id);
    a.execute = vi.fn(async () => ({
      status: "failed",
      summary: "Second app rejected the change",
    }));
    const failedService = service(a);
    await failedService.execute(second.id);
    expect(
      (await repository.list("task")).map((op) => projectApplicationOperation(op, now).status),
    ).toEqual(expect.arrayContaining(["complete", "failed"]));
  });
  it("never persists secrets or silently truncates executable inputs", async () => {
    const s = service();
    await expect(s.create(request({ input: { password: "hidden" } }))).rejects.toThrow(
      "connection handles",
    );
    await expect(s.create(request({ input: { text: "a".repeat(20_000) } }))).rejects.toThrow(
      "bounded",
    );
    expect(await repository.list("task")).toHaveLength(0);
  });
  it("redacts output credentials before journal persistence", async () => {
    const s = service(
      adapter({
        execute: async () => ({
          status: "completed",
          result: { ...result(), data: { password: "hidden" } },
        }),
      }),
    );
    const op = await s.create(request());
    await s.execute(op.id);
    expect((await s.get(op.id)).result?.data?.password).toBe("[redacted]");
    expect(
      (db.prepare("SELECT data FROM application_operations").get() as { data: string }).data,
    ).not.toContain("hidden");
  });
  it("redacts native tool output before flattening it into a durable legacy result", async () => {
    const gateway = new ApplicationTaskToolGateway();
    gateway.bind("task", {
      call: async () => ({
        password: "hidden-password",
        nested: { authorization: "hidden-header" },
      }),
    });
    const daemon = {
      getDatabase: () => db,
      logEvent: vi.fn(),
      resumeAfterApplicationOperations: vi.fn().mockResolvedValue(undefined),
      getWorkSessionContractService: () => ({
        beginWait: vi.fn(),
        resolveWait: vi.fn(),
        recordEvidence: vi.fn(),
      }),
    } as unknown as AgentDaemon;
    const s = createDaemonApplicationExecution(daemon, gateway);
    services.push(s);
    const op = await s.create(
      request({ capability: "cowork.tool", input: { name: "fixture.read", arguments: {} } }),
    );
    await s.execute(op.id);
    expect((await s.get(op.id)).result?.data?.output).not.toContain("hidden");
    expect((await s.get(op.id)).result?.data?.output).toContain("[redacted]");
  });
  it("enforces cost estimates, attempt limits, deadlines, and permission denial without a side effect", async () => {
    const a = adapter();
    const s = service(a);
    const unknownCost = await s.create(request({ constraints: { maxCost: 5, currency: "USD" } }));
    expect(await s.execute(unknownCost.id)).toMatchObject({
      execution: "failed",
      error: expect.stringContaining("cost is unknown"),
    });
    const deadline = await s.create(
      request({ idempotencyKey: "deadline", constraints: { deadlineAt: now + 10 } }),
    );
    now += 11;
    expect(await s.execute(deadline.id)).toMatchObject({
      execution: "failed",
      error: expect.stringContaining("deadline exceeded"),
    });
    expect(a.execute).not.toHaveBeenCalled();
    const denied = service(
      adapter({
        route: route({ id: "denied" }),
        execute: async (context) => {
          await context.tools.call("change", {}, context);
          return { status: "completed", result: result() };
        },
      }),
      {
        call: vi.fn(async () => {
          throw new ApplicationNotDispatchedError("Permission denied at the existing gateway");
        }),
      },
    );
    const op = await denied.create(request({ idempotencyKey: "denied", routeId: "denied" }));
    expect(await denied.execute(op.id)).toMatchObject({
      execution: "failed",
      error: expect.stringContaining("Permission denied"),
    });
  });
  it("holds a shared resource while an effect is unknown and dispatches queued work after reconciliation", async () => {
    const a = adapter({
      execute: vi.fn(async () => {
        throw new Error("Lost reply");
      }),
    });
    const s = service(a);
    const first = await s.create(request());
    await s.execute(first.id);
    const second = await s.create(
      request({ idempotencyKey: "second", taskId: "task2", sessionId: "session2" }),
    );
    await s.execute(second.id);
    expect(a.execute).toHaveBeenCalledTimes(1);
    await s.reconcile(first.id);
    await s.runWorkerOnce();
    expect(a.execute).toHaveBeenCalledTimes(2);
  });
  it("fences expired workers and keeps unknown dispatches in the journal without replay", async () => {
    const s = service();
    const op = await s.create(request());
    const first = await repository.claim(op.id, "execute", "worker-a", now, 1_000);
    now += 1_001;
    await repository.recoverExpired(now);
    expect((await repository.get(op.id))?.execution).toBe("unknown");
    expect(await repository.claim(op.id, "execute", "worker-b", now, 1_000)).toBeUndefined();
    const second = await repository.claim(op.id, "observe", "worker-b", now, 1_000);
    await repository.finish(
      second!,
      { execution: "completed", result: result("Current authoritative result") },
      now,
    );
    expect(
      await repository.finish(
        first!,
        { execution: "completed", result: result("Stale worker output") },
        now,
      ),
    ).toBeUndefined();
    expect((await s.get(op.id)).result?.summary).toBe("Current authoritative result");
    expect((await repository.attempts(op.id))[0].status).toBe("unknown");
  });
  it("makes a retry eligible only after original-route observation proves no effect and replay is supported", async () => {
    const a = adapter({
      route: route({ replay: "remote_idempotency" }),
      execute: vi.fn(async () => {
        throw new Error("Lost reply");
      }),
      observe: async () => ({
        status: "not_applied",
        summary: "Authoritative idempotency lookup confirms absence",
      }),
    });
    const s = service(a);
    const op = await s.create(request({ constraints: { maxAttempts: 2 } }));
    await s.execute(op.id);
    await s.execute(op.id);
    expect(a.execute).toHaveBeenCalledTimes(1);
    expect((await s.reconcile(op.id)).execution).toBe("planned");
    await s.execute(op.id);
    expect(a.execute).toHaveBeenCalledTimes(2);
    expect((await s.reconcile(op.id)).execution).toBe("failed");
  });
  it("retains external job identity and completes polling after a database reopen", async () => {
    let done = false;
    const a = adapter({
      execute: async () => ({ status: "running", externalId: "job-17", pollAfterMs: 1_000 }),
      observe: async (context) => {
        expect(context.operation.externalId).toBe("job-17");
        return done
          ? { status: "completed", result: result() }
          : { status: "running", externalId: "job-17" };
      },
    });
    const s = service(a);
    const op = await s.create(request());
    expect((await s.execute(op.id)).execution).toBe("running");
    await s.stop();
    db.close();
    db = new Database(path.join(directory, "profile.db"));
    repository = new ApplicationOperationRepository(db);
    const restarted = service(a);
    done = true;
    now += 2_000;
    await restarted.runWorkerOnce();
    expect(restarted.projection(await restarted.get(op.id)).status).toBe("complete");
    expect(await repository.attempts(op.id)).toMatchObject([
      { phase: "execute" },
      { phase: "observe" },
      { phase: "verify" },
    ]);
  });
  it("handles cooperative cancellation without pretending it undoes completed effects", async () => {
    const a = adapter({
      route: route({ supports: { ...route().supports, cancel: true } }),
      execute: async () => ({ status: "running", externalId: "job" }),
      cancel: async () => ({ confirmed: true, summary: "No further job work will run" }),
    });
    const s = service(a);
    const op = await s.create(request());
    await s.execute(op.id);
    expect(await s.cancel(op.id)).toMatchObject({
      execution: "cancelled",
      cancellation: "confirmed",
    });
    const complete = service();
    const other = await complete.create(request({ idempotencyKey: "completed" }));
    await complete.execute(other.id);
    expect((await complete.cancel(other.id)).execution).toBe("completed");
  });
  it("persists cancellation arriving during dispatch and ignores no late completed effect", async () => {
    let resolve!: (value: { status: "completed"; result: ApplicationResult }) => void;
    const dispatched = Promise.withResolvers<void>();
    const a = adapter({
      execute: async () => {
        dispatched.resolve();
        return new Promise((r) => {
          resolve = r;
        });
      },
    });
    const s = service(a);
    const op = await s.create(request());
    const execution = s.execute(op.id);
    await dispatched.promise;
    expect((await s.cancel(op.id)).cancellation).toBe("unsupported");
    resolve({ status: "completed", result: result("Effect completed before cancellation") });
    expect(await execution).toMatchObject({ execution: "unknown", cancellation: "unsupported" });
  });
  it("recovers a real remote mutation after a dropped HTTP response without duplicate writes", async () => {
    let mutations = 0;
    const remote = new Map<string, { account: string; value: number }>();
    const server = http.createServer(async (req, res) => {
      const key = req.headers["idempotency-key"] as string;
      const account = req.headers["x-account"] as string;
      if (req.method === "POST") {
        for await (const _chunk of req) {
          /* drain request */
        }
        remote.set(key, { account, value: 7 });
        mutations++;
        req.socket.destroy();
        return; // The app committed, but the harness never receives a result.
      }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(remote.get(key) ?? null));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address() as { port: number };
    const url = `http://127.0.0.1:${address.port}`;
    const gateway: ApplicationToolGateway = {
      call: async (_name, input, context) => {
        const response = await fetch(url, {
          method: input.method as string,
          signal: context.signal,
          headers: {
            "Idempotency-Key": context.idempotencyKey,
            "X-Account": context.operation.request.resources[0].accountId!,
          },
        });
        return response.json();
      },
    };
    const a = adapter({
      execute: async (context) => {
        await context.tools.call("fixture.http", { method: "POST" }, context);
        return { status: "completed", result: result() };
      },
      observe: async (context) => {
        const record = (await context.tools.call("fixture.http", { method: "GET" }, context)) as {
          account: string;
          value: number;
        };
        expect(record).toEqual({ account: "account-a", value: 7 });
        return { status: "completed", result: { ...result(), data: record } };
      },
      verify: async (context) => {
        const record = (await context.tools.call("fixture.http", { method: "GET" }, context)) as {
          value: number;
        };
        return {
          status: record.value === 7 ? "verified" : "contradicted",
          summary: "Read back the original record/account",
          checkedAt: now,
          evidence: [
            { source: url, claim: "Expected value exists under the original operation identity" },
          ],
        };
      },
    });
    const s = service(a, gateway);
    const op = await s.create(request());
    expect((await s.execute(op.id)).execution).toBe("unknown");
    await s.stop();
    const restarted = service(a, gateway);
    expect(restarted.projection(await restarted.reconcile(op.id)).status).toBe("complete");
    await restarted.execute(op.id);
    expect(mutations).toBe(1);
  });
  it("preserves native files and non-file analysis results through the same lifecycle", async () => {
    const file = path.join(directory, "model.txt");
    fs.writeFileSync(file, "width=10");
    const localRoute = route({
      id: "fixture.file",
      protocol: "cli",
      control: "script",
      effect: "read",
      replay: "read_only",
      environment: {
        id: "local",
        kind: "local",
        locality: "local",
        isolated: false,
        background: true,
      },
    });
    const a = adapter({
      route: localRoute,
      execute: async () => ({
        status: "completed",
        result: {
          kind: "analysis",
          summary: fs.readFileSync(file, "utf8"),
          resources: [{ kind: "file", system: "local", identity: file, locator: file }],
          unmetCriteria: [],
        },
      }),
      verify: async (context) => ({
        status:
          fs.readFileSync(file, "utf8") === context.operation.result?.summary
            ? "verified"
            : "contradicted",
        summary: "Fresh file readback matches analysis",
        checkedAt: now,
        evidence: [{ source: file, claim: "Native source remains readable" }],
      }),
    });
    const s = service(a);
    const op = await s.create(
      request({
        routeId: localRoute.id,
        resources: [{ kind: "file", system: "local", identity: file }],
      }),
    );
    expect(s.projection(await s.execute(op.id))).toMatchObject({
      status: "complete",
      result: { kind: "analysis" },
    });
    expect(fs.readFileSync(file, "utf8")).toBe("width=10");
  });
  it("runs browser and desktop control adapters without making user observation a lifecycle dependency", async () => {
    for (const control of ["browser", "computer"] as const) {
      const a = adapter({
        route: route({
          id: `fixture.${control}`,
          protocol: "native",
          control,
          environment: {
            id: `isolated-${control}`,
            kind: control === "browser" ? "browser" : "desktop",
            locality: "remote",
            isolated: true,
            background: true,
          },
        }),
      });
      const s = service(a);
      const op = await s.create(
        request({
          idempotencyKey: control,
          routeId: a.route.id,
          constraints: { backgroundRequired: true },
          resources: [{ kind: "application_state", system: "fixture", identity: control }],
        }),
      );
      expect(s.projection(await s.execute(op.id)).status).toBe("complete");
    }
  });
  it("replaces a revised unsubmitted proposal without erasing past effects", async () => {
    const a = adapter();
    const s = service(a);
    const old = await s.create(request({ decision: { reason: "Choice", question: "Continue?" } }));
    const prepared = await s.prepare(old.id);
    await s.decide({
      operationId: old.id,
      decisionId: prepared.decision!.id,
      binding: prepared.decision!.binding,
      resolutionKey: "feedback",
      status: "revise",
      feedback: "Use value 8",
    });
    const next = await s.create(
      request({
        idempotencyKey: "revision",
        planRevision: 2,
        supersedes: old.id,
        input: { value: 8 },
      }),
    );
    expect(s.projection(await s.get(old.id)).status).toBe("superseded");
    expect(s.projection(await s.execute(next.id)).status).toBe("complete");
    await expect(
      s.create(request({ idempotencyKey: "erase", planRevision: 3, supersedes: next.id })),
    ).rejects.toThrow("unsubmitted proposal");
  });
  it("supersedes a proven stale no-dispatch phone attempt with a freshly approved revision", async () => {
    let stale = true;
    const a = adapter({
      route: route({ id: "phone.android.v1", capability: "phone.android.action" }),
      execute: async () => {
        if (stale)
          throw new ApplicationNotDispatchedError("stale_snapshot: phone changed; observe again");
        return { status: "completed", result: result() };
      },
    });
    const s = service(a);
    const input = {
      deviceId: "selected",
      snapshotId: "before",
      action: { kind: "type_text", text: "QA" },
      expected: { text: "QA" },
    };
    const old = await s.create(request({ capability: a.route.capability, input }));
    const failed = await s.execute(old.id);
    expect(failed).toMatchObject({ execution: "failed", notDispatched: true });
    stale = false;
    const next = await s.create(
      request({
        capability: a.route.capability,
        idempotencyKey: "fresh",
        planRevision: 2,
        supersedes: old.id,
        input: { ...input, snapshotId: "fresh" },
      }),
    );
    expect(s.projection(await s.get(old.id)).status).toBe("superseded");
    expect((await s.get(old.id)).error).toContain("stale_snapshot");
    expect(next.execution).toBe("planned");
    expect(s.projection(await s.execute(next.id)).status).toBe("complete");
  });
  it.each([
    "unknown",
    "completed",
    "not_stale",
    "legacy_no_proof",
    "other_device",
    "other_action",
    "other_criteria",
    "same_snapshot",
    "same_revision",
  ])("never supersedes unsafe or mismatched phone recovery: %s", async (caseName) => {
    const a = adapter({
      route: route({ id: "phone.android.v1", capability: "phone.android.action" }),
      execute: async () => {
        if (caseName === "unknown") throw new Error("Lost reply");
        if (caseName === "completed") return { status: "completed", result: result() };
        throw new ApplicationNotDispatchedError(
          caseName === "not_stale" ? "Approval denied" : "stale_snapshot: phone changed",
        );
      },
    });
    const s = service(a);
    const input = {
      deviceId: "selected",
      snapshotId: "before",
      action: { kind: "type_text", text: "QA" },
      expected: { text: "QA" },
    };
    const old = await s.create(request({ capability: a.route.capability, input }));
    await s.execute(old.id);
    if (caseName === "legacy_no_proof") {
      const stored = await s.get(old.id);
      delete stored.notDispatched;
      db.prepare("UPDATE application_operations SET data = ? WHERE id = ?").run(
        JSON.stringify(stored),
        old.id,
      );
    }
    const nextInput = {
      ...input,
      snapshotId: caseName === "same_snapshot" ? "before" : "fresh",
      ...(caseName === "other_device" ? { deviceId: "other" } : {}),
      ...(caseName === "other_action" ? { action: { kind: "type_text", text: "different" } } : {}),
      ...(caseName === "other_criteria" ? { expected: { text: "different" } } : {}),
    };
    await expect(
      s.create(
        request({
          capability: a.route.capability,
          idempotencyKey: "fresh",
          planRevision: caseName === "same_revision" ? 1 : 2,
          supersedes: old.id,
          input: nextInput,
        }),
      ),
    ).rejects.toThrow("superseded");
    expect((await s.get(old.id)).supersededBy).toBeUndefined();
  });
  it("requires an operator's exact unknown revision for manual recovery and retains unavailable verification", async () => {
    const s = service(
      adapter({
        execute: async () => {
          throw new Error("Lost reply");
        },
      }),
    );
    const op = await s.create(request());
    const unknown = await s.execute(op.id);
    const resolution = {
      operationId: op.id,
      expectedRevision: unknown.revision,
      resolutionKey: "human-observation",
      status: "applied" as const,
      summary: "I checked the original account and record; the field changed",
    };
    await expect(s.resolveUnknown({ ...resolution, expectedRevision: 1 })).rejects.toThrow(
      "displayed unknown",
    );
    const resolved = await s.resolveUnknown(resolution);
    await s.resolveUnknown(resolution);
    expect(s.projection(resolved).status).toBe("unverified");
    await expect(s.assertToolDispatch("task", false)).resolves.toBeUndefined();
    await expect(s.resolveUnknown({ ...resolution, summary: "different" })).rejects.toThrow(
      "different content",
    );
  });
  it("keeps an unclassified workspace effect from being bypassed through another route with omitted resources", async () => {
    const a = adapter({
      route: route({ effect: "unknown" }),
      execute: vi.fn(async () => {
        throw new Error("Unknown effect");
      }),
    });
    const s = service(a);
    const op = await s.create(request());
    await s.execute(op.id);
    s.catalog.register(adapter({ route: route({ id: "other", control: "browser" }) }));
    const second = await s.create(
      request({ idempotencyKey: "bypass", routeId: "other", resources: [] }),
    );
    expect((await s.execute(second.id)).execution).toBe("planned");
    expect(a.execute).toHaveBeenCalledTimes(1);
  });
  it("drains shutdown, preserves uncertain effects, and ignores a response delivered after interruption", async () => {
    const started = Promise.withResolvers<void>();
    const late = Promise.withResolvers<{ status: "completed"; result: ApplicationResult }>();
    const s = service(
      adapter({
        execute: async () => {
          started.resolve();
          return late.promise;
        },
      }),
    );
    const op = await s.create(request());
    const executing = s.execute(op.id);
    await started.promise;
    await s.stop();
    expect((await executing).execution).toBe("unknown");
    late.resolve({ status: "completed", result: result("Late response") });
    await late.promise;
    expect((await s.get(op.id)).execution).toBe("unknown");
  });
  it("propagates task cancellation to queued work and live jobs without dispatching another operation", async () => {
    const a = adapter({
      route: route({ supports: { ...route().supports, cancel: true } }),
      execute: vi.fn(async () => ({ status: "running" as const, externalId: "job" })),
      cancel: vi.fn(async () => ({ confirmed: true, summary: "Job stopped" })),
    });
    const s = service(a);
    const first = await s.create(request());
    await s.execute(first.id);
    const queued = await s.create(request({ idempotencyKey: "queued" }));
    await s.cancelForTask("task");
    expect((await s.get(queued.id)).execution).toBe("cancelled");
    expect((await s.get(first.id)).cancellation).toBe("requested");
    await expect(s.create(request({ idempotencyKey: "after-stop" }))).rejects.toThrow(
      "task was cancelled",
    );
    await s.runWorkerOnce();
    expect((await s.get(first.id)).cancellation).toBe("confirmed");
    expect(a.execute).toHaveBeenCalledTimes(1);
    s.resetTaskCancellation("task");
    expect((await s.create(request({ idempotencyKey: "new-turn" }))).execution).toBe("planned");
  });
  it("rejects new operations for a persisted cancelled task after a process restart", async () => {
    db.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = 'task'").run();
    await expect(service().create(request())).rejects.toThrow("terminal task");
  });
  it("blocks a direct mutation after an unknown effect, while allowing readback and fenced host attempts", async () => {
    const s = service(
      adapter({
        execute: async () => {
          throw new Error("Lost response");
        },
      }),
    );
    const op = await s.create(request());
    await s.execute(op.id);
    await expect(s.assertToolDispatch("task", false)).rejects.toThrow("Reconcile pending");
    await expect(s.assertToolDispatch("task", true)).resolves.toBeUndefined();
    const claim = await repository.claim(op.id, "observe", "observer", now, 1_000);
    const observation = {
      operationId: op.id,
      attemptId: claim!.attempt.id,
      generation: claim!.generation,
      phase: "observe" as const,
    };
    await expect(s.assertToolDispatch("task", false, observation)).rejects.toThrow(
      "read-only observation",
    );
    await expect(
      s.assertToolDispatch("task", false, { ...observation, phase: "execute" }),
    ).rejects.toThrow("stale");
    await repository.finish(claim!, { execution: "completed", result: result() }, now);
    const next = await s.create(request({ idempotencyKey: "next" }));
    const execute = await repository.claim(next.id, "execute", "executor", now, 1_000);
    await expect(
      s.assertToolDispatch("task", false, {
        operationId: next.id,
        attemptId: execute!.attempt.id,
        generation: execute!.generation,
        phase: "execute",
      }),
    ).resolves.toBeUndefined();
  });
  it("reconciles a lost cancellation response without issuing cancellation twice", async () => {
    const cancel = vi.fn(async () => {
      throw new Error("Cancellation response lost after remote acceptance");
    });
    const a = adapter({
      route: route({ supports: { ...route().supports, cancel: true } }),
      execute: async () => ({ status: "running", externalId: "job" }),
      cancel,
      observe: async () => ({
        status: "cancelled",
        summary: "Original job is authoritatively cancelled",
      }),
    });
    const s = service(a);
    const op = await s.create(request());
    await s.execute(op.id);
    expect(await s.cancel(op.id)).toMatchObject({ execution: "unknown", pendingAction: "cancel" });
    now += 2_000;
    await s.runWorkerOnce();
    expect(await s.get(op.id)).toMatchObject({ execution: "cancelled", cancellation: "confirmed" });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("recovers a lost preparation separately from executing the final business action", async () => {
    const a = adapter({
      route: route({ supports: { ...route().supports, prepare: true } }),
      prepare: async () => {
        throw new Error("Draft reply lost");
      },
      observe: async () => ({
        status: "prepared",
        prepared: { kind: "summary", summary: "Recovered remote draft", references: [] },
      }),
    });
    const s = service(a);
    const op = await s.create(
      request({ decision: { reason: "Draft", question: "Apply this draft?" } }),
    );
    expect((await s.execute(op.id)).pendingAction).toBe("prepare");
    const recovered = await s.reconcile(op.id);
    expect(recovered).toMatchObject({ execution: "prepared", decision: { status: "pending" } });
    expect(a.execute).not.toHaveBeenCalled();
  });
  it("stops automatic observations when the polling budget is exhausted", async () => {
    const a = adapter({
      execute: async () => ({ status: "running", externalId: "job" }),
      observe: vi.fn(async () => ({
        status: "running" as const,
        externalId: "job",
        pollAfterMs: 1_000,
      })),
    });
    const s = service(a);
    const op = await s.create(request({ constraints: { maxPolls: 1 } }));
    await s.execute(op.id);
    now += 2_000;
    await s.runWorkerOnce();
    now += 2_000;
    await s.runWorkerOnce();
    now += 2_000;
    await s.runWorkerOnce();
    expect(await s.get(op.id)).toMatchObject({
      execution: "unknown",
      error: expect.stringContaining("observation budget"),
    });
    expect(a.observe).toHaveBeenCalledTimes(1);
  });
  it("binds existing input UI responses to the exact persisted proposal and preserves duplicate-response recovery", async () => {
    const s = service();
    const op = await s.create(request({ decision: { reason: "Choice", question: "Continue?" } }));
    const prepared = await s.prepare(op.id);
    const decision = prepared.decision!;
    const questionId = `${APPLICATION_DECISION_PREFIX}${op.id}_${decision.id}_${decision.binding}`;
    const inputRequest: InputRequest = {
      id: "input-1",
      taskId: "task",
      status: "pending",
      requestedAt: now,
      questions: [{ id: questionId, header: "Review", question: "Continue?", options: [] }],
    };
    const response = {
      requestId: inputRequest.id,
      status: "submitted" as const,
      answers: { [questionId]: { optionLabel: "Continue" } },
    };
    await resolveApplicationInput(s, inputRequest, response);
    await resolveApplicationInput(s, inputRequest, response);
    expect((await s.get(op.id)).decision?.status).toBe("accepted");
    await expect(
      resolveApplicationInput(
        s,
        {
          ...inputRequest,
          questions: [
            {
              ...inputRequest.questions[0],
              id: `${APPLICATION_DECISION_PREFIX}${op.id}_${decision.id}_wrong`,
            },
          ],
        },
        response,
      ),
    ).rejects.toThrow("decision revision mismatch");
  });
  it("exposes the same bounded lifecycle to operators while read clients cannot mutate or resolve decisions", async () => {
    const s = service();
    const methods = new Map<string, (client: unknown, params?: unknown) => Promise<unknown>>();
    const daemon = {
      getApplicationExecutionService: () => s,
      getTask: () => ({ id: "task", workspaceId: "workspace" }),
      getWorkSessionContractService: () => ({
        ensureForTask: () => ({ session: { id: "session" } }),
      }),
    } as unknown as AgentDaemon;
    registerApplicationExecutionMethods({
      agentDaemon: daemon,
      server: {
        registerMethod: (
          name: string,
          handler: (client: unknown, params?: unknown) => Promise<unknown>,
        ) => methods.set(name, handler),
      } as unknown as ControlPlaneServer,
      requireScope: (client, scope) => {
        if (!(client as string[]).includes(scope))
          throw { code: ErrorCodes.UNAUTHORIZED, message: "Scope denied" };
      },
    });
    await expect(
      methods.get(Methods.APPLICATION_OPERATION_CREATE)!(["read"], {
        taskId: "task",
        request: request(),
      }),
    ).rejects.toMatchObject({ message: "Scope denied" });
    const created = (await methods.get(Methods.APPLICATION_OPERATION_CREATE)!(["operator"], {
      taskId: "task",
      request: request(),
    })) as { operationId: string };
    await methods.get(Methods.APPLICATION_OPERATION_EXECUTE)!(["operator"], {
      operationId: created.operationId,
    });
    expect(
      await methods.get(Methods.APPLICATION_OPERATION_GET)!(["read"], {
        operationId: created.operationId,
      }),
    ).toMatchObject({ projection: { status: "complete" } });
    await expect(
      methods.get(Methods.APPLICATION_DECISION_RESOLVE)!(["read"], {}),
    ).rejects.toMatchObject({ message: "Scope denied" });
    await expect(
      methods.get(Methods.APPLICATION_OPERATION_GET)!(["read"], { operationId: "x", bypass: true }),
    ).rejects.toMatchObject({ code: ErrorCodes.INVALID_PARAMS });
  });
  it("upgrades an existing profile additively and runs identical units through a real database worker", async () => {
    db.exec(APPLICATION_EXECUTION_SCHEMA); // Reopening the migration never loses old profile rows.
    expect(db.prepare("SELECT id FROM tasks ORDER BY id").all()).toEqual([
      { id: "task" },
      { id: "task2" },
    ]);
    const buildDirectory = path.resolve("node_modules/.cache/cowork-application-worker-test");
    fs.mkdirSync(buildDirectory, { recursive: true });
    const workerPath = path.join(buildDirectory, `worker-${process.pid}.cjs`);
    buildSync({
      entryPoints: [path.resolve("src/electron/database/async/database-worker.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node24",
      outfile: workerPath,
      external: ["better-sqlite3"],
      logLevel: "silent",
    });
    try {
      const client = await DatabaseClient.start({
        dbPath: db.name,
        workerPath,
        requiredTables: ["application_operations", "application_operation_attempts"],
      });
      clients.push(client);
      setStatementClient("services", db.name, client);
      const s = service();
      const op = await s.create(request());
      expect(s.projection(await s.execute(op.id)).status).toBe("complete");
      expect((await repository.events(op.id)).map((e) => e.kind)).toContain("verify.completed");
    } finally {
      fs.rmSync(workerPath, { force: true });
    }
  }, 30_000);
});
