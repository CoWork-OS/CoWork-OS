import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  canonicalizeRecurringApprovalOperation,
  fingerprintRecurringApprovalOperation,
} from "../recurring-approval-service";
import { RecurringApprovalService } from "../recurring-approval-repository-facades";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE workspaces (id TEXT PRIMARY KEY);
    CREATE TABLE approvals (id TEXT PRIMARY KEY);
    CREATE TABLE recurring_approval_rules (
      id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL UNIQUE,
      tool_name TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      policy_version TEXT NOT NULL,
      effect TEXT NOT NULL,
      scope_preview TEXT NOT NULL,
      operation_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER,
      created_by_approval_id TEXT
    );
  `);
  return db;
}

const baseInput = {
  workspaceId: "workspace-1",
  toolName: "http_request",
  toolInput: { url: "https://api.example.com/items", headers: { Authorization: "secret" } },
  approvalType: "network_access",
  command: null,
  path: null,
  serverName: null,
  scope: { kind: "domain" as const, domain: "api.example.com", toolName: "http_request" },
};

describe("RecurringApprovalService", () => {
  it("canonicalizes argument order and redacts sensitive values", () => {
    const first = canonicalizeRecurringApprovalOperation(baseInput);
    const second = canonicalizeRecurringApprovalOperation({
      ...baseInput,
      toolInput: {
        headers: { Authorization: "different-secret" },
        url: "https://api.example.com/items",
      },
    });
    expect(first).toBe(second);
    expect(first).not.toContain("secret");
    expect(fingerprintRecurringApprovalOperation(baseInput)).not.toBe(
      fingerprintRecurringApprovalOperation({
        ...baseInput,
        toolInput: {
          headers: { Authorization: "different-secret" },
          url: "https://api.example.com/items",
        },
      }),
    );
  });

  it("changes identity when the workspace, target, or policy changes", () => {
    const original = fingerprintRecurringApprovalOperation(baseInput);
    expect(
      fingerprintRecurringApprovalOperation({
        ...baseInput,
        workspaceId: "workspace-2",
      }),
    ).not.toBe(original);
    expect(
      fingerprintRecurringApprovalOperation({
        ...baseInput,
        toolInput: { url: "https://other.example.com/items" },
      }),
    ).not.toBe(original);
    expect(
      fingerprintRecurringApprovalOperation({
        ...baseInput,
        policyVersion: "permission-operation-v2",
      }),
    ).not.toBe(original);
  });

  it("matches only active rules and revocation takes effect immediately", async () => {
    const db = createDb();
    const service = new RecurringApprovalService(db);
    const created = await service.create(
      {
        ...baseInput,
        effect: "allow",
        scopePreview: "api.example.com",
        expiresAt: 2_000,
      },
      1_000,
    );
    expect((await service.findActive(baseInput, 1_500))?.summary.id).toBe(created.id);
    expect(await service.findActive(baseInput, 2_000)).toBeNull();

    await service.create(
      {
        ...baseInput,
        effect: "allow",
        scopePreview: "api.example.com",
        expiresAt: 20_000,
      },
      3_000,
    );
    expect(await service.revoke(created.id)).toBe(true);
    expect(await service.findActive(baseInput, 3_100)).toBeNull();
    db.close();
  });

  it("keeps a revocation when an approval decided before it is written late", async () => {
    const db = createDb();
    const service = new RecurringApprovalService(db);
    const input = { ...baseInput, effect: "allow" as const, scopePreview: "api.example.com" };
    const created = await service.create({ ...input, expiresAt: 50_000 }, 1_000);
    expect(await service.revoke(created.id, 5_000)).toBe(true);

    // Decided at 4 000, before the revocation, but persisted at 6 000.
    const late = await service.create({ ...input, expiresAt: 60_000, decidedAt: 4_000 }, 6_000);
    expect(late.revokedAt).toBe(5_000);
    expect(await service.findActive(baseInput, 6_100)).toBeNull();

    // A decision made after the revocation grants again.
    await service.create({ ...input, expiresAt: 60_000, decidedAt: 7_000 }, 7_000);
    expect((await service.findActive(baseInput, 7_100))?.summary.id).toBe(created.id);
    db.close();
  });
});
