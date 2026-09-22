import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { TaskRepository } from "../repositories";

describe("bot conversation query isolation", () => {
  it("filters before pagination and excludes archived conversations without excluding ordinary role work from generic lists", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`CREATE TABLE tasks (id TEXT, title TEXT, prompt TEXT, raw_prompt TEXT, user_prompt TEXT,
        result_summary TEXT, status TEXT, workspace_id TEXT, assigned_agent_role_id TEXT,
        agent_config TEXT, created_at INTEGER, updated_at INTEGER, session_id TEXT, source TEXT,
        is_pinned INTEGER, completed_at INTEGER, last_run_duration_ms INTEGER, parent_task_id TEXT,
        agent_type TEXT, worker_role TEXT, board_column TEXT, priority INTEGER,
        comparison_session_id TEXT, branch_from_task_id TEXT, branch_from_event_id TEXT,
        branch_label TEXT, resume_strategy TEXT, strategy_lock TEXT, budget_profile TEXT,
        terminal_status TEXT, failure_class TEXT, verification_verdict TEXT, continuation_count INTEGER,
        awaiting_user_input_reason_code TEXT, worktree_path TEXT, target_node_id TEXT, company_id TEXT,
        goal_id TEXT, project_id TEXT, issue_id TEXT, heartbeat_run_id TEXT, request_depth INTEGER,
        billing_code TEXT, semantic_summary TEXT);
        CREATE TABLE task_events (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          type TEXT NOT NULL,
          payload TEXT NOT NULL,
          seq INTEGER,
          legacy_type TEXT
        );
        CREATE TABLE task_session_metadata (session_id TEXT, archived_at INTEGER);`);
      const insert = db.prepare(
        `INSERT INTO tasks (
          id, title, prompt, raw_prompt, user_prompt, result_summary, status, workspace_id,
          assigned_agent_role_id, agent_config, created_at, updated_at, session_id, source, is_pinned
        ) VALUES (?, ?, '', '', '', '', 'completed', ?, ?, ?, ?, ?, ?, 'manual', 0)`,
      );
      const add = (
        id: string,
        workspace: string,
        role: string,
        config: string | null,
        time: number,
      ) => insert.run(id, id, workspace, role, config, time, time, id);
      add("older-chat", "workspace-a", "bot-a", '{"botConversation":true}', 1);
      add("newer-chat", "workspace-a", "bot-a", '{"botConversation":true}', 2);
      add("archived-chat", "workspace-a", "bot-a", '{"botConversation":true}', 3);
      db.prepare("INSERT INTO task_session_metadata VALUES (?, ?)").run("archived-chat", 4);
      add("different-workspace", "workspace-b", "bot-a", '{"botConversation":true}', 4);
      add("different-bot", "workspace-a", "bot-b", '{"botConversation":true}', 5);
      add("routine-work", "workspace-a", "bot-a", "{}", 6);
      add("side-chat", "workspace-a", "bot-a", '{"botConversation":true}', 7);
      db.exec("UPDATE tasks SET source = 'side_chat' WHERE id = 'side-chat'");
      add("malformed-config", "workspace-a", "bot-a", "not-json", 8);
      add("null-config", "workspace-a", "bot-a", null, 9);
      const insertEvent = db.prepare(
        "INSERT INTO task_events (id, task_id, timestamp, type, payload, seq) VALUES (?, ?, ?, ?, ?, ?)",
      );
      insertEvent.run(
        "newer-user-message",
        "newer-chat",
        20,
        "user_message",
        JSON.stringify({ message: "Review the latest bot findings" }),
        20,
      );
      insertEvent.run(
        "newer-assistant-message",
        "newer-chat",
        21,
        "assistant_message",
        JSON.stringify({ message: "The latest findings are ready" }),
        21,
      );
      insertEvent.run(
        "older-agent-receipt",
        "older-chat",
        22,
        "timeline_step_updated",
        JSON.stringify({
          message: '{"success":true,"deliveryStatus":"queued","message_id":"message-4"}',
        }),
        22,
      );
      db.prepare("UPDATE task_events SET legacy_type = 'assistant_message' WHERE id = ?").run(
        "older-agent-receipt",
      );
      for (let i = 0; i < 600; i++) add(`unrelated-${i}`, "workspace-b", "bot-b", "{}", 10 + i);
      const repo = new TaskRepository(db as never);
      const filter = {
        botConversation: { workspaceId: "workspace-a", agentRoleId: "bot-a" },
        includeArchivedSessions: false,
        excludeSources: ["side_chat" as const],
      };
      const newestBotPage = repo.findAll(1, 0, filter);
      expect(newestBotPage.map((task) => task.id)).toEqual(["newer-chat"]);
      expect(newestBotPage[0]?.sidebarPromptPreview).toBe("The latest findings are ready");
      expect(repo.findAll(1, 1, filter).map((task) => task.id)).toEqual(["older-chat"]);
      expect(
        repo.findAll(10, 0, { ...filter, includeArchivedSessions: true }).map((task) => task.id),
      ).toEqual(["archived-chat", "newer-chat", "older-chat"]);
      expect(
        repo
          .findAll(1000, 0, { includeArchivedSessions: false })
          .some((task) => task.id === "routine-work"),
      ).toBe(true);
      const sidebarIds = repo
        .findSidebarSummaries(1000, 0, {
          excludeBotConversations: true,
          includeArchivedSessions: false,
          excludeSources: ["side_chat"],
        })
        .map((task) => task.id);
      expect(sidebarIds).toEqual(
        expect.arrayContaining(["routine-work", "malformed-config", "null-config"]),
      );
      expect(sidebarIds).not.toEqual(
        expect.arrayContaining(["newer-chat", "older-chat", "side-chat"]),
      );
      expect(
        repo.findBotConversations("workspace-a", { agentRoleId: "bot-a" }).map((task) => task.id),
      ).toEqual(["archived-chat", "newer-chat", "older-chat"]);
      expect(
        repo
          .findBotConversations("workspace-a", {
            agentRoleId: "bot-a",
            includeArchivedSessions: false,
            limit: 1,
          })
          .map((task) => task.id),
      ).toEqual(["newer-chat"]);
      expect(repo.findBotConversations("workspace-b", { agentRoleId: "bot-a" })).toHaveLength(1);
      expect(
        repo
          .findBotConversations("workspace-a", {
            agentRoleId: "bot-a",
            includeAllWorkspaces: true,
            includeArchivedSessions: false,
          })
          .map((task) => task.id),
      ).toEqual(["different-workspace", "newer-chat", "older-chat"]);
      expect(
        repo
          .findBotConversations("workspace-a", { agentRoleId: "bot-a" })
          .find((task) => task.id === "newer-chat")?.sidebarPromptPreview,
      ).toBe("The latest findings are ready");
      expect(
        repo
          .findBotConversations("workspace-a", { agentRoleId: "bot-a" })
          .find((task) => task.id === "older-chat")?.sidebarPromptPreview,
      ).toBe("Queued for the next turn");
      expect(
        repo.findBotConversations("workspace-a", { agentRoleId: "bot-b" }).map((task) => task.id),
      ).toEqual(["different-bot"]);
      expect(
        repo
          .findBotConversations("workspace-a", { agentRoleId: "bot-a" })
          .find((task) => task.id === "archived-chat")?.sessionArchived,
      ).toBe(true);
    } finally {
      db.close();
    }
  });
});
