import type Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentDaemon } from "../daemon";
import { ApprovalStore } from "../../database/repositories";
import { nativeSqliteAvailable } from "../../memory/__tests__/memory-items-test-db";
const suite = nativeSqliteAvailable ? describe : describe.skip;
suite("automatic review with the real approval store", () => {
  let db: Database.Database;
  beforeEach(async () => {
    const { default: Sqlite } = await import("better-sqlite3");
    db = new Sqlite(":memory:");
    db.exec(
      `CREATE TABLE approvals (id TEXT PRIMARY KEY, task_id TEXT, type TEXT, description TEXT, details TEXT, status TEXT, requested_at INTEGER, resolved_at INTEGER, resolved_by_principal_id TEXT, resolved_by_role TEXT)`,
    );
  });
  afterEach(() => db.close());
  function fixture(session: boolean) {
    const approvalRepo = new ApprovalStore(db);
    const task = {
      id: "auto-task",
      status: "executing",
      agentConfig: { accessProfileId: "approve_for_me" },
    };
    const recordPermissionSuccess = vi.fn();
    const daemon = {
      sessionAutoApproveAll: session,
      approvalRepo,
      taskRepo: { findById: vi.fn(() => task) },
      pendingApprovals: new Map(),
      logEvent: vi.fn(),
      updateTask: vi.fn(),
      evaluatePermissionRequest: vi
        .fn()
        .mockResolvedValue({
          evaluation: {
            decision: "ask",
            reason: { type: "mode", mode: "default", summary: "Fixture review" },
          },
          promptDetails: {},
          scope: { kind: "tool", toolName: "web_fetch" },
          trackingKey: "fixture",
          authorizationKey: "fixture-authority",
          workspace: { permissions: { accessApprovalPolicy: "on-request" } },
          runtime: { recordPermissionSuccess },
        }),
      canSessionAutoApproveType: AgentDaemon.prototype["canSessionAutoApproveType"],
      canAutoReviewApprove: vi.fn(() => ({ approved: true, reason: "fixture safe review" })),
      isApprovalAuthorityCurrent: AgentDaemon.prototype["isApprovalAuthorityCurrent"],
      grantExternalFileApprovalsFromDetails: vi.fn(),
    } as Any;
    const request = (type = "network_access", signal?: AbortSignal) =>
      AgentDaemon.prototype.requestApproval.call(
        daemon,
        task.id,
        type,
        "Review fixture",
        type === "external_file_access"
          ? { tool: "read_file", path: "/fixture/draft", operation: "read" }
          : { tool: "web_fetch", params: { url: "https://example.invalid/fixture" } },
        { signal },
      );
    return { daemon, task, approvalRepo, recordPermissionSuccess, request };
  }
  it.each([false, true])(
    "records a successful automatic decision when session approve-all is %s",
    async (session) => {
      const f = fixture(session);
      expect(await f.request()).toBe(true);
      const row = db.prepare("SELECT status, resolved_at FROM approvals").get() as Any;
      expect(row.status).toBe("approved");
      expect(row.resolved_at).toBeGreaterThan(0);
      expect(f.recordPermissionSuccess).toHaveBeenCalledOnce();
      expect(f.daemon.logEvent).toHaveBeenCalledWith(
        "auto-task",
        "approval_granted",
        expect.objectContaining({ reason: session ? "session_auto_approve" : "auto_review" }),
      );
    },
  );
  it("a losing decision cannot record success or issue grants", async () => {
    const f = fixture(false);
    vi.spyOn(f.approvalRepo, "resolvePending").mockImplementation((id) => {
      f.approvalRepo.update(id, "denied");
      return false;
    });
    expect(await f.request("external_file_access")).toBe(false);
    expect(f.recordPermissionSuccess).not.toHaveBeenCalled();
    expect(f.daemon.grantExternalFileApprovalsFromDetails).not.toHaveBeenCalled();
    expect((db.prepare("SELECT status FROM approvals").get() as Any).status).toBe("denied");
  });
  it("rechecks permission authority after creating the pending row", async () => {
    const f = fixture(false);
    f.daemon.isApprovalAuthorityCurrent = vi.fn().mockResolvedValue(false);
    expect(await f.request()).toBe(false);
    expect(f.recordPermissionSuccess).not.toHaveBeenCalled();
    expect((db.prepare("SELECT status FROM approvals").get() as Any).status).toBe("denied");
  });
  it("a task cancelled during the transition cannot receive success effects", async () => {
    const f = fixture(false);
    const resolve = f.approvalRepo.resolvePending.bind(f.approvalRepo);
    vi.spyOn(f.approvalRepo, "resolvePending").mockImplementation((...args) => {
      const won = resolve(...args);
      f.task.status = "cancelled";
      return won;
    });
    expect(await f.request()).toBe(false);
    expect(f.recordPermissionSuccess).not.toHaveBeenCalled();
    expect((db.prepare("SELECT status FROM approvals").get() as Any).status).toBe("approved");
  });
  it("an abort during the winning transition cannot issue an external grant", async () => {
    const f = fixture(false);
    const controller = new AbortController();
    const resolve = f.approvalRepo.resolvePending.bind(f.approvalRepo);
    vi.spyOn(f.approvalRepo, "resolvePending").mockImplementation((...args) => {
      const won = resolve(...args);
      controller.abort();
      return won;
    });
    expect(await f.request("external_file_access", controller.signal)).toBe(false);
    expect(f.recordPermissionSuccess).not.toHaveBeenCalled();
    expect(f.daemon.grantExternalFileApprovalsFromDetails).not.toHaveBeenCalled();
  });
  it("refuses changed authority after a recorded approval without treating it as action success", async () => {
    const f = fixture(false);
    f.daemon.isApprovalAuthorityCurrent = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    expect(await f.request()).toBe(false);
    expect(f.recordPermissionSuccess).not.toHaveBeenCalled();
    expect((db.prepare("SELECT status FROM approvals").get() as Any).status).toBe("approved");
  });
  it.each([false, true])(
    "refuses an unreadable explicit draft under automatic review (session=%s)",
    async (session) => {
      const f = fixture(session);
      const result = await AgentDaemon.prototype.requestApproval.call(
        f.daemon,
        f.task.id,
        "data_export",
        "Review unavailable file",
        { reviewFiles: ["draft.md"], tool: "http_request" },
      );
      expect(result).toBe(false);
      expect(f.recordPermissionSuccess).not.toHaveBeenCalled();
      expect(f.daemon.grantExternalFileApprovalsFromDetails).not.toHaveBeenCalled();
      expect(f.daemon.logEvent).not.toHaveBeenCalledWith(
        "auto-task",
        "approval_granted",
        expect.anything(),
      );
      const stored = db.prepare("SELECT status,details FROM approvals").get() as Any;
      expect(stored.status).toBe("approved");
      expect(JSON.parse(stored.details).draftRevision.state).toBe("unavailable");
    },
  );
  it.each(["unchanged", "changed", "unavailable", "cancelled", "aborted", "revoked"])(
    "validates a captured automatic-review draft before success (%s)",
    async (scenario) => {
      const f = fixture(false);
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-auto-revision-"));
      const controller = new AbortController();
      try {
        db.exec(
          "CREATE TABLE tasks(id TEXT PRIMARY KEY,workspace_id TEXT);CREATE TABLE workspaces(id TEXT PRIMARY KEY,path TEXT,permissions TEXT);INSERT INTO tasks VALUES('auto-task','ws')",
        );
        const permissions = {
          read: true,
          write: false,
          delete: false,
          shell: false,
          network: false,
        };
        db.prepare("INSERT INTO workspaces VALUES('ws',?,?)").run(
          directory,
          JSON.stringify(permissions),
        );
        fs.writeFileSync(path.join(directory, "draft.md"), "reviewed bytes");
        const permission = await f.daemon.evaluatePermissionRequest();
        f.daemon.evaluatePermissionRequest.mockResolvedValue({
          ...permission,
          workspace: { id: "ws", path: directory, permissions },
        });
        const resolve = f.approvalRepo.resolvePending.bind(f.approvalRepo);
        vi.spyOn(f.approvalRepo, "resolvePending").mockImplementation((...args) => {
          const won = resolve(...args);
          if (scenario === "changed")
            fs.writeFileSync(path.join(directory, "draft.md"), "changed bytes");
          return won;
        });
        if (scenario === "unavailable")
          vi.spyOn(f.approvalRepo, "approvedRevisionCurrent").mockImplementation(() => {
            throw new Error("worker unavailable");
          });
        if (scenario === "revoked") {
          f.daemon.isApprovalAuthorityCurrent = vi
            .fn()
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(true)
            .mockResolvedValue(false);
        }
        if (scenario === "cancelled" || scenario === "aborted") {
          const inspect = f.approvalRepo.approvedRevisionCurrent.bind(f.approvalRepo);
          vi.spyOn(f.approvalRepo, "approvedRevisionCurrent").mockImplementation((...args) => {
            const current = inspect(...args);
            if (scenario === "cancelled") f.task.status = "cancelled";
            else controller.abort();
            return current;
          });
        }
        const result = await AgentDaemon.prototype.requestApproval.call(
          f.daemon,
          f.task.id,
          "data_export",
          "Review file",
          { reviewFiles: ["draft.md"], tool: "http_request" },
          { signal: controller.signal },
        );
        expect(result).toBe(scenario === "unchanged");
        expect(f.recordPermissionSuccess).toHaveBeenCalledTimes(scenario === "unchanged" ? 1 : 0);
        expect(f.daemon.grantExternalFileApprovalsFromDetails).not.toHaveBeenCalled();
        expect((db.prepare("SELECT status,details FROM approvals").get() as Any).status).toBe(
          "approved",
        );
        const stored = JSON.parse(
          (db.prepare("SELECT details FROM approvals").get() as Any).details,
        );
        expect(stored.draftRevision.state).toBe("bound");
        if (scenario !== "unchanged")
          expect(f.daemon.logEvent).not.toHaveBeenCalledWith(
            "auto-task",
            "approval_granted",
            expect.anything(),
          );
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
