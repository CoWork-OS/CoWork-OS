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

describeWithSqlite("ChannelStore.delete", () => {
  let tempDir: string;
  let previousUserDataDir: string | undefined;
  let manager: import("../schema").DatabaseManager;
  let ChannelStore: typeof import("../repositories").ChannelStore;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-channel-delete-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tempDir;

    const [{ DatabaseManager }, repositories] = await Promise.all([
      import("../schema"),
      import("../repositories"),
    ]);
    manager = new DatabaseManager();
    ChannelStore = repositories.ChannelStore;

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
    const repository = new ChannelStore(db);
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

  it("deletes a discontinued channel's pairings, sessions and messages but keeps its tasks", () => {
    const db = manager.getDatabase();
    const repository = new ChannelStore(db);
    const channel = repository.create({
      type: "twitch",
      name: "Twitch",
      enabled: true,
      config: { oauthToken: "oauth:secret" },
      securityConfig: { mode: "pairing" },
      status: "disconnected",
    });
    const now = Date.now();
    db.prepare(
      "INSERT INTO workspaces (id, name, path, created_at, permissions) VALUES (?, ?, ?, ?, ?)",
    ).run("ws-1", "Workspace", path.join(tempDir, "ws"), now, "{}");
    db.prepare(
      "INSERT INTO tasks (id, title, prompt, status, workspace_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("task-1", "From chat", "Do it", "completed", "ws-1", now, now);
    db.prepare(
      "INSERT INTO channel_users (id, channel_id, channel_user_id, display_name, allowed, created_at, last_seen_at) VALUES (?, ?, ?, ?, 1, ?, ?)",
    ).run("user-1", channel.id, "viewer", "Viewer", now, now);
    db.prepare(
      "INSERT INTO channel_sessions (id, channel_id, chat_id, user_id, task_id, workspace_id, created_at, last_activity_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("session-1", channel.id, "#stream", "user-1", "task-1", "ws-1", now, now);
    db.prepare(
      "INSERT INTO channel_messages (id, channel_id, session_id, channel_message_id, chat_id, user_id, direction, content, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("message-1", channel.id, "session-1", "m-1", "#stream", "user-1", "incoming", "hi", now);

    repository.delete(channel.id);

    expect(repository.findById(channel.id)).toBeUndefined();
    for (const table of ["channel_users", "channel_sessions", "channel_messages"]) {
      expect(db.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
    expect(db.prepare("SELECT id, status FROM tasks").all()).toEqual([
      { id: "task-1", status: "completed" },
    ]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });
});
