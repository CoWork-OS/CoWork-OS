import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decryptOsSealedAsync,
  getSafeStorage,
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
/** An older Electron, as the previous CoWork version used it: sync API only. */
const syncOnly = {
  isEncryptionAvailable: () => true,
  encryptString: osSeal,
  decryptString: osOpen,
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
    setNativeSafeStorageForTests(syncOnly);
    const before = new mod.SecureSettingsRepository(db);
    const innerLegacy = `encrypted:${osSeal("el-key").toString("base64")}`;
    before.save("voice", { provider: "elevenlabs", apiKey: innerLegacy });
    expect(before.verifyKeychainIdentity()).toBe("created");
    expect(isDataKeySealed(Buffer.from(stored().encrypted_data.slice(3), "base64"))).toBe(false);
    const revision = stored().revision;

    setNativeSafeStorageForTests(native);
    const repo = new mod.SecureSettingsRepository(db);
    await expect(repo.openDataKey(tmpDir)).resolves.toBe("created");
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

  it("keeps the sealed key in the database and restores a lost key file from it", async () => {
    const repo = new mod.SecureSettingsRepository(db);
    await expect(repo.openDataKey(tmpDir)).resolves.toBe("created");
    repo.save("voice", { provider: "kept" });
    const keyFile = path.join(tmpDir, "safe-storage-key.json");
    const sealedInFile = JSON.parse(fs.readFileSync(keyFile, "utf8")).sealed;
    const keyRow = db
      .prepare(
        "SELECT encrypted_data FROM secure_settings WHERE category = '__safe_storage_data_key__'",
      )
      .get() as { encrypted_data: string };
    expect(keyRow.encrypted_data).toBe(`key:${sealedInFile}`);
    // It is not a settings category.
    expect(repo.listCategories()).not.toContain("__safe_storage_data_key__");

    // The file is lost; the next start restores it from the database.
    fs.rmSync(keyFile);
    resetSafeStorageDataKeyForTests();
    const next = new mod.SecureSettingsRepository(db);
    await expect(next.openDataKey(tmpDir)).resolves.toBe("loaded");
    expect(JSON.parse(fs.readFileSync(keyFile, "utf8")).sealed).toBe(sealedInFile);
    expect(next.load<{ provider: string }>("voice")?.provider).toBe("kept");
  });

  it("never creates a new key while secrets are sealed with a lost one", async () => {
    const repo = new mod.SecureSettingsRepository(db);
    await repo.openDataKey(tmpDir);
    repo.save("voice", { provider: "sealed" });
    // Both copies are gone, but the data-key secret remains.
    fs.rmSync(path.join(tmpDir, "safe-storage-key.json"));
    db.prepare("DELETE FROM secure_settings WHERE category = '__safe_storage_data_key__'").run();
    resetSafeStorageDataKeyForTests();

    const next = new mod.SecureSettingsRepository(db);
    await expect(next.openDataKey(tmpDir)).resolves.toBe("unreadable");
    expect(fs.existsSync(path.join(tmpDir, "safe-storage-key.json"))).toBe(false);
  });

  it("re-seals a key only a former keychain identity can open", async () => {
    const repo = new mod.SecureSettingsRepository(db);
    await repo.openDataKey(tmpDir);
    repo.save("voice", { provider: "before-rename" });
    const keyFile = path.join(tmpDir, "safe-storage-key.json");
    const formerSealed = JSON.parse(fs.readFileSync(keyFile, "utf8")).sealed;
    const keyHex = osOpen(Buffer.from(formerSealed, "base64"));
    resetSafeStorageDataKeyForTests();

    // The app's keychain identity changed: the current keychain seals differently.
    const renamedSeal = (text: string) => Buffer.from(`new|${text}`);
    const renamedOpen = (sealed: Buffer) => {
      const text = sealed.toString();
      if (!text.startsWith("new|")) throw new Error("Error while decrypting the ciphertext");
      return text.slice(4);
    };
    setNativeSafeStorageForTests({
      isEncryptionAvailable: () => true,
      encryptString: renamedSeal,
      decryptString: renamedOpen,
      isAsyncEncryptionAvailable: async () => true,
      encryptStringAsync: async (text: string) => renamedSeal(text),
      decryptStringAsync: async (sealed: Buffer) => ({ result: renamedOpen(sealed) }),
    });
    const recover = vi.fn(async (sealed: string) => (sealed === formerSealed ? keyHex : null));
    const next = new mod.SecureSettingsRepository(db);
    await expect(next.openDataKey(tmpDir, recover)).resolves.toBe("recovered");
    expect(next.load<{ provider: string }>("voice")?.provider).toBe("before-rename");
    // Re-sealed for the current identity, in both places.
    const resealed = JSON.parse(fs.readFileSync(keyFile, "utf8")).sealed;
    expect(Buffer.from(resealed, "base64").toString().startsWith("new|")).toBe(true);
    resetSafeStorageDataKeyForTests();
    await expect(new mod.SecureSettingsRepository(db).openDataKey(tmpDir)).resolves.toBe("loaded");
  });

  it("does not overwrite a row another writer changed while it was decrypting", async () => {
    setNativeSafeStorageForTests(syncOnly);
    new mod.SecureSettingsRepository(db).save("voice", { provider: "old" });
    setNativeSafeStorageForTests(native);
    const repo = new mod.SecureSettingsRepository(db);
    await repo.openDataKey(tmpDir);
    const other = new mod.SecureSettingsRepository(new Database(path.join(tmpDir, "settings.db")));

    const rewrapped = await repo.rewrapOsSealedRows(async (sealed) => {
      other.save("voice", { provider: "new" });
      return decryptOsSealedAsync(sealed);
    });

    expect(rewrapped).toBe(0);
    expect(repo.load<{ provider: string }>("voice")?.provider).toBe("new");
  });
});
