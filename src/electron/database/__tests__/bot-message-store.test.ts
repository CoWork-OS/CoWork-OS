import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BotMessageStore } from "../bot-message-store";

const nativeSqliteAvailable = (() => {
  try {
    new Database(":memory:").close();
    return true;
  } catch {
    return false;
  }
})();

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

describeWithSqlite("BotMessageStore", () => {
  let db: Database.Database;
  let store: BotMessageStore;

  const addConversation = (
    id: string,
    createdAt: number,
    overrides: Record<string, unknown> = {},
  ) =>
    db
      .prepare(
        `INSERT INTO tasks (id, workspace_id, assigned_agent_role_id, agent_config, source, created_at)
         VALUES (@id, @workspaceId, @roleId, @agentConfig, @source, @createdAt)`,
      )
      .run({
        id,
        workspaceId: "ws",
        roleId: "atlas",
        agentConfig: JSON.stringify({ botConversation: true }),
        source: "manual",
        createdAt,
        ...overrides,
      });
  let eventCounter = 0;
  const addEvent = (taskId: string, timestamp: number, type: string, payload: object) => {
    eventCounter += 1;
    db.prepare(
      `INSERT INTO task_events (id, task_id, timestamp, type, legacy_type, payload)
       VALUES (?, ?, ?, ?, NULL, ?)`,
    ).run(
      `ev-${String(eventCounter).padStart(4, "0")}`,
      taskId,
      timestamp,
      type,
      JSON.stringify(payload),
    );
  };

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE tasks (id TEXT PRIMARY KEY, workspace_id TEXT, assigned_agent_role_id TEXT,
        agent_config TEXT, source TEXT, created_at INTEGER);
      CREATE TABLE task_events (id TEXT PRIMARY KEY, task_id TEXT, timestamp INTEGER, type TEXT,
        legacy_type TEXT, payload TEXT);
    `);
    store = new BotMessageStore(db);
    eventCounter = 0;
  });

  afterEach(() => db.close());

  it("pages a bot's messages newest first across its earlier conversations", () => {
    addConversation("old", 100);
    addConversation("mid", 200);
    addConversation("current", 300);
    addConversation("other-bot", 150, { roleId: "forge" });
    addEvent("old", 110, "user_message", { message: "Start chatting with Atlas." });
    for (let i = 0; i < 5; i += 1)
      addEvent("old", 120 + i, "user_message", { message: `old ${i}` });
    addEvent("mid", 210, "assistant_message", { message: "mid reply" });
    addEvent("mid", 211, "tool_call", { message: "ignored" });
    addEvent("current", 310, "user_message", { message: "live" });
    addEvent("other-bot", 160, "user_message", { message: "not atlas" });

    const first = store.findPage({
      workspaceId: "ws",
      agentRoleId: "atlas",
      beforeConversationId: "current",
      limit: 3,
    });
    expect(first.messages.map((message) => message.text)).toEqual(["old 3", "old 4", "mid reply"]);
    expect(first.hasMore).toBe(true);

    const second = store.findPage({
      workspaceId: "ws",
      agentRoleId: "atlas",
      beforeConversationId: "current",
      cursor: first.nextCursor,
      limit: 3,
    });
    expect(second.messages.map((message) => message.text)).toEqual(["old 0", "old 1", "old 2"]);

    const last = store.findPage({
      workspaceId: "ws",
      agentRoleId: "atlas",
      beforeConversationId: "current",
      cursor: second.nextCursor,
      limit: 3,
    });
    expect(last.messages).toEqual([]);
    expect(last.hasMore).toBe(false);
  });

  it("hides greeting replies to the opening seed", () => {
    addConversation("old", 100);
    addEvent("old", 110, "user_message", { message: "Start chatting with Atlas." });
    addEvent("old", 111, "assistant_message", { message: "Atlas here — what's on your mind?" });
    addEvent("old", 120, "user_message", { message: "what now?" });
    addEvent("old", 121, "assistant_message", { message: "Ship one fix." });

    const page = store.findPage({ workspaceId: "ws", agentRoleId: "atlas" });
    expect(page.messages.map((message) => message.text)).toEqual(["what now?", "Ship one fix."]);
  });

  it("keeps a reply once when its completion summary repeats it", () => {
    addConversation("old", 100);
    addEvent("old", 110, "assistant_message", { message: "Ship one fix." });
    addEvent("old", 111, "task_completed", { resultSummary: "Ship one fix." });
    addEvent("old", 112, "assistant_message", { message: "Ship one fix." });

    const page = store.findPage({ workspaceId: "ws", agentRoleId: "atlas" });
    expect(page.messages.map((message) => message.text)).toEqual(["Ship one fix."]);
    expect(page.hasMore).toBe(false);
  });
});
