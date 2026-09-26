import { createHash } from "crypto";
import { EventEmitter } from "events";
import { PassThrough } from "stream";
import { describe, expect, it, vi } from "vitest";
import type { ChildProcess, SpawnOptions } from "child_process";
import {
  decryptLegacyMacSafeStorageRows,
  MAC_SAFE_STORAGE_MIGRATION_RESULT_PREFIX,
  migrateLegacyMacSafeStorageChannels,
  migrateLegacyMacSafeStorageSettings,
  runMacSafeStorageMigrationWorker,
  type DecryptedSecureSetting,
  type EncryptedSecureSettingRow,
} from "../mac-safe-storage-migration";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function row(category: string, plaintext: string): EncryptedSecureSettingRow {
  const encrypted_data = `os:${Buffer.from(category).toString("base64")}`;
  return { category, encrypted_data, checksum: sha256(encrypted_data) };
}

describe("macOS safeStorage legacy migration", () => {
  it("decrypts only checksum-valid os-encrypted object settings", () => {
    const valid = row("user-profile", JSON.stringify({ facts: [] }));
    const invalidChecksum = { ...valid, checksum: "invalid" };
    const nonOs = { ...valid, encrypted_data: "app:legacy" };
    const decryptString = vi.fn((ciphertext: Buffer) => {
      const category = ciphertext.toString("utf8");
      if (category === "bad") throw new Error("wrong Keychain identity");
      return JSON.stringify({ category });
    });

    const result = decryptLegacyMacSafeStorageRows(
      [
        { ...valid, encrypted_data: `os:${Buffer.from("user-profile").toString("base64")}` },
        invalidChecksum,
        nonOs,
        { ...valid, encrypted_data: `os:${Buffer.from("bad").toString("base64")}` },
      ],
      { isEncryptionAvailable: () => true, encryptString: vi.fn(), decryptString },
    );

    expect(result).toEqual([{ category: "user-profile", settings: { category: "user-profile" } }]);
  });

  it("does not rewrite settings that are already readable with the current identity", async () => {
    const rows = [row("user-profile", "{}"), row("appearance", "{}"), row("missing", "{}")];
    const recovered: DecryptedSecureSetting[] = rows.map(({ category }) => ({
      category,
      settings: { restored: category },
    }));
    const input = new PassThrough();
    const output = new PassThrough();
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, {
      stdin: input,
      stdout: output,
      kill: vi.fn(),
    });
    const spawnProcess = vi.fn((_executable: string, _args: string[], _options: SpawnOptions) => {
      input.once("finish", () => {
        output.end(`${MAC_SAFE_STORAGE_MIGRATION_RESULT_PREFIX}${JSON.stringify(recovered)}\n`);
        output.once("end", () => child.emit("close", 0));
      });
      return child;
    });
    const save = vi.fn();
    const loadWithStatus = vi.fn(({} = {}) => ({ status: "decryption_failed" }));
    loadWithStatus.mockImplementation((category: string) => ({
      status:
        category === "appearance"
          ? "success"
          : category === "missing"
            ? "not_found"
            : "decryption_failed",
    }));
    const logger = { info: vi.fn(), warn: vi.fn() };

    const migratedCount = await migrateLegacyMacSafeStorageSettings({
      platform: "darwin",
      database: { prepare: vi.fn(() => ({ all: () => rows })) },
      repository: { loadWithStatus, save },
      executable: "/Applications/CoWork OS.app/Contents/MacOS/CoWork OS",
      appPath: "/Applications/CoWork OS.app/Contents/Resources/app.asar",
      logger,
      legacyAppNames: ["cowork-os"],
      spawnProcess: spawnProcess as never,
      env: { ELECTRON_RUN_AS_NODE: "1" },
    });

    expect(migratedCount).toBe(1);
    expect(spawnProcess).toHaveBeenCalledWith(
      "/Applications/CoWork OS.app/Contents/MacOS/CoWork OS",
      [
        "/Applications/CoWork OS.app/Contents/Resources/app.asar",
        "--cowork-safe-storage-migration-worker",
        "cowork-os",
      ],
      expect.objectContaining({
        env: {},
        stdio: ["pipe", "pipe", "ignore"],
      }),
    );
    expect(save).toHaveBeenCalledWith(
      "user-profile",
      { restored: "user-profile" },
      { allowUnreadableOverwrite: true },
    );
    expect(logger.info).toHaveBeenCalledWith(
      "Migrated encrypted settings from the legacy macOS Keychain identity.",
      expect.objectContaining({ migratedCount: 1 }),
    );
  });

  it("tries known legacy app names and migrates only data decrypted by a candidate", async () => {
    const rows = [row("voice", "ciphertext")];
    const decrypted = [{ category: "voice", settings: { restored: true } }];
    const attemptedNames: string[] = [];
    const spawnProcess = vi.fn((_executable: string, args: string[]) => {
      attemptedNames.push(args.at(-1) || "");
      const input = new PassThrough();
      const output = new PassThrough();
      const child = new EventEmitter() as ChildProcess;
      Object.assign(child, { stdin: input, stdout: output, kill: vi.fn() });
      input.once("finish", () => {
        const result = args.at(-1) === "Electron" ? decrypted : [];
        output.end(`${MAC_SAFE_STORAGE_MIGRATION_RESULT_PREFIX}${JSON.stringify(result)}\n`);
        output.once("end", () => child.emit("close", 0));
      });
      return child;
    });
    const saved = new Set<string>();
    const save = vi.fn((category: string) => saved.add(category));
    const loadWithStatus = vi.fn((category: string) =>
      saved.has(category)
        ? { status: "success", data: { restored: true } }
        : { status: "decryption_failed" },
    );

    const migratedCount = await migrateLegacyMacSafeStorageSettings({
      platform: "darwin",
      database: { prepare: vi.fn(() => ({ all: () => rows })) },
      repository: { loadWithStatus, save },
      executable: "/Applications/CoWork OS.app/Contents/MacOS/CoWork OS",
      appPath: "/Applications/CoWork OS.app/Contents/Resources/app.asar",
      logger: { info: vi.fn(), warn: vi.fn() },
      spawnProcess: spawnProcess as never,
    });

    expect(attemptedNames).toEqual(["cowork-os", "Electron"]);
    expect(migratedCount).toBe(1);
    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith(
      "voice",
      { restored: true },
      { allowUnreadableOverwrite: true },
    );
  });

  it("does not run or touch the database outside macOS", async () => {
    const prepare = vi.fn();
    const spawnProcess = vi.fn();

    await expect(
      migrateLegacyMacSafeStorageSettings({
        platform: "linux",
        database: { prepare },
        repository: { loadWithStatus: vi.fn(), save: vi.fn() },
        executable: "electron",
        appPath: ".",
        logger: { info: vi.fn(), warn: vi.fn() },
        spawnProcess: spawnProcess as never,
      }),
    ).resolves.toBe(0);

    expect(prepare).not.toHaveBeenCalled();
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("re-encrypts decryptable legacy channel configs under the current Keychain identity", async () => {
    const originalConfig = `enc:${Buffer.from("legacy-channel-ciphertext").toString("base64")}`;
    const rows = [{ id: "email-channel", config: originalConfig }];
    const plaintext = JSON.stringify({ oauthToken: "private-test-value" });
    const recovered: DecryptedSecureSetting[] = [
      { category: "email-channel", settings: { oauthToken: "private-test-value" } },
    ];
    const input = new PassThrough();
    const output = new PassThrough();
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, { stdin: input, stdout: output, kill: vi.fn() });
    const spawnProcess = vi.fn((_executable: string, _args: string[], _options: SpawnOptions) => {
      input.once("finish", () => {
        output.end(`${MAC_SAFE_STORAGE_MIGRATION_RESULT_PREFIX}${JSON.stringify(recovered)}\n`);
        output.once("end", () => child.emit("close", 0));
      });
      return child;
    });
    const update = vi.fn(() => ({ changes: 1 }));
    const prepare = vi.fn((sql: string) =>
      sql.startsWith("SELECT") ? { all: () => rows, run: update } : { all: () => [], run: update },
    );
    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: vi.fn((value: string) => Buffer.from(`current:${value}`)),
      decryptString: vi.fn(),
    };
    const logger = { info: vi.fn(), warn: vi.fn() };

    const migratedCount = await migrateLegacyMacSafeStorageChannels({
      platform: "darwin",
      database: { prepare },
      safeStorage,
      executable: "/Applications/CoWork OS.app/Contents/MacOS/CoWork OS",
      appPath: "/Applications/CoWork OS.app/Contents/Resources/app.asar",
      logger,
      legacyAppNames: ["cowork-os"],
      spawnProcess: spawnProcess as never,
    });

    expect(migratedCount).toBe(1);
    expect(safeStorage.encryptString).toHaveBeenCalledWith(plaintext);
    expect(update).toHaveBeenCalledWith(
      `enc:${Buffer.from(`current:${plaintext}`).toString("base64")}`,
      expect.any(Number),
      "email-channel",
      originalConfig,
    );
    expect(logger.info).toHaveBeenCalledWith(
      "Migrated channel configs from the legacy macOS Keychain identity.",
      expect.objectContaining({ migratedCount: 1 }),
    );
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain("private-test-value");
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("private-test-value");
  });

  it("leaves a channel config unchanged when it changes during legacy decryption", async () => {
    const originalConfig = `enc:${Buffer.from("legacy-channel-ciphertext").toString("base64")}`;
    const recovered: DecryptedSecureSetting[] = [
      { category: "email-channel", settings: { oauthToken: "private-test-value" } },
    ];
    const input = new PassThrough();
    const output = new PassThrough();
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, { stdin: input, stdout: output, kill: vi.fn() });
    const spawnProcess = vi.fn(() => {
      input.once("finish", () => {
        output.end(`${MAC_SAFE_STORAGE_MIGRATION_RESULT_PREFIX}${JSON.stringify(recovered)}\n`);
        output.once("end", () => child.emit("close", 0));
      });
      return child;
    });
    const update = vi.fn(() => ({ changes: 0 }));
    const logger = { info: vi.fn(), warn: vi.fn() };

    const migratedCount = await migrateLegacyMacSafeStorageChannels({
      platform: "darwin",
      database: {
        prepare: (sql: string) =>
          sql.startsWith("SELECT")
            ? { all: () => [{ id: "email-channel", config: originalConfig }], run: update }
            : { all: () => [], run: update },
      },
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (value: string) => Buffer.from(value),
        decryptString: vi.fn(),
      },
      executable: "electron",
      appPath: ".",
      logger,
      legacyAppNames: ["cowork-os"],
      spawnProcess: spawnProcess as never,
    });

    expect(migratedCount).toBe(0);
    expect(update).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Number),
      "email-channel",
      originalConfig,
    );
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("runs the worker protocol without logging decrypted profile data", async () => {
    const plaintext = JSON.stringify({ facts: [{ value: "private" }] });
    const inputRow = row("user-profile", plaintext);
    const writeResult = vi.fn();

    await runMacSafeStorageMigrationWorker({
      platform: "darwin",
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: vi.fn(),
        decryptString: () => plaintext,
      },
      readInput: async () => JSON.stringify([inputRow]),
      writeResult,
    });

    expect(writeResult).toHaveBeenCalledOnce();
    expect(writeResult.mock.calls[0]?.[0]).toContain(MAC_SAFE_STORAGE_MIGRATION_RESULT_PREFIX);
    expect(writeResult.mock.calls[0]?.[0]).toContain('"category":"user-profile"');
  });
});
