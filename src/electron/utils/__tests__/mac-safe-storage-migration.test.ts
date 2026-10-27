import { createHash } from "crypto";
import { EventEmitter } from "events";
import { PassThrough } from "stream";
import { describe, expect, it, vi } from "vitest";
import type { ChildProcess, SpawnOptions } from "child_process";
import {
  decryptLegacyMacSafeStorageRows,
  MAC_SAFE_STORAGE_MIGRATION_RESULT_PREFIX,
  migrateLegacyMacSafeStorageChannels,
  migrateLegacyMacSafeStorageMailbox,
  migrateLegacyMacSafeStorageSettings,
  recoverDataKeyFromLegacyIdentity,
  runMacSafeStorageMigrationWorker,
  type DecryptedSecureSetting,
  type EncryptedSecureSettingRow,
} from "../mac-safe-storage-migration";
import { LEGACY_MAC_SAFE_STORAGE_APP_NAMES } from "../mac-safe-storage-identity";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function row(category: string): EncryptedSecureSettingRow {
  const encrypted_data = `os:${Buffer.from(category).toString("base64")}`;
  return { category, encrypted_data, checksum: sha256(encrypted_data) };
}

describe("macOS safeStorage legacy migration", () => {
  it("decrypts only checksum-valid os-encrypted object settings", async () => {
    const valid = row("user-profile");
    const invalidChecksum = { ...valid, checksum: "invalid" };
    const nonOs = { ...valid, encrypted_data: "app:legacy" };
    const decrypt = vi.fn(async (ciphertext: Buffer) => {
      const category = ciphertext.toString("utf8");
      // The async OS call yields null for a value another Keychain identity sealed.
      if (category === "bad") return null;
      return JSON.stringify({ category });
    });

    const result = await decryptLegacyMacSafeStorageRows(
      [
        { ...valid, encrypted_data: `os:${Buffer.from("user-profile").toString("base64")}` },
        invalidChecksum,
        nonOs,
        { ...valid, encrypted_data: `os:${Buffer.from("bad").toString("base64")}` },
      ],
      decrypt,
    );

    expect(result).toEqual([{ category: "user-profile", settings: { category: "user-profile" } }]);
  });

  it("does not rewrite settings that are already readable with the current identity", async () => {
    const rows = [row("user-profile"), row("appearance"), row("missing")];
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
    const loadWithStatus = vi
      .fn<(category: string) => { status: string }>()
      .mockReturnValue({ status: "decryption_failed" });
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

  it("recovers the data key through the legacy worker, trying each former identity", async () => {
    const keyHex = "ab".repeat(32);
    const attemptedNames: string[] = [];
    let sentRows: Array<{ encrypted_data: string; format?: string }> = [];
    const spawnProcess = vi.fn((_executable: string, args: string[]) => {
      const name = args.at(-1) || "";
      attemptedNames.push(name);
      const input = new PassThrough();
      const output = new PassThrough();
      const child = new EventEmitter() as ChildProcess;
      Object.assign(child, { stdin: input, stdout: output, kill: vi.fn() });
      let received = "";
      input.on("data", (chunk) => (received += chunk));
      input.once("finish", () => {
        sentRows = JSON.parse(received);
        // Only the second identity sealed this key.
        const result =
          name === "cowork-os" ? [{ category: "data-key", settings: { text: keyHex } }] : [];
        output.end(`${MAC_SAFE_STORAGE_MIGRATION_RESULT_PREFIX}${JSON.stringify(result)}\n`);
        output.once("end", () => child.emit("close", 0));
      });
      return child;
    });

    await expect(
      recoverDataKeyFromLegacyIdentity({
        platform: "darwin",
        sealedKey: "c2VhbGVk",
        executable: "electron",
        appPath: ".",
        logger: { info: vi.fn(), warn: vi.fn() },
        legacyAppNames: ["Electron", "cowork-os"],
        spawnProcess: spawnProcess as never,
      }),
    ).resolves.toBe(keyHex);
    expect(attemptedNames).toEqual(["Electron", "cowork-os"]);
    expect(sentRows).toEqual([
      expect.objectContaining({ encrypted_data: "os:c2VhbGVk", format: "text" }),
    ]);
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

    expect(attemptedNames).toEqual([...LEGACY_MAC_SAFE_STORAGE_APP_NAMES]);
    expect(attemptedNames).toEqual(expect.arrayContaining(["cowork-oss", "Chromium"]));
    expect(migratedCount).toBe(1);
    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith(
      "voice",
      { restored: true },
      { allowUnreadableOverwrite: true },
    );
  });

  it("does not launch legacy workers when every setting is readable", async () => {
    const spawnProcess = vi.fn();

    const migratedCount = await migrateLegacyMacSafeStorageSettings({
      platform: "darwin",
      database: { prepare: vi.fn(() => ({ all: () => [row("voice", "ciphertext")] })) },
      repository: {
        loadWithStatus: vi.fn(() => ({ status: "success", data: {} })),
        save: vi.fn(),
      },
      executable: "electron",
      appPath: ".",
      logger: { info: vi.fn(), warn: vi.fn() },
      spawnProcess: spawnProcess as never,
    });

    expect(migratedCount).toBe(0);
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("does not launch legacy workers for channel configs the current identity can read", async () => {
    const spawnProcess = vi.fn();

    const migratedCount = await migrateLegacyMacSafeStorageChannels({
      platform: "darwin",
      database: {
        prepare: vi.fn(() => ({
          all: () => [
            { id: "email-channel", config: `enc:${Buffer.from("x").toString("base64")}` },
          ],
          run: vi.fn(),
        })),
      },
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: vi.fn(),
        decryptString: vi.fn(() => "{}"),
      },
      executable: "electron",
      appPath: ".",
      logger: { info: vi.fn(), warn: vi.fn() },
      spawnProcess: spawnProcess as never,
    });

    expect(migratedCount).toBe(0);
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("probes channel configs with the async OS call, never the deprecated sync one", async () => {
    const { setNativeSafeStorageForTests } = await import("../safe-storage");
    // Only the async API answers; this config is readable by the current identity.
    setNativeSafeStorageForTests({
      decryptStringAsync: vi.fn(async () => ({ result: "{}" })),
    });
    const decryptString = vi.fn(() => "{}");
    const spawnProcess = vi.fn();
    try {
      const migratedCount = await migrateLegacyMacSafeStorageChannels({
        platform: "darwin",
        database: {
          prepare: vi.fn(() => ({
            all: () => [
              { id: "email-channel", config: `enc:${Buffer.from("x").toString("base64")}` },
            ],
            run: vi.fn(),
          })),
        },
        safeStorage: { isEncryptionAvailable: () => true, encryptString: vi.fn(), decryptString },
        executable: "electron",
        appPath: ".",
        logger: { info: vi.fn(), warn: vi.fn() },
        spawnProcess: spawnProcess as never,
      });

      expect(migratedCount).toBe(0);
      expect(spawnProcess).not.toHaveBeenCalled();
      expect(decryptString).not.toHaveBeenCalled();
    } finally {
      setNativeSafeStorageForTests(undefined);
    }
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

  it("does not touch channel storage when OS keychain access is disabled", async () => {
    const prepare = vi.fn();
    await expect(
      migrateLegacyMacSafeStorageChannels({
        platform: "darwin",
        database: { prepare },
        safeStorage: null,
        executable: "electron",
        appPath: ".",
        logger: { info: vi.fn(), warn: vi.fn() },
      }),
    ).resolves.toBe(0);
    expect(prepare).not.toHaveBeenCalled();
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
      // The current identity cannot read legacy configs.
      decryptString: vi.fn(() => {
        throw new Error("wrong keychain identity");
      }),
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
        decryptString: vi.fn(() => {
          throw new Error("wrong keychain identity");
        }),
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
      decrypt: async () => plaintext,
      readInput: async () => JSON.stringify([inputRow]),
      writeResult,
    });

    expect(writeResult).toHaveBeenCalledOnce();
    expect(writeResult.mock.calls[0]?.[0]).toContain(MAC_SAFE_STORAGE_MIGRATION_RESULT_PREFIX);
    expect(writeResult.mock.calls[0]?.[0]).toContain('"category":"user-profile"');
  });
});

describe("macOS safeStorage legacy migration: mailbox content", () => {
  const b64 = (value: string) => Buffer.from(value).toString("base64");
  // The current identity reads "current:" ciphertexts; the "cowork-os" worker reads "legacy:".
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from(`current:${text}`),
    decryptString: (buffer: Buffer) => {
      const value = buffer.toString("utf8");
      if (!value.startsWith("current:")) throw new Error("wrong Keychain identity");
      return value.slice("current:".length);
    },
  };

  function fakeStore(columns: Record<string, Record<string, string>>) {
    const writes: string[] = [];
    const store = {
      targets: Object.keys(columns),
      list: vi.fn(async (target: string) =>
        Object.entries(columns[target] ?? {}).map(([key, value]) => ({ key, value })),
      ),
      replaceIfUnchanged: vi.fn(
        async (target: string, key: string, next: string, previous: string) => {
          writes.push(key);
          if (columns[target]?.[key] !== previous) return false;
          columns[target][key] = next;
          return true;
        },
      ),
    };
    return { store, columns, writes };
  }

  function fakeWorkers() {
    const attempted: string[] = [];
    const spawnProcess = vi.fn((_executable: string, args: string[]) => {
      const identity = args.at(-1) || "";
      attempted.push(identity);
      const input = new PassThrough();
      const output = new PassThrough();
      const child = new EventEmitter() as ChildProcess;
      Object.assign(child, { stdin: input, stdout: output, kill: vi.fn() });
      let body = "";
      input.on("data", (chunk) => (body += String(chunk)));
      input.once("finish", () => {
        const rows = JSON.parse(body) as EncryptedSecureSettingRow[];
        const result = rows.flatMap((item) => {
          const plain = Buffer.from(item.encrypted_data.slice(3), "base64").toString("utf8");
          return identity === "cowork-os" && plain.startsWith("legacy:") && item.format === "text"
            ? [{ category: item.category, settings: { text: plain.slice("legacy:".length) } }]
            : [];
        });
        output.end(`${MAC_SAFE_STORAGE_MIGRATION_RESULT_PREFIX}${JSON.stringify(result)}\n`);
        output.once("end", () => child.emit("close", 0));
      });
      return child;
    });
    return { spawnProcess, attempted };
  }

  const baseOptions = {
    platform: "darwin" as const,
    safeStorage,
    executable: "/Applications/CoWork OS.app/Contents/MacOS/CoWork OS",
    appPath: "/Applications/CoWork OS.app/Contents/Resources/app.asar",
    legacyAppNames: ["Electron", "cowork-os"],
  };

  it("returns text rows from the worker as { text } without parsing JSON", async () => {
    const encrypted_data = `os:${b64("plain mail body")}`;
    const result = await decryptLegacyMacSafeStorageRows(
      [{ category: "m1", encrypted_data, checksum: sha256(encrypted_data), format: "text" }],
      async (buffer: Buffer) => buffer.toString("utf8"),
    );
    expect(result).toEqual([{ category: "m1", settings: { text: "plain mail body" } }]);
  });

  it("re-encrypts values a former identity can read and leaves readable ones alone", async () => {
    const database = fakeStore({
      "mailbox_messages.body_text": {
        m1: `mbox:os:${b64("legacy:hello")}`,
        m2: `mbox:os:${b64("current:already fine")}`,
        m3: "plain, not encrypted",
      },
      "mailbox_summaries.summary_text": { t1: `mbox:os:${b64("legacy:summary")}` },
    });
    const { spawnProcess, attempted } = fakeWorkers();
    const attempts = { value: null as string | null, read: () => null, write: vi.fn() };
    const logger = { info: vi.fn(), warn: vi.fn() };

    const migrated = await migrateLegacyMacSafeStorageMailbox({
      ...baseOptions,
      store: database.store,
      logger,
      attempts,
      spawnProcess: spawnProcess as never,
    });

    expect(migrated).toBe(2);
    expect(attempted).toEqual(["Electron", "cowork-os"]);
    expect(database.columns["mailbox_messages.body_text"].m1).toBe(
      `mbox:os:${b64("current:hello")}`,
    );
    expect(database.columns["mailbox_summaries.summary_text"].t1).toBe(
      `mbox:os:${b64("current:summary")}`,
    );
    expect(database.writes).not.toContain("m2");
    expect(database.writes).not.toContain("m3");
    expect(attempts.write).toHaveBeenCalledWith("");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("does not overwrite a value that changed while the worker ran", async () => {
    const database = fakeStore({
      "mailbox_summaries.summary_text": { t1: `mbox:os:${b64("legacy:old")}` },
    });
    const { spawnProcess } = fakeWorkers();
    spawnProcess.mockImplementationOnce(((executable: string, args: string[]) => {
      database.columns["mailbox_summaries.summary_text"].t1 = `mbox:os:${b64("current:newer")}`;
      return fakeWorkers().spawnProcess(executable, args);
    }) as never);

    const migrated = await migrateLegacyMacSafeStorageMailbox({
      ...baseOptions,
      legacyAppNames: ["cowork-os"],
      store: database.store,
      logger: { info: vi.fn(), warn: vi.fn() },
      spawnProcess: spawnProcess as never,
    });

    expect(migrated).toBe(0);
    expect(database.columns["mailbox_summaries.summary_text"].t1).toBe(
      `mbox:os:${b64("current:newer")}`,
    );
  });

  it("remembers values no identity can read and skips them on the next launch", async () => {
    const columns = {
      "mailbox_messages.body_html": { m9: `mbox:os:${b64("mock:unknown key")}` },
    };
    let stored: string | null = null;
    const attempts = { read: () => stored, write: (value: string) => (stored = value || null) };
    const logger = { info: vi.fn(), warn: vi.fn() };

    const first = fakeWorkers();
    await migrateLegacyMacSafeStorageMailbox({
      ...baseOptions,
      store: fakeStore(columns).store,
      logger,
      attempts,
      spawnProcess: first.spawnProcess as never,
    });
    expect(first.attempted).toEqual(["Electron", "cowork-os"]);
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("no known identity can read"),
      { unreadableCount: 1 },
    );

    const second = fakeWorkers();
    await migrateLegacyMacSafeStorageMailbox({
      ...baseOptions,
      store: fakeStore(columns).store,
      logger,
      attempts,
      spawnProcess: second.spawnProcess as never,
    });
    expect(second.attempted).toEqual([]);

    // A new unreadable value changes the set, so the next launch tries again.
    const third = fakeWorkers();
    await migrateLegacyMacSafeStorageMailbox({
      ...baseOptions,
      store: fakeStore({
        "mailbox_messages.body_html": {
          ...columns["mailbox_messages.body_html"],
          m10: `mbox:os:${b64("legacy:new")}`,
        },
      }).store,
      logger,
      attempts,
      spawnProcess: third.spawnProcess as never,
    });
    expect(third.attempted).toEqual(["Electron", "cowork-os"]);
  });

  it("does nothing off macOS or without OS encryption", async () => {
    const database = fakeStore({ "mailbox_messages.body_text": {} });
    for (const options of [
      { platform: "linux" as const, safeStorage },
      { platform: "darwin" as const, safeStorage: null },
    ]) {
      expect(
        await migrateLegacyMacSafeStorageMailbox({
          ...baseOptions,
          ...options,
          store: database.store,
          logger: { info: vi.fn(), warn: vi.fn() },
        }),
      ).toBe(0);
    }
    expect(database.store.list).not.toHaveBeenCalled();
  });
});
