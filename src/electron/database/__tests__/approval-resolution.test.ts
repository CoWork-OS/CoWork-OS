import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ApprovalStore } from "../repositories";
import { DatabaseManager } from "../schema";
import { nativeSqliteAvailable } from "../../memory/__tests__/memory-items-test-db";
const suite = nativeSqliteAvailable ? describe : describe.skip;
suite("atomic pending approval resolution", () => {
  let first: Database.Database, second: Database.Database, dir: string;
  beforeEach(async () => {
    const { default: Sqlite } = await import("better-sqlite3");
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-approval-cas-"));
    first = new Sqlite(path.join(dir, "test.db"));
    first.pragma("journal_mode = WAL");
    first.exec(
      `CREATE TABLE approvals (id TEXT PRIMARY KEY, task_id TEXT, type TEXT, description TEXT, details TEXT, status TEXT, requested_at INTEGER, resolved_at INTEGER, resolved_by_principal_id TEXT, resolved_by_role TEXT)`,
    );
    second = new Sqlite(path.join(dir, "test.db"));
  });
  afterEach(() => {
    second.close();
    first.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  function pending(requestedAt = Date.now()) {
    return new ApprovalStore(first).create({
      taskId: "task",
      type: "run_command",
      description: "Run reviewed command",
      details: { command: "node --version", revisionHash: "r1" },
      status: "pending",
      requestedAt,
    });
  }
  it("permits only one response across two connections and preserves the winner's attribution", () => {
    const request = pending(),
      a = new ApprovalStore(first),
      b = new ApprovalStore(second);
    expect(
      a.resolvePending(request.id, "approved", request, { principalId: "actor", role: "user" }),
    ).toBe(true);
    expect(b.resolvePending(request.id, "denied", request, { principalId: "other" })).toBe(false);
    expect(b.update(request.id, "denied")).toBe(false);
    expect(first.prepare("SELECT status, resolved_by_principal_id FROM approvals").get()).toEqual({
      status: "approved",
      resolved_by_principal_id: "actor",
    });
  });
  it("a timeout/denial winner cannot later become approved", () => {
    const request = pending();
    expect(new ApprovalStore(second).update(request.id, "denied")).toBe(true);
    expect(new ApprovalStore(first).resolvePending(request.id, "approved", request)).toBe(false);
    expect(new ApprovalStore(first).findById(request.id)?.status).toBe("denied");
  });
  it.each(["details", "description", "type", "task_id", "requested_at"])(
    "refuses a stale %s revision",
    (field) => {
      const request = pending();
      first
        .prepare(`UPDATE approvals SET ${field} = ? WHERE id = ?`)
        .run(
          field === "requested_at"
            ? request.requestedAt + 1
            : field === "details"
              ? "{}"
              : "changed",
          request.id,
        );
      expect(new ApprovalStore(second).resolvePending(request.id, "approved", request)).toBe(false);
      expect(new ApprovalStore(first).findById(request.id)?.status).toBe("pending");
    },
  );
  it("an expired request cannot be approved, but can be denied", () => {
    const request = pending(Date.now() - 300001),
      store = new ApprovalStore(second);
    expect(store.resolvePending(request.id, "approved", request)).toBe(false);
    expect(store.resolvePending(request.id, "denied", request)).toBe(true);
  });
});

suite("responsibility action review schema upgrade", () => {
  it("reopens an older profile additively without changing private roles or inventing approval receipts", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-action-review-upgrade-"));
    const dbPath = path.join(dir, "profile.db");
    let manager: DatabaseManager | undefined;
    try {
      manager = new DatabaseManager({ dbPath });
      const db = manager.getDatabase();
      const now = Date.now();
      db.prepare(
        `INSERT INTO workspaces (id, name, path, created_at, last_used_at, permissions)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run("ws-private", "Private workspace", dir, now, now, JSON.stringify({ read: true }));
      db.prepare(
        `INSERT INTO agent_roles
           (id, name, display_name, system_prompt, capabilities, is_system, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "role-private",
        "renamed-private-bot",
        "Renamed private bot",
        "Keep this private custom prompt intact.",
        JSON.stringify(["code"]),
        0,
        0,
        now,
        now,
      );
      db.prepare(
        `INSERT INTO tasks (id, title, prompt, status, workspace_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "task-private",
        "Pending task",
        "Original task prompt",
        "waiting_approval",
        "ws-private",
        now,
        now,
      );

      const pendingDetails = { command: "node --version", legacy: true };
      db.prepare(
        `INSERT INTO approvals (id, task_id, type, description, details, status, requested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "approval-pending-legacy",
        "task-private",
        "run_command",
        "Ordinary pending approval",
        JSON.stringify(pendingDetails),
        "pending",
        now,
      );
      const approvedDetails = {
        path: "notes.txt",
        content: "legacy decision has no one-time authority receipt",
        responsibilityActionReview: { version: 1 },
      };
      db.prepare(
        `INSERT INTO approvals (id, task_id, type, description, details, status, requested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "approval-approved-legacy",
        "task-private",
        "workspace_write",
        "Legacy approved write",
        JSON.stringify(approvedDetails),
        "approved",
        now,
      );
      const originalRole = db
        .prepare(
          `SELECT id, name, display_name, system_prompt, capabilities, is_system, is_active, created_at, updated_at
           FROM agent_roles WHERE id = ?`,
        )
        .get("role-private");
      const originalPending = db
        .prepare("SELECT * FROM approvals WHERE id = ?")
        .get("approval-pending-legacy");
      const originalApproved = db
        .prepare("SELECT * FROM approvals WHERE id = ?")
        .get("approval-approved-legacy");

      manager.close();
      manager = undefined;
      const { default: Sqlite } = await import("better-sqlite3");
      const oldProfile = new Sqlite(dbPath);
      oldProfile.exec(
        "DROP TABLE responsibility_action_review_claims; DROP TABLE responsibility_action_review_decisions;",
      );
      oldProfile.close();

      manager = new DatabaseManager({ dbPath });
      const upgraded = manager.getDatabase();
      expect(
        upgraded
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all()
          .map((row: { name: string }) => row.name),
      ).toEqual(
        expect.arrayContaining([
          "responsibility_action_review_decisions",
          "responsibility_action_review_claims",
        ]),
      );
      expect(
        upgraded
          .prepare(
            `SELECT id, name, display_name, system_prompt, capabilities, is_system, is_active, created_at, updated_at
             FROM agent_roles WHERE id = ?`,
          )
          .get("role-private"),
      ).toEqual(originalRole);
      expect(
        upgraded.prepare("SELECT * FROM approvals WHERE id = ?").get("approval-pending-legacy"),
      ).toEqual(originalPending);
      expect(
        upgraded.prepare("SELECT * FROM approvals WHERE id = ?").get("approval-approved-legacy"),
      ).toEqual(originalApproved);
      expect(
        upgraded.prepare("SELECT * FROM responsibility_action_review_decisions").all(),
      ).toEqual([]);
      expect(upgraded.prepare("SELECT * FROM responsibility_action_review_claims").all()).toEqual(
        [],
      );
    } finally {
      manager?.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
