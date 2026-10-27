import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decryptOsSealedAsync,
  getSafeStorage,
  initializeSafeStorageDataKey,
  isDataKeySealed,
  resetSafeStorageDataKeyForTests,
  setNativeSafeStorageForTests,
} from "../../utils/safe-storage";

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
const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

/** A stand-in OS keychain with both the sync and the async API. */
const osSeal = (text: string) => Buffer.from(`os|${text}`);
const osOpen = (sealed: Buffer) => {
  const text = sealed.toString();
  if (!text.startsWith("os|")) throw new Error("Error while decrypting the ciphertext");
  return text.slice(3);
};
const native = {
  isEncryptionAvailable: () => true,
  encryptString: osSeal,
  decryptString: osOpen,
  isAsyncEncryptionAvailable: async () => true,
  encryptStringAsync: async (text: string) => osSeal(text),
  decryptStringAsync: async (sealed: Buffer) => ({ result: osOpen(sealed) }),
};

describeWithSqlite("secure settings data key rewrap", () => {
  let tmpDir: string;
  let previousUserDataDir: string | undefined;
  let db: Database.Database;
  let mod: typeof import("../SecureSettingsRepository");

  const stored = () =>
    db
      .prepare("SELECT encrypted_data, revision FROM secure_settings WHERE category = 'voice'")
      .get() as { encrypted_data: string; revision: number };

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-data-key-rewrap-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tmpDir;
    resetSafeStorageDataKeyForTests();
    setNativeSafeStorageForTests(native);
    db = new Database(path.join(tmpDir, "settings.db"));
    mod = await import("../SecureSettingsRepository");
  });

  afterEach(() => {
    db.close();
    setNativeSafeStorageForTests(undefined);
    resetSafeStorageDataKeyForTests();
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("moves a keychain-sealed row and its encrypted: values onto the data key", async () => {
    // Written before this version: the record and an inner value sealed by the keychain.
    const before = new mod.SecureSettingsRepository(db);
    const innerLegacy = `encrypted:${osSeal("el-key").toString("base64")}`;
    before.save("voice", { provider: "elevenlabs", apiKey: innerLegacy });
    expect(before.verifyKeychainIdentity()).toBe("created");
    expect(isDataKeySealed(Buffer.from(stored().encrypted_data.slice(3), "base64"))).toBe(false);
    const revision = stored().revision;

    await initializeSafeStorageDataKey(tmpDir);
    const repo = new mod.SecureSettingsRepository(db);
    await expect(repo.rewrapOsSealedRows(decryptOsSealedAsync)).resolves.toBe(1);

    const row = stored();
    expect(isDataKeySealed(Buffer.from(row.encrypted_data.slice(3), "base64"))).toBe(true);
    expect(row.revision).toBeGreaterThan(revision);
    const loaded = repo.load<{ provider: string; apiKey: string }>("voice")!;
    expect(loaded.provider).toBe("elevenlabs");
    const inner = Buffer.from(loaded.apiKey.slice("encrypted:".length), "base64");
    expect(isDataKeySealed(inner)).toBe(true);
    expect(getSafeStorage()!.decryptString(inner)).toBe("el-key");

    // The keychain identity canary moved too and still verifies.
    const canary = (
      db
        .prepare("SELECT encrypted_data FROM secure_settings_keychain_canary WHERE id = 1")
        .get() as {
        encrypted_data: string;
      }
    ).encrypted_data;
    expect(isDataKeySealed(Buffer.from(canary.slice(3), "base64"))).toBe(true);
    expect(repo.verifyKeychainIdentity()).toBe("verified");

    // Nothing left to move.
    await expect(repo.rewrapOsSealedRows(decryptOsSealedAsync)).resolves.toBe(0);
  });

  it("does not overwrite a row another writer changed while it was decrypting", async () => {
    new mod.SecureSettingsRepository(db).save("voice", { provider: "old" });
    await initializeSafeStorageDataKey(tmpDir);
    const repo = new mod.SecureSettingsRepository(db);
    const other = new mod.SecureSettingsRepository(new Database(path.join(tmpDir, "settings.db")));

    const rewrapped = await repo.rewrapOsSealedRows(async (sealed) => {
      other.save("voice", { provider: "new" });
      return decryptOsSealedAsync(sealed);
    });

    expect(rewrapped).toBe(0);
    expect(repo.load<{ provider: string }>("voice")?.provider).toBe("new");
  });
});
