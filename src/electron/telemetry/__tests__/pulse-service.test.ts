import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { categorizePulseTool, PulseService } from "../pulse-service";

describe("CoWork Pulse privacy categorization", () => {
  it("reduces tool names to bounded categories", () => {
    expect(categorizePulseTool("exec_command")).toBe("shell");
    expect(categorizePulseTool("read_file")).toBe("filesystem");
    expect(categorizePulseTool("browser_navigate")).toBe("browser");
    expect(categorizePulseTool("mcp__linear__create_issue")).toBe("connector");
    expect(categorizePulseTool("unknown-private-tool-name")).toBe("other");
  });
});

describe("CoWork Pulse synthetic sample exclusion", () => {
  it("omits sample tasks and their tool and model errors from the daily package", () => {
    const db = new Database(":memory:");
    try {
      db.exec(`
        CREATE TABLE tasks (id TEXT PRIMARY KEY, source TEXT, created_at INTEGER, completed_at INTEGER, status TEXT, terminal_status TEXT, last_run_duration_ms INTEGER, parent_task_id TEXT, eval_case_id TEXT, session_id TEXT);
        CREATE TABLE task_events (task_id TEXT, timestamp INTEGER, type TEXT, legacy_type TEXT, payload TEXT);
        CREATE TABLE llm_call_events (task_id TEXT, timestamp INTEGER, success INTEGER);
      `);
      const now = Date.UTC(2026, 8, 24, 12);
      const insertTask = db.prepare(
        "INSERT INTO tasks VALUES (?, ?, ?, ?, 'completed', 'ok', 1000, NULL, NULL, ?)",
      );
      insertTask.run("sample", "sample", now, now, "sample");
      insertTask.run("real", "manual", now, now, "real");
      db.prepare("INSERT INTO task_events VALUES (?, ?, 'tool_call', NULL, ?)").run(
        "sample",
        now,
        JSON.stringify({ tool: "read_file" }),
      );
      db.prepare("INSERT INTO task_events VALUES (?, ?, 'tool_call', NULL, ?)").run(
        "real",
        now,
        JSON.stringify({ tool: "read_file" }),
      );
      db.prepare("INSERT INTO llm_call_events VALUES (?, ?, 0)").run("sample", now);
      db.prepare("INSERT INTO llm_call_events VALUES (?, ?, 0)").run("real", now);
      const service = new PulseService(db, {
        version: "test",
        runtime: "desktop",
        now: () => now + 86_400_000,
      });
      const daily = (
        service as unknown as {
          buildPackage(id: string): {
            activity: { tasksStarted: number; usefulTasks: number };
            tools: { filesystem: number };
            reliability: { llmErrors: number };
          };
        }
      ).buildPackage("install");
      expect(daily.activity.tasksStarted).toBe(1);
      expect(daily.activity.usefulTasks).toBe(1);
      expect(daily.tools.filesystem).toBe(1);
      expect(daily.reliability.llmErrors).toBe(1);
    } finally {
      db.close();
    }
  });
});
