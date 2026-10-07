import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { DatabaseManager } from "../../database/schema";
import { TaskStore, WorkspaceStore } from "../../database/repositories";
import { AgentRoleStore } from "../AgentRoleRepository";
import { WorkSessionProtocolRepository } from "../../database/WorkSessionProtocolRepository";
import { WorkSessionContractRepository } from "../../database/WorkSessionContractRepository";
import { BotWorkResultStore } from "../../database/bot-work-result-store";
import { BotWorkResultService } from "../BotWorkResultService";
import { checkBotArtifacts } from "../bot-work-artifact-worker";

describe("bot result evidence boundaries", () => {
  let directory: string,
    manager: DatabaseManager,
    request: { workspaceId: string; agentRoleId: string; taskId: string },
    contracts: WorkSessionContractRepository,
    revisionId: string,
    contractId: string;
  const access = () => ({
    settings: { defaultPermissionAccess: "full" } as never,
    adminPolicies: { runtime: {} } as never,
  });
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "bot-result-"));
    manager = new DatabaseManager({ dbPath: path.join(directory, "test.db") });
    const db = manager.getDatabase();
    const workspace = new WorkspaceStore(db).create("Here", directory, {
      read: true,
      write: false,
      delete: false,
      network: false,
      shell: false,
    });
    const bot = new AgentRoleStore(db).create({
      name: randomUUID(),
      displayName: "Private renamed bot",
      capabilities: [],
    });
    const task = new TaskStore(db).create({
      workspaceId: workspace.id,
      assignedAgentRoleId: bot.id,
      title: "Report",
      prompt: "SECRET PROMPT",
      status: "completed",
      verificationVerdict: "PASS",
    });
    request = { workspaceId: workspace.id, agentRoleId: bot.id, taskId: task.id };
    const session = new WorkSessionProtocolRepository(db).ensureForTask({
      workspaceId: workspace.id,
      taskId: task.id,
      status: "completed",
    });
    contracts = new WorkSessionContractRepository(db);
    const contract = contracts.createOutcomeContract({
      sessionId: session.session.id,
      taskId: task.id,
      objective: "Produce report",
      requirements: [
        {
          id: "file",
          kind: "output",
          description: "Report exists",
          required: true,
          verifier: "file_exists",
          targetPath: "report.txt",
          status: "satisfied",
        },
      ],
    });
    contractId = contract.id;
    fs.writeFileSync(path.join(directory, "report.txt"), "proof");
    const revision = contracts.createArtifactRevision({
      sessionId: session.session.id,
      taskId: task.id,
      path: "report.txt",
      mimeType: "text/plain",
      sha256: createHash("sha256").update("proof").digest("hex"),
      size: 5,
      status: "committed",
    });
    revisionId = revision.id;
    const evidence = contracts.appendEvidence({
      sessionId: session.session.id,
      contractId: contract.id,
      claim: "Report exists",
      sourceType: "artifact_revision",
      sourceRef: "SECRET SOURCE",
      snippet: "SECRET SNIPPET",
      artifactRevisionId: revision.id,
      status: "supporting",
    });
    contracts.updateOutcomeContract(contract.id, {
      requirements: contract.requirements.map((r) => ({ ...r, evidenceIds: [evidence.id] })),
      status: "satisfied",
    });
  });
  afterEach(() => {
    manager.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const service = () =>
    new BotWorkResultService(manager.getDatabase(), {
      access,
      inspect: async (input) => checkBotArtifacts(input),
    });
  it("checks current bytes without claiming content quality or external delivery and never writes", async () => {
    const db = manager.getDatabase(),
      before = db.prepare("SELECT total_changes() n").get();
    const result = await service().get(request);
    expect(result).toMatchObject({
      recordedVerification: "passed",
      delivery: "unknown",
      outputs: [{ check: "matches" }],
      contract: { requirements: [{ currentEvidence: "matches" }] },
    });
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(JSON.stringify(result)).not.toContain('"permissions"');
    expect(db.prepare("SELECT total_changes() n").get()).toEqual(before);
  });
  it("distinguishes changed and missing files while retaining recorded verification", async () => {
    fs.writeFileSync(path.join(directory, "report.txt"), "other");
    expect(await service().get(request)).toMatchObject({
      recordedVerification: "passed",
      outputs: [{ check: "changed" }],
      contract: { requirements: [{ currentEvidence: "failed" }] },
    });
    fs.unlinkSync(path.join(directory, "report.txt"));
    expect(await service().get(request)).toMatchObject({ outputs: [{ check: "missing" }] });
  });
  it("rejects foreign, archived and malformed scopes", async () => {
    const db = manager.getDatabase(),
      other = new AgentRoleStore(db).create({
        name: randomUUID(),
        displayName: "Other",
        capabilities: [],
      });
    await expect(service().get({ ...request, agentRoleId: other.id })).rejects.toThrow("outside");
    await expect(service().get({ ...request, workspaceId: "missing" })).rejects.toThrow(
      "Workspace not found",
    );
    await expect(service().get({ ...request, path: "report.txt" })).rejects.toThrow();
    db.prepare(
      "INSERT INTO task_session_metadata(session_id,archived_at,created_at,updated_at) VALUES(?,1,1,1)",
    ).run(request.taskId);
    await expect(service().get(request)).rejects.toThrow("outside");
  });
  it("denies inspection after current policy changes and for symlinks or outside paths", async () => {
    const db = manager.getDatabase();
    db.prepare("UPDATE workspaces SET permissions=? WHERE id=?").run(
      JSON.stringify({ read: false, write: false, delete: false, shell: false, network: false }),
      request.workspaceId,
    );
    expect(await service().get(request)).toMatchObject({
      outputs: [{ check: "unavailable" }],
      contract: { requirements: [{ currentEvidence: "unconfirmed" }] },
    });
    db.prepare("UPDATE workspaces SET permissions=? WHERE id=?").run(
      '{"read":true,"write":false,"delete":false,"shell":false,"network":false}',
      request.workspaceId,
    );
    fs.unlinkSync(path.join(directory, "report.txt"));
    fs.symlinkSync(path.join(directory, "test.db"), path.join(directory, "report.txt"));
    expect(await service().get(request)).toMatchObject({ outputs: [{ check: "unavailable" }] });
    db.prepare("UPDATE work_session_artifact_revisions SET path='../outside.txt' WHERE id=?").run(
      revisionId,
    );
    expect(await service().get(request)).toMatchObject({ outputs: [{ check: "unavailable" }] });
  });
  it("does not turn expired or retracted evidence into current requirement proof", async () => {
    manager
      .getDatabase()
      .prepare("UPDATE work_session_evidence SET freshness_expires_at=1 WHERE contract_id=?")
      .run(contractId);
    expect(await service().get(request)).toMatchObject({
      outputs: [{ check: "matches" }],
      contract: { requirements: [{ currentEvidence: "unconfirmed" }] },
      evidence: [{ status: "stale" }],
    });
  });
  it("uses only the latest revision and the exact task's canonical session", async () => {
    const db = manager.getDatabase();
    const manifest = new BotWorkResultStore(db).manifest(request);
    const sessionId = (
      db
        .prepare("SELECT session_id FROM work_session_task_bindings WHERE task_id=?")
        .get(request.taskId) as { session_id: string }
    ).session_id;
    contracts.createArtifactRevision({
      sessionId,
      taskId: request.taskId,
      path: "report.txt",
      mimeType: "text/plain",
      sha256: "a".repeat(64),
      size: 5,
      status: "committed",
      revision: 2,
    });
    expect(await service().get(request)).toMatchObject({
      outputs: [{ revision: 2, check: "changed" }],
      contract: { requirements: [{ currentEvidence: "unconfirmed" }] },
    });
    const foreignWorkspace = new WorkspaceStore(db).create(
      "Foreign",
      path.join(directory, "foreign"),
      { read: false, write: false, delete: false, shell: false, network: false },
    );
    const foreign = new WorkSessionProtocolRepository(db).createAggregate({
      workspaceId: foreignWorkspace.id,
    });
    db.prepare("UPDATE work_session_task_bindings SET session_id=? WHERE task_id=?").run(
      foreign.session.id,
      request.taskId,
    );
    expect(await service().get(request)).toMatchObject({
      contract: null,
      outputs: [],
      recordedVerification: "passed",
    });
    expect(manifest.artifacts).toHaveLength(1);
  });
  it("rejects a scope or policy change while a file check is in flight", async () => {
    const late = new BotWorkResultService(manager.getDatabase(), {
      access,
      inspect: async (input) => {
        const outputs = checkBotArtifacts(input);
        manager
          .getDatabase()
          .prepare("UPDATE tasks SET assigned_agent_role_id=NULL WHERE id=?")
          .run(request.taskId);
        return outputs;
      },
    });
    await expect(late.get(request)).rejects.toThrow("outside");
  });
  it("rejects policy changes after inspection and treats worker failure as unavailable", async () => {
    const db = manager.getDatabase();
    const late = new BotWorkResultService(db, {
      access,
      inspect: async (input) => {
        const outputs = checkBotArtifacts(input);
        db.prepare("UPDATE workspaces SET permissions=? WHERE id=?").run(
          '{"read":false,"write":false,"delete":false,"network":false,"shell":false}',
          request.workspaceId,
        );
        return outputs;
      },
    });
    await expect(late.get(request)).rejects.toThrow("policy changed");
    const offline = new BotWorkResultService(db, {
      access,
      inspect: async () => {
        throw Error("Unavailable");
      },
    });
    expect(await offline.get(request)).toMatchObject({
      outputs: [{ check: "unavailable" }],
      contract: { requirements: [{ currentEvidence: "unconfirmed" }] },
    });
  });
  it("bounds artifact and evidence collections without selecting a foreign task's revisions", async () => {
    const db = manager.getDatabase();
    const sessionId = (
      db
        .prepare("SELECT session_id FROM work_session_task_bindings WHERE task_id=?")
        .get(request.taskId) as { session_id: string }
    ).session_id;
    for (let i = 0; i < 26; i++)
      contracts.createArtifactRevision({
        sessionId,
        taskId: request.taskId,
        path: `extra-${i}.txt`,
        mimeType: "text/plain",
        sha256: "b".repeat(64),
        size: 1,
        status: "committed",
      });
    for (let i = 0; i < 35; i++)
      contracts.appendEvidence({
        sessionId,
        contractId,
        claim: `Claim ${i}`,
        sourceType: "artifact_revision",
        sourceRef: "PRIVATE",
        status: "supporting",
        artifactRevisionId: revisionId,
      });
    const result = await service().get(request);
    expect(result.outputs).toHaveLength(24);
    expect(result.evidence).toHaveLength(32);
    expect(result.truncated).toBe(true);
    const foreign = new TaskStore(db).create({
      workspaceId: request.workspaceId,
      title: "Other",
      prompt: "Private",
      status: "completed",
    });
    contracts.createArtifactRevision({
      sessionId,
      taskId: foreign.id,
      path: "foreign-secret.txt",
      mimeType: "text/plain",
      sha256: "c".repeat(64),
      size: 1,
      status: "committed",
    });
    expect(JSON.stringify(await service().get(request))).not.toContain("foreign-secret.txt");
  });
  it("fails closed for invalid policy and artifact metadata", async () => {
    const db = manager.getDatabase();
    db.prepare("UPDATE tasks SET agent_config='invalid-json' WHERE id=?").run(request.taskId);
    expect(await service().get(request)).toMatchObject({ outputs: [{ check: "unavailable" }] });
    db.prepare("UPDATE work_session_artifact_revisions SET size=-1 WHERE id=?").run(revisionId);
    expect(await service().get(request)).toMatchObject({
      outputs: [],
      issues: expect.arrayContaining(["Some artifact revisions have invalid metadata."]),
    });
  });
});
