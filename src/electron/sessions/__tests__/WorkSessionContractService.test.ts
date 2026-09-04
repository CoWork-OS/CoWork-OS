import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ApprovalRepository,
  InputRequestRepository,
  TaskEventRepository,
  TaskRepository,
} from "../../database/repositories";
import { DatabaseManager } from "../../database/schema";
import { WorkSessionContractService } from "../WorkSessionContractService";
import { WorkSessionProtocolService } from "../WorkSessionProtocolService";

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

describeWithSqlite("WorkSessionContractService", () => {
  let tempDir: string;
  let previousUserDataDir: string | undefined;
  let manager: DatabaseManager;
  let db: Database.Database;
  let taskRepo: TaskRepository;
  let eventRepo: TaskEventRepository;
  let approvalRepo: ApprovalRepository;
  let inputRequestRepo: InputRequestRepository;
  let protocol: WorkSessionProtocolService;
  let service: WorkSessionContractService;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-work-session-contract-service-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tempDir;
    manager = new DatabaseManager();
    db = manager.getDatabase();
    taskRepo = new TaskRepository(db);
    eventRepo = new TaskEventRepository(db);
    approvalRepo = new ApprovalRepository(db);
    inputRequestRepo = new InputRequestRepository(db);
    protocol = new WorkSessionProtocolService(db);
    service = new WorkSessionContractService(db, protocol);
    db.prepare(
      `INSERT INTO workspaces (id, name, path, created_at, permissions)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("workspace-1", "Workspace", path.join(tempDir, "workspace"), Date.now(), "{}");
  });

  afterEach(() => {
    manager.close();
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function createTask(overrides: Record<string, unknown> = {}) {
    return taskRepo.create({
      title: "Contract service task",
      prompt: "Create a verified deliverable",
      status: "executing",
      workspaceId: "workspace-1",
      source: "manual",
      ...overrides,
    } as Parameters<TaskRepository["create"]>[0]);
  }

  function addEvent(taskId: string, id: string, type: string, payload: Record<string, unknown>) {
    return eventRepo.create({
      id,
      taskId,
      timestamp: Date.now(),
      type: type as never,
      payload,
      schemaVersion: 2,
      eventId: id,
    });
  }

  it("initializes a contract from task criteria and policy constraints", () => {
    const task = createTask({
      successCriteria: { type: "shell_command", command: "npm test" },
      agentConfig: {
        allowedTools: ["shell", "read_file"],
        toolRestrictions: ["network"],
      },
    });
    const result = service.ensureForTask(task);

    expect(result.contract).toMatchObject({
      taskId: task.id,
      objective: task.prompt,
      status: "pending",
    });
    expect(result.contract?.requirements).toEqual([
      expect.objectContaining({
        kind: "verification",
        description: "Command exits successfully: npm test",
        verifier: "shell_command",
      }),
    ]);
    expect(result.aggregate.constraints.map((entry) => entry.key)).toEqual(
      expect.arrayContaining(["tool_restrictions", "allowed_tools"]),
    );
  });

  it("turns approval and evidence events into durable waits and evidence", () => {
    const task = createTask();
    const approval = addEvent(task.id, "event-approval", "approval_requested", {
      approval: { id: "approval-1", description: "Publish the artifact" },
      token: "must-not-persist",
    });
    service.recordTaskEvent(task.id, approval);
    const evidence = addEvent(task.id, "event-evidence", "citations_collected", {
      citations: [
        {
          url: "https://example.test/report",
          claim: "Report was verified",
          snippet: "PASS",
        },
      ],
    });
    service.recordTaskEvent(task.id, evidence);

    const aggregate = service.getForTask(task.id)!.aggregate;
    expect(aggregate.waitStates).toEqual([
      expect.objectContaining({
        kind: "approval",
        requestId: "approval-1",
        status: "pending",
      }),
    ]);
    expect(aggregate.evidence).toEqual([
      expect.objectContaining({
        sourceType: "url",
        sourceRef: "https://example.test/report",
        claim: "Report was verified",
      }),
    ]);
    expect(aggregate.evidence[0].snippet).toBe("PASS");
    expect(
      protocol
        .getRepository()
        .listItems(aggregate.contract!.sessionId)
        .some((item) => item.kind === "wait"),
    ).toBe(true);

    const granted = addEvent(task.id, "event-granted", "approval_granted", {
      approvalId: "approval-1",
    });
    service.recordTaskEvent(task.id, granted);
    expect(service.getForTask(task.id)!.aggregate.waitStates[0].status).toBe("resolved");

    const nestedRequested = addEvent(task.id, "event-approval-nested", "approval_requested", {
      approval: { id: "approval-nested", description: "Approve the second artifact" },
    });
    service.recordTaskEvent(task.id, nestedRequested);
    const nestedGranted = addEvent(task.id, "event-granted-nested", "approval_granted", {
      approval: { id: "approval-nested" },
    });
    service.recordTaskEvent(task.id, nestedGranted);
    expect(
      service
        .getForTask(task.id)!
        .aggregate.waitStates.find((wait) => wait.requestId === "approval-nested")?.status,
    ).toBe("resolved");

    const inputRequested = addEvent(task.id, "event-input-nested", "input_request_created", {
      request: { id: "input-nested" },
    });
    service.recordTaskEvent(task.id, inputRequested);
    const inputResolved = addEvent(
      task.id,
      "event-input-resolved-nested",
      "input_request_resolved",
      {
        request: { id: "input-nested" },
      },
    );
    service.recordTaskEvent(task.id, inputResolved);
    expect(
      service
        .getForTask(task.id)!
        .aggregate.waitStates.find((wait) => wait.requestId === "input-nested")?.status,
    ).toBe("resolved");
  });

  it("persists runtime blockers and preserves approval/input waits on resume", () => {
    const task = createTask();
    service.ensureForTask(task);

    const blockerTypes = [
      "task_interrupted",
      "auto_continuation_blocked",
      "follow_up_turn_recovery_blocked",
      "safety_stop_triggered",
      "mode_gate_blocked",
      "reconnect_requested",
      "child_wait",
    ];
    for (const [index, type] of blockerTypes.entries()) {
      service.recordTaskEvent(
        task.id,
        addEvent(task.id, `event-blocker-${index}`, type, { reason: `${type} reason` }),
      );
    }

    service.recordTaskEvent(
      task.id,
      addEvent(task.id, "event-approval-pending", "approval_requested", {
        approval: { id: "approval-pending" },
      }),
    );
    service.recordTaskEvent(
      task.id,
      addEvent(task.id, "event-input-pending", "input_request_created", {
        request: { id: "input-pending" },
      }),
    );

    const beforeResume = service.getForTask(task.id)!.aggregate.waitStates;
    expect(beforeResume).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "paused", status: "pending" }),
        expect.objectContaining({ kind: "external", status: "pending" }),
        expect.objectContaining({ kind: "reconnect", status: "pending" }),
        expect.objectContaining({ kind: "child", status: "pending" }),
        expect.objectContaining({
          kind: "approval",
          requestId: "approval-pending",
          status: "pending",
        }),
        expect.objectContaining({ kind: "input", requestId: "input-pending", status: "pending" }),
      ]),
    );

    service.recordTaskEvent(
      task.id,
      addEvent(task.id, "event-resume", "task_resumed", { message: "Task resumed" }),
    );

    const afterResume = service.getForTask(task.id)!.aggregate.waitStates;
    expect(
      afterResume.find((wait) => wait.kind === "approval" && wait.requestId === "approval-pending")
        ?.status,
    ).toBe("pending");
    expect(
      afterResume.find((wait) => wait.kind === "input" && wait.requestId === "input-pending")
        ?.status,
    ).toBe("pending");
    expect(
      afterResume
        .filter((wait) => wait.kind !== "approval" && wait.kind !== "input")
        .every((wait) => wait.status === "resolved"),
    ).toBe(true);
  });

  it("rehydrates persisted approval and input waits when a task is reopened", () => {
    const task = createTask({ status: "paused" });
    const approval = approvalRepo.create({
      taskId: task.id,
      type: "run_command",
      description: "Approve the migration",
      details: { command: "npm run migrate" },
      status: "pending",
      requestedAt: Date.now(),
    });
    const input = inputRequestRepo.create({
      taskId: task.id,
      questions: [
        {
          header: "Environment",
          id: "environment",
          question: "Which environment?",
          options: [
            { label: "Dev", description: "Use the development environment" },
            { label: "Prod", description: "Use the production environment" },
          ],
        },
      ],
      requestedAt: Date.now(),
    });

    const aggregate = service.ensureForTask(task).aggregate;
    expect(aggregate.waitStates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "approval", requestId: approval.id, status: "pending" }),
        expect.objectContaining({ kind: "input", requestId: input.id, status: "pending" }),
      ]),
    );
  });

  it("marks terminal tasks truthfully and records verification evidence", () => {
    const task = createTask({
      successCriteria: { type: "file_exists", filePaths: ["dist/report.pdf"] },
    });
    service.ensureForTask(task);
    taskRepo.update(task.id, {
      status: "completed",
      resultSummary: "Report delivered",
      verificationVerdict: "PASS",
    });
    const completed = addEvent(task.id, "event-complete", "task_completed", {
      verificationReport: "The required file exists and opens successfully.",
    });
    const terminal = service.recordTaskTerminal(task.id, completed);

    expect(terminal.contract?.status).toBe("satisfied");
    expect(terminal.contract?.requirements[0].status).toBe("satisfied");
    expect(service.getForTask(task.id)!.aggregate.evidence).toEqual([
      expect.objectContaining({
        claim: "Task verification report",
        status: "supporting",
      }),
    ]);
  });

  it("gives child tasks isolated canonical sessions with inherited policy", () => {
    const parent = createTask({
      agentConfig: {
        accessProfileId: "workspace",
        permissionMode: "default",
        allowedTools: ["read_file"],
      },
    });
    const child = createTask({
      parentTaskId: parent.id,
      agentType: "sub",
      sessionId: parent.id,
      agentConfig: { toolRestrictions: ["network"] },
    });

    const link = service.ensureChildSession(parent, child)!;
    const parentSessionId = protocol.getRepository().findSessionIdForTask(parent.id)!;
    const childSessionId = protocol.getRepository().findSessionIdForTask(child.id)!;
    expect(childSessionId).not.toBe(parentSessionId);
    expect(childSessionId).toBe(child.id);
    expect(link).toMatchObject({
      parentSessionId,
      childSessionId,
      parentTaskId: parent.id,
      childTaskId: child.id,
      status: "pending",
    });
    expect(link.inheritedPolicySnapshot).toMatchObject({
      inheritedFromTaskId: parent.id,
      accessProfileId: "workspace",
      allowedTools: ["read_file"],
      toolRestrictions: ["network"],
    });
    expect(service.getForTask(child.id)?.contract?.sessionId).toBe(childSessionId);
  });

  it("aggregates child terminal outcomes without claiming full success", () => {
    const parent = createTask();
    const completeChild = createTask({
      parentTaskId: parent.id,
      agentType: "sub",
      sessionId: parent.id,
    });
    const partialChild = createTask({
      parentTaskId: parent.id,
      agentType: "sub",
      sessionId: parent.id,
    });
    service.ensureChildSession(parent, completeChild);
    service.ensureChildSession(parent, partialChild);

    taskRepo.update(completeChild.id, { status: "completed", resultSummary: "Done" });
    taskRepo.update(partialChild.id, {
      status: "completed",
      terminalStatus: "partial_success",
      verificationVerdict: "PARTIAL",
      resultSummary: "Partially done",
    });
    service.recordTaskTerminal(completeChild.id);
    const partialResult = service.recordTaskTerminal(partialChild.id);

    expect(partialResult.childAggregate).toMatchObject({
      childCount: 2,
      completedCount: 1,
      partialCount: 1,
      outcome: "partial",
    });
    const parentSessionId = protocol.getRepository().findSessionIdForTask(parent.id)!;
    expect(service.getForSession(parentSessionId).evidence).toEqual([
      expect.objectContaining({
        sourceType: "child_session",
        claim: "Child session aggregate outcome",
      }),
    ]);
  });
});
