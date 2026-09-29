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
const keychain = { key: "identity-a", available: true };
vi.mock("../../utils/safe-storage", () => ({
  getSafeStorage: () => ({
    isEncryptionAvailable: () => keychain.available,
    encryptString: (plaintext: string) => Buffer.from(`${keychain.key}|${plaintext}`),
    decryptString: (ciphertext: Buffer) => {
      const [key, ...rest] = ciphertext.toString().split("|");
      if (key !== keychain.key) throw new Error("Error while decrypting the ciphertext");
      return rest.join("|");
    },
  }),
}));

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

type RepositoryModule = typeof import("../SecureSettingsRepository");

// Revision-checked settings writes (async SQLite plan, DB5). Two connections to one file
// stand in for two processes sharing a profile.
describeWithSqlite("SecureSettingsRepository revisions", () => {
  let tmpDir: string;
  let previousUserDataDir: string | undefined;
  let dbPath: string;
  const connections: Database.Database[] = [];
  let mod: RepositoryModule;

  const open = () => {
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    connections.push(db);
    return db;
  };
  const repository = (db = open()) => {
    const created = new mod.SecureSettingsRepository(db);
    return { db, repo: created };
  };
  const revisionOf = (db: Database.Database, category: string) =>
    (
      db.prepare("SELECT revision FROM secure_settings WHERE category = ?").get(category) as
        | { revision: number }
        | undefined
    )?.revision ?? null;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-settings-revisions-"));
    dbPath = path.join(tmpDir, "settings.db");
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tmpDir;
    keychain.key = "identity-a";
    keychain.available = true;
    vi.resetModules();
    mod = await import("../SecureSettingsRepository");
    (mod.SecureSettingsRepository as unknown as { instance: unknown }).instance = null;
  });

  afterEach(() => {
    for (const db of connections.splice(0)) db.close();
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads a pre-revision profile and starts revising it on the next write", () => {
    // Ciphertext from a scratch repository; the profile table predates revisions.
    const scratch = new Database(":memory:");
    connections.push(scratch);
    const record = new mod.SecureSettingsRepository(scratch).encryptRecord({ theme: "dark" });
    const legacy = open();
    legacy.exec(`
      CREATE TABLE secure_settings (
        id TEXT PRIMARY KEY, category TEXT NOT NULL UNIQUE, encrypted_data TEXT NOT NULL,
        checksum TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
    `);
    legacy
      .prepare("INSERT INTO secure_settings VALUES ('legacy-id', 'appearance', ?, ?, 1, 1)")
      .run(record.encryptedData, record.checksum);

    const { db, repo } = repository(open());
    expect(repo.readRecord("appearance")).toMatchObject({
      status: "success",
      data: { theme: "dark" },
      revision: 0,
    });
    repo.save("appearance", { theme: "light" });
    expect(revisionOf(db, "appearance")).toBeGreaterThan(0);
    expect(repo.load("appearance")).toEqual({ theme: "light" });
  });

  it("re-applies an update on top of a concurrent write from another connection", () => {
    const a = repository();
    const b = repository();
    a.repo.save("permissions", { rules: ["base"] });
    let interfered = false;
    const result = a.repo.update<{ rules: string[] }>("permissions", (current) => {
      if (!interfered) {
        interfered = true;
        // Another process writes between this read and the commit.
        b.repo.save("permissions", { rules: [...(current?.rules ?? []), "from-b"] });
      }
      return { rules: [...(current?.rules ?? []), "from-a"] };
    });
    expect(result.value).toEqual({ rules: ["base", "from-b", "from-a"] });
    expect(b.repo.load("permissions")).toEqual({ rules: ["base", "from-b", "from-a"] });
  });

  it("gives up after its retries instead of overwriting a row that keeps changing", () => {
    const a = repository();
    const b = repository();
    a.repo.save("guardrails", { n: 0 });
    let n = 0;
    expect(() =>
      a.repo.update<{ n: number }>(
        "guardrails",
        (current) => {
          b.repo.save("guardrails", { n: ++n + 100 });
          return { n: (current?.n ?? 0) + 1 };
        },
        { maxAttempts: 3 },
      ),
    ).toThrow(mod.SecureSettingsConflictError);
    expect(b.repo.load("guardrails")).toEqual({ n: 103 });
  });

  it("refuses writes under a changed keychain key and says so", () => {
    const { repo } = repository();
    repo.save("permissions", { rules: ["kept"] });
    expect(repo.verifyKeychainIdentity()).toBe("created");
    keychain.key = "identity-b";
    const { db, repo: after } = repository();
    expect(after.verifyKeychainIdentity()).toBe("mismatch");
    const before = revisionOf(db, "permissions");

    expect(after.save("permissions", { rules: ["lost"] })).toBe(false);
    expect(() => after.update("permissions", () => ({ rules: ["lost"] }))).toThrow(
      mod.SecureSettingsWriteRefusedError,
    );
    expect(revisionOf(db, "permissions")).toBe(before);
    keychain.key = "identity-a";
    expect(repository().repo.load("permissions")).toEqual({ rules: ["kept"] });
  });

  it("does not read-modify-write an unreadable row unless asked, and backs it up when it does", () => {
    const { db, repo } = repository();
    repo.save("protected-credentials", { version: 1, credentials: ["secret"] });
    keychain.key = "identity-b";
    const { repo: other } = repository(db);
    expect(() => other.update("protected-credentials", () => ({ version: 1 }))).toThrow(
      mod.SecureSettingsUnreadableError,
    );
    other.update("protected-credentials", () => ({ version: 1, credentials: [] }), {
      replaceUnreadable: true,
    });
    const backups = db
      .prepare("SELECT status FROM secure_settings_unreadable_backup WHERE category = ?")
      .all("protected-credentials");
    expect(backups).toEqual([{ status: "decryption_failed" }]);
  });

  it("adopting a new keychain key keeps a row another writer replaced in the meantime", () => {
    const { db, repo } = repository();
    repo.save("llm", { key: "old" });
    repo.save("voice", { key: "old" });
    expect(repo.verifyKeychainIdentity()).toBe("created");
    keychain.key = "identity-b";
    const { repo: adopting } = repository(db);
    expect(adopting.verifyKeychainIdentity()).toBe("mismatch");
    const other = repository();
    // Between adoption's read and its transaction, another writer re-enters `voice`.
    let raced = false;
    vi.spyOn(db, "transaction").mockImplementation(((fn: () => unknown) => {
      if (!raced) {
        raced = true;
        other.repo.save("voice", { key: "fresh" }, { allowUnreadableOverwrite: true });
      }
      return Database.prototype.transaction.call(db, fn);
    }) as never);
    expect(adopting.adoptCurrentKeychainIdentity()).toEqual(["llm"]);
    vi.restoreAllMocks();
    expect(other.repo.load("voice")).toEqual({ key: "fresh" });
    expect(adopting.load("llm")).toBeUndefined();
  });

  it("merges a plain save with fields another writer changed since this process read", () => {
    const a = repository();
    const b = repository();
    a.repo.save("appearance", { theme: "dark", density: "cozy", accent: "blue" });
    expect(a.repo.load("appearance")).toEqual({ theme: "dark", density: "cozy", accent: "blue" });
    // Another process changes one field after this process read the settings.
    b.repo.save("appearance", { theme: "dark", density: "compact", accent: "blue" });
    // This process saves a change to a different field from its older copy.
    expect(a.repo.save("appearance", { theme: "light", density: "cozy", accent: "blue" })).toBe(
      true,
    );
    expect(b.repo.load("appearance")).toEqual({
      theme: "light",
      density: "compact",
      accent: "blue",
    });
  });

  it("keeps this save's value where both writers changed the same field", () => {
    const a = repository();
    const b = repository();
    a.repo.save("tray", { mode: "a", other: 1 });
    a.repo.load("tray");
    b.repo.save("tray", { mode: "b", other: 2 });
    a.repo.save("tray", { mode: "c", other: 1 });
    expect(b.repo.load("tray")).toEqual({ mode: "c", other: 2 });
  });

  it("refuses to replace a keychain-encrypted row in a process without that keychain", () => {
    const { db, repo } = repository();
    repo.save("llm", { apiKey: "desktop-secret" });
    // The daemon or CLI: same profile, no OS keychain.
    keychain.available = false;
    const { repo: headless } = repository(db);
    expect(headless.loadWithStatus("llm", { logErrors: false }).status).toBe(
      "os_encryption_unavailable",
    );
    expect(headless.save("llm", { apiKey: "headless" })).toBe(false);
    expect(() =>
      headless.update("llm", () => ({ apiKey: "headless" }), { replaceUnreadable: true }),
    ).toThrow(mod.SecureSettingsWriteRefusedError);
    expect(db.prepare("SELECT COUNT(*) AS n FROM secure_settings_unreadable_backup").get()).toEqual(
      { n: 0 },
    );
    // Rows it can read (app-level encryption) are still written.
    expect(headless.save("tray", { mode: "headless" })).toBe(true);
    keychain.available = true;
    expect(repository(db).repo.load("llm")).toEqual({ apiKey: "desktop-secret" });
  });

  it("never reuses a revision after a delete", () => {
    const { db, repo } = repository();
    repo.save("tray", { a: 1 });
    const first = revisionOf(db, "tray")!;
    repo.delete("tray");
    repo.save("tray", { a: 2 });
    expect(revisionOf(db, "tray")!).toBeGreaterThan(first);
  });

  it("re-checks a category it found unreadable once another process rewrites it", () => {
    const a = repository();
    keychain.key = "identity-b";
    a.repo.save("voice", { provider: "b" });
    keychain.key = "identity-a";
    expect(a.repo.loadWithStatus("voice", { logErrors: false }).status).toBe("decryption_failed");
    // Another process, holding the current key, repairs the row.
    const b = repository();
    b.repo.save("voice", { provider: "repaired" });
    expect(a.repo.load("voice")).toEqual({ provider: "repaired" });
  });

  it("deletes through an update and reports the new revision", () => {
    const { db, repo } = repository();
    repo.save("queue", { max: 1 });
    expect(repo.update("queue", () => mod.DELETE_SECURE_SETTINGS)).toEqual({
      value: undefined,
      revision: null,
    });
    expect(revisionOf(db, "queue")).toBeNull();
    const created = repo.update<{ max: number }>("queue", (current) => ({
      max: (current?.max ?? 0) + 5,
    }));
    expect(created).toEqual({ value: { max: 5 }, revision: revisionOf(db, "queue") });
  });
});
