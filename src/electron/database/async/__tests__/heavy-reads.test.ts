import Database from "better-sqlite3";
import { buildSync } from "esbuild";
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseClient } from "../DatabaseClient";
import { DatabaseRequestError } from "../protocol";
import { DATABASE_COMMANDS, requiredTablesFor } from "../commands";
import { DatabaseManager } from "../../schema";
import { TaskEventRepository, TaskStore, WorkspaceStore } from "../../repositories";
import { insertLlmCallRow } from "../../llm-call-events";
import { WorkspaceRepository } from "../../repository-facades";
import { setReportReaderClient, setStatementClient } from "../../statements/statement-route";
import { prepareLlmCallSuccess } from "../../../agent/llm/usage-telemetry";
import { UsageInsightsProjector } from "../../../reports/UsageInsightsProjector";
import { setDeferredMigrationExecutor } from "../../deferred-event-migrations";
import { type UsageInsights, UsageInsightsService } from "../../../reports/UsageInsightsService";

// DB4 exit evidence with a real worker and a real reporting reader: result parity with
// the host, a responsive host under a deliberately slow query, cancellation of queued
// work, and worker failures that surface as errors rather than empty reports.

const BUILD_DIR = path.resolve("node_modules/.cache/cowork-db-worker-test");
let workerPath: string;
let testCommandsModule: string;

const TEST_COMMANDS_SOURCE = `
exports.commands = {
  "test.holdWriter": {
    kind: "write",
    tables: [],
    run(db, args) {
      const gate = new Int32Array(args.gate);
      Atomics.store(gate, 0, 1);
      Atomics.wait(gate, 1, 0, 5000);
      return null;
    },
  },
  "test.sleep": {
    kind: "read",
    tables: [],
    run(db, args) {
      const end = Date.now() + args.ms;
      while (Date.now() < end) {}
      return { slept: args.ms };
    },
  },
};
`;

beforeAll(() => {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  workerPath = path.join(BUILD_DIR, `database-worker-heavy-${process.pid}.js`);
  testCommandsModule = path.join(BUILD_DIR, `test-commands-heavy-${process.pid}.js`);
  buildSync({
    entryPoints: [path.resolve("src/electron/database/async/database-worker.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile: workerPath,
    external: ["better-sqlite3", "electron"],
    logLevel: "silent",
  });
  fs.writeFileSync(testCommandsModule, TEST_COMMANDS_SOURCE);
});

afterAll(() => {
  fs.rmSync(workerPath, { force: true });
  fs.rmSync(testCommandsModule, { force: true });
});

const DAY_MS = 24 * 60 * 60 * 1000;

/** Longest gap between host timer ticks while `work` runs. */
const maxHostStall = async (work: () => Promise<unknown>) => {
  let last = Date.now();
  let maxGap = 0;
  const ticker = setInterval(() => {
    const now = Date.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
  }, 5);
  try {
    await work();
  } finally {
    clearInterval(ticker);
  }
  return maxGap;
};

const waitFor = async (predicate: () => boolean, timeoutMs = 15_000) => {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/** A report without its wall-clock fields, for comparing two computations. */
const comparable = (report: UsageInsights) => {
  const { generatedAt: _generatedAt, periodStart: _start, periodEnd: _end, ...rest } = report;
  return rest;
};

const ROLLUP_TABLES = [
  "usage_insights_day",
  "usage_insights_hour",
  "usage_insights_skill_day",
  "usage_insights_tool_day",
  "usage_insights_persona_day",
  "usage_insights_feedback_reason_day",
];

const snapshotRollups = (db: Database.Database) =>
  Object.fromEntries(
    ROLLUP_TABLES.map((table) => [
      table,
      db
        .prepare(`SELECT * FROM ${table}`)
        .all()
        .map((row) => JSON.stringify(row))
        .sort(),
    ]),
  );

const resetProjector = async () => {
  await UsageInsightsProjector.shutdown();
  (UsageInsightsProjector as unknown as { instance: unknown }).instance = null;
};

describe("heavy reads and maintenance in the database worker", () => {
  let tempDir: string;
  let previousUserDataDir: string | undefined;
  let manager: DatabaseManager;
  let db: Database.Database;
  let clients: DatabaseClient[];

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-db4-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tempDir;
    manager = new DatabaseManager();
    db = manager.getDatabase();
    clients = [];
  });

  afterEach(async () => {
    setReportReaderClient(null, null);
    setStatementClient(null, null, null);
    await resetProjector();
    await Promise.all(clients.map((client) => client.close(2_000)));
    manager.close();
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const startWriter = async () => {
    const client = await DatabaseClient.start({
      dbPath: manager.getDatabasePath(),
      requiredTables: requiredTablesFor(DATABASE_COMMANDS),
      workerPath,
    });
    clients.push(client);
    return client;
  };

  const startReader = async () => {
    const client = await DatabaseClient.start({
      dbPath: manager.getDatabasePath(),
      requiredTables: [],
      readonly: true,
      workerPath,
      testCommandsModule,
    });
    clients.push(client);
    return client;
  };

  it("lists workspaces while the write worker is occupied, without losing committed updates", async () => {
    const writer = await DatabaseClient.start({
      dbPath: manager.getDatabasePath(),
      requiredTables: requiredTablesFor(DATABASE_COMMANDS),
      workerPath,
      testCommandsModule,
      readDeadlineMs: 50,
    });
    clients.push(writer);
    const reader = await startReader();
    const workspace = new WorkspaceStore(db).create("TEST DATA workspace", tempDir, {
      read: true,
      write: true,
      delete: false,
      network: false,
      shell: false,
    });
    const expectedWorkspaces = new WorkspaceStore(db).findAll();
    setStatementClient("storage", manager.getDatabasePath(), writer);
    const repository = new WorkspaceRepository(db);

    const holdWriter = async () => {
      const gate = new Int32Array(new SharedArrayBuffer(8));
      const done = writer.executeCommand("test.holdWriter", { gate: gate.buffer });
      await waitFor(() => Atomics.load(gate, 0) === 1);
      return {
        done,
        release: () => {
          Atomics.store(gate, 1, 1);
          Atomics.notify(gate, 1);
        },
      };
    };

    // Reproduce the original error: a fast workspace read expires behind other work.
    const first = await holdWriter();
    const expired = repository.findAll().catch((error: unknown) => error);
    try {
      await new Promise((resolve) => setTimeout(resolve, 80));
    } finally {
      first.release();
      await first.done;
    }
    expect(await expired).toMatchObject({ code: "deadline_exceeded" });
    expect(((await expired) as Error).message).toContain(
      "Deadline passed before statements.readUnit started",
    );

    setReportReaderClient(manager.getDatabasePath(), reader);
    const second = await holdWriter();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const workspaces = await Promise.race([
        repository.findAll(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Workspace listing waited on the writer")),
            1000,
          );
        }),
      ]);
      expect(workspaces).toEqual(expectedWorkspaces);
    } finally {
      clearTimeout(timeout);
      second.release();
      await second.done;
    }

    await repository.updatePath(workspace.id, `${tempDir}/updated`);
    expect((await repository.findAll())[0].path).toBe(`${tempDir}/updated`);
  });

  /** Tasks with legacy usage events, tool and skill events, and canonical usage rows. */
  const seedUsage = () => {
    const workspace = new WorkspaceStore(db).create("Usage", path.join(tempDir, "ws"), {
      read: true,
      write: true,
      delete: false,
      network: false,
      shell: false,
    });
    const tasks = new TaskStore(db);
    const events = new TaskEventRepository(db);
    const now = Date.now();
    for (let index = 0; index < 24; index += 1) {
      const createdAt = now - (index % 12) * DAY_MS - 60_000;
      const task = tasks.create({
        title: `Task ${index}`,
        prompt: "usage",
        status: index % 5 === 0 ? "failed" : "completed",
        workspaceId: workspace.id,
      });
      db.prepare(
        "UPDATE tasks SET created_at = ?, updated_at = ?, completed_at = ? WHERE id = ?",
      ).run(createdAt, createdAt, createdAt + 30_000, task.id);
      const at = (offset: number) => createdAt + offset * 1_000;
      events.create({
        taskId: task.id,
        timestamp: at(1),
        type: "llm_usage",
        payload: {
          providerType: "openai",
          modelId: "gpt-5.4",
          delta: { inputTokens: 1_000 + index, outputTokens: 200, cost: 0.01 },
        },
      });
      events.create({
        taskId: task.id,
        timestamp: at(2),
        type: "tool_call",
        payload: { tool: index % 2 ? "read_file" : "run_command" },
      });
      events.create({
        taskId: task.id,
        timestamp: at(3),
        type: "skill_used",
        payload: { skillId: "review", skillName: "Review" },
      });
      if (index % 4 === 0) {
        events.create({
          taskId: task.id,
          timestamp: at(4),
          type: "llm_error",
          payload: { message: "rate limited" },
        });
      }
      insertLlmCallRow(
        db,
        prepareLlmCallSuccess(
          {
            workspaceId: workspace.id,
            taskId: task.id,
            sourceKind: "task_event",
            providerType: "anthropic",
            modelId: "claude-sonnet-5",
            timestamp: at(5),
          },
          { inputTokens: 2_000, outputTokens: 400 },
        ),
      );
    }
    return workspace;
  };

  it("computes the same report in the reporting reader as on the host", async () => {
    const workspace = seedUsage();
    const reader = await startReader();
    const host = new UsageInsightsService(db);
    for (const plan of [
      { kind: "raw", canonical: false } as const,
      { kind: "raw", canonical: true } as const,
    ]) {
      for (const workspaceId of [null, workspace.id]) {
        const nowMs = Date.now();
        const expected = host.generateWithPlan(workspaceId, 30, plan, nowMs);
        const actual = await reader.execute("usage.generateReport", {
          workspaceId,
          periodDays: 30,
          plan,
          nowMs,
        });
        expect(comparable(actual)).toEqual(comparable(expected));
      }
    }
  });

  it("backfills rollups in the worker exactly as the host does, then reports from the reader", async () => {
    const workspace = seedUsage();

    // Host backfill first: the reference rollups and report.
    const hostProjector = UsageInsightsProjector.initialize(db);
    hostProjector.warm();
    await waitFor(() => hostProjector.isBackfillComplete());
    const hostRollups = snapshotRollups(db);
    const hostReport = new UsageInsightsService(db).generate(workspace.id, 30);
    await resetProjector();
    for (const table of [...ROLLUP_TABLES, "usage_insights_state"]) db.exec(`DELETE FROM ${table}`);

    const writer = await startWriter();
    const reader = await startReader();
    const writerCalls = vi.spyOn(writer, "execute");
    const projector = UsageInsightsProjector.initialize(db);
    projector.attachDatabaseWorkers(Promise.resolve({ writer, reader }));
    projector.warm();
    await waitFor(() => projector.isBackfillComplete());

    expect(snapshotRollups(db)).toEqual(hostRollups);
    const commands = new Set(writerCalls.mock.calls.map(([name]) => name));
    expect(commands).toEqual(
      new Set([
        "usage.resetRollups",
        "usage.backfillLegacyTelemetryChunk",
        "usage.rebuildRollupDates",
      ]),
    );

    const readerReport = await new UsageInsightsService(db).generateInReader(
      reader,
      workspace.id,
      30,
    );
    expect(comparable(readerReport)).toEqual(comparable(hostReport));
  });

  it("applies refreshes in the worker before a reader report", async () => {
    const workspace = seedUsage();
    const writer = await startWriter();
    const reader = await startReader();
    const projector = UsageInsightsProjector.initialize(db);
    projector.attachDatabaseWorkers(Promise.resolve({ writer, reader }));
    projector.warm();
    await waitFor(() => projector.isBackfillComplete());
    const service = new UsageInsightsService(db);
    const before = await service.generateInReader(reader, workspace.id, 7);

    const row = prepareLlmCallSuccess(
      {
        workspaceId: workspace.id,
        sourceKind: "task_event",
        providerType: "anthropic",
        modelId: "claude-sonnet-5",
        timestamp: Date.now() - 1_000,
      },
      { inputTokens: 5_000, outputTokens: 1_000 },
    );
    insertLlmCallRow(db, row);
    projector.enqueueLlmTelemetry(workspace.id, Date.now() - 1_000);

    const after = await service.generateInReader(reader, workspace.id, 7);
    expect(after.costMetrics.totalInputTokens).toBe(before.costMetrics.totalInputTokens + 5_000);
  });

  it("surfaces a reader failure as an error, never as an empty report", async () => {
    seedUsage();
    const reader = await startReader();
    await reader.close(1_000);
    await expect(new UsageInsightsService(db).generateInReader(reader, null, 30)).rejects.toThrow();
  });

  it("keeps the host responsive under a slow reader query and cancels queued work", async () => {
    seedUsage();
    const reader = await startReader();
    const controller = new AbortController();
    const slow = reader.executeCommand("test.sleep", { ms: 400 });
    const queued = new UsageInsightsService(db).generateInReader(reader, null, 30, {
      signal: controller.signal,
    });
    const stall = await maxHostStall(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      controller.abort();
      const error = await queued.then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(DatabaseRequestError);
      expect(error).toMatchObject({ code: "cancelled" });
      await slow;
    });
    expect(stall).toBeLessThan(100);
    // The reader keeps serving after a cancellation.
    await expect(
      reader.execute("usage.generateReport", {
        workspaceId: null,
        periodDays: 7,
        plan: { kind: "raw", canonical: false },
      }),
    ).resolves.toMatchObject({ workspaceId: null });
  });

  it("writes legacy events converted on a host read in the worker", async () => {
    const workspace = seedUsage();
    const task = new TaskStore(db).create({
      title: "Legacy",
      prompt: "p",
      status: "completed",
      workspaceId: workspace.id,
    });
    const insert = db.prepare(
      "INSERT INTO task_events (id, task_id, timestamp, type, payload, schema_version) VALUES (?, ?, ?, ?, ?, 1)",
    );
    for (let index = 0; index < 300; index += 1) {
      insert.run(
        `legacy-${index}`,
        task.id,
        5_000 + index,
        "tool_call",
        JSON.stringify({ tool: "grep" }),
      );
    }
    const legacy = () =>
      (
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM task_events WHERE task_id = ? AND COALESCE(schema_version, 0) <> 2",
          )
          .get(task.id) as { count: number }
      ).count;
    const writer = await startWriter();
    const calls = vi.spyOn(writer, "execute");
    setDeferredMigrationExecutor(db.name, async (taskId, rows) => {
      await writer.execute("timeline.persistMigratedEvents", { taskId, rows });
    });
    try {
      const events = new TaskEventRepository(db);
      const converted = events.findByTaskId(task.id);
      await waitFor(() => legacy() === 0);
      expect(calls.mock.calls.map(([name]) => name)).toEqual(["timeline.persistMigratedEvents"]);
      expect(events.findByTaskId(task.id)).toEqual(converted);
      expect(events.getLatestSeq(task.id)).toBe(300);
    } finally {
      setDeferredMigrationExecutor(db.name, null);
    }
  });

  it("refuses writes on the reporting reader", async () => {
    const reader = await startReader();
    await expect(
      reader.execute("maintenance.setState", { key: "x", value: "1" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("runs post-startup maintenance chunks in the worker with the host's results", async () => {
    const seedMaintenance = (target: Database.Database) => {
      target
        .prepare(
          "INSERT INTO workspaces (id, name, path, created_at, permissions) VALUES (?, ?, ?, ?, ?)",
        )
        .run("ws-m", "M", path.join(tempDir, "m"), 1, "{}");
      const insertTask = target.prepare(
        `INSERT INTO tasks (id, title, prompt, status, workspace_id, created_at, updated_at, completed_at)
         VALUES (?, ?, ?, 'completed', 'ws-m', ?, ?, ?)`,
      );
      const insertEvent = target.prepare(
        `INSERT INTO task_events (id, task_id, timestamp, type, payload, schema_version)
         VALUES (?, ?, ?, ?, ?, 2)`,
      );
      for (let index = 0; index < 250; index += 1) {
        const createdAt = 1_000_000 + index * 100_000;
        insertTask.run(`t-${index}`, "T", "p", createdAt, createdAt, createdAt + 50_000);
        insertEvent.run(`e-${index}-1`, `t-${index}`, createdAt + 1_000, "user_message", "{}");
        insertEvent.run(`e-${index}-2`, `t-${index}`, createdAt + 9_000, "tool_call", "{}");
      }
      insertEvent.run(
        "e-big",
        "t-0",
        1_002_000,
        "tool_result",
        JSON.stringify({ result: "x".repeat(900_000) }),
      );
      target.pragma("foreign_keys = OFF");
      insertEvent.run("e-orphan-1", "missing-task", 1, "tool_call", "{}");
      insertEvent.run("e-orphan-2", "missing-task", 2, "tool_call", "{}");
      target.pragma("foreign_keys = ON");
    };
    const snapshot = (target: Database.Database) => ({
      durations: target.prepare("SELECT id, last_run_duration_ms FROM tasks ORDER BY id").all(),
      bigPayloadBytes: (
        target
          .prepare("SELECT LENGTH(payload) AS bytes FROM task_events WHERE id = 'e-big'")
          .get() as {
          bytes: number;
        }
      ).bytes,
      orphans: (
        target
          .prepare("SELECT COUNT(*) AS count FROM task_events WHERE task_id = 'missing-task'")
          .get() as { count: number }
      ).count,
      sanitizerDone: (
        target
          .prepare(
            "SELECT value FROM maintenance_state WHERE key = 'task_event_payload_sanitizer_v1_completed'",
          )
          .get() as { value: string } | undefined
      )?.value,
    });

    seedMaintenance(db);
    const writer = await startWriter();
    const stall = await maxHostStall(() => manager.runPostStartupMaintenance({ client: writer }));
    const viaWorker = snapshot(db);

    // Same seed, host path, separate profile.
    const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-db4-host-"));
    process.env.COWORK_USER_DATA_DIR = hostDir;
    const hostManager = new DatabaseManager();
    try {
      seedMaintenance(hostManager.getDatabase());
      await hostManager.runPostStartupMaintenance();
      expect(viaWorker).toEqual(snapshot(hostManager.getDatabase()));
    } finally {
      hostManager.close();
      fs.rmSync(hostDir, { recursive: true, force: true });
    }

    expect(
      viaWorker.durations.every(
        (row) => (row as { last_run_duration_ms: number | null }).last_run_duration_ms !== null,
      ),
    ).toBe(true);
    expect(viaWorker.bigPayloadBytes).toBeLessThan(900_000);
    expect(viaWorker.orphans).toBe(0);
    expect(viaWorker.sanitizerDone).toBe("1");
    expect(stall).toBeLessThan(100);
  });
});
