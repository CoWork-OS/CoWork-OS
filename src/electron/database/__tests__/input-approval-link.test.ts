import type Database from "better-sqlite3";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../../agent/approval-policy", async (original) => ({
  ...(await original<typeof import("../../agent/approval-policy")>()),
  approvalPromptsDisabled: () => true,
}));
import { ApprovalStore, InputRequestStore } from "../repositories";
import { approvalRequestRevisionHash } from "../../agent/approval-revision";
import { buildAssistantApprovalRequest } from "../../agent/assistant-approval";
import { AgentDaemon } from "../../agent/daemon";
import { nativeSqliteAvailable } from "../../memory/__tests__/memory-items-test-db";
const suite = nativeSqliteAvailable ? describe : describe.skip;
suite("durable inline input to approval binding", () => {
  let db: Database.Database, approvals: ApprovalStore, inputs: InputRequestStore;
  beforeEach(async () => {
    const { default: Sqlite } = await import("better-sqlite3");
    db = new Sqlite(":memory:");
    db.exec(
      "CREATE TABLE approvals(id TEXT PRIMARY KEY,task_id TEXT,type TEXT,description TEXT,details TEXT,status TEXT,requested_at INTEGER,resolved_at INTEGER,resolved_by_principal_id TEXT,resolved_by_role TEXT);CREATE TABLE input_requests(id TEXT PRIMARY KEY,task_id TEXT,questions TEXT,status TEXT,answers TEXT,requested_at INTEGER,resolved_at INTEGER);CREATE TABLE approval_input_links(input_id TEXT PRIMARY KEY,approval_id TEXT UNIQUE,task_id TEXT,revision_hash TEXT);",
    );
    approvals = new ApprovalStore(db);
    inputs = new InputRequestStore(db);
  });
  afterEach(() => db.close());
  function fixture() {
    const approval = approvals.create({
      taskId: "task",
      type: "run_command",
      description: "Review",
      details: { command: "fixture only" },
      status: "pending",
      requestedAt: Date.now(),
    });
    const binding = {
      approvalId: approval.id,
      revisionHash: approvalRequestRevisionHash(approval),
    };
    const request = {
      taskId: "task",
      ...buildAssistantApprovalRequest("run_command", "Review", {}),
      requestedAt: Date.now(),
      status: "pending" as const,
    };
    return { approval, binding, request };
  }
  it("atomically saves a link to the actual pending revision", () => {
    const f = fixture(),
      input = inputs.create(f.request, f.binding);
    expect(inputs.getApprovalBinding(input.id)).toEqual({ ...f.binding, taskId: "task" });
    expect(approvals.findById(f.approval.id)?.status).toBe("pending");
  });
  it.each(["foreign_task", "hash", "expired", "ordinary_question", "approved"])(
    "refuses an invalid trusted binding without inserting input (%s)",
    (scenario) => {
      const f = fixture();
      if (scenario === "foreign_task") f.request.taskId = "foreign";
      if (scenario === "hash") f.binding.revisionHash = "a".repeat(64);
      if (scenario === "expired")
        db.prepare("UPDATE approvals SET requested_at=1 WHERE id=?").run(f.approval.id);
      if (scenario === "ordinary_question") f.request.questions[0].id = "ordinary";
      if (scenario === "approved")
        expect(approvals.resolvePending(f.approval.id, "approved", f.approval)).toBe(true);
      expect(() => inputs.create(f.request, f.binding)).toThrow();
      expect((db.prepare("SELECT COUNT(*) AS n FROM input_requests").get() as Any).n).toBe(0);
    },
  );
  it("rolls back a second input attempting to reuse an approval", () => {
    const f = fixture();
    inputs.create(f.request, f.binding);
    expect(() => inputs.create(f.request, f.binding)).toThrow();
    expect((db.prepare("SELECT COUNT(*) AS n FROM input_requests").get() as Any).n).toBe(1);
  });
  it.each(["revised", "denied", "expired"])(
    "refuses a linked submission after approval authority changes (%s)",
    (scenario) => {
      const f = fixture(),
        input = inputs.create(f.request, f.binding);
      if (scenario === "revised")
        db.prepare("UPDATE approvals SET description='changed' WHERE id=?").run(f.approval.id);
      if (scenario === "denied") approvals.resolvePending(f.approval.id, "denied", f.approval);
      if (scenario === "expired")
        db.prepare("UPDATE approvals SET requested_at=1 WHERE id=?").run(f.approval.id);
      expect(
        inputs.resolve(input.id, "submitted", { approval_decision: { optionLabel: "Allow once" } }),
      ).toBe(false);
      expect(inputs.findById(input.id)?.status).toBe("pending");
      expect(inputs.resolve(input.id, "dismissed")).toBe(true);
    },
  );
  it("has exactly one input response winner", () => {
    const f = fixture(),
      input = inputs.create(f.request, f.binding);
    expect(
      inputs.resolve(input.id, "submitted", { approval_decision: { optionLabel: "Allow once" } }),
    ).toBe(true);
    expect(inputs.resolve(input.id, "dismissed")).toBe(false);
    expect(inputs.findById(input.id)?.status).toBe("submitted");
    expect(approvals.findById(f.approval.id)?.status).toBe("pending");
  });
  it.each(["pending", "approved", "revised", "legacy"])(
    "never replays an approval card without its live waiter (%s)",
    async (scenario) => {
      const f = fixture(),
        input = inputs.create(f.request, scenario === "legacy" ? undefined : f.binding);
      if (scenario === "approved") approvals.resolvePending(f.approval.id, "approved", f.approval);
      if (scenario === "revised")
        db.prepare("UPDATE approvals SET description='new decision' WHERE id=?").run(f.approval.id);
      const daemon = {
        inputRequestRepo: inputs,
        approvalRepo: approvals,
        pendingInputRequests: new Map(),
        taskRepo: { findById: () => ({ id: "task", status: "paused" }) },
        resolveRestartedResponsibilityActionReviewInput: vi.fn().mockResolvedValue(null),
        resumeTaskAfterDurableWait: vi.fn(),
        logEvent: vi.fn(),
        updateTask: vi.fn(),
      } as Any;
      expect(
        await AgentDaemon.prototype.respondToInputRequest.call(daemon, {
          requestId: input.id,
          status: "submitted",
          answers: { approval_decision: { optionLabel: "Allow once" } },
        }),
      ).toEqual({ status: "handled", requestId: input.id });
      expect(inputs.findById(input.id)?.status).toBe("dismissed");
      expect(daemon.resumeTaskAfterDurableWait).not.toHaveBeenCalled();
      expect(daemon.updateTask).not.toHaveBeenCalled();
      expect(approvals.findById(f.approval.id)?.status).toBe(
        scenario === "pending" ? "denied" : scenario === "approved" ? "approved" : "pending",
      );
    },
  );
  it.each([true, false])(
    "binds and resolves the real inline input path (allow=%s)",
    async (allow) => {
      const task = {
        id: "task",
        status: "executing",
        agentConfig: { accessProfileId: "ask_for_approval" },
      };
      const runtime = { recordPermissionSuccess: vi.fn(), recordPermissionDenial: vi.fn() };
      const daemon = {
        approvalRepo: approvals,
        inputRequestRepo: inputs,
        pendingApprovals: new Map(),
        pendingInputRequests: new Map(),
        taskRepo: { findById: () => task },
        requestUserInput: AgentDaemon.prototype.requestUserInput,
        requestAssistantApproval: AgentDaemon.prototype["requestAssistantApproval"],
        isApprovalAuthorityCurrent: async () => true,
        evaluatePermissionRequest: async () => ({
          evaluation: {
            decision: "ask",
            reason: { type: "mode", mode: "default", summary: "Review" },
          },
          promptDetails: { scope: { kind: "tool", toolName: "http_request" } },
          trackingKey: "exact",
          authorizationKey: "exact",
          runtime,
        }),
        logEvent: vi.fn(),
        updateTask: (_id: string, patch: Any) => Object.assign(task, patch),
      } as Any;
      const result = AgentDaemon.prototype.requestApproval.call(
        daemon,
        "task",
        "data_export",
        "Review",
        { tool: "http_request" },
        { allowAutoApprove: false },
      );
      await vi.waitFor(() => expect(daemon.pendingInputRequests.size).toBe(1));
      const input = inputs.findAllPending()[0],
        binding = inputs.getApprovalBinding(input.id)!;
      expect(binding.taskId).toBe("task");
      expect(binding.revisionHash).toBe(
        approvalRequestRevisionHash(approvals.findById(binding.approvalId)!),
      );
      expect(
        await AgentDaemon.prototype.respondToInputRequest.call(daemon, {
          requestId: input.id,
          status: "submitted",
          answers: { approval_decision: { optionLabel: allow ? "Allow once" : "Deny" } },
        }),
      ).toEqual({ status: "handled", requestId: input.id });
      expect(await result).toBe(allow);
      expect(runtime.recordPermissionSuccess).toHaveBeenCalledTimes(allow ? 1 : 0);
      expect(inputs.findById(input.id)?.status).toBe("submitted");
      expect(approvals.findById(binding.approvalId)?.status).toBe(allow ? "approved" : "denied");
    },
  );
});
