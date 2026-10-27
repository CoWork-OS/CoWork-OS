import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SAFE_STORAGE_DATA_KEY_FILE,
  getSafeStorage,
  hasSafeStorageDataKey,
  initializeSafeStorageDataKey,
  isDataKeySealed,
  resetSafeStorageDataKeyForTests,
  setNativeSafeStorageForTests,
} from "../safe-storage";

/** A stand-in OS keychain: "sealing" reverses the bytes behind an "os|" marker. */
function fakeNative(options: { sync?: boolean; foreign?: boolean; backend?: string } = {}) {
  const seal = (text: string) => Buffer.concat([Buffer.from("os|"), Buffer.from(text).reverse()]);
  const open = (sealed: Buffer) => {
    if (options.foreign || sealed.subarray(0, 3).toString() !== "os|") {
      throw new Error(
        "Error while decrypting the ciphertext provided to safeStorage.decryptString.",
      );
    }
    return Buffer.from(sealed.subarray(3)).reverse().toString();
  };
  return {
    isAsyncEncryptionAvailable: vi.fn(async () => true),
    encryptStringAsync: vi.fn(async (text: string) => seal(text)),
    decryptStringAsync: vi.fn(async (sealed: Buffer) => ({ result: open(sealed) })),
    ...(options.backend ? { getSelectedStorageBackend: vi.fn(() => options.backend!) } : {}),
    ...(options.sync === false
      ? {}
      : {
          isEncryptionAvailable: vi.fn(() => true),
          encryptString: vi.fn((text: string) => seal(text)),
          decryptString: vi.fn((sealed: Buffer) => open(sealed)),
        }),
  };
}

describe("safe storage data key", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-safe-storage-"));
    resetSafeStorageDataKeyForTests();
  });

  afterEach(() => {
    setNativeSafeStorageForTests(undefined);
    resetSafeStorageDataKeyForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("creates a sealed key once, then seals and opens secrets synchronously without the OS sync API", async () => {
    const native = fakeNative();
    setNativeSafeStorageForTests(native);

    await expect(initializeSafeStorageDataKey(dir)).resolves.toBe("created");
    const file = path.join(dir, SAFE_STORAGE_DATA_KEY_FILE);
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(stored.version).toBe(1);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);

    const storage = getSafeStorage()!;
    const sealed = storage.encryptString("sk-secret");
    expect(isDataKeySealed(sealed)).toBe(true);
    expect(sealed.toString("utf8")).not.toContain("sk-secret");
    expect(storage.decryptString(sealed)).toBe("sk-secret");
    expect(storage.isEncryptionAvailable()).toBe(true);
    expect(native.encryptString).not.toHaveBeenCalled();
    expect(native.decryptString).not.toHaveBeenCalled();
    expect(native.isEncryptionAvailable).not.toHaveBeenCalled();

    // A later start opens the same key from the file.
    resetSafeStorageDataKeyForTests();
    await expect(initializeSafeStorageDataKey(dir)).resolves.toBe("loaded");
    expect(getSafeStorage()!.decryptString(sealed)).toBe("sk-secret");
  });

  it("still reads a value sealed by the OS keychain directly while Electron has the sync call", async () => {
    const native = fakeNative();
    setNativeSafeStorageForTests(native);
    const legacy = native.encryptString("legacy-token");
    await initializeSafeStorageDataKey(dir);

    expect(getSafeStorage()!.decryptString(legacy)).toBe("legacy-token");
  });

  it("refuses a legacy value it cannot read synchronously instead of returning garbage", async () => {
    const native = fakeNative({ sync: false });
    setNativeSafeStorageForTests(native);
    await initializeSafeStorageDataKey(dir);

    expect(() => getSafeStorage()!.decryptString(Buffer.from("os|nekot"))).toThrow(
      /cannot read it synchronously/,
    );
  });

  it("never replaces a key file another keychain sealed", async () => {
    setNativeSafeStorageForTests(fakeNative());
    await initializeSafeStorageDataKey(dir);
    const before = fs.readFileSync(path.join(dir, SAFE_STORAGE_DATA_KEY_FILE), "utf8");

    resetSafeStorageDataKeyForTests();
    setNativeSafeStorageForTests(fakeNative({ foreign: true }));
    await expect(initializeSafeStorageDataKey(dir)).resolves.toBe("unreadable");
    expect(hasSafeStorageDataKey()).toBe(false);
    expect(fs.readFileSync(path.join(dir, SAFE_STORAGE_DATA_KEY_FILE), "utf8")).toBe(before);
  });

  it("keeps the OS keychain sealing directly when there is no async API or keychain", async () => {
    setNativeSafeStorageForTests({
      isEncryptionAvailable: () => true,
      encryptString: (text: string) => Buffer.from(text),
      decryptString: (sealed: Buffer) => sealed.toString(),
    });
    await expect(initializeSafeStorageDataKey(dir)).resolves.toBe("unavailable");
    expect(isDataKeySealed(getSafeStorage()!.encryptString("x"))).toBe(false);

    setNativeSafeStorageForTests(null);
    expect(getSafeStorage()).toBeNull();
  });

  it("creates no key on Linux's fixed-key fallback, where the async probe still says available", async () => {
    const native = fakeNative({ backend: "basic_text" });
    setNativeSafeStorageForTests(native);

    await expect(initializeSafeStorageDataKey(dir)).resolves.toBe("unavailable");
    expect(fs.existsSync(path.join(dir, SAFE_STORAGE_DATA_KEY_FILE))).toBe(false);
    expect(native.encryptStringAsync).not.toHaveBeenCalled();
    expect(hasSafeStorageDataKey()).toBe(false);
  });

  it("still opens a key that exists on the fixed-key fallback, and still reports the backend", async () => {
    setNativeSafeStorageForTests(fakeNative({ backend: "gnome_libsecret" }));
    await initializeSafeStorageDataKey(dir);
    const sealed = getSafeStorage()!.encryptString("kept");

    resetSafeStorageDataKeyForTests();
    setNativeSafeStorageForTests(fakeNative({ backend: "basic_text" }));
    await expect(initializeSafeStorageDataKey(dir)).resolves.toBe("loaded");
    const storage = getSafeStorage()!;
    expect(storage.decryptString(sealed)).toBe("kept");
    // The browser vault refuses to store logins on this backend; it must still see it.
    expect(storage.getSelectedStorageBackend?.()).toBe("basic_text");
  });

  it("agrees on one key when another process created the file first", async () => {
    const native = fakeNative();
    setNativeSafeStorageForTests(native);
    // The other process wins the exclusive create between our read and our write.
    native.encryptStringAsync.mockImplementationOnce(async (text: string) => {
      const otherKey = Buffer.alloc(32, 7).toString("hex");
      const sealed = Buffer.concat([Buffer.from("os|"), Buffer.from(otherKey).reverse()]);
      fs.writeFileSync(
        path.join(dir, SAFE_STORAGE_DATA_KEY_FILE),
        JSON.stringify({ version: 1, sealed: sealed.toString("base64") }),
      );
      return Buffer.concat([Buffer.from("os|"), Buffer.from(text).reverse()]);
    });

    await expect(initializeSafeStorageDataKey(dir)).resolves.toBe("loaded");
    const sealed = getSafeStorage()!.encryptString("shared");
    resetSafeStorageDataKeyForTests();
    await initializeSafeStorageDataKey(dir);
    expect(getSafeStorage()!.decryptString(sealed)).toBe("shared");
  });
});
