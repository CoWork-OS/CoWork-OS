import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

describeWithSqlite("TaskRepository.delete", () => {
  let tmpDir: string;
  let previousUserDataDir: string | undefined;
  let manager: import("../schema").DatabaseManager;
  let db: ReturnType<import("../schema").DatabaseManager["getDatabase"]>;
  let taskRepo: import("../repositories").TaskRepository;

  const insertWorkspace = (name = "main") => {
    const workspace = {
      id: randomUUID(),
      name,
      path: path.join(tmpDir, name),
      createdAt: Date.now(),
      permissions: JSON.stringify({
        read: true,
        write: true,
        delete: true,
        network: true,
        shell: true,
      }),
    };

    fs.mkdirSync(workspace.path, { recursive: true });
    db.prepare(
      `
        INSERT INTO workspaces (id, name, path, created_at, permissions)
        VALUES (?, ?, ?, ?, ?)
      `,
    ).run(workspace.id, workspace.name, workspace.path, workspace.createdAt, workspace.permissions);

    return workspace;
  };

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-task-delete-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tmpDir;

    const [{ DatabaseManager }, repositories] = await Promise.all([
      import("../schema"),
      import("../repositories"),
    ]);

    manager = new DatabaseManager();
    db = manager.getDatabase();
    taskRepo = new repositories.TaskRepository(db);
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

  it("removes task rows while nulling newer task-linked history tables", () => {
    const now = Date.now();
    const workspace = insertWorkspace();

    const task = taskRepo.create({
      title: "Root task",
      prompt: "archive me",
      status: "pending",
      workspaceId: workspace.id,
    });

    const childTask = taskRepo.create({
      title: "Child task",
      prompt: "branch from root",
      status: "pending",
      workspaceId: workspace.id,
    });
    taskRepo.update(childTask.id, {
      parentTaskId: task.id,
      branchFromTaskId: task.id,
    });

    db.prepare(
      `
        INSERT INTO llm_call_events (
          id, timestamp, workspace_id, task_id, source_kind, source_id, provider_type, model_key, model_id,
          input_tokens, output_tokens, cached_tokens, cost, success, error_code, error_message
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      randomUUID(),
      now,
      workspace.id,
      task.id,
      "task",
      `source-${randomUUID()}`,
      "openai",
      "gpt-5.4",
      "gpt-5.4",
      10,
      20,
      0,
      0.01,
      1,
      null,
      null,
    );

    db.prepare(
      `
        INSERT INTO supervisor_exchanges (
          id, workspace_id, coordination_channel_id, linked_task_id, status, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(randomUUID(), workspace.id, "discord:ops", task.id, "open", now, now);

    const councilConfigId = randomUUID();
    db.prepare(
      `
        INSERT INTO council_configs (
          id, workspace_id, name, enabled, schedule_json, participants_json, judge_seat_index,
          rotating_idea_seat_index, source_bundle_json, delivery_config_json, execution_policy_json,
          managed_cron_job_id, next_idea_seat_index, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      councilConfigId,
      workspace.id,
      "Delete test council",
      1,
      JSON.stringify({ kind: "cron", expr: "0 9 * * *" }),
      JSON.stringify([]),
      0,
      0,
      JSON.stringify({}),
      JSON.stringify({}),
      JSON.stringify({}),
      null,
      0,
      now,
      now,
    );

    const councilRunId = randomUUID();
    db.prepare(
      `
        INSERT INTO council_runs (
          id, council_config_id, workspace_id, task_id, status, source_snapshot_json, started_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(councilRunId, councilConfigId, workspace.id, task.id, "running", JSON.stringify({}), now);

    db.prepare(
      `
        INSERT INTO council_memos (
          id, council_run_id, council_config_id, workspace_id, task_id, content, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(randomUUID(), councilRunId, councilConfigId, workspace.id, task.id, "memo", now);

    taskRepo.delete(task.id);

    expect(taskRepo.findById(task.id)).toBeUndefined();
    expect(taskRepo.findById(childTask.id)?.parentTaskId).toBeUndefined();
    expect(taskRepo.findById(childTask.id)?.branchFromTaskId).toBeUndefined();

    expect(
      db.prepare("SELECT task_id FROM llm_call_events WHERE source_kind = 'task'").get() as {
        task_id: string | null;
      },
    ).toEqual({ task_id: null });

    expect(
      db.prepare("SELECT linked_task_id FROM supervisor_exchanges").get() as {
        linked_task_id: string | null;
      },
    ).toEqual({ linked_task_id: null });

    expect(
      db.prepare("SELECT task_id FROM council_runs WHERE id = ?").get(councilRunId) as {
        task_id: string | null;
      },
    ).toEqual({ task_id: null });

    expect(
      db.prepare("SELECT task_id FROM council_memos WHERE council_run_id = ?").get(councilRunId) as {
        task_id: string | null;
      },
    ).toEqual({ task_id: null });

    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("archives tasks that have memory and managed-session history", () => {
    const now = Date.now();
    const workspace = insertWorkspace();

    const task = taskRepo.create({
      title: "Task with retained history",
      prompt: "archive me without breaking history",
      status: "completed",
      workspaceId: workspace.id,
    });

    const memoryId = randomUUID();
    db.prepare(
      `
        INSERT INTO memories (
          id, workspace_id, task_id, type, content, summary, tokens,
          is_compressed, is_private, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      memoryId,
      workspace.id,
      task.id,
      "task_result",
      "Retained memory content",
      "Retained memory",
      12,
      0,
      0,
      now,
      now,
    );

    db.prepare(
      `
        INSERT INTO curated_memory_entries (
          id, workspace_id, task_id, target, kind, content, normalized_key,
          source, confidence, status, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      randomUUID(),
      workspace.id,
      task.id,
      "workspace",
      "preference",
      "A curated memory tied to the archived task",
      "workspace:preference:test",
      "task",
      0.9,
      "active",
      now,
      now,
    );

    db.prepare(
      `
        INSERT INTO memory_observation_metadata (
          memory_id, workspace_id, task_id, origin, observation_type, title,
          narrative, content_hash, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      memoryId,
      workspace.id,
      task.id,
      "task",
      "summary",
      "Retained observation",
      "Observation metadata tied to the archived task",
      "hash-archive-task",
      now,
      now,
    );

    const agentId = randomUUID();
    const environmentId = randomUUID();
    const managedSessionId = randomUUID();
    db.prepare(
      `
        INSERT INTO managed_agents (id, name, description, status, current_version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(agentId, "Archive Test Agent", null, "active", 1, now, now);
    db.prepare(
      `
        INSERT INTO managed_environments (id, name, kind, revision, status, config_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(environmentId, "Archive Test Env", "local", 1, "active", "{}", now, now);
    db.prepare(
      `
        INSERT INTO managed_sessions (
          id, agent_id, agent_version, environment_id, title, status, workspace_id,
          backing_task_id, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      managedSessionId,
      agentId,
      1,
      environmentId,
      "Managed archive session",
      "completed",
      workspace.id,
      task.id,
      now,
      now,
    );
    db.prepare(
      `
        INSERT INTO managed_session_events (
          id, session_id, seq, timestamp, type, payload_json, source_task_id, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(randomUUID(), managedSessionId, 1, now, "task_event", "{}", task.id, now);

    taskRepo.delete(task.id);

    expect(taskRepo.findById(task.id)).toBeUndefined();
    expect(
      db.prepare("SELECT task_id FROM memories WHERE id = ?").get(memoryId) as {
        task_id: string | null;
      },
    ).toEqual({ task_id: null });
    expect(
      db.prepare("SELECT task_id FROM curated_memory_entries").get() as {
        task_id: string | null;
      },
    ).toEqual({ task_id: null });
    expect(
      db.prepare("SELECT task_id FROM memory_observation_metadata WHERE memory_id = ?").get(memoryId) as {
        task_id: string | null;
      },
    ).toEqual({ task_id: null });
    expect(
      db.prepare("SELECT backing_task_id FROM managed_sessions WHERE id = ?").get(managedSessionId) as {
        backing_task_id: string | null;
      },
    ).toEqual({ backing_task_id: null });
    expect(
      db.prepare("SELECT source_task_id FROM managed_session_events WHERE session_id = ?").get(managedSessionId) as {
        source_task_id: string | null;
      },
    ).toEqual({ source_task_id: null });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("prunes only stale remote shadow tasks covered by the fetched window", () => {
    const workspace = insertWorkspace();
    const now = Date.now();

    const keepTask = taskRepo.create({
      title: "Keep remote task",
      prompt: "still exists remotely",
      status: "in_progress",
      workspaceId: workspace.id,
      targetNodeId: "remote-gateway:device-1",
    });
    const recentStaleTask = taskRepo.create({
      title: "Recent stale remote task",
      prompt: "archived on remote",
      status: "in_progress",
      workspaceId: workspace.id,
      targetNodeId: "remote-gateway:device-1",
    });
    const oldStaleTask = taskRepo.create({
      title: "Old remote history",
      prompt: "older than current fetch window",
      status: "completed",
      workspaceId: workspace.id,
      targetNodeId: "device-1-client-id",
    });
    const otherDeviceTask = taskRepo.create({
      title: "Other remote device",
      prompt: "should stay",
      status: "pending",
      workspaceId: workspace.id,
      targetNodeId: "remote-gateway:device-2",
    });

    db.prepare("UPDATE tasks SET created_at = ?, updated_at = ? WHERE id = ?").run(
      now - 1_000,
      now - 1_000,
      keepTask.id,
    );
    db.prepare("UPDATE tasks SET created_at = ?, updated_at = ? WHERE id = ?").run(
      now - 2_000,
      now - 2_000,
      recentStaleTask.id,
    );
    db.prepare("UPDATE tasks SET created_at = ?, updated_at = ? WHERE id = ?").run(
      now - 10_000,
      now - 10_000,
      oldStaleTask.id,
    );

    const pruned = taskRepo.pruneByTargetNodeIds(
      ["remote-gateway:device-1", "device-1-client-id"],
      [keepTask.id],
      now - 3_000,
    );

    expect(pruned).toBe(1);
    expect(taskRepo.findById(keepTask.id)).toBeDefined();
    expect(taskRepo.findById(recentStaleTask.id)).toBeUndefined();
    expect(taskRepo.findById(oldStaleTask.id)).toBeDefined();
    expect(taskRepo.findById(otherDeviceTask.id)).toBeDefined();
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
