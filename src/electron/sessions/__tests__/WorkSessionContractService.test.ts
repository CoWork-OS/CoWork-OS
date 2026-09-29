import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ApprovalStore,
  InputRequestStore,
  TaskEventRepository,
  TaskStore,
} from "../../database/repositories";
import { DatabaseManager } from "../../database/schema";
import { WorkSessionContractService } from "../WorkSessionContractService";
import { WorkSessionProtocolService } from "../WorkSessionProtocolService";
import type { OutcomeContract } from "../../../shared/types";

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
  let taskRepo: TaskStore;
  let eventRepo: TaskEventRepository;
  let approvalRepo: ApprovalStore;
  let inputRequestRepo: InputRequestStore;
  let protocol: WorkSessionProtocolService;
  let service: WorkSessionContractService;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-work-session-contract-service-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tempDir;
    manager = new DatabaseManager();
    db = manager.getDatabase();
    taskRepo = new TaskStore(db);
    eventRepo = new TaskEventRepository(db);
    approvalRepo = new ApprovalStore(db);
    inputRequestRepo = new InputRequestStore(db);
    protocol = new WorkSessionProtocolService(db);
    service = new WorkSessionContractService(db, protocol);
    const workspacePath = path.join(tempDir, "workspace");
    fs.mkdirSync(workspacePath, { recursive: true });
    db.prepare(
      `INSERT INTO workspaces (id, name, path, created_at, permissions)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      "workspace-1",
      "Workspace",
      workspacePath,
      Date.now(),
      JSON.stringify({ read: true, write: true, delete: false, shell: false, network: false }),
    );
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
    } as Parameters<TaskStore["create"]>[0]);
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

  it("does not treat generic PASS prose or task completion as requirement proof", () => {
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

    expect(terminal.contract?.status).toBe("unmet");
    expect(terminal.contract?.requirements[0].status).toBe("failed");
    expect(terminal.contract?.requirements[0].evidenceIds).toHaveLength(1);
    const linked = service
      .getRepository()
      .listEvidenceByIds(
        terminal.contract!.sessionId,
        terminal.contract!.requirements[0].evidenceIds!,
      );
    expect(linked[0]).toMatchObject({
      claim: "Workspace file is missing (existence check only)",
      status: "contradicting",
      sourceType: "task_event",
    });
    expect(service.getForTask(task.id)!.aggregate.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ claim: "Task verification report", status: "supporting" }),
      ]),
    );
  });

  it("satisfies file_exists only from a fresh server-inspected exact target", () => {
    const task = createTask({
      successCriteria: { type: "file_exists", filePaths: ["dist/report.pdf"] },
    });
    const output = path.join(tempDir, "workspace", "dist", "report.pdf");
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, "report bytes");
    service.ensureForTask(task);
    taskRepo.update(task.id, {
      status: "completed",
      resultSummary: "Report delivered",
      verificationVerdict: "PASS",
    });

    const terminal = service.recordTaskTerminal(task.id);
    expect(terminal.contract).toMatchObject({ status: "satisfied" });
    const requirement = terminal.contract!.requirements[0];
    expect(requirement).toMatchObject({
      status: "satisfied",
      verifier: "file_exists",
      targetPath: "dist/report.pdf",
    });
    const [proof] = service
      .getRepository()
      .listEvidenceByIds(terminal.contract!.sessionId, requirement.evidenceIds!);
    expect(proof).toMatchObject({
      claim: "Workspace file is present (existence only)",
      sourceType: "artifact_revision",
      status: "supporting",
    });
    expect(proof.artifactRevisionId).toBeTruthy();
    const revision = service.getRepository().getArtifactRevisionById(proof.artifactRevisionId!);
    expect(revision).toMatchObject({
      status: "committed",
      createdBy: "system",
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      metadata: { evidenceKind: "workspace_file_exists" },
    });
    expect(
      service.getRequirementEvidenceManifest(task.id)?.requirements[0].evidence[0],
    ).toMatchObject({
      id: proof.id,
      sourceRef: fs.realpathSync(output),
      sha256: revision!.sha256,
      capturedAt: expect.any(Number),
      validatedAt: expect.any(Number),
    });
    expect(service.getRequirementEvidenceManifest(task.id)?.capturedAt).toEqual(expect.any(Number));
  });

  it("includes the 41st required target even when its linked proof is beyond the aggregate evidence window", () => {
    const filePaths = Array.from({ length: 41 }, (_, index) => `required-${index + 1}.txt`);
    const task = createTask({ successCriteria: { type: "file_exists", filePaths } });
    const initial = service.ensureForTask(task);
    for (let index = 0; index < 1_005; index += 1) {
      service.getRepository().appendEvidence({
        sessionId: initial.session.id,
        claim: `Unrelated evidence ${index + 1}`,
        sourceType: "task_event",
        sourceRef: `unrelated:${index + 1}`,
      });
    }
    for (const filePath of filePaths) {
      fs.writeFileSync(path.join(tempDir, "workspace", filePath), `proof for ${filePath}`);
    }
    taskRepo.update(task.id, { status: "completed", verificationVerdict: "PASS" });
    const terminal = service.recordTaskTerminal(task.id).contract!;
    const requirement41 = terminal.requirements[40];
    const manifest = service.getRequirementEvidenceManifest(task.id)!;
    const manifestRequirement41 = manifest.requirements[40];
    const proof = manifestRequirement41.evidence[0];

    expect(terminal.requirements).toHaveLength(41);
    expect(requirement41).toMatchObject({
      id: "successCriteria:file_exists:40",
      status: "satisfied",
      targetPath: "required-41.txt",
    });
    expect(manifestRequirement41).toMatchObject({
      requirementId: requirement41.id,
      required: true,
      status: "satisfied",
      targetPath: "required-41.txt",
    });
    expect(proof).toMatchObject({
      claim: "Workspace file is present (existence only)",
      sourceRef: fs.realpathSync(path.join(tempDir, "workspace", "required-41.txt")),
    });
    expect(
      service
        .getRepository()
        .getEvidenceManifest(terminal.sessionId)
        .entries.some((entry) => entry.id === proof.id),
    ).toBe(false);
    expect(service.getRepository().listEvidenceByIds(terminal.sessionId, [proof.id])).toEqual([
      expect.objectContaining({ id: proof.id }),
    ]);
  });

  it("invalidates prior proof when a completed task resumes before publishing a fresh manifest", () => {
    const task = createTask({
      successCriteria: { type: "file_exists", filePaths: ["resumed-report.txt"] },
    });
    const output = path.join(tempDir, "workspace", "resumed-report.txt");
    fs.writeFileSync(output, "initial result");
    service.ensureForTask(task);
    taskRepo.update(task.id, { status: "completed", verificationVerdict: "PASS" });
    const completed = service.recordTaskTerminal(task.id).contract!;
    const oldEvidenceIds = completed.requirements[0].evidenceIds!;
    expect(completed.status).toBe("satisfied");

    taskRepo.update(task.id, { status: "executing" });
    fs.rmSync(output);
    const manifest = service.getRequirementEvidenceManifest(task.id)!;

    expect(manifest.requirements[0]).toMatchObject({ status: "pending", evidence: [] });
    expect(service.getForSession(completed.sessionId).contract?.status).toBe("pending");
    expect(service.getRepository().listEvidenceByIds(completed.sessionId, oldEvidenceIds)).toEqual([
      expect.objectContaining({ status: "stale" }),
    ]);

    fs.writeFileSync(output, "revised result");
    taskRepo.update(task.id, { status: "completed" });
    const refreshed = service.getRequirementEvidenceManifest(task.id)!;
    expect(refreshed.requirements[0].status).toBe("satisfied");
    expect(refreshed.requirements[0].evidence[0].id).not.toBe(oldEvidenceIds[0]);
  });

  it("revalidates physical targets on session reads", () => {
    const task = createTask({
      successCriteria: { type: "file_exists", filePaths: ["session-read.txt"] },
    });
    const output = path.join(tempDir, "workspace", "session-read.txt");
    fs.writeFileSync(output, "present");
    service.ensureForTask(task);
    taskRepo.update(task.id, { status: "completed", verificationVerdict: "PASS" });
    const satisfied = service.recordTaskTerminal(task.id).contract!;
    fs.rmSync(output);

    const aggregate = service.getForSession(satisfied.sessionId);

    expect(aggregate.contract?.requirements[0]).toMatchObject({ status: "failed" });
    expect(
      service
        .getRepository()
        .listEvidenceByIds(satisfied.sessionId, aggregate.contract!.requirements[0].evidenceIds!),
    ).toEqual([
      expect.objectContaining({
        claim: "Workspace file is missing (existence check only)",
        status: "contradicting",
      }),
    ]);
  });

  it("does not execute unsupported shell criteria or accept generic evidence for them", () => {
    const task = createTask({ successCriteria: { type: "shell_command", command: "npm test" } });
    service.ensureForTask(task);
    taskRepo.update(task.id, {
      status: "completed",
      verificationVerdict: "PASS",
    });
    const terminal = service.recordTaskTerminal(task.id);

    expect(terminal.contract).toMatchObject({ status: "pending" });
    expect(terminal.contract?.requirements[0]).toMatchObject({
      verifier: "shell_command",
      status: "pending",
    });
  });

  it("keeps contracts with no criteria pending after task completion", () => {
    const task = createTask();
    service.ensureForTask(task);
    taskRepo.update(task.id, { status: "completed", verificationVerdict: "PASS" });

    const terminal = service.recordTaskTerminal(task.id);
    expect(terminal.contract).toMatchObject({ status: "pending", requirements: [] });
  });

  it("lets an explicit FAIL verdict contradict a physically present output", () => {
    const task = createTask({
      successCriteria: { type: "file_exists", filePaths: ["report.txt"] },
    });
    fs.writeFileSync(path.join(tempDir, "workspace", "report.txt"), "present");
    service.ensureForTask(task);
    taskRepo.update(task.id, {
      status: "failed",
      terminalStatus: "failed",
      failureClass: "required_verification",
      verificationVerdict: "FAIL",
    });

    const terminal = service.recordTaskTerminal(task.id);
    expect(terminal.contract).toMatchObject({ status: "unmet" });
    expect(terminal.contract?.requirements[0]).toMatchObject({ status: "failed" });
    const [evidence] = service
      .getRepository()
      .listEvidenceByIds(
        terminal.contract!.sessionId,
        terminal.contract!.requirements[0].evidenceIds!,
      );
    expect(evidence).toMatchObject({
      claim: "Server recorded a verification failure",
      status: "contradicting",
      sourceRef: `task:${task.id}:verification-verdict`,
    });
  });

  it("does not re-apply an older task-level FAIL to a requirement corrected after that verdict", () => {
    const task = createTask({
      successCriteria: { type: "file_exists", filePaths: ["report.txt"] },
    });
    service.ensureForTask(task);
    taskRepo.update(task.id, {
      status: "failed",
      terminalStatus: "failed",
      failureClass: "required_verification",
      verificationVerdict: "FAIL",
      completedAt: Date.now() - 60_000,
    });
    const failed = service.recordTaskTerminal(task.id).contract!;
    expect(failed.requirements[0]).toMatchObject({ status: "failed" });

    const corrected = service.recordUserRequirementCorrection(task.id, {
      requirementId: failed.requirements[0].id,
      statement: "The report must contain the approved totals",
      criterion: { type: "unsupported" },
      idempotencyKey: "correction:after-fail",
    })!;
    expect(corrected).toMatchObject({ version: 2 });

    const reread = service.getForTask(task.id)!.contract!;
    expect(reread.version).toBe(2);
    expect(reread.requirements[0]).toMatchObject({
      status: "pending",
      description: "The report must contain the approved totals",
    });
  });

  it("rejects linked evidence for the wrong target and stales it", () => {
    const task = createTask({
      successCriteria: { type: "file_exists", filePaths: ["required.txt"] },
    });
    const result = service.ensureForTask(task);
    const contract = result.contract!;
    const wrongRevision = service.getRepository().createArtifactRevision({
      sessionId: result.session.id,
      taskId: task.id,
      path: path.join(tempDir, "workspace", "wrong.txt"),
      mimeType: "text/plain",
      sha256: "a".repeat(64),
      createdBy: "system",
      metadata: { evidenceKind: "workspace_file_exists" },
    });
    const wrongEvidence = service.getRepository().appendEvidence({
      sessionId: result.session.id,
      contractId: contract.id,
      claim: "Workspace file is present (existence only)",
      sourceType: "artifact_revision",
      sourceRef: wrongRevision.path,
      artifactRevisionId: wrongRevision.id,
      status: "supporting",
    });
    const linkedContract = service.getRepository().updateOutcomeContract(contract.id, {
      requirements: contract.requirements.map((requirement) => ({
        ...requirement,
        evidenceIds: [wrongEvidence.id],
      })) as OutcomeContract["requirements"],
      status: "satisfied",
    });
    taskRepo.update(task.id, { status: "completed", verificationVerdict: "PASS" });

    const terminal = service.recordTaskTerminal(task.id);
    const wrong = service
      .getRepository()
      .listEvidenceByIds(contract.sessionId, [wrongEvidence.id])[0];
    expect(linkedContract.status).toBe("satisfied");
    expect(terminal.contract).toMatchObject({ status: "unmet" });
    expect(wrong.status).toBe("stale");
  });

  it("rejects an outdated revision for the exact target even when that revision is committed", () => {
    const task = createTask({
      successCriteria: { type: "file_exists", filePaths: ["report.txt"] },
    });
    const output = path.join(tempDir, "workspace", "report.txt");
    fs.writeFileSync(output, "current bytes");
    const result = service.ensureForTask(task);
    const contract = result.contract!;
    const outdatedRevision = service.getRepository().createArtifactRevision({
      sessionId: result.session.id,
      taskId: task.id,
      path: fs.realpathSync(output),
      mimeType: "text/plain",
      sha256: "a".repeat(64),
      size: 12,
      createdBy: "agent",
    });
    const outdatedEvidence = service.getRepository().appendEvidence({
      sessionId: result.session.id,
      contractId: contract.id,
      claim: "Workspace file is present (existence only)",
      sourceType: "artifact_revision",
      sourceRef: fs.realpathSync(output),
      artifactRevisionId: outdatedRevision.id,
      status: "supporting",
    });
    service.getRepository().updateOutcomeContract(contract.id, {
      status: "satisfied",
      requirements: contract.requirements.map((requirement) => ({
        ...requirement,
        evidenceIds: [outdatedEvidence.id],
      })),
    });
    taskRepo.update(task.id, { status: "completed", verificationVerdict: "PASS" });

    const refreshed = service.recordTaskTerminal(task.id).contract!;
    expect(refreshed).toMatchObject({ status: "satisfied" });
    expect(
      service.getRepository().listEvidenceByIds(result.session.id, [outdatedEvidence.id])[0].status,
    ).toBe("stale");
    expect(service.getRepository().getArtifactRevisionById(outdatedRevision.id)?.status).toBe(
      "superseded",
    );
    const [proof] = service
      .getRepository()
      .listEvidenceByIds(result.session.id, refreshed.requirements[0].evidenceIds!);
    expect(service.getRepository().getArtifactRevisionById(proof.artifactRevisionId!)?.sha256).toBe(
      createHash("sha256").update("current bytes").digest("hex"),
    );
  });

  it("re-evaluates legacy satisfied file requirements without trusting their stored status", () => {
    const task = createTask({
      successCriteria: { type: "file_exists", filePaths: ["legacy.txt"] },
    });
    const initial = service.ensureForTask(task);
    const legacyContract = service.getRepository().updateOutcomeContract(initial.contract!.id, {
      status: "satisfied",
      requirements: initial.contract!.requirements.map((requirement) => ({
        ...requirement,
        targetPath: undefined,
        status: "satisfied",
      })),
      satisfiedAt: Date.now(),
    });
    taskRepo.update(task.id, { status: "completed", verificationVerdict: "PASS" });

    const refreshed = service.getForTask(task.id)!.contract!;
    expect(legacyContract.status).toBe("satisfied");
    expect(refreshed).toMatchObject({ status: "unmet" });
    expect(refreshed.requirements[0]).toMatchObject({
      status: "failed",
      targetPath: "legacy.txt",
    });
  });

  it("invalidates an old artifact revision after an out-of-band file edit", () => {
    const task = createTask({
      successCriteria: { type: "file_exists", filePaths: ["report.txt"] },
    });
    const output = path.join(tempDir, "workspace", "report.txt");
    fs.writeFileSync(output, "before");
    service.ensureForTask(task);
    taskRepo.update(task.id, { status: "completed", verificationVerdict: "PASS" });
    const first = service.recordTaskTerminal(task.id).contract!;
    const oldProofId = first.requirements[0].evidenceIds![0];
    const oldProof = service.getRepository().listEvidenceByIds(first.sessionId, [oldProofId])[0];
    const oldRevision = service
      .getRepository()
      .getArtifactRevisionById(oldProof.artifactRevisionId!)!;

    fs.writeFileSync(output, "after with different bytes");
    const refreshed = service.getForTask(task.id)!.contract!;
    const newProof = service
      .getRepository()
      .listEvidenceByIds(refreshed.sessionId, refreshed.requirements[0].evidenceIds!)[0];
    const newRevision = service
      .getRepository()
      .getArtifactRevisionById(newProof.artifactRevisionId!)!;
    expect(refreshed.requirements[0].status).toBe("satisfied");
    expect(newRevision.sha256).not.toBe(oldRevision.sha256);
    expect(newRevision.id).not.toBe(oldRevision.id);
    expect(newRevision.status).toBe("committed");
    expect(
      service.getRepository().listEvidenceByIds(refreshed.sessionId, [oldProofId])[0].status,
    ).toBe("stale");
    expect(service.getRepository().getArtifactRevisionById(oldRevision.id)?.status).toBe(
      "superseded",
    );
  });

  it("reopens corrected requirements in the constraint ledger and keeps them pending after restart", () => {
    const task = createTask({
      successCriteria: { type: "file_exists", filePaths: ["report.txt"] },
    });
    fs.writeFileSync(path.join(tempDir, "workspace", "report.txt"), "present");
    service.ensureForTask(task);
    taskRepo.update(task.id, { status: "completed", verificationVerdict: "PASS" });
    const satisfied = service.recordTaskTerminal(task.id).contract!;
    const requirement = satisfied.requirements[0];

    const correction = {
      requirementId: requirement.id,
      statement: "The report must contain the approved totals",
      criterion: { type: "unsupported" } as const,
      idempotencyKey: "correction:report-totals",
    };
    const reopened = service.recordUserRequirementCorrection(task.id, correction)!;
    expect(reopened).toMatchObject({ version: 2, status: "pending" });
    expect(reopened.requirements[0]).toMatchObject({
      status: "pending",
      description: "The report must contain the approved totals",
    });
    expect(reopened.requirements[0].evidenceIds).toBeUndefined();
    expect(
      service
        .getRepository()
        .listEvidenceByIds(reopened.sessionId, requirement.evidenceIds!)
        .map((entry) => entry.status),
    ).toEqual(["stale"]);
    expect(service.getRepository().listConstraints(reopened.sessionId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "requirement",
          owner: "user",
          status: "active",
          metadata: { requirementId: requirement.id, verifier: "unsupported" },
        }),
      ]),
    );

    const repeated = service.recordUserRequirementCorrection(task.id, correction)!;
    expect(repeated.id).toBe(reopened.id);
    expect(service.getRepository().listConstraints(reopened.sessionId)).toHaveLength(1);

    manager.close();
    manager = new DatabaseManager();
    db = manager.getDatabase();
    service = new WorkSessionContractService(db, new WorkSessionProtocolService(db));
    const afterRestart = service.getForTask(task.id)!.contract!;
    expect(afterRestart).toMatchObject({ version: 2, status: "pending" });
    expect(afterRestart.requirements[0]).toMatchObject({
      status: "pending",
      description: "The report must contain the approved totals",
    });
  });

  it("restores corrected target semantics from the ledger after legacy requirement normalization", () => {
    const task = createTask({
      successCriteria: { type: "file_exists", filePaths: ["original-report.txt"] },
    });
    fs.writeFileSync(path.join(tempDir, "workspace", "original-report.txt"), "old output");
    service.ensureForTask(task);
    taskRepo.update(task.id, { status: "completed", verificationVerdict: "PASS" });
    const initial = service.recordTaskTerminal(task.id).contract!;
    const corrected = service.recordUserRequirementCorrection(task.id, {
      requirementId: initial.requirements[0].id,
      statement: "The approved report must exist",
      criterion: { type: "file_exists", targetPath: "approved-report.txt" },
      idempotencyKey: "correction:approved-report",
    })!;

    db.prepare("UPDATE work_session_outcome_contracts SET requirements_json = ? WHERE id = ?").run(
      JSON.stringify(
        corrected.requirements.map(
          ({ verifier: _verifier, targetPath: _targetPath, ...rest }) => rest,
        ),
      ),
      corrected.id,
    );

    const refreshed = service.getForTask(task.id)!.contract!;

    expect(refreshed.version).toBe(2);
    expect(refreshed.requirements[0]).toMatchObject({
      status: "failed",
      verifier: "file_exists",
      targetPath: "approved-report.txt",
      description: "The approved report must exist",
    });
    expect(refreshed.requirements[0].targetPath).not.toBe("original-report.txt");
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
