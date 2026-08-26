import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../utils/safe-storage", () => ({
  getSafeStorage: () => ({
    isEncryptionAvailable: () => true,
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

describeWithSqlite("ChannelSpecializationRepository", () => {
  let tmpDir: string;
  let previousUserDataDir: string | undefined;
  let manager: import("../schema").DatabaseManager;
  let repos: typeof import("../repositories");

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-channel-spec-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tmpDir;

    const [{ DatabaseManager }, repositories] = await Promise.all([
      import("../schema"),
      import("../repositories"),
    ]);
    manager = new DatabaseManager();
    repos = repositories;
  });

  afterEach(() => {
    manager?.close();
    if (previousUserDataDir === undefined) {
      delete process.env.COWORK_USER_DATA_DIR;
    } else {
      process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function seed() {
    const db = manager.getDatabase();
    const workspaceRepo = new repos.WorkspaceRepository(db);
    const channelRepo = new repos.ChannelRepository(db);
    const specializationRepo = new repos.ChannelSpecializationRepository(db);
    const workspace = workspaceRepo.create("Workspace", path.join(tmpDir, "workspace"), {
      read: true,
      write: true,
      delete: false,
      network: true,
      shell: false,
    });
    const channel = channelRepo.create({
      type: "telegram",
      name: "Telegram",
      enabled: true,
      config: {},
      securityConfig: { mode: "pairing" },
      status: "connected",
    });
    return { workspace, channel, specializationRepo };
  }

  it("creates, updates, lists, and deletes specializations", () => {
    const { workspace, channel, specializationRepo } = seed();
    const created = specializationRepo.create({
      channelId: channel.id,
      chatId: "chat-1",
      name: "Support group",
      workspaceId: workspace.id,
      systemGuidance: "Handle support triage.",
      toolRestrictions: ["group:memory", " group:memory ", "shell_command"],
      allowSharedContextMemory: true,
    });

    expect(created.chatId).toBe("chat-1");
    expect(created.workspaceId).toBe(workspace.id);
    expect(created.toolRestrictions).toEqual(["group:memory", "shell_command"]);
    expect(created.allowSharedContextMemory).toBe(true);

    const updated = specializationRepo.update({
      id: created.id,
      threadId: "topic-1",
      name: "Support topic",
      enabled: false,
    });
    expect(updated?.threadId).toBe("topic-1");
    expect(updated?.name).toBe("Support topic");
    expect(updated?.enabled).toBe(false);

    expect(specializationRepo.listByChannel(channel.id)).toHaveLength(1);
    expect(specializationRepo.delete(created.id)).toBe(true);
    expect(specializationRepo.listByChannel(channel.id)).toHaveLength(0);
  });

  it("resolves thread before chat before channel and skips disabled records", () => {
    const { workspace, channel, specializationRepo } = seed();
    const channelDefault = specializationRepo.create({
      channelId: channel.id,
      name: "Channel default",
      workspaceId: workspace.id,
    });
    const chatDefault = specializationRepo.create({
      channelId: channel.id,
      chatId: "chat-1",
      name: "Chat default",
      workspaceId: workspace.id,
    });
    const threadDefault = specializationRepo.create({
      channelId: channel.id,
      chatId: "chat-1",
      threadId: "topic-1",
      name: "Topic default",
      workspaceId: workspace.id,
    });
    specializationRepo.create({
      channelId: channel.id,
      chatId: "chat-1",
      threadId: "topic-2",
      name: "Disabled topic",
      enabled: false,
      workspaceId: workspace.id,
    });

    expect(
      specializationRepo.resolve({
        channelId: channel.id,
        chatId: "chat-1",
        threadId: "topic-1",
      })?.id,
    ).toBe(threadDefault.id);
    expect(
      specializationRepo.resolve({
        channelId: channel.id,
        chatId: "chat-1",
        threadId: "topic-2",
      })?.id,
    ).toBe(chatDefault.id);
    expect(
      specializationRepo.resolve({
        channelId: channel.id,
        chatId: "other-chat",
      })?.id,
    ).toBe(channelDefault.id);
  });
});
