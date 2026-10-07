import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelDecisionService } from "../ChannelDecisionService";
import { ChannelDecisionStore } from "../ChannelDecisionStore";
import { ChannelDecisionRepository } from "../ChannelDecisionRepository";
import { ApprovalStore } from "../../database/repositories";
import { nativeSqliteAvailable } from "../../memory/__tests__/memory-items-test-db";
const suite = nativeSqliteAvailable ? describe : describe.skip;
suite("authorized durable decision service", () => {
  let db: Database.Database;
  beforeEach(async () => {
    const { default: Sqlite } = await import("better-sqlite3");
    db = new Sqlite(":memory:");
    db.exec(`CREATE TABLE approvals (id TEXT PRIMARY KEY, task_id TEXT, type TEXT, description TEXT, details TEXT, status TEXT, requested_at INTEGER, resolved_at INTEGER, resolved_by_principal_id TEXT, resolved_by_role TEXT);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, workspace_id TEXT, assigned_agent_role_id TEXT, parent_task_id TEXT, agent_config TEXT, status TEXT);
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, permissions TEXT);
    CREATE TABLE workspace_permission_rules (id TEXT PRIMARY KEY, workspace_id TEXT, effect TEXT);
    CREATE TABLE agent_roles (id TEXT PRIMARY KEY, is_active INTEGER, capabilities TEXT, tool_restrictions TEXT);
    CREATE TABLE channel_sessions (id TEXT PRIMARY KEY, channel_id TEXT, chat_id TEXT, workspace_id TEXT, task_id TEXT, context TEXT);
    CREATE TABLE channels (id TEXT PRIMARY KEY, type TEXT, enabled INTEGER, config TEXT, security_config TEXT);
    CREATE TABLE channel_users (channel_id TEXT, channel_user_id TEXT, allowed INTEGER);
    INSERT INTO workspaces VALUES ('ws','{}'); INSERT INTO agent_roles VALUES ('custom-bot',1,'[]','{}');
    INSERT INTO tasks VALUES ('root','ws','custom-bot',NULL,'{"gatewayContext":"private"}','blocked');
    INSERT INTO channels VALUES ('channel','slack',1,'{"ownerUserIds":["actor"],"decisionMessagesEnabled":true}','{}');
    INSERT INTO channel_sessions VALUES ('session','channel','chat','ws','root','{"taskRequesterUserId":"actor"}');
    INSERT INTO channel_users VALUES ('channel','actor',1), ('channel','allowed-contact',1);`);
    new ChannelDecisionStore(db).initialize();
  });
  afterEach(() => db.close());
  function fixture() {
    const approvals = new ApprovalStore(db);
    const request = approvals.create({
      taskId: "root",
      type: "run_command",
      description: "Review fixture",
      details: { command: "fixture only" },
      status: "pending",
      requestedAt: Date.now(),
    });
    const repository = new ChannelDecisionRepository(db);
    const adapter = {
      type: "slack",
      status: "connected",
      decisionCapabilities: { approve: true, deny: true },
      sendDecision: vi.fn().mockResolvedValue("published"),
      sendMessage: vi.fn(),
    } as Any;
    const respond = vi.fn(async (input: Any) => {
      return approvals.resolvePending(
        input.approvalId,
        input.approved ? "approved" : "denied",
        approvals.findById(input.approvalId)!,
        input.attribution,
        input.guard,
      )
        ? ("handled" as const)
        : ("not_found" as const);
    });
    const dependencies = {
      repository,
      getSession: vi.fn(async () => ({ id: "session", channelId: "channel" })),
      getChannel: vi.fn(async (id: string) => {
        const row = db.prepare("SELECT * FROM channels WHERE id = ?").get(id) as Any;
        return row
          ? { ...row, enabled: row.enabled === 1, config: JSON.parse(row.config) }
          : undefined;
      }),
      getApproval: vi.fn(async (id: string) => approvals.findById(id)),
      getAdapter: vi.fn(() => adapter),
      describeApproval: vi.fn((approval: Any) => approval.description),
      respond,
    };
    const service = new ChannelDecisionService(dependencies);
    const input = { approvalId: request.id, sessionId: "session", actorId: "actor" };
    const event = (id: string) => ({
      routeId: id,
      channelType: "slack" as const,
      chatId: "chat",
      messageId: "published",
      actorId: "actor",
      callbackId: "click",
      action: "approve" as const,
      transport: "slack_socket" as const,
    });
    return {
      approvals,
      request,
      repository,
      adapter,
      respond,
      dependencies,
      service,
      input,
      event,
    };
  }
  it("publishes once with the stored deadline and resolves the claimed revision with attribution", async () => {
    const f = fixture();
    const route = await f.service.publish(f.input);
    expect(route.state).toBe("sent");
    expect(route.botId).toBe("custom-bot");
    expect(f.adapter.sendDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        expiresAt: f.request.requestedAt + 300000,
        routeId: route.id,
        summary: f.request.description,
      }),
    );
    expect((await f.service.publish(f.input)).id).toBe(route.id);
    expect(f.adapter.sendDecision).toHaveBeenCalledOnce();
    expect(await f.service.handle("channel", f.event(route.id))).toBe("handled");
    expect(f.respond).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevisionHash: route.approvalRevisionHash,
        attribution: { principalId: "gateway:slack:actor", role: "owner" },
        guard: { routeId: route.id, claimId: expect.any(String) },
      }),
    );
    expect(f.approvals.findById(f.request.id)?.status).toBe("approved");
    await expect(f.service.handle("channel", f.event(route.id))).rejects.toThrow();
    expect(f.respond).toHaveBeenCalledOnce();
  });
  it.each(["no-owner", "contact-only", "disabled", "wrong-owner", "invalid-owner"])(
    "does not publish for %s",
    async (kind) => {
      const f = fixture();
      const config: Any = { ownerUserIds: ["actor"], decisionMessagesEnabled: true };
      if (kind === "no-owner") delete config.ownerUserIds;
      if (kind === "contact-only") config.ownerUserIds = [];
      if (kind === "disabled") config.decisionMessagesEnabled = false;
      if (kind === "wrong-owner") config.ownerUserIds = ["another-owner"];
      if (kind === "invalid-owner") config.ownerUserIds = ["actor", "bad id"];
      db.prepare("UPDATE channels SET config = ?").run(JSON.stringify(config));
      await expect(f.service.publish(f.input)).rejects.toThrow(/not authorized/);
      expect(f.adapter.sendDecision).not.toHaveBeenCalled();
      expect(db.prepare("SELECT count(*) AS n FROM channel_decision_routes").get()).toEqual({
        n: 0,
      });
    },
  );
  it.each(["group-session", "different-requester"])(
    "does not publish a typed decision for %s",
    async (kind) => {
      const f = fixture();
      if (kind === "group-session")
        db.prepare("UPDATE tasks SET agent_config = ? WHERE id = 'root'").run(
          '{"gatewayContext":"group"}',
        );
      else
        db.prepare("UPDATE channel_sessions SET context = ? WHERE id = 'session'").run(
          '{"taskRequesterUserId":"another-owner"}',
        );
      await expect(f.service.publish(f.input)).rejects.toThrow();
      expect(f.adapter.sendDecision).not.toHaveBeenCalled();
      expect(db.prepare("SELECT count(*) AS n FROM channel_decision_routes").get()).toEqual({
        n: 0,
      });
    },
  );
  it("refuses allowlisted contacts and forged transports on callback", async () => {
    const f = fixture();
    const route = await f.service.publish(f.input);
    await expect(
      f.service.handle("channel", { ...f.event(route.id), actorId: "allowed-contact" }),
    ).rejects.toThrow(/not authorized/);
    await expect(
      f.service.handle("channel", { ...f.event(route.id), transport: "teams_botframework" }),
    ).rejects.toThrow(/transport/);
    await expect(f.service.handle("another-channel", f.event(route.id))).rejects.toThrow(
      /destination/,
    );
    expect(f.respond).not.toHaveBeenCalled();
    expect(f.approvals.findById(f.request.id)?.status).toBe("pending");
  });
  it("refuses a request that changes before publication", async () => {
    const f = fixture();
    f.dependencies.getApproval.mockResolvedValue({ ...f.request, description: "changed" });
    await expect(f.service.publish(f.input)).rejects.toThrow(/request changed/);
    expect(f.adapter.sendDecision).not.toHaveBeenCalled();
  });
  it("does not replay a failed card or replace it with text", async () => {
    const f = fixture();
    f.adapter.sendDecision.mockRejectedValue(new Error("ambiguous send"));
    const route = await f.service.publish(f.input);
    expect(route.state).toBe("delivery_unknown");
    expect((await f.service.publish(f.input)).state).toBe("delivery_unknown");
    expect(f.adapter.sendDecision).toHaveBeenCalledOnce();
    expect(f.adapter.sendMessage).not.toHaveBeenCalled();
  });
  it("keeps publication fenced when every receipt write/read fails after sending", async () => {
    const f = fixture();
    vi.spyOn(f.repository, "delivered").mockRejectedValue(new Error("receipt write failed"));
    vi.spyOn(f.repository, "deliveryUnknown").mockRejectedValue(new Error("receipt write failed"));
    vi.spyOn(f.repository, "get").mockRejectedValue(new Error("receipt read failed"));
    expect((await f.service.publish(f.input)).state).toBe("delivering");
    expect(f.adapter.sendDecision).toHaveBeenCalledOnce();
    expect(f.adapter.sendMessage).not.toHaveBeenCalled();
  });
  it("refuses an owner revocation after callback claiming at the atomic writer", async () => {
    const f = fixture();
    const route = await f.service.publish(f.input);
    const actual = f.respond.getMockImplementation()!;
    f.respond.mockImplementation(async (input) => {
      db.prepare("UPDATE channels SET config = ?").run(
        '{"ownerUserIds":[],"decisionMessagesEnabled":true}',
      );
      return actual(input);
    });
    expect(await f.service.handle("channel", f.event(route.id))).toBe("delivery_unknown");
    expect(f.approvals.findById(f.request.id)?.status).toBe("pending");
    expect((await f.repository.get(route.id))?.outcome).toBe("delivery_unknown");
  });
  it("never calls the responder again after an uncertain response", async () => {
    const f = fixture();
    const route = await f.service.publish(f.input);
    f.respond.mockRejectedValue(new Error("uncertain handoff"));
    expect(await f.service.handle("channel", f.event(route.id))).toBe("delivery_unknown");
    await expect(f.service.handle("channel", f.event(route.id))).rejects.toThrow();
    expect(f.respond).toHaveBeenCalledOnce();
  });
  it("publishes the bound request revision and file counts without private draft contents or paths", async () => {
    const f = fixture();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-card-review-"));
    try {
      db.exec("ALTER TABLE workspaces ADD COLUMN path TEXT");
      const permissions = { read: true, write: false, delete: false, network: false, shell: false };
      db.prepare("UPDATE workspaces SET path=?,permissions=? WHERE id='ws'").run(
        dir,
        JSON.stringify(permissions),
      );
      fs.writeFileSync(path.join(dir, "private-draft.md"), "PRIVATE CAPTURED CONTENT");
      const request = f.approvals.create(
        {
          taskId: "root",
          type: "run_command",
          description: "Review fixture",
          details: { command: "fixture only", reviewFiles: ["private-draft.md"] },
          status: "pending",
          requestedAt: Date.now(),
        },
        { path: dir, permissions },
      );
      expect(request.details.draftRevision.entries[0]).not.toHaveProperty("preview");
      const route = await f.service.publish({ ...f.input, approvalId: request.id });
      expect(f.adapter.sendDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          revisionHash: route.approvalRevisionHash,
          draftFiles: { present: 1, missing: 0 },
        }),
      );
      const message = JSON.stringify(f.adapter.sendDecision.mock.calls[0][0]);
      expect(message).not.toContain("PRIVATE CAPTURED CONTENT");
      expect(message).not.toContain("private-draft.md");
      expect(message).not.toContain(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
