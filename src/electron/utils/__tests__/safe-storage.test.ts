import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for getSafeStorage helper.
 *
 * The module uses `require('electron')` at runtime inside the function body.
 * In the vitest test environment, `require('electron')` resolves to the Electron
 * binary path (a string), not the Electron API object, so safeStorage is never available.
 * We test the code paths that are reachable in this environment.
 */

describe("getSafeStorage", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.resetModules();
    delete process.env.COWORK_DISABLE_OS_KEYCHAIN;
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", {
      value: originalPlatform,
    });
    vi.doUnmock("electron");
  });

  it("returns null when electron does not provide safeStorage (test env)", async () => {
    // In the test environment, require('electron') returns the binary path string,
    // not the Electron module APIs, so getSafeStorage should return null.
    const { getSafeStorage } = await import("../safe-storage");
    const result = getSafeStorage();
    expect(result).toBeNull();
  });

  it("SafeStorageLike interface shape is correct", async () => {
    const { getSafeStorage } = await import("../safe-storage");
    // Verify the function exists and returns the expected type
    expect(typeof getSafeStorage).toBe("function");
    const result = getSafeStorage();
    // In test env, always null
    expect(result).toBeNull();
  });

  it("handles errors gracefully when electron module throws", async () => {
    // Mock require to simulate electron not being available at all
    vi.doMock("electron", () => {
      throw new Error("Cannot find module");
    });
    const mod = await import("../safe-storage");
    const result = mod.getSafeStorage();
    expect(result).toBeNull();
  });

  it("supports disabling OS keychain access via COWORK_DISABLE_OS_KEYCHAIN", async () => {
    process.env.COWORK_DISABLE_OS_KEYCHAIN = "1";

    vi.doMock("electron", () => ({
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (plaintext: string) => Buffer.from(plaintext),
        decryptString: (ciphertext: Buffer) => ciphertext.toString("utf8"),
      },
    }));

    const mod = await import("../safe-storage");
    const result = mod.getSafeStorage();
    expect(result).toBeNull();
  });

  it("decrypts with legacy macOS app names and restores the current app name", async () => {
    Object.defineProperty(process, "platform", {
      value: "darwin",
    });

    let appName = "CoWork OS";
    const app = {
      getName: () => appName,
      setName: (nextName: string) => {
        appName = nextName;
      },
    };

    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (plaintext: string) => Buffer.from(plaintext),
      decryptString: vi.fn((ciphertext: Buffer) => {
        if (appName === "Electron") return `legacy:${ciphertext.toString("utf8")}`;
        throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString.");
      }),
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { decryptSafeStorageString } = await import("../safe-storage");
    const decrypted = decryptSafeStorageString(safeStorage, Buffer.from("secret"), app);

    expect(decrypted).toBe("legacy:secret");
    expect(safeStorage.decryptString).toHaveBeenCalledTimes(2);
    expect(appName).toBe("CoWork OS");
    warnSpy.mockRestore();
  });

  it("tries the package app name when macOS settings were encrypted before the display name was applied", async () => {
    Object.defineProperty(process, "platform", {
      value: "darwin",
    });

    let appName = "CoWork OS";
    const app = {
      getName: () => appName,
      setName: (nextName: string) => {
        appName = nextName;
      },
    };

    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (plaintext: string) => Buffer.from(plaintext),
      decryptString: vi.fn((ciphertext: Buffer) => {
        if (appName === "cowork-os") return `package:${ciphertext.toString("utf8")}`;
        throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString.");
      }),
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { decryptSafeStorageString } = await import("../safe-storage");
    const decrypted = decryptSafeStorageString(safeStorage, Buffer.from("secret"), app);

    expect(decrypted).toBe("package:secret");
    expect(safeStorage.decryptString).toHaveBeenCalledTimes(3);
    expect(appName).toBe("CoWork OS");
    warnSpy.mockRestore();
  });
});
