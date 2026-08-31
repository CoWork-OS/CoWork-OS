import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLogObserver } from "../../utils/logger";

const secureStorageState = vi.hoisted(() => ({ available: true }));

vi.mock("../../utils/safe-storage", () => ({
  getSafeStorage: () => ({
    isEncryptionAvailable: () => secureStorageState.available,
    encryptString: (value: string) => Buffer.from(value, "utf8"),
    decryptString: (value: Buffer) => value.toString("utf8"),
  }),
}));

const nativeSqliteAvailable = await import("better-sqlite3")
  .then((module) => {
    try {
      const Database = module.default;
      const probe = new Database(":memory:");
      probe.close();
      return true;
    } catch {
      return false;
    }
  })
  .catch(() => false);

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

describeWithSqlite("ChannelRepository logging", () => {
  let tmpDir: string;
  let previousUserDataDir: string | undefined;
  let manager: import("../schema").DatabaseManager;
  let repositories: typeof import("../repositories");

  beforeEach(async () => {
    secureStorageState.available = true;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-channel-log-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tmpDir;
    const [schema, loadedRepositories] = await Promise.all([
      import("../schema"),
      import("../repositories"),
    ]);
    repositories = loadedRepositories;
    manager = new schema.DatabaseManager();
  });

  afterEach(() => {
    setLogObserver(null);
    manager?.close();
    if (previousUserDataDir === undefined) {
      delete process.env.COWORK_USER_DATA_DIR;
    } else {
      process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("rate-limits repeated secure-storage-unavailable errors", () => {
    const errors: string[] = [];
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    setLogObserver((event) => {
      if (event.component === "ChannelRepository" && event.level === "error") {
        errors.push(String(event.args[0] || ""));
      }
    });

    const repo = new repositories.ChannelRepository(manager.getDatabase());
    const channel = repo.create({
      type: "telegram",
      name: "Telegram",
      enabled: true,
      config: { token: "secret" },
      securityConfig: { mode: "pairing" },
      status: "connected",
    });

    secureStorageState.available = false;
    repo.findById(channel.id);
    repo.findById(channel.id);
    repo.findById(channel.id);

    expect(errors).toHaveLength(1);

    nowSpy.mockReturnValue(1_800_000_060_000);
    repo.findById(channel.id);
    expect(errors).toHaveLength(2);
  });
});
