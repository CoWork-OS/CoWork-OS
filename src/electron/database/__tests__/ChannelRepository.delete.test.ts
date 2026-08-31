import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";

vi.mock("../../utils/safe-storage", () => ({
  getSafeStorage: () => ({
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, "utf8"),
    decryptString: (value: Buffer) => value.toString("utf8"),
  }),
}));

const nativeSqliteAvailable = (() => {
  try {
    const probe = new Database(":memory:");
    probe.close();
    return true;
  } catch {
    return false;
  }
})();

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

describeWithSqlite("ChannelRepository.delete", () => {
  let tempDir: string;
  let previousUserDataDir: string | undefined;
  let manager: import("../schema").DatabaseManager;
  let ChannelRepository: typeof import("../repositories").ChannelRepository;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-channel-delete-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tempDir;

    const [{ DatabaseManager }, repositories] = await Promise.all([
      import("../schema"),
      import("../repositories"),
    ]);
    manager = new DatabaseManager();
    ChannelRepository = repositories.ChannelRepository;

    // This table exists in older mailbox databases and was missing a cascade.
    manager.getDatabase().exec(`
        CREATE TABLE communication_threads (
          id TEXT PRIMARY KEY,
          channel_id TEXT,
          FOREIGN KEY (channel_id) REFERENCES channels(id)
        )
      `);
    manager.getDatabase().exec(`
      CREATE TABLE communication_messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        FOREIGN KEY (thread_id) REFERENCES communication_threads(id)
      );
      CREATE TABLE communication_commitments (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        message_id TEXT,
        FOREIGN KEY (thread_id) REFERENCES communication_threads(id),
        FOREIGN KEY (message_id) REFERENCES communication_messages(id)
      );
    `);
  });

  afterEach(() => {
    manager?.close();
    if (previousUserDataDir === undefined) {
      delete process.env.COWORK_USER_DATA_DIR;
    } else {
      process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("removes legacy communication-thread references before deleting a channel", () => {
    const db = manager.getDatabase();
    const repository = new ChannelRepository(db);
    const channel = repository.create({
      type: "discord",
      name: "Discord Bot",
      enabled: false,
      config: {},
      securityConfig: { mode: "pairing" },
      status: "disconnected",
    });

    db.prepare("INSERT INTO communication_threads (id, channel_id) VALUES (?, ?)").run(
      "thread-1",
      channel.id,
    );
    db.prepare("INSERT INTO communication_messages (id, thread_id) VALUES (?, ?)").run(
      "message-1",
      "thread-1",
    );
    db.prepare(
      "INSERT INTO communication_commitments (id, thread_id, message_id) VALUES (?, ?, ?)",
    ).run("commitment-1", "thread-1", "message-1");

    repository.delete(channel.id);

    expect(repository.findById(channel.id)).toBeUndefined();
    expect(
      db
        .prepare("SELECT count(*) AS count FROM communication_threads WHERE channel_id = ?")
        .get(channel.id),
    ).toEqual({ count: 0 });
    expect(db.prepare("SELECT count(*) AS count FROM communication_messages").get()).toEqual({
      count: 0,
    });
    expect(db.prepare("SELECT count(*) AS count FROM communication_commitments").get()).toEqual({
      count: 0,
    });
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });
});
