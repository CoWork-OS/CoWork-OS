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

describeWithSqlite("SecurityManager email channels", () => {
  let tmpDir: string;
  let previousUserDataDir: string | undefined;
  let manager: import("../../database/schema").DatabaseManager;
  let repos: typeof import("../../database/repositories");
  let SecurityManagerCtor: typeof import("../security").SecurityManager;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-email-security-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tmpDir;

    const [{ DatabaseManager }, repositories, { SecurityManager }] = await Promise.all([
      import("../../database/schema"),
      import("../../database/repositories"),
      import("../security"),
    ]);
    manager = new DatabaseManager();
    repos = repositories;
    SecurityManagerCtor = SecurityManager;
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

  it("treats email channels as open even when legacy security settings say pairing", async () => {
    const db = manager.getDatabase();
    const channelRepo = new repos.ChannelRepository(db);
    const security = new SecurityManagerCtor(db);
    const channel = channelRepo.create({
      type: "email",
      name: "Email",
      enabled: true,
      config: { protocol: "imap-smtp", email: "bot@example.com" },
      securityConfig: { mode: "pairing" },
      status: "connected",
    });

    const result = await security.checkAccess(channel, {
      messageId: "message-1",
      channel: "email",
      userId: "sender@example.com",
      userName: "Sender",
      chatId: "sender@example.com",
      text: "Hello",
      timestamp: new Date(),
    });

    expect(result.allowed).toBe(true);
    expect(result.pairingRequired).toBeUndefined();
    expect(result.user?.allowed).toBe(true);
  });

  it("ignores context allowlist policies for email authorization", async () => {
    const db = manager.getDatabase();
    const channelRepo = new repos.ChannelRepository(db);
    const security = new SecurityManagerCtor(db);
    const channel = channelRepo.create({
      type: "email",
      name: "Email",
      enabled: true,
      config: { protocol: "imap-smtp", email: "bot@example.com" },
      securityConfig: { mode: "allowlist", allowedUsers: ["approved@example.com"] },
      status: "connected",
    });
    security.getContextPolicyManager().create({
      channelId: channel.id,
      contextType: "dm",
      securityMode: "allowlist",
    });

    const result = await security.checkAccess(channel, {
      messageId: "message-2",
      channel: "email",
      userId: "new-sender@example.com",
      userName: "New Sender",
      chatId: "new-sender@example.com",
      text: "Hello",
      timestamp: new Date(),
    });

    expect(result.allowed).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.user?.allowed).toBe(true);
  });
});
