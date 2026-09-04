import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseManager } from "../schema";
import { TaskRepository } from "../repositories";
import { WorkSessionContractRepository } from "../WorkSessionContractRepository";
import { WorkSessionProtocolRepository } from "../WorkSessionProtocolRepository";

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

describeWithSqlite("WorkSessionContractRepository", () => {
  let tempDir: string;
  let previousUserDataDir: string | undefined;
  let manager: DatabaseManager;
  let db: Database.Database;
  let taskRepo: TaskRepository;
  let protocol: WorkSessionProtocolRepository;
  let repository: WorkSessionContractRepository;
  let now: number;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-work-session-contract-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tempDir;
    manager = new DatabaseManager();
    db = manager.getDatabase();
    taskRepo = new TaskRepository(db);
    protocol = new WorkSessionProtocolRepository(db);
    now = Date.now();
    repository = new WorkSessionContractRepository(db, { now: () => now });
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

  function createTask(overrides: Record<string, unknown> = {}) {
    return taskRepo.create({
      title: "Contract task",
      prompt: "Produce a verified output",
      status: "executing",
      workspaceId: "workspace-1",
      source: "manual",
      ...overrides,
    } as Parameters<TaskRepository["create"]>[0]);
  }

  function createSession(taskId: string, sessionId = `session:${taskId}`) {
    const task = taskRepo.findById(taskId)!;
    return protocol.ensureForTask({
      taskId,
      workspaceId: task.workspaceId,
      sessionId,
      status: "executing",
    }).session;
  }

  it("creates idempotent outcome contracts and reports a deterministic aggregate checksum", () => {
    const task = createTask({
      successCriteria: { type: "file_exists", filePaths: ["dist/report.pdf"] },
    });
    const session = createSession(task.id);
    const first = repository.createOutcomeContract({
      sessionId: session.id,
      taskId: task.id,
      objective: "Ship the report",
      requirements: [
        {
          kind: "output",
          description: "Report exists",
          verifier: "file_exists",
        },
      ],
      source: "test",
      idempotencyKey: "contract:task-1",
    });
    const retry = repository.createOutcomeContract({
      sessionId: session.id,
      taskId: task.id,
      objective: "Different retry payload",
      idempotencyKey: "contract:task-1",
    });

    expect(retry).toEqual(first);
    expect(first.requirements[0]).toMatchObject({
      kind: "output",
      required: true,
      status: "pending",
    });
    const updated = repository.updateOutcomeContract(first.id, {
      status: "satisfied",
      summary: "Verified",
      requirements: first.requirements.map((requirement) => ({
        ...requirement,
        status: "satisfied" as const,
      })),
      satisfiedAt: now,
    });
    expect(updated.status).toBe("satisfied");
    expect(updated.satisfiedAt).toBe(now);

    const aggregate = repository.getContractAggregate(session.id);
    expect(aggregate.contract?.status).toBe("satisfied");
    expect(aggregate.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(aggregate.checksum).toBe(repository.getContractAggregate(session.id).checksum);
  });

  it("redacts constraint/evidence metadata and marks expired evidence stale", () => {
    const task = createTask();
    const session = createSession(task.id);
    const constraint = repository.appendConstraint({
      sessionId: session.id,
      kind: "constraint",
      key: "no-secrets",
      statement: "Never persist credentials",
      metadata: { token: "hidden", nested: { authorization: "Bearer hidden" } },
      idempotencyKey: "constraint:1",
    });
    const evidence = repository.appendEvidence({
      sessionId: session.id,
      claim: "The command passed",
      sourceType: "task_event",
      sourceRef: "task-event:1",
      snippet: "PASS",
      freshnessExpiresAt: now - 1,
      confidence: 2,
      idempotencyKey: "evidence:1",
    });

    expect(constraint.metadata).toMatchObject({
      token: "[redacted]",
      nested: { authorization: "[redacted]" },
    });
    expect(evidence.status).toBe("stale");
    expect(evidence.confidence).toBe(1);
    const ledger = repository.getConstraintLedger(session.id);
    const manifest = repository.getEvidenceManifest(session.id);
    expect(ledger.entries).toHaveLength(1);
    expect(manifest.entries).toHaveLength(1);
    expect(ledger.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.checksum).toMatch(/^[a-f0-9]{64}$/);
  });

  it("creates artifact revisions with monotonic versions, supersession, and retry idempotency", () => {
    const task = createTask();
    const session = createSession(task.id);
    const first = repository.createArtifactRevision({
      sessionId: session.id,
      taskId: task.id,
      path: "dist/report.txt",
      mimeType: "text/plain",
      sha256: "a".repeat(64),
      size: 10,
      idempotencyKey: "artifact-event:1",
    });
    const retry = repository.createArtifactRevision({
      sessionId: session.id,
      taskId: task.id,
      path: "dist/report.txt",
      mimeType: "text/plain",
      sha256: "changed".padEnd(64, "b"),
      idempotencyKey: "artifact-event:1",
    });
    const second = repository.createArtifactRevision({
      sessionId: session.id,
      taskId: task.id,
      path: "dist/report.txt",
      mimeType: "text/plain",
      sha256: "b".repeat(64),
      size: 20,
    });

    expect(retry).toEqual(first);
    expect(second.revision).toBe(2);
    expect(second.parentRevisionId).toBe(first.id);
    expect(
      repository
        .listArtifactRevisions(session.id, { path: "dist/report.txt" })
        .map((item) => item.status),
    ).toEqual(["superseded", "committed"]);
    expect(repository.findLatestArtifactRevision(session.id, "dist/report.txt")?.id).toBe(
      second.id,
    );
  });

  it("deduplicates wait states, resolves them, and expires outstanding requests", () => {
    const task = createTask();
    const session = createSession(task.id);
    const approval = repository.createWaitState({
      sessionId: session.id,
      taskId: task.id,
      kind: "approval",
      requestId: "approval-1",
      reason: "Approve the publish",
      payload: { apiToken: "hidden" },
      expiresAt: now + 10_000,
    });
    const retry = repository.createWaitState({
      sessionId: session.id,
      taskId: task.id,
      kind: "approval",
      requestId: "approval-1",
      reason: "Changed retry",
    });
    const expiring = repository.createWaitState({
      sessionId: session.id,
      taskId: task.id,
      kind: "external",
      reason: "Provider callback",
      expiresAt: now + 1,
    });

    expect(retry).toEqual(approval);
    expect(approval.payload).toMatchObject({ apiToken: "[redacted]" });
    expect(repository.resolveWaitState(approval.id, "resolved", { approved: true }).status).toBe(
      "resolved",
    );
    now += 2;
    expect(repository.expireWaitStates()).toBe(1);
    expect(
      repository.listWaitStates(session.id).find((wait) => wait.id === expiring.id)?.status,
    ).toBe("expired");
  });

  it("keeps child sessions isolated and aggregates complete, partial, and failed outcomes", () => {
    const parent = createTask();
    const firstChild = createTask({
      parentTaskId: parent.id,
      agentType: "sub",
      sessionId: parent.id,
    });
    const secondChild = createTask({
      parentTaskId: parent.id,
      agentType: "sub",
      sessionId: parent.id,
    });
    const parentSession = createSession(parent.id, "parent-session");
    const firstSession = createSession(firstChild.id, "child-session-1");
    const secondSession = createSession(secondChild.id, "child-session-2");

    const firstLink = repository.linkChildSession({
      parentSessionId: parentSession.id,
      childSessionId: firstSession.id,
      parentTaskId: parent.id,
      childTaskId: firstChild.id,
      owner: "worker-a",
      inheritedPolicySnapshot: { accessProfileId: "workspace" },
      status: "completed",
    });
    const secondLink = repository.linkChildSession({
      parentSessionId: parentSession.id,
      childSessionId: secondSession.id,
      parentTaskId: parent.id,
      childTaskId: secondChild.id,
      status: "failed",
    });
    repository.updateChildSession(firstLink.id, { outcome: "complete" });
    repository.updateChildSession(secondLink.id, { outcome: "failed" });

    const aggregate = repository.aggregateChildOutcomes(parentSession.id);
    expect(firstLink.childSessionId).not.toBe(secondLink.childSessionId);
    expect(aggregate).toMatchObject({
      childCount: 2,
      completedCount: 1,
      failedCount: 1,
      outcome: "partial",
    });
    expect(repository.findChildSessionByTask(firstChild.id)?.inheritedPolicySnapshot).toMatchObject(
      {
        accessProfileId: "workspace",
      },
    );
  });
});
