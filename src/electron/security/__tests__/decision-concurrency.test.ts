import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nativeSqliteAvailable = await import("better-sqlite3")
  .then((module) => {
    try {
      new module.default(":memory:").close();
      return true;
    } catch {
      return false;
    }
  })
  .catch(() => false);

// A fake OS keychain whose key can be swapped to simulate an identity change.
const keychain = { key: "identity-a" };
vi.mock("../../utils/safe-storage", () => ({
  getSafeStorage: () => ({
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`${keychain.key}|${plaintext}`),
    decryptString: (ciphertext: Buffer) => {
      const [key, ...rest] = ciphertext.toString().split("|");
      if (key !== keychain.key) throw new Error("Error while decrypting the ciphertext");
      return rest.join("|");
    },
  }),
}));

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

// Security decisions under concurrency (DB5). Two connections to one profile database
// stand in for two processes (desktop and CLI, or two windows).
describeWithSqlite("security decisions across connections", () => {
  let tmpDir: string;
  let previousUserDataDir: string | undefined;
  const cleanups: Array<() => void> = [];

  type Modules = {
    schema: typeof import("../../database/schema");
    repo: typeof import("../../database/SecureSettingsRepository");
    credentials: typeof import("../protected-credential-service");
    permissions: typeof import("../permission-settings-manager");
  };
  let m: Modules;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-decisions-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tmpDir;
    keychain.key = "identity-a";
    vi.resetModules();
    m = {
      schema: await import("../../database/schema"),
      repo: await import("../../database/SecureSettingsRepository"),
      credentials: await import("../protected-credential-service"),
      permissions: await import("../permission-settings-manager"),
    };
  });

  afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** "Other process" first, then this process: the last repository is the singleton. */
  const twoProcesses = () => {
    const manager = new m.schema.DatabaseManager();
    cleanups.push(() => manager.close());
    const otherDb = new Database(manager.getDatabasePath());
    cleanups.push(() => otherDb.close());
    const other = new m.repo.SecureSettingsRepository(otherDb);
    const db = manager.getDatabase();
    const here = new m.repo.SecureSettingsRepository(db);
    m.permissions.PermissionSettingsManager.clearCache();
    return { db, otherDb, here, other };
  };

  it("keeps a revocation that lands while a credential is being resolved", () => {
    const { db, otherDb, here, other } = twoProcesses();
    const service = new m.credentials.ProtectedCredentialService(db, here);
    const request = service.createRequest({
      name: "API",
      destinationAllowlist: ["api.example.com"],
    });
    const credential = service.fulfillRequest(request.id, "secret");
    const otherService = new m.credentials.ProtectedCredentialService(otherDb, other);

    // The other process revokes between this process's read and its lastUsedAt write.
    const load = here.readRecord.bind(here);
    let raced = false;
    vi.spyOn(here, "readRecord").mockImplementation((category) => {
      const result = load(category);
      if (!raced) {
        raced = true;
        otherService.revokeCredential(credential.id);
      }
      return result as never;
    });

    expect(() => service.resolveForDestination(credential.id, "https://api.example.com")).toThrow(
      "Credential is unavailable.",
    );
    expect(otherService.listCredentials()[0]?.revokedAt).toBeDefined();
    // And nothing resolves it afterwards.
    expect(() => service.resolveForDestination(credential.id, "api.example.com")).toThrow(
      "Credential is unavailable.",
    );
  });

  it("fulfils a request and stores its credential together, once", () => {
    const { db, here } = twoProcesses();
    const service = new m.credentials.ProtectedCredentialService(db, here);
    const request = service.createRequest({
      name: "API",
      destinationAllowlist: ["api.example.com"],
    });
    service.fulfillRequest(request.id, "first");
    expect(() => service.fulfillRequest(request.id, "second")).toThrow(/no longer pending/);
    expect(service.listCredentials()).toHaveLength(1);
    expect(service.resolveForDestination(service.listCredentials()[0]!.id, "api.example.com")).toBe(
      "first",
    );
  });

  it("refuses a revocation under a changed keychain key instead of reporting success", () => {
    const { db, here } = twoProcesses();
    const service = new m.credentials.ProtectedCredentialService(db, here);
    const request = service.createRequest({
      name: "API",
      destinationAllowlist: ["api.example.com"],
    });
    const credential = service.fulfillRequest(request.id, "secret");
    expect(here.verifyKeychainIdentity()).toBe("created");
    keychain.key = "identity-b";
    const changed = new m.repo.SecureSettingsRepository(db);
    expect(changed.verifyKeychainIdentity()).toBe("mismatch");
    const refused = new m.credentials.ProtectedCredentialService(db, changed);
    expect(() => refused.revokeCredential(credential.id)).toThrow(
      m.repo.SecureSettingsWriteRefusedError,
    );
  });

  it("applies another process's permission edit at the next check without a cache clear", () => {
    const { other } = twoProcesses();
    const manager = m.permissions.PermissionSettingsManager;
    expect(manager.loadSettings().defaultMode).toBe("dangerous_only");
    other.save("permissions", { version: 2, defaultMode: "plan", rules: [] });
    expect(manager.loadSettings().defaultMode).toBe("plan");
  });

  it("keeps a rule remembered by an approval when a stale settings edit is saved", () => {
    const { other } = twoProcesses();
    const manager = m.permissions.PermissionSettingsManager;
    const snapshot = manager.loadSettings();

    // Another process remembers a rule "in profile" after this window loaded settings.
    const rule = {
      effect: "deny" as const,
      source: "profile" as const,
      scope: { kind: "tool" as const, toolName: "open_url" },
      createdAt: 1,
    };
    other.save("permissions", { ...snapshot, rules: [...snapshot.rules, rule] });

    // This window saves an edit made from its older snapshot.
    manager.saveSettings({ ...snapshot, defaultMode: "plan" });
    const stored = other.load<{ defaultMode: string; rules: unknown[] }>("permissions");
    expect(stored?.defaultMode).toBe("plan");
    expect(stored?.rules).toEqual([expect.objectContaining({ scope: rule.scope })]);
  });
});
