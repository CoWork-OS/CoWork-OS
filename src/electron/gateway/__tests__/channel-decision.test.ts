import type Database from "better-sqlite3";
import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { ChannelDecisionStore, type ChannelDecisionCallback } from "../ChannelDecisionStore";
import { nativeSqliteAvailable } from "../../memory/__tests__/memory-items-test-db";
const suite = nativeSqliteAvailable ? describe : describe.skip;
suite("durable channel decision bindings", () => {
  let db: Database.Database;
  let store: ChannelDecisionStore;
  const now = 1_000_000;
  beforeEach(async () => {
    const { default: Sqlite } = await import("better-sqlite3");
    db = new Sqlite(":memory:");
    db.exec(`CREATE TABLE approvals (id TEXT PRIMARY KEY, task_id TEXT, type TEXT, description TEXT, details TEXT, status TEXT, requested_at INTEGER);
   CREATE TABLE tasks (id TEXT PRIMARY KEY, workspace_id TEXT, assigned_agent_role_id TEXT, parent_task_id TEXT, agent_config TEXT, status TEXT);
   CREATE TABLE workspaces (id TEXT PRIMARY KEY, permissions TEXT);
   CREATE TABLE workspace_permission_rules (id TEXT PRIMARY KEY, workspace_id TEXT, effect TEXT);
   CREATE TABLE agent_roles (id TEXT PRIMARY KEY, is_active INTEGER, capabilities TEXT, tool_restrictions TEXT);
   CREATE TABLE channel_sessions (id TEXT PRIMARY KEY, channel_id TEXT, chat_id TEXT, workspace_id TEXT, task_id TEXT, context TEXT);
   CREATE TABLE channels (id TEXT PRIMARY KEY, type TEXT, enabled INTEGER, config TEXT, security_config TEXT);
   CREATE TABLE channel_users (channel_id TEXT, channel_user_id TEXT, allowed INTEGER);
   INSERT INTO workspaces VALUES ('ws','{"write":true}');
   INSERT INTO agent_roles VALUES ('bot',1,'[]','{}');
   INSERT INTO tasks VALUES ('root','ws','bot',NULL,'{"gatewayContext":"private"}','blocked'), ('child','ws',NULL,'root','{}','blocked');
   INSERT INTO channels VALUES ('channel','slack',1,'{"tenant":"fixture"}','{}');
   INSERT INTO channel_sessions VALUES ('session','channel','chat','ws','root','{"taskRequesterUserId":"actor"}');
   INSERT INTO channel_users VALUES ('channel','actor',1), ('channel','other',1);`);
    db.prepare(
      "INSERT INTO approvals VALUES ('approval','child','write_file','Write reviewed draft',?, 'pending', ?)",
    ).run(JSON.stringify({ path: "draft.md", revisionHash: "abc", policy: { write: true } }), now);
    store = new ChannelDecisionStore(db);
    store.initialize();
  });
  afterEach(() => db.close());
  const create = () =>
    store.create({ approvalId: "approval", sessionId: "session", actorId: "actor" }, now);
  function sent() {
    const route = create();
    const delivery = store.beginDelivery(route.id, now);
    return store.delivered(route.id, delivery.deliveryClaimId!, "message", now);
  }
  const callback = (routeId: string): ChannelDecisionCallback => ({
    routeId,
    channelId: "channel",
    channelType: "slack",
    chatId: "chat",
    messageId: "message",
    actorId: "actor",
    callbackId: "click",
    action: "approve",
    transport: "slack_socket",
  });
  it("binds the actual child request to the originating root session and bot", () => {
    const route = create();
    expect(route).toMatchObject({
      taskId: "child",
      rootTaskId: "root",
      botId: "bot",
      workspaceId: "ws",
      actorId: "actor",
      state: "queued",
      expiresAt: now + 300_000,
    });
    expect(create().id).toBe(route.id);
    expect(JSON.stringify(route)).not.toContain("draft.md");
    expect(() =>
      store.create({ approvalId: "approval", sessionId: "session", actorId: "other" }, now),
    ).toThrow(/requester does not match the session owner/);
  });
  it.each(["group", "public", "legacy-missing"])(
    "refuses %s context at the durable authority boundary",
    (context) => {
      const config =
        context === "legacy-missing" ? "{}" : JSON.stringify({ gatewayContext: context });
      db.prepare("UPDATE tasks SET agent_config = ? WHERE id = 'root'").run(config);
      expect(create).toThrow(/private owner session/);
      expect(db.prepare("SELECT count(*) AS n FROM channel_decision_routes").get()).toEqual({
        n: 0,
      });
    },
  );
  it("claims once while leaving ApprovalStore authoritative", () => {
    const route = sent();
    const claimed = store.claim(callback(route.id), now + 1);
    expect(claimed.state).toBe("claimed");
    expect(claimed.claimId).toBeTruthy();
    expect(db.prepare("SELECT status FROM approvals").get()).toEqual({ status: "pending" });
    expect(() => store.claim(callback(route.id), now + 2)).toThrow(/no longer actionable/);
    expect(() =>
      store.claim({ ...callback(route.id), callbackId: "another", action: "deny" }, now + 2),
    ).toThrow();
    expect(() => store.finish(route.id, "wrong", "handled", now + 2)).toThrow(/claim changed/);
    expect(() => store.finish(route.id, claimed.claimId!, "handled", now + 2)).toThrow(
      /not persisted/,
    );
    store.finish(route.id, claimed.claimId!, "delivery_unknown", now + 2);
    expect(store.get(route.id)?.outcome).toBe("delivery_unknown");
  });
  it.each(["actorId", "channelId", "chatId", "messageId", "channelType", "transport"] as const)(
    "rejects mismatched %s without consuming the decision",
    (key) => {
      const route = sent();
      expect(() =>
        store.claim({ ...callback(route.id), [key]: "forged" } as ChannelDecisionCallback, now + 1),
      ).toThrow();
      expect(store.get(route.id)?.state).toBe("sent");
    },
  );
  it.each([
    'UPDATE approvals SET details = \'{"revisionHash":"changed"}\'',
    "UPDATE tasks SET assigned_agent_role_id = NULL WHERE id = 'root'",
    "UPDATE tasks SET agent_config = '{\"permissionMode\":\"plan\"}' WHERE id = 'root'",
    "UPDATE workspaces SET permissions = '{\"write\":false}'",
    "INSERT INTO workspace_permission_rules VALUES ('revoked','ws','deny')",
    "UPDATE channels SET enabled = 0",
    'UPDATE channels SET config = \'{"tenant":"changed"}\'',
    "UPDATE channel_users SET allowed = 0 WHERE channel_user_id = 'actor'",
    "UPDATE channel_sessions SET chat_id = 'moved'",
    "UPDATE tasks SET parent_task_id = NULL WHERE id = 'child'",
    "UPDATE agent_roles SET is_active = 0",
    "UPDATE tasks SET status = 'completed' WHERE id = 'child'",
  ])("rejects changed revision, scope or authority (%s)", (sql) => {
    const route = sent();
    db.exec(sql);
    expect(() => store.claim(callback(route.id), now + 1)).toThrow();
    expect(store.get(route.id)?.state).toBe("sent");
  });
  it("uses the stored approval deadline and refuses expiry", () => {
    const route = sent();
    expect(() => store.claim(callback(route.id), route.expiresAt)).toThrow(/expired/);
    expect(() => create.call(null)).not.toThrow();
  });
  it("never treats unknown delivery as sent or automatically requeues it", () => {
    const route = create();
    const delivery = store.beginDelivery(route.id, now);
    store.deliveryUnknown(route.id, delivery.deliveryClaimId!, now + 1);
    expect(create().state).toBe("delivery_unknown");
    expect(() => store.claim(callback(route.id), now + 2)).toThrow();
    expect(() => store.delivered(route.id, delivery.deliveryClaimId!, "later", now + 2)).toThrow();
  });
  it("fences publication before effects and cannot restart a claimed delivery", () => {
    const route = create();
    const delivery = store.beginDelivery(route.id, now);
    expect(create().state).toBe("delivering");
    expect(() => store.beginDelivery(route.id, now + 1)).toThrow();
    expect(() => store.delivered(route.id, "foreign", "message", now + 1)).toThrow();
    expect(() => store.deliveryUnknown(route.id, "foreign", now + 1)).toThrow();
    expect(store.get(route.id)?.state).toBe("delivering");
    expect(store.delivered(route.id, delivery.deliveryClaimId!, "message", now + 1).state).toBe(
      "sent",
    );
  });
  it("supports the same authority checks for Teams", () => {
    db.exec("UPDATE channels SET type = 'teams'");
    const route = sent();
    expect(route.channelType).toBe("teams");
    expect(
      store.claim(
        { ...callback(route.id), channelType: "teams", transport: "teams_botframework" },
        now + 1,
      ).state,
    ).toBe("claimed");
  });
  function approvedWinner() {
    const route = sent(),
      claim = store.claim(callback(route.id), now + 1);
    store.assertResolution(
      { routeId: route.id, claimId: claim.claimId! },
      "approval",
      "approved",
      route.approvalRevisionHash,
      now + 1,
    );
    db.prepare("UPDATE approvals SET status='approved' WHERE id='approval'").run();
    store.recordApprovedResolution(
      { routeId: route.id, claimId: claim.claimId! },
      "approval",
      route.approvalRevisionHash,
    );
    return claim;
  }
  it("validates a channel winner before and after its transport receipt", () => {
    const route = approvedWinner();
    expect(() =>
      store.assertApprovedConsumption("approval", route.approvalRevisionHash, now + 2),
    ).not.toThrow();
    store.finish(route.id, route.claimId!, "handled", now + 2);
    expect(() =>
      store.assertApprovedConsumption("approval", route.approvalRevisionHash, now + 3),
    ).not.toThrow();
  });
  it.each([
    "UPDATE channels SET enabled=0",
    `UPDATE channels SET config='{"ownerUserIds":[]}'`,
    `UPDATE channels SET security_config='{"mode":"revoked"}'`,
    "UPDATE channel_users SET allowed=0 WHERE channel_user_id='actor'",
    "UPDATE channel_sessions SET chat_id='moved'",
    "UPDATE tasks SET parent_task_id=NULL WHERE id='child'",
    "UPDATE tasks SET status='cancelled' WHERE id='child'",
    `UPDATE workspaces SET permissions='{"write":false}'`,
    "INSERT INTO workspace_permission_rules VALUES('new-rule','ws','deny')",
    "UPDATE agent_roles SET is_active=0",
    "UPDATE approvals SET description='changed request'",
    "UPDATE channel_decision_routes SET claim_id='changed claim'",
    "UPDATE channel_decision_routes SET action='deny'",
    "UPDATE channel_decision_routes SET outcome='delivery_unknown',state='handled'",
  ])("refuses changed authority after a recorded channel winner (%s)", (sql) => {
    const route = approvedWinner();
    db.exec(sql);
    expect(() =>
      store.assertApprovedConsumption("approval", route.approvalRevisionHash, now + 2),
    ).toThrow();
    expect((db.prepare("SELECT status FROM approvals").get() as Any).status).toBe("approved");
  });
  it("refuses expiry and repeated origin binding", () => {
    const route = approvedWinner();
    expect(() =>
      store.assertApprovedConsumption("approval", route.approvalRevisionHash, route.expiresAt),
    ).toThrow();
    expect(() =>
      store.recordApprovedResolution(
        { routeId: route.id, claimId: route.claimId! },
        "approval",
        route.approvalRevisionHash,
      ),
    ).toThrow();
  });
  it("refuses a missing consumption schema for a recorded channel route", () => {
    const route = approvedWinner();
    db.exec("DROP TABLE channel_approval_consumption");
    expect(() =>
      store.assertApprovedConsumption("approval", route.approvalRevisionHash, now + 2),
    ).toThrow(/schema unavailable/);
  });
  it("does not infer channel authority for an independent local winner", () => {
    const route = sent();
    store.claim(callback(route.id), now + 1);
    db.prepare("UPDATE approvals SET status='approved' WHERE id='approval'").run();
    db.prepare("UPDATE channels SET enabled=0").run();
    expect(() =>
      store.assertApprovedConsumption("approval", route.approvalRevisionHash, now + 2),
    ).not.toThrow();
  });
});

suite("channel resolution transaction guard", () => {
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
    INSERT INTO workspaces VALUES ('ws','{}'); INSERT INTO agent_roles VALUES ('bot',1,'[]','{}');
    INSERT INTO tasks VALUES ('root','ws','bot',NULL,'{"gatewayContext":"private"}','blocked');
    INSERT INTO channels VALUES ('channel','slack',1,'{}','{}');
    INSERT INTO channel_sessions VALUES ('session','channel','chat','ws','root','{"taskRequesterUserId":"actor"}');
    INSERT INTO channel_users VALUES ('channel','actor',1);`);
  });
  afterEach(() => db.close());
  async function fixture() {
    const { ApprovalStore } = await import("../../database/repositories");
    const approvals = new ApprovalStore(db);
    const request = approvals.create({
      taskId: "root",
      type: "run_command",
      description: "Review",
      details: { command: "fixture" },
      status: "pending",
      requestedAt: Date.now(),
    });
    const transport = new ChannelDecisionStore(db);
    transport.initialize();
    const route = transport.create({
      approvalId: request.id,
      sessionId: "session",
      actorId: "actor",
    });
    const delivery = transport.beginDelivery(route.id);
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
    return { approvals, request, guard: { routeId: route.id, claimId: claimed.claimId! } };
  }
  it("atomically resolves the unchanged single-use claim", async () => {
    const f = await fixture();
    expect(
      f.approvals.resolvePending(f.request.id, "approved", f.request, undefined, f.guard),
    ).toBe(true);
    expect(() =>
      f.approvals.resolvePending(f.request.id, "approved", f.request, undefined, f.guard),
    ).toThrow();
    expect(f.approvals.findById(f.request.id)?.status).toBe("approved");
  });
  it.each(["owner-config", "enabled", "actor", "workspace", "bot", "task", "request", "claim"])(
    "refuses revoked %s after claiming",
    async (change) => {
      const f = await fixture();
      if (change === "owner-config")
        db.prepare("UPDATE channels SET config = ?").run('{"ownerUserIds":[]}');
      if (change === "enabled") db.exec("UPDATE channels SET enabled = 0");
      if (change === "actor") db.exec("UPDATE channel_users SET allowed = 0");
      if (change === "workspace")
        db.prepare("UPDATE workspaces SET permissions = ?").run('{"write":false}');
      if (change === "bot") db.exec("UPDATE agent_roles SET is_active = 0");
      if (change === "task") db.exec("UPDATE tasks SET status = 'cancelled'");
      if (change === "request") db.exec("UPDATE approvals SET description = 'changed'");
      if (change === "claim") f.guard.claimId = "other-claim";
      expect(() =>
        f.approvals.resolvePending(f.request.id, "approved", f.request, undefined, f.guard),
      ).toThrow();
      expect(f.approvals.findById(f.request.id)?.status).toBe("pending");
    },
  );
  it("cannot switch the callback's action at resolution", async () => {
    const f = await fixture();
    expect(() =>
      f.approvals.resolvePending(f.request.id, "denied", f.request, undefined, f.guard),
    ).toThrow(/claim changed/);
    expect(f.approvals.findById(f.request.id)?.status).toBe("pending");
  });

  it("validates the persisted channel origin through ApprovalStore after resolution", async () => {
    const f = await fixture();
    expect(
      f.approvals.resolvePending(f.request.id, "approved", f.request, undefined, f.guard),
    ).toBe(true);
    const { approvalRequestRevisionHash } = await import("../../agent/approval-revision");
    const revision = approvalRequestRevisionHash(f.request);
    expect(f.approvals.approvedRevisionCurrent(f.request.id, revision)).toBe(true);
    db.exec("UPDATE channels SET enabled=0");
    expect(f.approvals.approvedRevisionCurrent(f.request.id, revision)).toBe(false);
    expect(f.approvals.findById(f.request.id)?.status).toBe("approved");
  });
  it("rolls back the winning decision if channel-origin persistence fails", async () => {
    const f = await fixture();
    db.exec("DROP TABLE channel_approval_consumption");
    expect(() =>
      f.approvals.resolvePending(f.request.id, "approved", f.request, undefined, f.guard),
    ).toThrow();
    expect(f.approvals.findById(f.request.id)?.status).toBe("pending");
  });
});
