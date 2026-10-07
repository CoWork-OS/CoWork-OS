import { createHash } from "node:crypto";
import { approvalRequestRevisionHash } from "../../agent/approval-revision";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ApprovalRequest, WorkspacePermissions } from "../../../shared/types";
import { ApprovalStore } from "../repositories";
import { approvalDraftReferences, assertApprovalDraftsCurrent } from "../approval-drafts";
import { ChannelDecisionStore } from "../../gateway/ChannelDecisionStore";
import { nativeSqliteAvailable } from "../../memory/__tests__/memory-items-test-db";
const suite = nativeSqliteAvailable ? describe : describe.skip;
suite("trusted approval draft revisions", () => {
  let db: Database.Database, dir: string, approvals: ApprovalStore;
  const permissions: WorkspacePermissions = {
    read: true,
    write: true,
    delete: false,
    shell: false,
    network: false,
  };
  beforeEach(async () => {
    const { default: Sqlite } = await import("better-sqlite3");
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-draft-binding-"));
    db = new Sqlite(":memory:");
    db.exec(`CREATE TABLE approvals (id TEXT PRIMARY KEY, task_id TEXT, type TEXT, description TEXT, details TEXT, status TEXT, requested_at INTEGER, resolved_at INTEGER, resolved_by_principal_id TEXT, resolved_by_role TEXT);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, workspace_id TEXT, assigned_agent_role_id TEXT, parent_task_id TEXT, agent_config TEXT, status TEXT);
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, path TEXT, permissions TEXT);
    CREATE TABLE workspace_permission_rules (id TEXT PRIMARY KEY, workspace_id TEXT, effect TEXT);
    CREATE TABLE agent_roles (id TEXT PRIMARY KEY, is_active INTEGER, capabilities TEXT, tool_restrictions TEXT);
    CREATE TABLE channel_sessions (id TEXT PRIMARY KEY, channel_id TEXT, chat_id TEXT, workspace_id TEXT, task_id TEXT, context TEXT);
    CREATE TABLE channels (id TEXT PRIMARY KEY, type TEXT, enabled INTEGER, config TEXT, security_config TEXT);
    CREATE TABLE channel_users (channel_id TEXT, channel_user_id TEXT, allowed INTEGER);
    INSERT INTO tasks VALUES ('task','ws','bot',NULL,'{"gatewayContext":"private"}','blocked');
    INSERT INTO agent_roles VALUES ('bot',1,'[]','{}');
    INSERT INTO channels VALUES ('channel','slack',1,'{}','{}');
    INSERT INTO channel_sessions VALUES ('session','channel','chat','ws','task','{"taskRequesterUserId":"actor"}');
    INSERT INTO channel_users VALUES ('channel','actor',1);`);
    db.prepare("INSERT INTO workspaces VALUES ('ws',?,?)").run(dir, JSON.stringify(permissions));
    fs.writeFileSync(path.join(dir, "draft.md"), "original private draft");
    approvals = new ApprovalStore(db);
  });
  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  function pending(
    details: Record<string, unknown> = { reviewFiles: ["draft.md"] },
    trusted = true,
  ): ApprovalRequest {
    return approvals.create(
      {
        taskId: "task",
        type: "data_export",
        description: "Send reviewed draft",
        details,
        status: "pending",
        requestedAt: Date.now(),
      },
      trusted ? { path: dir, permissions } : undefined,
    );
  }
  it("binds adapter bytes only when their hash and size match trusted file capture", () => {
    const text = "original private draft";
    const expected = {
      reference: "draft.md",
      sha256: createHash("sha256").update(text).digest("hex"),
      size: Buffer.byteLength(text),
    };
    expect(
      pending({ reviewFiles: ["draft.md"], expectedDraftRevisions: [expected] }).details
        .draftRevision.state,
    ).toBe("bound");
    fs.writeFileSync(path.join(dir, "draft.md"), "replacement");
    const refused = pending({ reviewFiles: ["draft.md"], expectedDraftRevisions: [expected] });
    expect(refused.details.draftRevision.state).toBe("unavailable");
    expect(() => assertApprovalDraftsCurrent(db, refused)).toThrow("trusted revision");
  });
  it.each([null, [], [{ reference: "draft.md", sha256: "forged", size: 1 }]])(
    "rejects invalid byte constraints %j",
    (expected) => {
      expect(
        pending({ reviewFiles: ["draft.md"], expectedDraftRevisions: expected }).details
          .draftRevision.state,
      ).toBe("unavailable");
    },
  );
  it.each(["unavailable", "missing-binding", "wrong-version", "invalid-references"])(
    "refuses consumption of an explicitly reviewed draft with %s capture",
    (scenario) => {
      const request = pending(
        { reviewFiles: scenario === "invalid-references" ? "draft.md" : ["draft.md"] },
        scenario !== "unavailable",
      );
      if (scenario === "missing-binding") delete request.details.draftRevision;
      if (scenario === "wrong-version") request.details.draftRevision.version = 99;
      db.prepare("UPDATE approvals SET details=? WHERE id=?").run(
        JSON.stringify(request.details),
        request.id,
      );
      expect(approvals.resolvePending(request.id, "approved", request)).toBe(true);
      expect(
        approvals.approvedRevisionCurrent(request.id, approvalRequestRevisionHash(request)),
      ).toBe(false);
    },
  );
  it("does not accept an unsupported captured version for an implicit file dependency", () => {
    const request = pending({ filePath: "draft.md" });
    expect(request.details.draftRevision.state).toBe("bound");
    request.details.draftRevision.version = 99;
    db.prepare("UPDATE approvals SET details=? WHERE id=?").run(
      JSON.stringify(request.details),
      request.id,
    );
    expect(approvals.resolvePending(request.id, "approved", request)).toBe(true);
    expect(
      approvals.approvedRevisionCurrent(request.id, approvalRequestRevisionHash(request)),
    ).toBe(false);
  });
  it("captures actual bytes and discards caller hashes without persisting file contents", () => {
    const request = pending({ reviewFiles: ["draft.md"], draftRevision: { sha256: "forged" } });
    expect(request.details.draftRevision).toMatchObject({
      version: 1,
      state: "bound",
      workspaceId: "ws",
      entries: [{ status: "present", size: 22, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }],
    });
    expect(JSON.stringify(request)).not.toContain("original private draft");
    expect(JSON.stringify(request)).not.toContain("forged");
    expect(() => assertApprovalDraftsCurrent(db, request)).not.toThrow();
    expect(approvals.findById(request.id)?.details).toEqual(request.details);
  });
  it.each(["change", "delete", "symlink"])("refuses a %s after capture", (operation) => {
    const request = pending(),
      file = path.join(dir, "draft.md");
    if (operation === "change") fs.writeFileSync(file, "changed draft");
    else {
      fs.unlinkSync(file);
      if (operation === "symlink") fs.symlinkSync("other.md", file);
    }
    expect(() => assertApprovalDraftsCurrent(db, request)).toThrow();
  });
  it("binds absence and refuses a newly created destination", () => {
    const request = pending({ reviewFiles: ["new.md"] });
    expect(request.details.draftRevision.entries[0].status).toBe("missing");
    expect(() => assertApprovalDraftsCurrent(db, request)).not.toThrow();
    fs.writeFileSync(path.join(dir, "new.md"), "unexpected");
    expect(() => assertApprovalDraftsCurrent(db, request)).toThrow(/revision changed/);
  });
  it("requires trusted read context even when a caller supplies valid looking hashes", () => {
    const request = pending(
      { reviewFiles: ["draft.md"], draftRevision: { version: 1, state: "bound" } },
      false,
    );
    expect(request.details.draftRevision.state).toBe("unavailable");
    expect(() => assertApprovalDraftsCurrent(db, request)).toThrow(/trusted revision/);
  });
  it.each([null, "draft.md", [""], ["a", "b", "c", "d", "e"]])(
    "rejects malformed or excessive declarations (%j)",
    (reviewFiles) => {
      const request = pending({ reviewFiles });
      expect(request.details.draftRevision).toMatchObject({
        state: "unavailable",
        reason: "invalid_references",
      });
      expect(() => assertApprovalDraftsCurrent(db, request)).toThrow();
    },
  );
  it("refuses oversized files and files outside the workspace", () => {
    fs.writeFileSync(path.join(dir, "large"), Buffer.alloc(4 * 1024 * 1024 + 1));
    for (const file of ["large", "../outside"]) {
      const request = pending({ reviewFiles: [file] });
      expect(request.details.draftRevision.state).toBe("unavailable");
      expect(() => assertApprovalDraftsCurrent(db, request)).toThrow();
    }
  });
  it("checks stored workspace read revocation and workspace moves", () => {
    const request = pending();
    db.prepare("UPDATE workspaces SET permissions = ?").run(
      JSON.stringify({ ...permissions, read: false }),
    );
    expect(() => assertApprovalDraftsCurrent(db, request)).toThrow(/read scope/);
    db.prepare("UPDATE workspaces SET permissions = ?, path = ?").run(
      JSON.stringify(permissions),
      path.join(dir, "moved"),
    );
    expect(() => assertApprovalDraftsCurrent(db, request)).toThrow(/read scope/);
  });
  it("refuses denied effective task read scope", () => {
    const request = approvals.create(
      {
        taskId: "task",
        type: "workspace_write",
        description: "write",
        details: { params: { path: "draft.md" } },
        status: "pending",
        requestedAt: Date.now(),
      },
      { path: dir, permissions: { ...permissions, read: false } },
    );
    expect(request.details.draftRevision.state).toBe("unavailable");
  });
  it("extracts known paths, deduplicates them, and does not scan shell text", () => {
    expect(
      approvalDraftReferences({
        type: "workspace_write",
        details: { path: "draft.md", params: { path: "draft.md" } },
      }),
    ).toEqual(["draft.md"]);
    expect(
      approvalDraftReferences({ type: "run_command", details: { command: "cat draft.md" } }),
    ).toEqual([]);
    expect(pending({ draftRevision: { state: "forged" } }).details).toEqual({});
  });
  it("refuses stale bytes at the atomic channel transition after a successful claim", () => {
    const request = pending(),
      store = new ChannelDecisionStore(db);
    store.initialize();
    const route = store.create({ approvalId: request.id, sessionId: "session", actorId: "actor" });
    const delivery = store.beginDelivery(route.id);
    store.delivered(route.id, delivery.deliveryClaimId!, "message");
    const claimed = store.claim({
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
    fs.writeFileSync(path.join(dir, "draft.md"), "changed after claim");
    expect(() =>
      approvals.resolvePending(request.id, "approved", request, undefined, {
        routeId: route.id,
        claimId: claimed.claimId!,
      }),
    ).toThrow(/revision changed/);
    expect(approvals.findById(request.id)?.status).toBe("pending");
  });
  it("captures the local preview and keeps it tied to the requested file revision", () => {
    fs.writeFileSync(path.join(dir, "draft.md"), "PRIVATE REVIEW TEXT".repeat(200));
    const request = pending({ reviewFiles: ["draft.md"] });
    const preview = approvals.draftPreviews(request.id, approvalRequestRevisionHash(request))[0];
    expect(preview.text).toHaveLength(2000);
    expect(preview.text).toContain("PRIVATE REVIEW TEXT");
    expect(preview.truncated).toBe(true);
    expect(JSON.stringify(request)).not.toContain("PRIVATE REVIEW TEXT");
    fs.writeFileSync(path.join(dir, "draft.md"), "changed");
    expect(approvals.findById(request.id)?.details.draftRevision.entries[0]).not.toHaveProperty(
      "preview",
    );
    expect(() => approvals.draftPreviews(request.id, approvalRequestRevisionHash(request))).toThrow(
      "revision changed",
    );
    expect(() => assertApprovalDraftsCurrent(db, request)).toThrow("revision changed");
  });
  it("does not add text previews for unknown or binary file formats", () => {
    fs.writeFileSync(path.join(dir, "draft.pdf"), "PRIVATE BINARY CONTENT");
    const request = pending({ reviewFiles: ["draft.pdf"] });
    expect(request.details.draftRevision.entries[0]).not.toHaveProperty("preview");
  });
  it("refuses stale request identity, expired decisions and revoked read permission", () => {
    const request = pending();
    const revision = approvalRequestRevisionHash(request);
    expect(() => approvals.draftPreviews(request.id, "f".repeat(64))).toThrow("changed or expired");
    db.prepare("UPDATE workspaces SET permissions=?").run(
      JSON.stringify({ ...permissions, read: false }),
    );
    expect(() => approvals.draftPreviews(request.id, revision)).toThrow();
    db.prepare("UPDATE workspaces SET permissions=?").run(JSON.stringify(permissions));
    db.prepare("UPDATE approvals SET requested_at=? WHERE id=?").run(
      Date.now() - 300001,
      request.id,
    );
    expect(() => approvals.draftPreviews(request.id, revision)).toThrow("changed or expired");
  });
});
