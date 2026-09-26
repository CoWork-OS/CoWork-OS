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

describeWithSqlite("SecureSettingsRepository keychain identity check", () => {
  let tmpDir: string;
  let previousUserDataDir: string | undefined;
  let db: Database.Database;
  let Repository: typeof import("../SecureSettingsRepository").SecureSettingsRepository;

  const create = () => new Repository(db);
  const rowFor = (category: string) =>
    db.prepare("SELECT encrypted_data FROM secure_settings WHERE category = ?").get(category) as
      | { encrypted_data: string }
      | undefined;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-keychain-identity-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tmpDir;
    keychain.key = "identity-a";
    keychain.available = true;
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE secure_settings (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL UNIQUE,
        encrypted_data TEXT NOT NULL,
        checksum TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    vi.resetModules();
    Repository = (await import("../SecureSettingsRepository")).SecureSettingsRepository;
    (Repository as unknown as { instance: unknown }).instance = null;
  });

  afterEach(() => {
    db.close();
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("adopts the key on a fresh profile and verifies it on later launches", () => {
    expect(create().verifyKeychainIdentity()).toBe("created");
    expect(create().verifyKeychainIdentity()).toBe("verified");
  });

  it("adopts the key when it can read existing settings", () => {
    create().save("voice", { provider: "elevenlabs" });
    expect(create().verifyKeychainIdentity()).toBe("created");
  });

  it("refuses writes after the keychain key changes instead of re-encrypting", () => {
    const first = create();
    first.verifyKeychainIdentity();
    first.save("voice", { provider: "elevenlabs" });
    const original = rowFor("voice")?.encrypted_data;

    keychain.key = "identity-b";
    const repository = create();
    expect(repository.verifyKeychainIdentity()).toBe("mismatch");
    expect(repository.isKeychainIdentityMismatch()).toBe(true);

    repository.save("voice", { provider: "changed" });
    repository.save("tray", { enabled: true });

    expect(rowFor("voice")?.encrypted_data).toBe(original);
    expect(rowFor("tray")).toBeUndefined();

    keychain.key = "identity-a";
    expect(create().load<{ provider: string }>("voice")).toEqual({ provider: "elevenlabs" });
  });

  it("detects a changed key before any canary exists when no existing setting is readable", () => {
    create().save("voice", { provider: "elevenlabs" });
    keychain.key = "identity-b";

    expect(create().verifyKeychainIdentity()).toBe("mismatch");
  });

  it("archives unreadable settings and resumes saving when the new key is adopted", () => {
    const first = create();
    first.verifyKeychainIdentity();
    first.save("voice", { provider: "elevenlabs" });

    keychain.key = "identity-b";
    const repository = create();
    repository.verifyKeychainIdentity();

    expect(repository.adoptCurrentKeychainIdentity()).toEqual(["voice"]);
    expect(repository.isKeychainIdentityMismatch()).toBe(false);
    expect(rowFor("voice")).toBeUndefined();
    const archived = db
      .prepare("SELECT category, status FROM secure_settings_unreadable_backup")
      .all();
    expect(archived).toEqual([{ category: "voice", status: "decryption_failed" }]);

    repository.save("voice", { provider: "fresh" });
    expect(create().verifyKeychainIdentity()).toBe("verified");
    expect(create().load<{ provider: string }>("voice")).toEqual({ provider: "fresh" });
  });

  it("does nothing when OS keychain encryption is unavailable", () => {
    keychain.available = false;
    expect(create().verifyKeychainIdentity()).toBe("not_applicable");
  });
});
