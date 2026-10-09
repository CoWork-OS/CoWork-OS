import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nativeSqliteAvailable = await import("better-sqlite3")
  .then((module) => {
    try {
      const probe = new module.default(":memory:");
      probe.close();
      return true;
    } catch {
      return false;
    }
  })
  .catch(() => false);

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

/** The retired curated table, as an older profile still has it. */
const LEGACY_CURATED_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS curated_memory_entries (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, task_id TEXT, target TEXT NOT NULL,
    kind TEXT NOT NULL, content TEXT NOT NULL, normalized_key TEXT NOT NULL,
    source TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 0.7,
    status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, last_confirmed_at INTEGER,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
    FOREIGN KEY (task_id) REFERENCES tasks(id)
  )
`;

describeWithSqlite("memory purge (SEC-15, LIFE-4)", () => {
  let tmpDir: string;
  let previousUserDataDir: string | undefined;
  let manager: import("../../database/schema").DatabaseManager;
  let db: ReturnType<import("../../database/schema").DatabaseManager["getDatabase"]>;
  let taskRepo: import("../../database/repositories").TaskStore;
  let workspace: { id: string; path: string };

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-memory-purge-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tmpDir;
    const [{ DatabaseManager }, repositories, durable] = await Promise.all([
      import("../../database/schema"),
      import("../../database/repositories"),
      import("../durable-context-sql"),
    ]);
    manager = new DatabaseManager();
    db = manager.getDatabase();
    durable.ensureDurableContextSchema(db);
    db.exec(`CREATE TABLE IF NOT EXISTS transcript_spans (
      id TEXT PRIMARY KEY, workspace_path TEXT NOT NULL, task_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL,
      event_id TEXT, seq INTEGER, raw_line TEXT NOT NULL, search_text TEXT NOT NULL,
      created_at INTEGER NOT NULL)`);
    taskRepo = new repositories.TaskStore(db);
    workspace = { id: randomUUID(), path: path.join(tmpDir, "workspace") };
    fs.mkdirSync(workspace.path, { recursive: true });
    db.prepare(
      "INSERT INTO workspaces (id, name, path, created_at, permissions) VALUES (?, ?, ?, ?, ?)",
    ).run(workspace.id, "main", workspace.path, Date.now(), JSON.stringify({ read: true }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    manager?.close();
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const count = (sql: string, ...params: unknown[]) =>
    (db.prepare(sql).get(...params) as { n: number }).n;

  const insertMemory = (taskId: string | null, origin: string) => {
    const id = randomUUID();
    const now = Date.now();
    db.prepare(
      `INSERT INTO memories (id, workspace_id, task_id, type, content, summary, tokens,
         is_compressed, is_private, created_at, updated_at)
       VALUES (?, ?, ?, 'observation', ?, 's', 1, 0, 0, ?, ?)`,
    ).run(id, workspace.id, taskId, `content ${id}`, now, now);
    db.prepare(
      `INSERT INTO memory_observation_metadata (memory_id, workspace_id, task_id, origin,
         observation_type, title, narrative, content_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'summary', 't', 'n', ?, ?, ?)`,
    ).run(id, workspace.id, taskId, origin, `hash-${id}`, now, now);
    return id;
  };

  const seedTask = () => {
    const task = taskRepo.create({
      title: "Task",
      prompt: "prompt",
      status: "completed",
      workspaceId: workspace.id,
    });
    const now = Date.now();
    const derivedMemory = insertMemory(task.id, "task");
    const savedMemory = insertMemory(task.id, "tool");
    db.prepare(
      `INSERT INTO dreaming_runs (id, workspace_id, scope_kind, scope_ref, status, trigger_source,
         source_task_id, started_at, created_at)
       VALUES (?, ?, 'workspace', ?, 'completed', 'task_completion', ?, ?, ?)`,
    ).run(randomUUID(), workspace.id, workspace.id, task.id, now, now);
    db.prepare(
      `INSERT INTO pending_memory_writes (id, workspace_id, task_id, target, action, origin,
         summary, payload_json, created_at)
       VALUES (?, ?, ?, 'curated', 'add', 'task', 's', '{}', ?)`,
    ).run(randomUUID(), workspace.id, task.id, now);
    db.prepare(
      `INSERT INTO durable_context_conversations (id, workspace_id, task_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(randomUUID(), workspace.id, task.id, now, now);
    db.prepare(
      `INSERT INTO transcript_spans (id, workspace_path, task_id, timestamp, type, payload_json,
         raw_line, search_text, created_at)
       VALUES (?, ?, ?, ?, 'tool_result', '{}', '{}', 'x', ?)`,
    ).run(randomUUID(), workspace.path, task.id, now, now);
    const typeId = randomUUID();
    db.prepare(
      `INSERT INTO kg_entity_types (id, workspace_id, name, created_at) VALUES (?, ?, ?, ?)`,
    ).run(typeId, workspace.id, `type-${typeId}`, now);
    const taskEntity = randomUUID();
    const sharedEntity = randomUUID();
    for (const [entityId, name] of [
      [taskEntity, "only-this-task"],
      [sharedEntity, "shared"],
    ]) {
      db.prepare(
        `INSERT INTO kg_entities (id, workspace_id, entity_type_id, name, source_task_id,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(entityId, workspace.id, typeId, name, task.id, now, now);
    }
    db.prepare(
      `INSERT INTO kg_observations (id, entity_id, content, source_task_id, created_at)
       VALUES (?, ?, 'from this task', ?, ?), (?, ?, 'from another task', NULL, ?)`,
    ).run(randomUUID(), taskEntity, task.id, now, randomUUID(), sharedEntity, now);
    return { task, derivedMemory, savedMemory, taskEntity, sharedEntity };
  };

  it("creates the task foreign keys with ON DELETE SET NULL", () => {
    for (const [table, column] of [
      ["dreaming_runs", "source_task_id"],
      ["pending_memory_writes", "task_id"],
    ]) {
      const fk = (
        db.pragma(`foreign_key_list(${table})`) as Array<{
          table: string;
          from: string;
          on_delete: string;
        }>
      ).find((entry) => entry.table === "tasks" && entry.from === column);
      expect(fk?.on_delete).toBe("SET NULL");
    }
  });

  it("upgrades older dreaming_runs and pending_memory_writes tables in place", async () => {
    const { task } = seedTask();
    // Recreate the pre-migration definitions (no ON DELETE action) with the data kept.
    db.pragma("foreign_keys = OFF");
    for (const table of ["dreaming_runs", "pending_memory_writes"]) {
      const sql = (
        db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(table) as { sql: string }
      ).sql;
      db.exec(`ALTER TABLE ${table} RENAME TO ${table}_old`);
      db.exec(sql.replace(/ ON DELETE SET NULL/g, ""));
      db.exec(`INSERT INTO ${table} SELECT * FROM ${table}_old; DROP TABLE ${table}_old;`);
    }
    db.pragma("foreign_keys = ON");
    manager.close();

    const { DatabaseManager } = await import("../../database/schema");
    manager = new DatabaseManager();
    db = manager.getDatabase();
    const fk = (
      db.pragma("foreign_key_list(dreaming_runs)") as Array<{ table: string; on_delete: string }>
    ).find((entry) => entry.table === "tasks");
    expect(fk?.on_delete).toBe("SET NULL");
    expect(count("SELECT COUNT(*) AS n FROM dreaming_runs WHERE source_task_id = ?", task.id)).toBe(
      1,
    );
    expect(
      count("SELECT COUNT(*) AS n FROM pending_memory_writes WHERE task_id = ?", task.id),
    ).toBe(1);
  });

  it("deletes conversation records but keeps learned memory on a retention delete", () => {
    const { task, derivedMemory } = seedTask();

    taskRepo.delete(task.id);

    expect(count("SELECT COUNT(*) AS n FROM tasks WHERE id = ?", task.id)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM durable_context_conversations")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM transcript_spans")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM dreaming_runs WHERE source_task_id IS NULL")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM pending_memory_writes WHERE task_id IS NULL")).toBe(1);
    expect(
      count("SELECT COUNT(*) AS n FROM memories WHERE id = ? AND task_id IS NULL", derivedMemory),
    ).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM kg_observations")).toBe(2);
  });

  it("deletes memory derived from the task on an explicit user delete", () => {
    const { task, derivedMemory, savedMemory, taskEntity, sharedEntity } = seedTask();

    taskRepo.delete(task.id, { purgeDerivedMemory: true });

    expect(count("SELECT COUNT(*) AS n FROM memories WHERE id = ?", derivedMemory)).toBe(0);
    expect(
      count(
        "SELECT COUNT(*) AS n FROM memory_observation_metadata WHERE memory_id = ?",
        derivedMemory,
      ),
    ).toBe(0);
    // An explicit save survives, unlinked from the deleted task.
    expect(
      count("SELECT COUNT(*) AS n FROM memories WHERE id = ? AND task_id IS NULL", savedMemory),
    ).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM kg_entities WHERE id = ?", taskEntity)).toBe(0);
    expect(
      count(
        "SELECT COUNT(*) AS n FROM kg_entities WHERE id = ? AND source_task_id IS NULL",
        sharedEntity,
      ),
    ).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM kg_observations")).toBe(1);
  });

  it("clears every workspace memory store and reports per-store counts", async () => {
    const [{ MemoryWorkspacePurgeService }, { MemoryService }, curated, durableService] =
      await Promise.all([
        import("../MemoryWorkspacePurgeService"),
        import("../MemoryService"),
        import("../CuratedMemoryService"),
        import("../DurableContextService"),
      ]);
    seedTask();
    const now = Date.now();
    // An older profile that still has the retired curated table.
    db.exec(LEGACY_CURATED_TABLE_SQL);
    db.prepare(
      `INSERT INTO curated_memory_entries (id, workspace_id, target, kind, content, normalized_key,
         source, confidence, status, created_at, updated_at)
       VALUES (?, ?, 'user', 'preference', 'likes tea', 'k', 'manual', 1, 'active', ?, ?)`,
    ).run(randomUUID(), workspace.id, now, now);
    // The candidate's trace and profile rows are not needed for this test.
    db.pragma("foreign_keys = OFF");
    db.prepare(
      `INSERT INTO core_memory_candidates (id, trace_id, profile_id, workspace_id, scope_kind,
         scope_ref, candidate_type, summary, confidence, novelty_score, stability_score, status,
         created_at)
       VALUES (?, 'trace', 'profile', ?, 'workspace', ?, 'preference', 's', 1, 1, 1, 'proposed', ?)`,
    ).run(randomUUID(), workspace.id, workspace.id, now);
    db.pragma("foreign_keys = ON");

    const files: Record<string, string> = {
      ".cowork/memory/topics/auth.md": "topic",
      ".cowork/memory/MEMORY.md": "index",
      ".cowork/memory/summaries/2026-10-01.md": "summary",
      ".cowork/memory/transcripts/spans/task-1.jsonl": "{}",
      ".cowork/memory/transcripts/checkpoints/task-1.json": "{}",
      ".cowork/memory/keep.txt": "not a memory file",
    };
    for (const [relative, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(workspace.path, relative)), { recursive: true });
      fs.writeFileSync(path.join(workspace.path, relative), content);
    }
    const outside = path.join(tmpDir, "outside.md");
    fs.writeFileSync(outside, "outside");
    fs.symlinkSync(outside, path.join(workspace.path, ".cowork/memory/topics/linked.md"));

    vi.spyOn(MemoryService, "getDatabase").mockReturnValue(db);
    vi.spyOn(MemoryService, "getStats").mockResolvedValue({
      count: 2,
      totalTokens: 0,
      compressedCount: 0,
      compressionRatio: 0,
    });
    const clearMemories = vi.spyOn(MemoryService, "clearWorkspace").mockResolvedValue();
    vi.spyOn(MemoryService, "clearPromptRecallCache").mockImplementation(() => undefined);
    vi.spyOn(durableService.DurableContextService, "clearWorkspace").mockResolvedValue(1);
    // The generated kit block strip looks the workspace up first.
    const findWorkspace = vi
      .spyOn(curated.CuratedMemoryService, "findWorkspace")
      .mockResolvedValue(undefined);

    const result = await MemoryWorkspacePurgeService.purgeWorkspace({ id: workspace.id });

    expect(result.success).toBe(true);
    expect(result.errors).toEqual({});
    expect(clearMemories).toHaveBeenCalledWith(workspace.id);
    expect(findWorkspace).toHaveBeenCalledWith(workspace.id);
    expect(result.counts).toMatchObject({
      memories: 2,
      durableContext: 1,
      curatedEntries: 1,
      coreMemoryCandidates: 1,
      dreaming: 1,
      pendingMemoryWrites: 1,
      topicFiles: 3,
      dailySummaries: 1,
    });
    expect(result.counts.knowledgeGraph).toBeGreaterThanOrEqual(4);
    // Two files plus the span index row.
    expect(result.counts.transcripts).toBe(3);
    expect(
      count("SELECT COUNT(*) AS n FROM kg_entities WHERE workspace_id = ?", workspace.id),
    ).toBe(0);
    expect(fs.existsSync(path.join(workspace.path, ".cowork/memory/keep.txt"))).toBe(true);
    // The symlink is removed; its target outside the workspace is untouched.
    expect(fs.existsSync(outside)).toBe(true);
    expect(fs.existsSync(path.join(workspace.path, ".cowork/memory/MEMORY.md"))).toBe(false);
  });

  it("removes a deleted task's transcript files and Chronicle observations", async () => {
    const { MemoryWorkspacePurgeService } = await import("../MemoryWorkspacePurgeService");
    const taskId = "task-a";
    const otherTaskId = "task-b";
    const write = (relative: string, content: string) => {
      fs.mkdirSync(path.dirname(path.join(workspace.path, relative)), { recursive: true });
      fs.writeFileSync(path.join(workspace.path, relative), content);
    };
    write(`.cowork/memory/transcripts/spans/${taskId}.jsonl`, "{}");
    write(`.cowork/memory/transcripts/checkpoints/${taskId}.json`, "{}");
    write(`.cowork/memory/transcripts/checkpoints/${taskId}.previous.json`, "{}");
    write(`.cowork/memory/transcripts/spans/${otherTaskId}.jsonl`, "{}");
    for (const [id, owner] of [
      [`chronicle-${taskId}-frame1`, taskId],
      [`chronicle-${otherTaskId}-frame1`, otherTaskId],
    ]) {
      const imagePath = path.join(workspace.path, ".cowork/chronicle/assets", `${id}.png`);
      write(`.cowork/chronicle/assets/${id}.png`, "png");
      write(
        `.cowork/chronicle/observations/${id}.json`,
        JSON.stringify({ id, taskId: owner, capturedAt: Date.now(), imagePath }),
      );
    }

    const result = await MemoryWorkspacePurgeService.purgeTaskFiles({
      taskId,
      workspacePath: workspace.path,
    });

    expect(result.errors).toEqual([]);
    expect(result.chronicleObservations).toBe(1);
    const exists = (relative: string) => fs.existsSync(path.join(workspace.path, relative));
    expect(exists(`.cowork/memory/transcripts/spans/${taskId}.jsonl`)).toBe(false);
    expect(exists(`.cowork/memory/transcripts/checkpoints/${taskId}.previous.json`)).toBe(false);
    expect(exists(`.cowork/memory/transcripts/spans/${otherTaskId}.jsonl`)).toBe(true);
    expect(exists(`.cowork/chronicle/assets/chronicle-${taskId}-frame1.png`)).toBe(false);
    expect(exists(`.cowork/chronicle/assets/chronicle-${otherTaskId}-frame1.png`)).toBe(true);
  });
});
