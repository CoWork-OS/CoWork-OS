import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseManager } from "../../database/schema";
import { UsageInsightsService } from "../UsageInsightsService";
import {
  buildSessionUsageBreakdown,
  classifyUsageTask,
  type SessionUsageTaskRow,
} from "../usage-session-breakdown";

vi.mock("../../utils/safe-storage", () => ({
  getSafeStorage: () => ({
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, "utf8"),
    decryptString: (value: Buffer) => value.toString("utf8"),
  }),
}));

function task(id: string, overrides: Partial<SessionUsageTaskRow> = {}): SessionUsageTaskRow {
  return {
    id,
    title: `Task ${id}`,
    status: "completed",
    source: "manual",
    parentTaskId: null,
    agentConfig: null,
    assignedAgentRoleId: null,
    companyId: null,
    goalId: null,
    projectId: null,
    issueId: null,
    heartbeatRunId: null,
    ...overrides,
  };
}

function mapOf(...rows: SessionUsageTaskRow[]) {
  return new Map(rows.map((row) => [row.id, row]));
}

describe("classifyUsageTask", () => {
  it("files each kind of task under its category", () => {
    expect(classifyUsageTask(task("a"))).toBe("yours");
    expect(classifyUsageTask(task("a", { source: "suggested_task" }))).toBe("yours");
    expect(classifyUsageTask(task("a", { source: "side_chat" }))).toBe("yours");
    expect(classifyUsageTask(task("a", { parentTaskId: "p" }))).toBe("subagents");
    expect(classifyUsageTask(task("a", { source: "cron" }))).toBe("automated");
    expect(classifyUsageTask(task("a", { source: "hook", title: "Heartbeat: check" }))).toBe(
      "automated",
    );
    expect(classifyUsageTask(task("a", { agentConfig: { speculative: true } }))).toBe("automated");
    expect(classifyUsageTask(task("a", { agentConfig: { botConversation: true } }))).toBe("bots");
    expect(classifyUsageTask(task("a", { assignedAgentRoleId: "role" }))).toBe("bots");
    expect(classifyUsageTask(task("a", { source: "api" }))).toBe("integrations");
    expect(classifyUsageTask(task("a", { source: "hook" }))).toBe("integrations");
    expect(classifyUsageTask(task("a", { source: "api", companyId: "c" }))).toBe("automated");
  });

  it("counts a sub-agent as a sub-agent even when a bot or schedule started it", () => {
    expect(
      classifyUsageTask(task("a", { parentTaskId: "p", source: "cron", assignedAgentRoleId: "r" })),
    ).toBe("subagents");
  });
});

describe("buildSessionUsageBreakdown", () => {
  it("splits usage by category, most expensive first", () => {
    const result = buildSessionUsageBreakdown(
      [
        { taskId: "a", calls: 4, cost: 1, tokens: 1000 },
        { taskId: "b", calls: 2, cost: 3, tokens: 500 },
        { taskId: null, calls: 9, cost: 0.01, tokens: 90 },
        { taskId: "gone", calls: 1, cost: 0.5, tokens: 10 },
      ],
      mapOf(task("a"), task("b", { source: "cron" })),
    );
    expect(result.byCategory).toEqual([
      { category: "automated", cost: 3, tokens: 500, calls: 2, sessions: 1 },
      { category: "yours", cost: 1, tokens: 1000, calls: 4, sessions: 1 },
      { category: "deleted", cost: 0.5, tokens: 10, calls: 1, sessions: 1 },
      { category: "background", cost: 0.01, tokens: 90, calls: 9, sessions: 0 },
    ]);
  });

  it("orders by tokens when nothing was priced", () => {
    const result = buildSessionUsageBreakdown(
      [
        { taskId: "a", calls: 1, cost: 0, tokens: 10 },
        { taskId: "b", calls: 1, cost: 0, tokens: 99 },
      ],
      mapOf(task("a"), task("b", { source: "api" })),
    );
    expect(result.byCategory.map((row) => row.category)).toEqual(["integrations", "yours"]);
    expect(result.topSessions.map((row) => row.taskId)).toEqual(["b", "a"]);
  });

  it("adds sub-agent usage to the top-level session, through nested sub-agents", () => {
    const result = buildSessionUsageBreakdown(
      [
        { taskId: "root", calls: 1, cost: 0.1, tokens: 100 },
        { taskId: "child", calls: 2, cost: 0.4, tokens: 400 },
        { taskId: "grandchild", calls: 3, cost: 0.5, tokens: 500 },
        { taskId: "other", calls: 1, cost: 0.6, tokens: 50 },
      ],
      mapOf(
        task("root", { title: "  Plan the launch  " }),
        task("child", { parentTaskId: "root" }),
        task("grandchild", { parentTaskId: "child" }),
        task("other", { title: "" }),
      ),
    );
    expect(result.topSessions).toEqual([
      {
        taskId: "root",
        title: "Plan the launch",
        status: "completed",
        category: "yours",
        cost: 1,
        tokens: 1000,
        calls: 6,
        subagentCount: 2,
      },
      {
        taskId: "other",
        title: "Untitled session",
        status: "completed",
        category: "yours",
        cost: 0.6,
        tokens: 50,
        calls: 1,
        subagentCount: 0,
      },
    ]);
    expect(result.byCategory.find((row) => row.category === "subagents")).toMatchObject({
      cost: 0.9,
      sessions: 2,
    });
  });

  it("keeps a sub-agent whose parent is gone as its own entry and survives a parent loop", () => {
    const result = buildSessionUsageBreakdown(
      [
        { taskId: "orphan", calls: 1, cost: 0.2, tokens: 20 },
        { taskId: "loop-a", calls: 1, cost: 0.1, tokens: 10 },
      ],
      mapOf(
        task("orphan", { parentTaskId: "deleted-parent" }),
        task("loop-a", { parentTaskId: "loop-b" }),
        task("loop-b", { parentTaskId: "loop-a" }),
      ),
    );
    expect(result.topSessions.map((row) => row.taskId)).toContain("orphan");
    expect(result.topSessions).toHaveLength(2);
  });

  it("limits the list and leaves out sessions without usage", () => {
    const rows = Array.from({ length: 8 }, (_, index) => task(`t${index}`));
    const result = buildSessionUsageBreakdown(
      [
        ...rows.map((row, index) => ({ taskId: row.id, calls: 1, cost: index, tokens: 1 })),
        { taskId: "empty", calls: 1, cost: 0, tokens: 0 },
      ],
      mapOf(...rows, task("empty")),
    );
    expect(result.topSessions.map((row) => row.taskId)).toEqual(["t7", "t6", "t5", "t4", "t3"]);
  });
});

const Database = await import("better-sqlite3")
  .then((module) => {
    try {
      new module.default(":memory:").close();
      return module.default;
    } catch {
      return null;
    }
  })
  .catch(() => null);

const describeWithSqlite = Database ? describe : describe.skip;

describeWithSqlite("usage insights session usage on a real profile", () => {
  let tmpDir: string;
  let previousUserDataDir: string | undefined;
  let manager: DatabaseManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-session-usage-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tmpDir;
    manager = new DatabaseManager();
  });

  afterEach(() => {
    manager?.close();
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reports the split and top sessions for one workspace and for all", () => {
    const db = manager.getDatabase();
    const now = Date.now();
    for (const id of ["ws-1", "ws-2"]) {
      db.prepare(
        "INSERT INTO workspaces (id, name, path, created_at, permissions) VALUES (?, ?, ?, ?, ?)",
      ).run(id, id, path.join(tmpDir, id), now, JSON.stringify({ read: true, write: true }));
    }
    const insertTask = db.prepare(
      `INSERT INTO tasks (id, title, prompt, status, workspace_id, created_at, updated_at, source,
                          parent_task_id, agent_config)
       VALUES (?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?)`,
    );
    insertTask.run("root", "Ship the report", "p", "ws-1", now, now, "manual", null, null);
    insertTask.run("helper", "Helper", "p", "ws-1", now, now, "manual", "root", null);
    insertTask.run(
      "bot",
      "Chat with Atlas",
      "p",
      "ws-1",
      now,
      now,
      "manual",
      null,
      JSON.stringify({ botConversation: true }),
    );
    insertTask.run("elsewhere", "Other workspace", "p", "ws-2", now, now, "cron", null, null);

    const insertCall = db.prepare(
      `INSERT INTO llm_call_events (id, timestamp, workspace_id, task_id, source_kind,
                                    input_tokens, output_tokens, cost, success)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let n = 0;
    const call = (
      workspaceId: string,
      taskId: string | null,
      cost: number,
      success = 1,
      at = now - 60_000,
    ) =>
      insertCall.run(
        `call-${n++}`,
        at,
        workspaceId,
        taskId,
        taskId ? "task_event" : "mailbox_quick_reply",
        100,
        50,
        cost,
        success,
      );
    call("ws-1", "root", 0.5);
    call("ws-1", "helper", 0.25);
    call("ws-1", "helper", 9, 0); // failed call: not counted
    call("ws-1", "bot", 0.1);
    call("ws-1", null, 0.01);
    call("ws-1", "root", 5, 1, now - 30 * 24 * 60 * 60 * 1000); // outside the period
    call("ws-2", "elsewhere", 2);

    const service = new UsageInsightsService(db);
    const one = service.generate("ws-1", 7).sessionUsage;
    expect(one.byCategory.map((row) => [row.category, row.cost, row.calls])).toEqual([
      ["yours", 0.5, 1],
      ["subagents", 0.25, 1],
      ["bots", 0.1, 1],
      ["background", 0.01, 1],
    ]);
    expect(one.topSessions[0]).toMatchObject({
      taskId: "root",
      title: "Ship the report",
      cost: 0.75,
      tokens: 300,
      subagentCount: 1,
    });

    const all = service.generate(null, 7).sessionUsage;
    expect(all.topSessions.map((row) => [row.taskId, row.category])).toEqual([
      ["elsewhere", "automated"],
      ["root", "yours"],
      ["bot", "bots"],
    ]);
  });
});
