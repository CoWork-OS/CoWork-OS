import type Database from "better-sqlite3";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
vi.mock("../approval-policy", async (original) => ({
  ...(await original<typeof import("../approval-policy")>()),
  approvalPromptsDisabled: () => false,
}));
import { AgentDaemon } from "../daemon";
import { ApprovalStore } from "../../database/repositories";
import { nativeSqliteAvailable } from "../../memory/__tests__/memory-items-test-db";
const suite = nativeSqliteAvailable ? describe : describe.skip;
suite("approval revision at daemon resumption", () => {
  let db: Database.Database, dir: string, store: ApprovalStore;
  let waits: Map<string, Any>[];
  const permissions = { read: true, write: false, delete: false, shell: false, network: false };
  beforeEach(async () => {
    const { default: Sqlite } = await import("better-sqlite3");
    db = new Sqlite(":memory:");
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-grant-revision-"));
    waits = [];
    db.exec(
      `CREATE TABLE approvals(id TEXT PRIMARY KEY,task_id TEXT,type TEXT,description TEXT,details TEXT,status TEXT,requested_at INTEGER,resolved_at INTEGER,resolved_by_principal_id TEXT,resolved_by_role TEXT);CREATE TABLE tasks(id TEXT PRIMARY KEY,workspace_id TEXT);CREATE TABLE workspaces(id TEXT PRIMARY KEY,path TEXT,permissions TEXT);INSERT INTO tasks VALUES('task','ws');`,
    );
    db.prepare("INSERT INTO workspaces VALUES ('ws',?,?)").run(dir, JSON.stringify(permissions));
    fs.writeFileSync(path.join(dir, "draft.md"), "reviewed bytes");
    store = new ApprovalStore(db);
  });
  afterEach(() => {
    for (const map of waits)
      for (const pending of map.values()) clearTimeout(pending.timeoutHandle);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  function fixture() {
    const daemon = {
      approvalRepo: store,
      pendingDurableApprovalGrants: new Map(),
      pendingApprovals: new Map(),
      isApprovalAuthorityCurrent: vi.fn().mockResolvedValue(true),
      taskRepo: {
        findById: () => ({
          id: "task",
          status: "executing",
          agentConfig: { accessProfileId: "ask_for_approval" },
        }),
      },
      logEvent: vi.fn(),
      updateTask: vi.fn(),
      evaluatePermissionRequest: vi.fn().mockResolvedValue({
        evaluation: {
          decision: "ask",
          reason: { type: "mode", mode: "default", summary: "review" },
        },
        promptDetails: { scope: { kind: "tool", toolName: "http_request" } },
        trackingKey: "exact",
        authorizationKey: "exact",
        workspace: { id: "ws", path: dir, permissions },
      }),
    } as Any;
    waits.push(daemon.pendingApprovals);
    return daemon;
  }
  function queued(daemon: Any) {
    const request = store.create(
      {
        taskId: "task",
        type: "data_export",
        description: "Review draft",
        details: {
          reviewFiles: ["draft.md"],
          authorization: { version: 1, key: "exact" },
          permissionPrompt: { scope: { kind: "tool", toolName: "http_request" } },
        },
        status: "pending",
        requestedAt: Date.now(),
      },
      { path: dir, permissions },
    );
    expect(store.resolvePending(request.id, "approved", request)).toBe(true);
    AgentDaemon.prototype["rememberDurableApprovalGrant"].call(daemon, "task", request);
    return request;
  }
  const consume = (daemon: Any) =>
    AgentDaemon.prototype["consumeDurableApprovalGrant"].call(daemon, "task", "exact");
  it("consumes an unchanged approved file revision exactly once", async () => {
    const d = fixture(),
      request = queued(d);
    expect(await consume(d)).toMatchObject({
      approvalId: request.id,
      revisionHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(await consume(d)).toBeUndefined();
  });
  it("refuses file changes between approval and queued-grant consumption", async () => {
    const d = fixture();
    queued(d);
    fs.writeFileSync(path.join(dir, "draft.md"), "new bytes");
    expect(await consume(d)).toBeUndefined();
    expect(d.pendingDurableApprovalGrants.size).toBe(0);
  });
  it("refuses a request revision changed after it was queued", async () => {
    const d = fixture(),
      request = queued(d);
    db.prepare("UPDATE approvals SET description='changed' WHERE id=?").run(request.id);
    expect(await consume(d)).toBeUndefined();
    expect(d.isApprovalAuthorityCurrent).not.toHaveBeenCalled();
  });
  it("refuses revoked current authority before inspecting files", async () => {
    const d = fixture();
    queued(d);
    d.isApprovalAuthorityCurrent.mockResolvedValue(false);
    const inspect = vi.spyOn(store, "approvedRevisionCurrent");
    expect(await consume(d)).toBeUndefined();
    expect(inspect).not.toHaveBeenCalled();
  });
  it("does not replay after a failed worker validation", async () => {
    const d = fixture();
    queued(d);
    vi.spyOn(store, "approvedRevisionCurrent").mockImplementation(() => {
      throw new Error("unavailable");
    });
    expect(await consume(d)).toBeUndefined();
    expect(await consume(d)).toBeUndefined();
  });
  it.each([false, true])(
    "rechecks captured files when a local wait resumes (changed=%s)",
    async (changed) => {
      const d = fixture();
      const result = AgentDaemon.prototype.requestApproval.call(
        d,
        "task",
        "data_export",
        "Review draft",
        { reviewFiles: ["draft.md"], tool: "http_request" },
        { allowAutoApprove: false },
      );
      await vi.waitFor(() => expect(d.pendingApprovals.size).toBe(1));
      const pending = [...d.pendingApprovals.values()][0] as Any;
      expect(store.resolvePending(pending.approval.id, "approved", pending.approval)).toBe(true);
      pending.resolved = true;
      clearTimeout(pending.timeoutHandle);
      pending.resolve(true);
      if (changed) fs.writeFileSync(path.join(dir, "draft.md"), "changed after response");
      expect(await result).toBe(!changed);
    },
  );
  it("withholds a local approved response when explicit draft capture was unavailable", async () => {
    const d = fixture();
    const permission = await d.evaluatePermissionRequest();
    d.evaluatePermissionRequest.mockResolvedValue({ ...permission, workspace: undefined });
    const result = AgentDaemon.prototype.requestApproval.call(
      d,
      "task",
      "data_export",
      "Review draft",
      { reviewFiles: ["draft.md"], tool: "http_request" },
      { allowAutoApprove: false },
    );
    await vi.waitFor(() => expect(d.pendingApprovals.size).toBe(1));
    const pending = [...d.pendingApprovals.values()][0] as Any;
    expect(pending.approval.details.draftRevision.state).toBe("unavailable");
    expect(store.resolvePending(pending.approval.id, "approved", pending.approval)).toBe(true);
    pending.resolved = true;
    clearTimeout(pending.timeoutHandle);
    pending.resolve(true);
    expect(await result).toBe(false);
  });
  it("refuses a task stopped while the queued grant was being validated", async () => {
    const d = fixture();
    queued(d);
    d.consumeDurableApprovalGrant = AgentDaemon.prototype["consumeDurableApprovalGrant"];
    d.taskRepo.findById = vi
      .fn()
      .mockReturnValueOnce({
        id: "task",
        status: "executing",
        agentConfig: { accessProfileId: "ask_for_approval" },
      })
      .mockReturnValue({ id: "task", status: "cancelled" });
    expect(
      await AgentDaemon.prototype.requestApproval.call(
        d,
        "task",
        "data_export",
        "Review",
        { reviewFiles: ["draft.md"] },
        { allowAutoApprove: false },
      ),
    ).toBe(false);
    expect(d.logEvent).not.toHaveBeenCalledWith("task", "approval_granted", expect.anything());
  });
});
