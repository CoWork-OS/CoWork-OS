import type Database from "better-sqlite3";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { TeamsConversationReferenceStore } from "../TeamsConversationReferenceStore";
import { nativeSqliteAvailable } from "../../memory/__tests__/memory-items-test-db";
import { normalizeTeamsDecisionReference } from "../channels/teams-conversation-reference";
const suite = nativeSqliteAvailable ? describe : describe.skip;
suite("durable Teams decision references", () => {
  let db: Database.Database, store: TeamsConversationReferenceStore;
  const now = 1_000_000;
  const reference = {
    channelId: "msteams" as const,
    serviceUrl: "https://smba.trafficmanager.net/amer/",
    bot: { id: "bot" },
    conversation: { id: "chat", tenantId: "tenant" },
  };
  beforeEach(async () => {
    const { default: Sqlite } = await import("better-sqlite3");
    db = new Sqlite(":memory:");
    db.exec(
      `CREATE TABLE channels(id TEXT PRIMARY KEY,type TEXT,enabled INTEGER,config TEXT,security_config TEXT);INSERT INTO channels VALUES ('channel','teams',1,'sealed-config','{}'), ('other','teams',1,'sealed-config','{}');`,
    );
    store = new TeamsConversationReferenceStore(db);
    store.initialize();
  });
  afterEach(() => db.close());
  const scope = () => ({
    channelId: "channel",
    appId: "app",
    tenantId: "tenant",
    policyHash: store.policy("channel")!,
  });
  const save = () => {
    const input = scope();
    store.put({ ...input, reference }, now);
    return input;
  };
  it("recovers minimal routing metadata through a new store instance", () => {
    const input = save();
    store = new TeamsConversationReferenceStore(db);
    expect(store.get({ ...input, chatId: "chat" }, now + 1)).toEqual(reference);
    const minimal = normalizeTeamsDecisionReference(
      {
        ...reference,
        user: { id: "private-user", name: "private name" },
        activityId: "message",
        text: "private text",
      },
      "tenant",
    );
    expect(minimal).toEqual(reference);
    expect(JSON.stringify(minimal)).not.toContain("private");
  });
  it.each(["appId", "tenantId", "chatId", "channelId"] as const)(
    "refuses a different %s",
    (key) => {
      const input = save();
      expect(
        store.get(
          {
            ...input,
            chatId: "chat",
            [key]: "other",
            ...(key === "channelId" ? { policyHash: store.policy("other") } : {}),
          },
          now,
        ),
      ).toBeUndefined();
    },
  );
  it.each(["config", "security_config"])("refuses a changed %s after capture", (key) => {
    const input = save();
    db.prepare(`UPDATE channels SET ${key} = 'changed' WHERE id = 'channel'`).run();
    expect(() => store.get({ ...input, chatId: "chat" }, now)).toThrow(/configuration changed/);
    expect(() => store.put({ ...input, reference }, now)).toThrow(/configuration changed/);
    expect(store.get({ ...scope(), chatId: "chat" }, now)).toBeUndefined();
  });
  it("denies a disabled channel without returning its reference", () => {
    const input = save();
    db.exec("UPDATE channels SET enabled=0 WHERE id='channel'");
    expect(() => store.get({ ...input, chatId: "chat" }, now)).toThrow();
  });
  it("expires references and rejects future-dated records", () => {
    const input = save();
    expect(
      store.get({ ...input, chatId: "chat" }, now + 90 * 24 * 60 * 60 * 1000 + 1),
    ).toBeUndefined();
    expect(store.get({ ...input, chatId: "chat" }, now - 1)).toBeUndefined();
  });
  it.each([
    "http://smba.trafficmanager.net/amer/",
    "https://user:secret@example.com/",
    "https://example.com/?token=secret",
    "https://example.com/#fragment",
  ])("rejects unsafe service URL %s", (serviceUrl) => {
    expect(() => store.put({ ...scope(), reference: { ...reference, serviceUrl } }, now)).toThrow();
  });
  it("refuses malformed stored data and foreign conversations", () => {
    const input = save();
    db.prepare("UPDATE teams_conversation_references SET reference_json = ?").run(
      JSON.stringify({ ...reference, conversation: { id: "foreign", tenantId: "tenant" } }),
    );
    expect(() => store.get({ ...input, chatId: "chat" }, now)).toThrow(/scope changed/);
  });
  it("caps a channel at 1000 recent references", () => {
    const input = scope();
    for (let index = 0; index < 1001; index++)
      store.put(
        {
          ...input,
          reference: {
            ...reference,
            conversation: { ...reference.conversation, id: `chat-${index}` },
          },
        },
        now + index,
      );
    expect(db.prepare("SELECT COUNT(*) AS count FROM teams_conversation_references").get()).toEqual(
      { count: 1000 },
    );
    expect(store.get({ ...input, chatId: "chat-0" }, now + 1001)).toBeUndefined();
  });
});
