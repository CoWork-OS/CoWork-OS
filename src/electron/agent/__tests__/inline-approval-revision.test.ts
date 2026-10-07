import type Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../approval-policy", async (original) => ({
  ...(await original<typeof import("../approval-policy")>()),
  approvalPromptsDisabled: () => true,
}));
import { AgentDaemon } from "../daemon";
import { ApprovalStore } from "../../database/repositories";
import { APPROVAL_REQUEST_TIMEOUT_MS } from "../approval-timeouts";
import { nativeSqliteAvailable } from "../../memory/__tests__/memory-items-test-db";
const suite = nativeSqliteAvailable ? describe : describe.skip;
suite("inline approval canonical request and resumption", () => {
  let db: Database.Database, directory: string, store: ApprovalStore;
  const permissions = { read: true, write: false, delete: false, shell: false, network: false };
  beforeEach(async () => {
    const { default: Sqlite } = await import("better-sqlite3");
    db = new Sqlite(":memory:");
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-inline-revision-"));
    db.exec(
      "CREATE TABLE approvals(id TEXT PRIMARY KEY,task_id TEXT,type TEXT,description TEXT,details TEXT,status TEXT,requested_at INTEGER,resolved_at INTEGER,resolved_by_principal_id TEXT,resolved_by_role TEXT);CREATE TABLE tasks(id TEXT PRIMARY KEY,workspace_id TEXT);CREATE TABLE workspaces(id TEXT PRIMARY KEY,path TEXT,permissions TEXT);INSERT INTO tasks VALUES('task','ws');",
    );
    db.prepare("INSERT INTO workspaces VALUES('ws',?,?)").run(
      directory,
      JSON.stringify(permissions),
    );
    fs.writeFileSync(path.join(directory, "draft.md"), "reviewed bytes");
    store = new ApprovalStore(db);
  });
  afterEach(() => {
    vi.useRealTimers();
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  it.each([
    "unchanged",
    "changed",
    "revised",
    "revoked",
    "unavailable",
    "cancelled",
    "aborted",
    "denied",
    "dismissed",
    "input_error",
    "timeout",
    "opposite_decision",
    "late_cancelled",
    "late_aborted",
    "late_revoked",
  ])("records success only after validation (%s)", async (scenario) => {
    let answer!: (value: Any) => void, rejectAnswer!: (error: Error) => void;
    const response = new Promise<Any>((resolve, reject) => {
      answer = resolve;
      rejectAnswer = reject;
    });
    const task = {
      id: "task",
      status: "executing",
      agentConfig: { accessProfileId: "ask_for_approval" },
    };
    const runtime = { recordPermissionSuccess: vi.fn(), recordPermissionDenial: vi.fn() };
    const controller = new AbortController();
    const daemon = {
      approvalRepo: store,
      taskRepo: { findById: () => task },
      pendingApprovals: new Map(),
      requestUserInput: vi.fn(() => response),
      dismissPendingAssistantApproval: vi.fn().mockResolvedValue(undefined),
      requestAssistantApproval: AgentDaemon.prototype["requestAssistantApproval"],
      isApprovalAuthorityCurrent: vi.fn().mockResolvedValue(true),
      evaluatePermissionRequest: vi.fn().mockResolvedValue({
        evaluation: {
          decision: "ask",
          reason: { type: "mode", mode: "default", summary: "Review" },
        },
        promptDetails: { scope: { kind: "tool", toolName: "http_request" } },
        trackingKey: "exact",
        authorizationKey: "exact",
        workspace: { id: "ws", path: directory, permissions },
        runtime,
      }),
      logEvent: vi.fn(),
      updateTask: vi.fn(),
      grantExternalFileApprovalsFromDetails: vi.fn(),
    } as Any;
    if (scenario === "timeout") vi.useFakeTimers();
    const result = AgentDaemon.prototype.requestApproval.call(
      daemon,
      "task",
      "data_export",
      "Review draft",
      { reviewFiles: ["draft.md"], tool: "http_request" },
      { allowAutoApprove: false, signal: controller.signal },
    );
    // Attach rejection handling before signalling input failures or cancellation.
    const settled = result.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await vi.waitFor(() => expect(daemon.requestUserInput).toHaveBeenCalledOnce());
    const row = db.prepare("SELECT * FROM approvals").get() as Any;
    expect(row.status).toBe("pending");
    expect(JSON.parse(row.details).draftRevision.state).toBe("bound");
    expect(daemon.logEvent).not.toHaveBeenCalledWith(
      "task",
      "approval_requested",
      expect.anything(),
    );
    if (scenario === "changed") fs.writeFileSync(path.join(directory, "draft.md"), "new bytes");
    if (scenario === "revised")
      db.prepare("UPDATE approvals SET description='revised' WHERE id=?").run(row.id);
    if (scenario === "revoked") daemon.isApprovalAuthorityCurrent.mockResolvedValue(false);
    if (scenario === "unavailable")
      vi.spyOn(store, "approvedRevisionCurrent").mockImplementation(() => {
        throw new Error("worker unavailable");
      });
    if (scenario.startsWith("late_")) {
      const inspect = store.approvedRevisionCurrent.bind(store);
      vi.spyOn(store, "approvedRevisionCurrent").mockImplementation((...args) => {
        const current = inspect(...args);
        if (scenario === "late_cancelled") task.status = "cancelled";
        if (scenario === "late_aborted") controller.abort();
        if (scenario === "late_revoked") daemon.isApprovalAuthorityCurrent.mockResolvedValue(false);
        return current;
      });
    }
    if (scenario === "cancelled") task.status = "cancelled";
    if (scenario === "aborted") controller.abort();
    if (scenario === "opposite_decision")
      expect(store.resolvePending(row.id, "denied", store.findById(row.id)!)).toBe(true);
    if (scenario === "timeout") await vi.advanceTimersByTimeAsync(APPROVAL_REQUEST_TIMEOUT_MS);
    else if (scenario === "input_error") rejectAnswer(new Error("input unavailable"));
    else if (scenario === "dismissed")
      rejectAnswer(new Error("structured input request dismissed by user"));
    else
      answer({
        requestId: "input-fixture",
        status: "submitted",
        answers: {
          approval_decision: { optionLabel: scenario === "denied" ? "Deny" : "Allow once" },
        },
      });
    const outcome = await settled;
    if (scenario === "input_error" || scenario === "aborted" || scenario === "late_aborted")
      expect(outcome).toHaveProperty("error");
    else expect(outcome).toEqual({ value: scenario === "unchanged" });
    expect(runtime.recordPermissionSuccess).toHaveBeenCalledTimes(scenario === "unchanged" ? 1 : 0);
    expect(
      daemon.logEvent.mock.calls.filter((call: Any[]) => call[1] === "approval_granted"),
    ).toHaveLength(scenario === "unchanged" ? 1 : 0);
    expect(daemon.grantExternalFileApprovalsFromDetails).not.toHaveBeenCalled();
    if (scenario !== "revised")
      expect((db.prepare("SELECT status FROM approvals").get() as Any).status).not.toBe("pending");
  });
  it("rejects a submitted answer before recording permission success when validation refuses", async () => {
    const runtime = { recordPermissionSuccess: vi.fn(), recordPermissionDenial: vi.fn() };
    const validate = vi.fn().mockResolvedValue(false);
    const daemon = {
      taskRepo: {
        findById: () => ({
          id: "task",
          status: "executing",
          agentConfig: { accessProfileId: "ask_for_approval" },
        }),
      },
      requestUserInput: vi.fn().mockResolvedValue({
        requestId: "input",
        status: "submitted",
        answers: { approval_decision: { optionLabel: "Allow once" } },
      }),
      logEvent: vi.fn(),
    } as Any;
    expect(
      await AgentDaemon.prototype["requestAssistantApproval"].call(
        daemon,
        "task",
        "data_export",
        "Review",
        {},
        runtime,
        "exact",
        undefined,
        validate,
      ),
    ).toBe(false);
    expect(validate).toHaveBeenCalledWith(true);
    expect(runtime.recordPermissionSuccess).not.toHaveBeenCalled();
    expect(runtime.recordPermissionDenial).toHaveBeenCalledWith("exact");
    expect(daemon.logEvent).not.toHaveBeenCalledWith("task", "approval_granted", expect.anything());
  });
});
