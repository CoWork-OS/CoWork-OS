import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRoleStore } from "../../../agents/AgentRoleRepository";
import { RoutineService } from "../../../routines/service";
import { DatabaseManager } from "../../../database/schema";
import {
  ApprovalStore,
  InputRequestStore,
  TaskStore,
  WorkspaceStore,
} from "../../../database/repositories";
import { approvalRequestRevisionHash } from "../../approval-revision";
import { AgentDaemon } from "../../daemon";
import { FileTools } from "../file-tools";
import {
  claimResponsibilityActionReview,
  claimResponsibilityActionReviewInUnit,
  finishResponsibilityActionReview,
  getResponsibilityActionReviewContext,
  type ResponsibilityActionReviewClaimInput,
  type ResponsibilityActionReviewPayload,
} from "../../../automation/responsibility-task-policy";
import { BotResponsibilityStore } from "../../../automation/responsibility-store";
import type { BotResponsibilityDefinition } from "../../../../shared/bot-responsibility";
import type { Workspace } from "../../../../shared/types";
import { RESPONSIBILITY_ACTION_REVIEW_DECISION_QUESTION_ID } from "../../../../shared/approval-draft-presentation";

type FixtureOptions = {
  decision?: "allow_once" | "deny_once";
  taskSource?: "manual" | "cron";
  afterDecision?: (context: { db: Database.Database; targetPath: string }) => void;
  afterClaim?: (context: { db: Database.Database; targetPath: string }) => void;
};

async function createFixture(options: FixtureOptions = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-reviewed-write-"));
  const dbPath = path.join(dir, "profile.db");
  const manager = new DatabaseManager({ dbPath });
  const db = manager.getDatabase();
  const workspace = new WorkspaceStore(db).create("Review fixture", dir, {
    read: true,
    write: true,
    delete: false,
    shell: false,
    network: false,
  });
  const role = new AgentRoleStore(db).create({
    name: `review-${randomUUID()}`,
    displayName: "Private review fixture",
    capabilities: ["code"],
    systemPrompt: "This private test role is never a default.",
  });
  const routines = new RoutineService({
    db,
    getCronService: () => null,
    getEventTriggerService: () => null,
    loadHooksSettings: () => ({
      enabled: false,
      token: "fixture",
      path: "/hooks",
      maxBodyBytes: 1024,
      presets: [],
      mappings: [],
    }),
    saveHooksSettings: vi.fn(),
    createTask: vi.fn(),
  });
  const routine = await routines.create({
    name: "Review fixture routine",
    workspaceId: workspace.id,
    enabled: false,
    prompt: "Write the selected file after review.",
    connectors: [],
    triggers: [{ id: "manual", type: "manual", enabled: true }],
  });
  const definition: BotResponsibilityDefinition = {
    objective: "Write one selected workspace file after human review.",
    engine: { kind: "routine", id: routine.id },
    mode: "act",
    sources: [],
    permittedActions: [
      { connectorId: "workspace_files", method: "write_file", resourceId: "notes.md" },
    ],
    expectedOutput: "A reviewed file.",
    reviewBoundary: "all_effects",
    destination: { channel: "internal", id: "results" },
    backend: "node",
    budget: { maxTokens: 1000, maxCost: 0 },
  };
  const responsibilityStore = new BotResponsibilityStore(db);
  const responsibility = responsibilityStore.create(
    { workspaceId: workspace.id, agentRoleId: role.id },
    definition,
    Date.now(),
  );
  db.prepare("UPDATE bot_responsibilities SET state = 'active' WHERE id = ?").run(
    responsibility.id,
  );
  const taskStore = new TaskStore(db);
  const task = taskStore.create({
    title: "Reviewed write",
    prompt: "Update notes.md.",
    status: "pending",
    workspaceId: workspace.id,
    agentConfig: { automationRoutineId: routine.id },
    source: options.taskSource ?? "manual",
    budgetTokens: 1000,
    budgetCost: 0,
  });
  const approvalStore = new ApprovalStore(db);
  let request: ReturnType<ApprovalStore["findById"]> | undefined;
  let claimedInput: ResponsibilityActionReviewClaimInput | undefined;
  const targetPath = path.join(dir, "notes.md");
  const daemon = {
    getDatabase: () => db,
    getTask: (taskId: string) => taskStore.findById(taskId),
    getTaskById: async (taskId: string) => taskStore.findById(taskId),
    getEffectiveWorkspaceForTask: (_taskId: string) =>
      new WorkspaceStore(db).findById(workspace.id) ?? null,
    captureTaskMutationBaseline: vi.fn(async () => undefined),
    logEvent: vi.fn(),
    recordReviewedOutput: vi.fn(),
    getWorkSessionContractService() {
      return { recordReviewedOutput: this.recordReviewedOutput };
    },
    requestResponsibilityActionApproval: async (
      taskId: string,
      review: ResponsibilityActionReviewPayload,
    ) => {
      const pending = approvalStore.create(
        {
          taskId,
          type: "workspace_write",
          description: `Review proposed write to ${review.canonicalPath}`,
          details: {
            tool: "write_file",
            params: { path: review.canonicalPath },
            path: review.canonicalPath,
            reviewFiles: [review.canonicalPath],
            responsibilityActionReview: review,
          },
          status: "pending",
          requestedAt: Date.now(),
        },
        workspace,
      );
      request = pending;
      const decision = options.decision ?? "allow_once";
      const won = approvalStore.resolvePending(
        pending.id,
        decision === "allow_once" ? "approved" : "denied",
        pending,
        undefined,
        undefined,
        decision,
      );
      if (!won) return null;
      options.afterDecision?.({ db, targetPath });
      if (decision !== "allow_once") return null;
      const draft = pending.details?.draftRevision as
        | { entries?: Array<Record<string, unknown>> }
        | undefined;
      const base = draft?.entries?.[0];
      if (
        !base ||
        (base.status !== "present" && base.status !== "missing") ||
        typeof base.path !== "string"
      )
        return null;
      return {
        approvalId: pending.id,
        requestRevisionHash: approvalRequestRevisionHash(pending),
        baseRevision: {
          status: base.status,
          path: base.path,
          ...(base.status === "present"
            ? { sha256: base.sha256 as string, size: base.size as number }
            : {}),
        },
      };
    },
    validateResponsibilityActionApproval: async (
      input: ResponsibilityActionReviewClaimInput,
      consume: boolean,
    ) => {
      const current = approvalStore.findById(input.approvalId);
      if (
        !current ||
        current.status !== "approved" ||
        approvalRequestRevisionHash(current) !== input.requestRevisionHash ||
        !approvalStore.approvedRevisionCurrent(current.id, input.requestRevisionHash)
      )
        return false;
      const run = await getResponsibilityActionReviewContext(
        db,
        input.taskId,
        input.workspaceId,
        input.workspacePath,
        input.canonicalPath,
        input.runtime,
      );
      if (
        !run ||
        run.id !== input.responsibilityRun.id ||
        run.revision !== input.responsibilityRun.revision ||
        run.controlVersion !== input.responsibilityRun.controlVersion ||
        run.workspaceId !== input.responsibilityRun.workspaceId ||
        run.agentRoleId !== input.responsibilityRun.agentRoleId
      )
        return false;
      if (!consume) return true;
      claimedInput = input;
      try {
        const claimed = await claimResponsibilityActionReview(db, input);
        if (!claimed) return false;
        if (!approvalStore.approvedRevisionCurrent(current.id, input.requestRevisionHash))
          return false;
        options.afterClaim?.({ db, targetPath });
        return true;
      } catch {
        return false;
      }
    },
    finishResponsibilityActionApproval: (
      input: ResponsibilityActionReviewClaimInput,
      outcome: "committed" | "uncertain",
    ) =>
      finishResponsibilityActionReview(
        db,
        input.approvalId,
        input.requestRevisionHash,
        input.executionId,
        outcome,
      ),
  };
  let runtimeStopped = false;
  const files = new FileTools(
    new WorkspaceStore(db).findById(workspace.id) as Workspace,
    daemon as never,
    task.id,
  );

  return {
    dir,
    dbPath,
    db,
    manager,
    workspace,
    task,
    taskStore,
    approvalStore,
    targetPath,
    request: () => request,
    claimedInput: () => claimedInput,
    files,
    recordReviewedOutput: daemon.recordReviewedOutput,
    async close() {
      if (!runtimeStopped) {
        await routines.stopWorkflowRuntime();
        runtimeStopped = true;
      }
      manager.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
    async closeProfile() {
      if (!runtimeStopped) {
        await routines.stopWorkflowRuntime();
        runtimeStopped = true;
      }
      manager.close();
    },
  };
}

describe("FileTools exact responsibility action review", () => {
  const fixtures: Array<Awaited<ReturnType<typeof createFixture>>> = [];
  afterEach(async () => {
    while (fixtures.length > 0) await fixtures.pop()!.close();
  });

  async function fixture(options: FixtureOptions = {}) {
    const created = await createFixture(options);
    fixtures.push(created);
    return created;
  }

  async function createPendingReview(
    test: Awaited<ReturnType<typeof createFixture>>,
    content: string,
  ) {
    const run = await getResponsibilityActionReviewContext(
      test.db,
      test.task.id,
      test.workspace.id,
      test.workspace.path,
      "notes.md",
    );
    if (!run) throw new Error("responsibility review context was not available");
    const bytes = Buffer.from(content, "utf8");
    const review: ResponsibilityActionReviewPayload = {
      version: 1,
      operation: { connectorId: "workspace_files", method: "write_file" },
      canonicalPath: "notes.md",
      content,
      contentBytes: bytes.length,
      contentSha256: createHash("sha256").update(bytes).digest("hex"),
      responsibilityRun: run,
    };
    const approval = test.approvalStore.create(
      {
        taskId: test.task.id,
        type: "workspace_write",
        description: "Review proposed write to notes.md",
        details: {
          tool: "write_file",
          params: { path: "notes.md" },
          path: "notes.md",
          reviewFiles: ["notes.md"],
          responsibilityActionReview: review,
        },
        status: "pending",
        requestedAt: Date.now(),
      },
      test.workspace,
    );
    const revisionHash = approvalRequestRevisionHash(approval);
    const input = new InputRequestStore(test.db).create(
      {
        taskId: test.task.id,
        requestedAt: Date.now(),
        questions: [
          {
            header: "Permission",
            id: RESPONSIBILITY_ACTION_REVIEW_DECISION_QUESTION_ID,
            question: "Review exact proposed bytes and decide.",
            options: [
              { label: "Deny once", description: "Stop this operation." },
              { label: "Allow once", description: "Write these exact bytes once." },
            ],
          },
        ],
      },
      { approvalId: approval.id, revisionHash },
    );
    test.taskStore.update(test.task.id, { status: "executing" });
    return { review, approval, input, revisionHash };
  }

  function daemonForRestartedReview(test: Awaited<ReturnType<typeof createFixture>>) {
    const inputRequestRepo = new InputRequestStore(test.db);
    const daemon = Object.assign(Object.create(AgentDaemon.prototype), {
      approvalRepo: test.approvalStore,
      inputRequestRepo,
      taskRepo: test.taskStore,
      workspaceRepo: new WorkspaceStore(test.db),
      pendingInputRequests: new Map(),
      getDatabase: () => test.db,
      getTask: (taskId: string) => test.taskStore.findById(taskId),
      getTaskById: async (taskId: string) => test.taskStore.findById(taskId),
      getEffectiveWorkspaceForTask: () =>
        new WorkspaceStore(test.db).findById(test.workspace.id) ?? null,
      isApprovalAuthorityCurrent: vi.fn(async () => true),
      updateTask: (taskId: string, updates: Any) => test.taskStore.update(taskId, updates),
      logEvent: vi.fn(),
      resumeTaskAfterDurableWait: vi.fn(async () => undefined),
      requestApproval: vi.fn(async () => false),
      captureTaskMutationBaseline: vi.fn(async () => undefined),
    }) as Any;
    return daemon;
  }

  it("writes the exact approved bytes once and keeps its committed claim across reopen", async () => {
    const test = await fixture();
    const base = "Original text\n";
    const proposed = "Reviewed \uFEFFcafé 🚀\n";
    fs.writeFileSync(test.targetPath, base);

    await expect(test.files.writeFile("notes.md", proposed)).resolves.toEqual({
      success: true,
      path: "notes.md",
    });

    const bytes = fs.readFileSync(test.targetPath);
    expect(bytes.equals(Buffer.from(proposed, "utf8"))).toBe(true);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      test.request()?.details?.responsibilityActionReview.contentSha256,
    );
    expect(
      test.db
        .prepare("SELECT outcome FROM responsibility_action_review_claims WHERE approval_id = ?")
        .get(test.request()?.id),
    ).toEqual({ outcome: "committed" });
    const claim = test.claimedInput();
    expect(claim).toBeDefined();
    // The approved bytes (not a re-read of the path) are recorded once for result cards.
    expect(test.recordReviewedOutput).toHaveBeenCalledTimes(1);
    const [recordedTask, recorded] = test.recordReviewedOutput.mock.calls[0];
    expect(recordedTask).toBe(test.task.id);
    expect(recorded).toEqual({
      path: expect.any(String),
      sha256: test.request()?.details?.responsibilityActionReview.contentSha256,
      size: Buffer.byteLength(proposed, "utf8"),
      approvalId: test.request()?.id,
    });
    expect(fs.realpathSync(recorded.path)).toBe(fs.realpathSync(test.targetPath));

    await test.closeProfile();
    const reopened = new DatabaseManager({ dbPath: test.dbPath });
    try {
      const db = reopened.getDatabase();
      expect(
        db
          .prepare("SELECT outcome FROM responsibility_action_review_claims WHERE approval_id = ?")
          .get(test.request()?.id),
      ).toEqual({ outcome: "committed" });
      expect(fs.readFileSync(test.targetPath).equals(Buffer.from(proposed, "utf8"))).toBe(true);
      // Restore the recorded base only to isolate the durable single-use claim check from
      // the separate base-revision check, which correctly rejects the committed output.
      fs.writeFileSync(test.targetPath, base);
      expect(
        claimResponsibilityActionReviewInUnit(db, {
          ...claim!,
          executionId: randomUUID(),
        }),
      ).toBe(false);
    } finally {
      reopened.close();
    }
  });

  it("reviews the granted target when the model passes its absolute workspace path", async () => {
    const test = await fixture();
    fs.writeFileSync(test.targetPath, "Original text\n");
    await expect(
      test.files.writeFile(test.targetPath, "Absolute path proposal\n"),
    ).resolves.toEqual({
      success: true,
      path: "notes.md",
    });
    expect(fs.readFileSync(test.targetPath, "utf8")).toBe("Absolute path proposal\n");
    expect(test.request()?.details?.responsibilityActionReview.canonicalPath).toBe("notes.md");
  });

  it("keeps a scheduled task's exact selected native write target instead of redirecting it", async () => {
    const test = await fixture({ taskSource: "cron" });
    const proposal = "Scheduled reviewed output\n";

    await expect(test.files.writeFile("notes.md", proposal)).resolves.toEqual({
      success: true,
      path: "notes.md",
    });

    expect(fs.readFileSync(test.targetPath, "utf8")).toBe(proposal);
    expect(test.request()?.details?.responsibilityActionReview.canonicalPath).toBe("notes.md");
    expect(fs.existsSync(path.join(test.dir, ".cowork", test.request()?.taskId || ""))).toBe(false);
  });

  it("retains a default-inline review across restart and writes only the exact one-time decision", async () => {
    const test = await fixture();
    const base = "Original before restart\n";
    const proposed = "The exact approved content after restart\n";
    fs.writeFileSync(test.targetPath, base);
    const { review, approval, input, revisionHash } = await createPendingReview(test, proposed);
    const daemon = daemonForRestartedReview(test);
    const oldPromptSetting = process.env.COWORK_APPROVAL_PROMPTS;
    process.env.COWORK_APPROVAL_PROMPTS = "off";

    try {
      await AgentDaemon.prototype["reconcileDurableWaitsOnStartup"].call(daemon);
      expect(test.approvalStore.findById(approval.id)?.status).toBe("pending");
      expect(new InputRequestStore(test.db).findById(input.id)?.status).toBe("pending");
      expect(test.taskStore.findById(test.task.id)).toMatchObject({
        status: "blocked",
        terminalStatus: "awaiting_approval",
      });

      await expect(
        AgentDaemon.prototype.respondToInputRequest.call(daemon, {
          requestId: input.id,
          status: "submitted",
          answers: {
            [RESPONSIBILITY_ACTION_REVIEW_DECISION_QUESTION_ID]: {
              optionLabel: "Allow once",
            },
          },
        }),
      ).resolves.toEqual({ status: "handled", requestId: input.id });
      expect(test.approvalStore.findById(approval.id)?.status).toBe("approved");
      expect(new InputRequestStore(test.db).findById(input.id)?.status).toBe("submitted");
      expect(
        test.db
          .prepare("SELECT action FROM responsibility_action_review_decisions WHERE approval_id=?")
          .get(approval.id),
      ).toEqual({ action: "allow_once" });
      expect(test.taskStore.findById(test.task.id)?.status).toBe("executing");
      expect(daemon.resumeTaskAfterDurableWait).toHaveBeenCalledOnce();

      const resumed = await AgentDaemon.prototype.requestResponsibilityActionApproval.call(
        daemon,
        test.task.id,
        review,
      );
      expect(resumed).toEqual({
        approvalId: approval.id,
        requestRevisionHash: revisionHash,
        baseRevision: expect.objectContaining({ status: "present", sha256: expect.any(String) }),
      });
      expect(daemon.requestApproval).not.toHaveBeenCalled();

      const resumedTools = new FileTools(
        new WorkspaceStore(test.db).findById(test.workspace.id) as Workspace,
        daemon,
        test.task.id,
      );
      await expect(resumedTools.writeFile("notes.md", proposed)).resolves.toEqual({
        success: true,
        path: "notes.md",
      });
      expect(fs.readFileSync(test.targetPath, "utf8")).toBe(proposed);
      expect(
        test.db
          .prepare("SELECT outcome FROM responsibility_action_review_claims WHERE approval_id=?")
          .get(approval.id),
      ).toEqual({ outcome: "committed" });
    } finally {
      if (oldPromptSetting === undefined) delete process.env.COWORK_APPROVAL_PROMPTS;
      else process.env.COWORK_APPROVAL_PROMPTS = oldPromptSetting;
    }
  });

  it("denies a restarted Allow once response if the captured base changed", async () => {
    const test = await fixture();
    fs.writeFileSync(test.targetPath, "Original before restart\n");
    const { approval, input } = await createPendingReview(test, "Exact proposed write\n");
    const daemon = daemonForRestartedReview(test);
    fs.writeFileSync(test.targetPath, "External replacement before response\n");

    await expect(
      AgentDaemon.prototype.respondToInputRequest.call(daemon, {
        requestId: input.id,
        status: "submitted",
        answers: {
          [RESPONSIBILITY_ACTION_REVIEW_DECISION_QUESTION_ID]: {
            optionLabel: "Allow once",
          },
        },
      }),
    ).resolves.toEqual({ status: "handled", requestId: input.id });

    expect(test.approvalStore.findById(approval.id)?.status).toBe("denied");
    expect(new InputRequestStore(test.db).findById(input.id)?.status).toBe("dismissed");
    expect(test.taskStore.findById(test.task.id)).toMatchObject({ status: "failed" });
    expect(fs.readFileSync(test.targetPath, "utf8")).toBe("External replacement before response\n");
    expect(
      test.db
        .prepare("SELECT action FROM responsibility_action_review_decisions WHERE approval_id=?")
        .get(approval.id),
    ).toEqual({ action: "deny_once" });
    expect(daemon.resumeTaskAfterDurableWait).not.toHaveBeenCalled();
  });

  it("denial leaves an existing target unchanged and records deny_once", async () => {
    const test = await fixture({ decision: "deny_once" });
    fs.writeFileSync(test.targetPath, "Original text\n");

    await expect(test.files.writeFile("notes.md", "Must not be written\n")).rejects.toThrow(
      "not approved",
    );

    expect(fs.readFileSync(test.targetPath, "utf8")).toBe("Original text\n");
    expect(
      test.db
        .prepare("SELECT action FROM responsibility_action_review_decisions WHERE approval_id = ?")
        .get(test.request()?.id),
    ).toEqual({ action: "deny_once" });
    expect(
      test.db
        .prepare("SELECT * FROM responsibility_action_review_claims WHERE approval_id = ?")
        .all(test.request()?.id),
    ).toEqual([]);
    expect(test.recordReviewedOutput).not.toHaveBeenCalled();
  });

  it("rejects a stale base revision during claim without overwriting the external edit", async () => {
    const external = "External edit during the approval claim\n";
    const test = await fixture({
      afterClaim: ({ targetPath }) => fs.writeFileSync(targetPath, external),
    });
    fs.writeFileSync(test.targetPath, "Original text\n");

    await expect(test.files.writeFile("notes.md", "Reviewed proposal\n")).rejects.toThrow(
      "no longer valid",
    );

    expect(fs.readFileSync(test.targetPath, "utf8")).toBe(external);
    expect(
      test.db
        .prepare("SELECT outcome FROM responsibility_action_review_claims WHERE approval_id = ?")
        .get(test.request()?.id),
    ).toEqual({ outcome: "uncertain" });
  });

  it("rejects a same-inode base edit made during the final async authority guard", async () => {
    let afterClaimCalls = 0;
    const external = "External same-inode edit after the final async gate\n";
    const test = await fixture({
      afterClaim: ({ targetPath }) => {
        afterClaimCalls += 1;
        if (afterClaimCalls === 3) fs.writeFileSync(targetPath, external);
      },
    });
    fs.writeFileSync(test.targetPath, "Original text\n");

    await expect(test.files.writeFile("notes.md", "Reviewed proposal\n")).rejects.toThrow(
      "base changed before commit",
    );

    expect(fs.readFileSync(test.targetPath, "utf8")).toBe(external);
    expect(
      test.db
        .prepare("SELECT outcome FROM responsibility_action_review_claims WHERE approval_id = ?")
        .get(test.request()?.id),
    ).toEqual({ outcome: "uncertain" });
  });

  it("rejects staged-byte mutation during the final async authority guard", async () => {
    let afterClaimCalls = 0;
    const test = await fixture({
      afterClaim: ({ targetPath }) => {
        afterClaimCalls += 1;
        const stagedName = fs
          .readdirSync(path.dirname(targetPath))
          .find((name) => name.startsWith(".notes.md.cowork-review-") && name.endsWith(".tmp"));
        if (!stagedName) throw new Error("review staging file was not present during final gate");
        expect(fs.statSync(path.join(path.dirname(targetPath), stagedName)).mode & 0o777).toBe(
          0o600,
        );
        if (afterClaimCalls !== 3) return;
        fs.writeFileSync(path.join(path.dirname(targetPath), stagedName), "Unreviewed bytes\n");
      },
    });
    const base = "Original text\n";
    fs.writeFileSync(test.targetPath, base);

    await expect(test.files.writeFile("notes.md", "Reviewed proposal\n")).rejects.toThrow(
      "staged reviewed write changed",
    );

    expect(fs.readFileSync(test.targetPath, "utf8")).toBe(base);
    expect(
      test.db
        .prepare("SELECT outcome FROM responsibility_action_review_claims WHERE approval_id = ?")
        .get(test.request()?.id),
    ).toEqual({ outcome: "uncertain" });
  });

  it("fails closed for oversized and malformed UTF-8 proposals before creating output", async () => {
    const test = await fixture();

    await expect(test.files.writeFile("notes.md", "x".repeat(256_001))).rejects.toThrow(
      "256,000-byte review limit",
    );
    await expect(test.files.writeFile("notes.md", "lone surrogate: \uD800")).rejects.toThrow(
      "exact UTF-8",
    );

    expect(fs.existsSync(test.targetPath)).toBe(false);
    expect(test.request()).toBeUndefined();
  });
});
