import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  ProtectedCredentialService,
  type ProtectedCredentialStoreLike,
} from "../protected-credential-service";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE protected_credential_requests (
      id TEXT PRIMARY KEY,
      task_id TEXT,
      name TEXT NOT NULL,
      destination_allowlist_json TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      resolved_at INTEGER,
      credential_id TEXT
    );
    CREATE TABLE protected_credential_audit (
      id TEXT PRIMARY KEY,
      request_id TEXT,
      credential_id TEXT,
      action TEXT NOT NULL,
      destination TEXT,
      created_at INTEGER NOT NULL
    );
  `);
  return db;
}

function createStore(): ProtectedCredentialStoreLike {
  let value: Record<string, unknown> | undefined;
  return {
    load: () => value as Any,
    save: (_category, settings) => {
      value = settings as Record<string, unknown>;
    },
  };
}

describe("ProtectedCredentialService", () => {
  it("stores values through the secure store but exposes metadata only", () => {
    const db = createDb();
    const service = new ProtectedCredentialService(db, createStore());
    const request = service.createRequest(
      {
        name: "Example API",
        destinationAllowlist: ["https://API.Example.com/v1"],
      },
      1_000,
    );
    const credential = service.fulfillRequest(request.id, "top-secret", 2_000);

    expect(credential).not.toHaveProperty("value");
    expect(service.listCredentials()).toEqual([
      expect.objectContaining({
        id: credential.id,
        name: "Example API",
        destinationAllowlist: ["api.example.com"],
      }),
    ]);
    expect(service.resolveForDestination(credential.id, "https://api.example.com/v1", 3_000)).toBe(
      "top-secret",
    );
    expect(() =>
      service.resolveForDestination(credential.id, "https://evil.example.com", 4_000),
    ).toThrow("not authorized");
    expect(service.listRequests({ includeResolved: true })[0]).not.toHaveProperty("value");
    expect(
      db
        .prepare(
          "SELECT destination, action FROM protected_credential_audit WHERE action = 'resolved'",
        )
        .get(),
    ).toEqual({
      destination: "api.example.com",
      action: "resolved",
    });
    db.close();
  });

  it("revokes credentials immediately and expires pending requests", () => {
    const db = createDb();
    const service = new ProtectedCredentialService(db, createStore());
    const request = service.createRequest(
      {
        name: "Expiring",
        destinationAllowlist: ["example.com"],
        expiresAt: 2_000,
      },
      1_000,
    );
    expect(service.listRequests({ includeResolved: true }, 2_000)[0].status).toBe("expired");
    expect(() => service.fulfillRequest(request.id, "value", 2_001)).toThrow("no longer pending");

    const active = service.createRequest(
      { name: "Active", destinationAllowlist: ["example.com"] },
      3_000,
    );
    const credential = service.fulfillRequest(active.id, "value", 3_001);
    expect(service.revokeCredential(credential.id, 3_002)).toBe(true);
    expect(() => service.resolveForDestination(credential.id, "example.com", 3_003)).toThrow(
      "unavailable",
    );
    db.close();
  });
});
