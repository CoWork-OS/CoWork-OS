import type Database from "better-sqlite3";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { AgentDaemon } from "../daemon";
import { ApprovalStore } from "../../database/repositories";
import { ChannelDecisionStore } from "../../gateway/ChannelDecisionStore";
import { approvalRequestRevisionHash } from "../approval-revision";
import { nativeSqliteAvailable } from "../../memory/__tests__/memory-items-test-db";
const suite = nativeSqliteAvailable ? describe : describe.skip;
suite("channel authority before response success and resumption", () => {
  let db: Database.Database;
  beforeEach(async () => {
    const { default: Sqlite } = await import("better-sqlite3");
    db = new Sqlite(":memory:");
    db.exec(`CREATE TABLE approvals(id TEXT PRIMARY KEY,task_id TEXT,type TEXT,description TEXT,details TEXT,status TEXT,requested_at INTEGER,resolved_at INTEGER,resolved_by_principal_id TEXT,resolved_by_role TEXT);
CREATE TABLE tasks(id TEXT PRIMARY KEY,workspace_id TEXT,assigned_agent_role_id TEXT,parent_task_id TEXT,agent_config TEXT,status TEXT);
CREATE TABLE workspaces(id TEXT PRIMARY KEY,permissions TEXT);CREATE TABLE workspace_permission_rules(id TEXT PRIMARY KEY,workspace_id TEXT,effect TEXT);
CREATE TABLE agent_roles(id TEXT PRIMARY KEY,is_active INTEGER,capabilities TEXT,tool_restrictions TEXT);
CREATE TABLE channels(id TEXT PRIMARY KEY,type TEXT,enabled INTEGER,config TEXT,security_config TEXT);
CREATE TABLE channel_sessions(id TEXT PRIMARY KEY,channel_id TEXT,chat_id TEXT,workspace_id TEXT,task_id TEXT,context TEXT);
CREATE TABLE channel_users(channel_id TEXT,channel_user_id TEXT,allowed INTEGER);
INSERT INTO tasks VALUES('task','ws','bot',NULL,'{"gatewayContext":"private"}','blocked');INSERT INTO workspaces VALUES('ws','{}');INSERT INTO agent_roles VALUES('bot',1,'[]','{}');
INSERT INTO channels VALUES('channel','slack',1,'{}','{}');INSERT INTO channel_sessions VALUES('session','channel','chat','ws','task','{"taskRequesterUserId":"actor"}');INSERT INTO channel_users VALUES('channel','actor',1);`);
  });
  afterEach(() => db.close());
  it.each(["local", "durable"])("checks a %s response before effects", async (mode) => {
    for (const change of [
      "unchanged",
      "before_persistence",
      "after_persistence",
      "worker_failure",
    ]) {
      db.exec("UPDATE channels SET enabled=1");
      const approvals = new ApprovalStore(db),
        transport = new ChannelDecisionStore(db);
      transport.initialize();
      const approval = approvals.create({
        taskId: "task",
        type: "external_file_access",
        description: "Review fixture",
        details: {
          authorization: { version: 1, key: "exact" },
          permissionPrompt: { scope: { kind: "tool", toolName: "read_file" } },
        },
        status: "pending",
        requestedAt: Date.now(),
      });
      const route = transport.create({
          approvalId: approval.id,
          sessionId: "session",
          actorId: "actor",
        }),
        delivery = transport.beginDelivery(route.id);
      transport.delivered(route.id, delivery.deliveryClaimId!, "message");
      const claimed = transport.claim({
        routeId: route.id,
        channelId: "channel",
        channelType: "slack",
        chatId: "chat",
        messageId: "message",
        actorId: "actor",
        callbackId: "click",
        action: "approve",
        transport: "slack_socket",
      });
      const runtime = { recordPermissionSuccess: vi.fn(), recordPermissionDenial: vi.fn() };
      const pending = {
        taskId: "task",
        approval,
        resolved: false,
        timeoutHandle: setTimeout(() => {}, 60000),
        resolve: vi.fn(),
        reject: vi.fn(),
      };
      if (mode !== "local") clearTimeout(pending.timeoutHandle);
      const daemon = {
        approvalRepo: approvals,
        pendingApprovals: mode === "local" ? new Map([[approval.id, pending]]) : new Map(),
        taskRepo: { findById: () => ({ id: "task", status: "blocked" }) },
        isApprovalAuthorityCurrent: async () => true,
        persistApprovalActionRule: vi.fn(async () => {
          if (change === "after_persistence") db.exec("UPDATE channels SET enabled=0");
        }),
        getExecutorForTask: () => ({ runtime }),
        buildPermissionTrackingKey: () => "exact",
        grantExternalFileApprovalsFromDetails: vi.fn(),
        rememberDurableApprovalGrant: vi.fn(),
        resumeTaskAfterDurableWait: vi.fn().mockResolvedValue(undefined),
        updateTask: vi.fn(),
        logEvent: vi.fn(),
      } as Any;
      const resolve = approvals.resolvePending.bind(approvals);
      const resolution = vi.spyOn(approvals, "resolvePending").mockImplementation((...args) => {
        const won = resolve(...args);
        if (change === "before_persistence") db.exec("UPDATE channels SET enabled=0");
        return won;
      });
      const worker =
        change === "worker_failure"
          ? vi.spyOn(approvals, "approvedRevisionCurrent").mockImplementation(() => {
              throw new Error("worker unavailable");
            })
          : undefined;
      try {
        const status = await AgentDaemon.prototype.respondToApproval.call(
          daemon,
          approval.id,
          true,
          "allow_once",
          undefined,
          approvalRequestRevisionHash(approval),
          { routeId: route.id, claimId: claimed.claimId! },
        );
        expect(status).toBe(change === "unchanged" ? "handled" : "not_found");
        expect(approvals.findById(approval.id)?.status).toBe("approved");
        expect(daemon.grantExternalFileApprovalsFromDetails).toHaveBeenCalledTimes(
          change === "unchanged" ? 1 : 0,
        );
        expect(
          daemon.logEvent.mock.calls.filter((call: Any[]) => call[1] === "approval_granted"),
        ).toHaveLength(change === "unchanged" ? 1 : 0);
        expect(daemon.resumeTaskAfterDurableWait).toHaveBeenCalledTimes(
          change === "unchanged" && mode === "durable" ? 1 : 0,
        );
        expect(daemon.rememberDurableApprovalGrant).toHaveBeenCalledTimes(
          change === "unchanged" && mode === "durable" ? 1 : 0,
        );
        expect(runtime.recordPermissionSuccess).toHaveBeenCalledTimes(
          change === "unchanged" && mode === "local" ? 1 : 0,
        );
        if (mode === "local") {
          expect(pending.resolve).toHaveBeenCalledTimes(change === "unchanged" ? 1 : 0);
          expect(pending.reject).toHaveBeenCalledTimes(change === "unchanged" ? 0 : 1);
        }
      } finally {
        clearTimeout(pending.timeoutHandle);
        resolution.mockRestore();
        worker?.mockRestore();
      }
    }
  });
});
