import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const safeStorageState = vi.hoisted(() => ({ available: false }));

vi.mock("../../utils/safe-storage", () => ({
  getSafeStorage: () => ({
    isEncryptionAvailable: () => safeStorageState.available,
    encryptString: (value: string) => Buffer.from(value, "utf8"),
    decryptString: (value: Buffer) => value.toString("utf8"),
  }),
}));

const nativeSqliteAvailable = await import("better-sqlite3")
  .then((module) => {
    try {
      const probe = new module.default(":memory:");
      probe.close();
      return true;
    } catch {
      return false;
    }
  })
  .catch(() => false);

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

describeWithSqlite("Node channel config secure-record codec", () => {
  let tmpDir: string;
  let previousUserDataDir: string | undefined;
  let manager: import("../schema").DatabaseManager;
  let ChannelStore: typeof import("../repositories").ChannelStore;
  let SecureSettingsRepository: typeof import("../SecureSettingsRepository").SecureSettingsRepository;

  beforeEach(async () => {
    safeStorageState.available = false;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-channel-secure-record-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tmpDir;
    const [schema, repositories, secureSettings] = await Promise.all([
      import("../schema"),
      import("../repositories"),
      import("../SecureSettingsRepository"),
    ]);
    manager = new schema.DatabaseManager();
    ChannelStore = repositories.ChannelStore;
    SecureSettingsRepository = secureSettings.SecureSettingsRepository;
    new SecureSettingsRepository(manager.getDatabase());
  });

  afterEach(() => {
    manager?.close();
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("seals Node-host channel credentials with the initialized profile repository and round-trips", () => {
    const db = manager.getDatabase();
    const store = new ChannelStore(db);
    const secret = "synthetic-node-channel-token";
    const channel = store.create({
      type: "telegram",
      name: "Synthetic Node Telegram",
      enabled: false,
      config: { botToken: secret, groupRoutingMode: "mentionsOnly" },
      securityConfig: { mode: "pairing" },
      status: "disconnected",
    });
    const stored = (
      db.prepare("SELECT config FROM channels WHERE id = ?").get(channel.id) as { config: string }
    ).config;

    expect(SecureSettingsRepository.isInitialized()).toBe(true);
    expect(stored).toMatch(/^enc:repo:v1:/);
    expect(stored).not.toContain(secret);
    expect(store.findById(channel.id)).toMatchObject({
      config: { botToken: secret, groupRoutingMode: "mentionsOnly" },
      configEncrypted: true,
    });
  });

  it("detects a checksum-tampered record and refuses to overwrite unreadable credentials", () => {
    const db = manager.getDatabase();
    const store = new ChannelStore(db);
    const channel = store.create({
      type: "telegram",
      name: "Synthetic Node Telegram",
      enabled: false,
      config: { botToken: "synthetic-preserved-token" },
      securityConfig: { mode: "pairing" },
      status: "disconnected",
    });
    const stored = (
      db.prepare("SELECT config FROM channels WHERE id = ?").get(channel.id) as { config: string }
    ).config;
    const prefix = "enc:repo:v1:";
    const record = JSON.parse(
      Buffer.from(stored.slice(prefix.length), "base64").toString("utf8"),
    ) as {
      encryptedData: string;
      checksum: string;
    };
    record.checksum = `${record.checksum[0] === "0" ? "1" : "0"}${record.checksum.slice(1)}`;
    const tampered = prefix + Buffer.from(JSON.stringify(record)).toString("base64");
    db.prepare("UPDATE channels SET config = ? WHERE id = ?").run(tampered, channel.id);

    const unreadable = store.findById(channel.id);
    expect(unreadable?.config).toEqual({});
    expect(unreadable?.configReadError).toBeTruthy();
    expect(() =>
      store.update(channel.id, { config: { botToken: "synthetic-replacement-token" } }),
    ).toThrow(/cannot be decrypted|could not be decrypted/i);
    expect(
      (db.prepare("SELECT config FROM channels WHERE id = ?").get(channel.id) as { config: string })
        .config,
    ).toBe(tampered);
    expect(tampered).not.toContain("synthetic-preserved-token");
  });
});
