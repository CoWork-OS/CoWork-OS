import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseManager } from "../../database/schema";
import { ChannelStore, ChannelUserStore } from "../../database/repositories";
import { SecurityManager } from "../security";
import { BlueBubblesAdapter } from "../channels/bluebubbles";
import type { BlueBubblesMessage } from "../channels/bluebubbles-client";
import {
  GrantAccessSchema,
  RevokeAccessSchema,
  GeneratePairingSchema,
} from "../../utils/validation";
import type { ContextType } from "../../../shared/types";

vi.mock("../../utils/safe-storage", () => ({
  getSafeStorage: () => ({
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  }),
}));

// Use the real schema, stores and async facades. A missing native driver must fail this suite.
describe("context-scoped gateway admission", () => {
  let manager: DatabaseManager;
  let security: SecurityManager;
  let channel: ReturnType<ChannelStore["create"]>;
  const message = (context: ContextType) => ({
    messageId: "message",
    channel: "telegram" as const,
    userId: "sender",
    userName: "Sender",
    chatId: context === "dm" ? "sender" : "group-chat",
    isGroup: context === "group",
    text: "Hello",
    timestamp: new Date(),
  });
  const access = (context: ContextType) =>
    security.checkAccess(channel, message(context), context === "group");

  beforeEach(() => {
    manager = new DatabaseManager({ dbPath: ":memory:" });
    channel = new ChannelStore(manager.getDatabase()).create({
      type: "telegram",
      name: "Telegram",
      enabled: true,
      config: {},
      securityConfig: { mode: "pairing" },
      status: "connected",
    });
    security = new SecurityManager(manager.getDatabase());
  });
  afterEach(() => manager.close());

  it.each([
    ["dm", "group"],
    ["group", "dm"],
  ] as const)(
    "open %s does not admit the sender to pairing %s",
    async (openContext, strictContext) => {
      await security
        .getContextPolicyManager()
        .updateByContext(channel.id, openContext, { securityMode: "open" });
      expect((await access(openContext)).allowed).toBe(true);
      expect(await access(strictContext)).toMatchObject({ allowed: false, pairingRequired: true });
    },
  );
  it.each([
    ["dm", "group"],
    ["group", "dm"],
  ] as const)("open %s does not bypass allowlist %s", async (openContext, strictContext) => {
    await security
      .getContextPolicyManager()
      .updateByContext(channel.id, openContext, { securityMode: "open" });
    await security
      .getContextPolicyManager()
      .updateByContext(channel.id, strictContext, { securityMode: "allowlist" });
    expect((await access(openContext)).allowed).toBe(true);
    expect((await access(strictContext)).allowed).toBe(false);
  });
  it.each([
    ["dm", "group"],
    ["group", "dm"],
  ] as const)("pairing %s and revoking it leaves %s independent", async (first, second) => {
    await access(first);
    await access(second);
    const firstCode = await security.generatePairingCode(channel, undefined, undefined, first);
    const secondCode = await security.generatePairingCode(channel, undefined, undefined, second);
    expect(
      (await security.verifyPairingCode(channel, "sender", firstCode.toLowerCase(), second))
        .success,
    ).toBe(false);
    expect(
      (await security.verifyPairingCode(channel, "sender", firstCode.toLowerCase(), first)).success,
    ).toBe(true);
    expect((await access(first)).allowed).toBe(true);
    expect((await access(second)).allowed).toBe(false);
    expect((await security.verifyPairingCode(channel, "sender", "INVALID", second)).success).toBe(
      false,
    );
    expect((await security.verifyPairingCode(channel, "sender", secondCode, second)).success).toBe(
      true,
    );
    await security.revokeAccess(channel.id, "sender", first);
    expect((await access(first)).allowed).toBe(false);
    expect((await access(second)).allowed).toBe(true);
    // Replaying a consumed code cannot resurrect access after revocation.
    expect((await security.verifyPairingCode(channel, "sender", firstCode, first)).success).toBe(
      false,
    );
    security = new SecurityManager(manager.getDatabase());
    expect((await access(first)).allowed).toBe(false);
    expect((await access(second)).allowed).toBe(true);
    await security.revokeAccess(channel.id, "sender");
    expect((await access(second)).allowed).toBe(false);
  });
  it("validates context selections at the IPC boundary", () => {
    const base = { channelId: channel.id, userId: "sender" };
    expect(GrantAccessSchema.parse(base).contextType).toBe("dm");
    expect(GeneratePairingSchema.parse(base).contextType).toBe("dm");
    expect(RevokeAccessSchema.parse(base).contextType).toBe("both");
    expect(GrantAccessSchema.parse({ ...base, contextType: "both" }).contextType).toBe("both");
    expect(GeneratePairingSchema.safeParse({ ...base, contextType: "both" }).success).toBe(false);
    expect(GrantAccessSchema.safeParse({ ...base, contextType: "GROUP" }).success).toBe(false);
  });
  it("scopes administrator grants, with both contexts requiring explicit selection", async () => {
    await security.grantAccess(channel.id, "sender", "Sender");
    expect((await access("dm")).allowed).toBe(true);
    expect((await access("group")).allowed).toBe(false);
    await security.grantAccess(channel.id, "sender", "Sender", "group");
    await security.revokeAccess(channel.id, "sender", "dm");
    expect((await access("group")).allowed).toBe(true);
    expect((await access("dm")).allowed).toBe(false);
    await security.grantAccess(channel.id, "sender", "Sender", "both");
    expect((await access("dm")).allowed).toBe(true);
    expect((await access("group")).allowed).toBe(true);
  });
  it("does not turn configured allowlist membership into a pairing grant", async () => {
    channel.securityConfig.allowedUsers = ["sender"];
    await security
      .getContextPolicyManager()
      .updateByContext(channel.id, "dm", { securityMode: "allowlist" });
    expect((await access("dm")).allowed).toBe(true);
    expect((await access("group")).allowed).toBe(false);
    channel.securityConfig.allowedUsers = [];
    expect((await access("dm")).allowed).toBe(false);
  });
  it("does not retain open access when the same context becomes restrictive", async () => {
    await security
      .getContextPolicyManager()
      .updateByContext(channel.id, "dm", { securityMode: "open" });
    expect((await access("dm")).allowed).toBe(true);
    await security
      .getContextPolicyManager()
      .updateByContext(channel.id, "dm", { securityMode: "pairing" });
    expect((await access("dm")).allowed).toBe(false);
  });
  it("uses adapter context for messages and callbacks when DM IDs differ", async () => {
    await security.grantAccess(channel.id, "sender", "Sender", "dm");
    const dm = { ...message("dm"), chatId: "discord-dm-channel", isGroup: false };
    expect(await security.checkAccess(channel, dm)).toMatchObject({
      allowed: true,
      contextType: "dm",
    });
    expect(await security.checkAccess(channel, { ...dm, isGroup: true })).toMatchObject({
      allowed: false,
      contextType: "group",
    });
    expect(security.resolveContextType(channel, dm)).toBe("dm");
  });
  it("consumes a code stored on a real user and enforces one-time use", async () => {
    await access("dm");
    const store = new ChannelUserStore(manager.getDatabase());
    const sender = store.findByChannelUserId(channel.id, "sender")!;
    store.update(sender.id, {
      pairingCode: "ABC234",
      pairingContext: "dm",
      pairingExpiresAt: Date.now() + 60_000,
    });
    expect((await security.verifyPairingCode(channel, "sender", "abc234", "dm")).success).toBe(
      true,
    );
    expect(store.findById(sender.id)?.pairingCode).toBeUndefined();
    await security.revokeAccess(channel.id, "sender", "dm");
    expect((await security.verifyPairingCode(channel, "sender", "ABC234", "dm")).success).toBe(
      false,
    );
  });
  it("rejects expired codes and preserves one winner under concurrent verification", async () => {
    await access("dm");
    const expired = await security.generatePairingCode(channel);
    manager
      .getDatabase()
      .prepare("UPDATE channel_users SET pairing_expires_at = ? WHERE pairing_code = ?")
      .run(Date.now() - 1, expired);
    expect((await security.verifyPairingCode(channel, "sender", expired)).success).toBe(false);
    const store = new ChannelUserStore(manager.getDatabase());
    store.create({
      channelId: channel.id,
      channelUserId: "other",
      displayName: "Other",
      allowed: false,
    });
    const code = await security.generatePairingCode(channel);
    const results = await Promise.all([
      security.verifyPairingCode(channel, "sender", code),
      security.verifyPairingCode(channel, "other", code),
    ]);
    expect(results.filter((result) => result.success)).toHaveLength(1);
  });
  it("preserves native BlueBubbles DM/group context and drops unknown representations", async () => {
    channel.type = "bluebubbles";
    await security
      .getContextPolicyManager()
      .updateByContext(channel.id, "dm", { securityMode: "open" });
    const adapter = new BlueBubblesAdapter({ serverUrl: "http://localhost", password: "fixture" });
    const results: Array<{ allowed: boolean; contextType?: ContextType }> = [];
    adapter.onMessage(async (incoming) => {
      results.push(await security.checkAccess(channel, incoming));
    });
    const errors: Error[] = [];
    adapter.onError((error) => {
      errors.push(error);
    });
    const receive = (chatGuid: string) =>
      (
        adapter as unknown as { handleIncomingMessage(message: BlueBubblesMessage): Promise<void> }
      ).handleIncomingMessage({
        guid: chatGuid,
        chatGuid,
        handleId: 1,
        handle: { id: 1, address: "sender", service: "iMessage" },
        text: "Hello",
        dateCreated: Date.now(),
        isFromMe: false,
        isRead: false,
      });
    await receive("iMessage;-;sender");
    await receive("iMessage;+;chat123");
    await receive("any;-;sender");
    await receive("invalid");
    expect(results).toMatchObject([
      { allowed: true, contextType: "dm" },
      { allowed: false, contextType: "group" },
      { allowed: true, contextType: "dm" },
    ]);
    expect(errors).toHaveLength(1);
  });
  it("upgrades legacy grants fail closed while preserving IDs and new grants on reopen", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-context-upgrade-"));
    const dbPath = path.join(dir, "cowork-os.db");
    let fixture: DatabaseManager | undefined;
    try {
      fixture = new DatabaseManager({ dbPath });
      const db = fixture.getDatabase();
      const fixtureChannel = new ChannelStore(db).create({
        type: "telegram",
        name: "Legacy",
        enabled: true,
        config: {},
        securityConfig: { mode: "pairing", allowedUsers: ["configured"] },
        status: "connected",
      });
      const user = new ChannelUserStore(db).create({
        channelId: fixtureChannel.id,
        channelUserId: "legacy",
        displayName: "Legacy",
        allowed: false,
      });
      db.prepare(
        "INSERT INTO channel_sessions (id, channel_id, chat_id, user_id, state, created_at, last_activity_at) VALUES ('session', ?, 'chat', ?, 'idle', 1, 1)",
      ).run(fixtureChannel.id, user.id);
      db.exec(
        "ALTER TABLE channel_users DROP COLUMN allowed_dm; ALTER TABLE channel_users DROP COLUMN allowed_group; ALTER TABLE channel_users DROP COLUMN pairing_context;",
      );
      db.prepare(
        "UPDATE channel_users SET allowed = 1, pairing_code = 'ABC234', pairing_expires_at = ?",
      ).run(Date.now() + 300_000);
      fixture.close();
      fixture = new DatabaseManager({ dbPath });
      const upgraded = new ChannelUserStore(fixture.getDatabase()).findById(user.id)!;
      expect(upgraded).toMatchObject({
        id: user.id,
        allowed: false,
        allowedDm: false,
        allowedGroup: false,
      });
      expect(upgraded.pairingCode).toBeUndefined();
      expect(
        fixture
          .getDatabase()
          .prepare("SELECT user_id FROM channel_sessions WHERE id = 'session'")
          .get(),
      ).toEqual({ user_id: user.id });
      const fixed = new SecurityManager(fixture.getDatabase());
      expect(
        (
          await fixed.checkAccess(fixtureChannel, {
            ...message("dm"),
            userId: "legacy",
            chatId: "legacy",
          })
        ).allowed,
      ).toBe(false);
      await fixed.grantAccess(fixtureChannel.id, "legacy", "Legacy", "group");
      fixture.close();
      fixture = new DatabaseManager({ dbPath });
      expect(new ChannelUserStore(fixture.getDatabase()).findById(user.id)).toMatchObject({
        allowedDm: false,
        allowedGroup: true,
      });
      expect(
        new ChannelStore(fixture.getDatabase()).findById(fixtureChannel.id)?.securityConfig
          .allowedUsers,
      ).toEqual(["configured"]);
      expect(fixture.getDatabase().pragma("foreign_key_check")).toEqual([]);
    } finally {
      fixture?.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
