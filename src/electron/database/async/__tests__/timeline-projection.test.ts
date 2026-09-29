import { pendingTimelineWritesCommitted } from "../../timeline-write-registry";
import { buildSync } from "esbuild";
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { normalizeTaskEventToTimelineV2 } from "../../../../shared/timeline-v2";
import type { TaskEvent } from "../../../../shared/types";
import { SessionProgressService } from "../../../sessions/SessionProgressService";
import { projectTimelineEvent } from "../../../sessions/timeline-projection";
import { WorkSessionContractService } from "../../../sessions/WorkSessionContractService";
import { WorkSessionProtocolService } from "../../../sessions/WorkSessionProtocolService";
import { TaskEventRepository, TaskStore, WorkspaceStore } from "../../repositories";
import { DatabaseManager } from "../../schema";
import { TimelineProjectionOutboxRepository } from "../../TimelineProjectionOutboxRepository";
import { DATABASE_COMMANDS, requiredTablesFor } from "../commands";
import { DatabaseClient } from "../DatabaseClient";
import { DatabaseRequestError } from "../protocol";
import { TimelineProjectionQueue } from "../TimelineProjectionQueue";
import { TimelineWriter } from "../TimelineWriter";
import { ActivityRepository } from "../../../activity/activity-repository-facades";
import { prepareLlmCallSuccess } from "../../../agent/llm/usage-telemetry";

// DB3: timeline projections through a real worker against the real schema and the real
// WorkSession services. No native-module skip guard: these must fail, not pass, without
// better-sqlite3.

const BUILD_DIR = path.resolve("node_modules/.cache/cowork-db-worker-test");
let workerPath: string;
let testCommandsModule: string;

beforeAll(() => {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  workerPath = path.join(BUILD_DIR, `timeline-database-worker-${process.pid}.js`);
  testCommandsModule = path.join(BUILD_DIR, `timeline-test-commands-${process.pid}.js`);
  const common = {
    bundle: true,
    platform: "node" as const,
    format: "cjs" as const,
    target: "node20",
    external: ["better-sqlite3", "electron"],
    logLevel: "silent" as const,
  };
  buildSync({
    ...common,
    entryPoints: [path.resolve("src/electron/database/async/database-worker.ts")],
    outfile: workerPath,
  });
  buildSync({
    ...common,
    entryPoints: [path.resolve("src/electron/database/async/__tests__/timeline-test-commands.ts")],
    outfile: testCommandsModule,
  });
});

afterAll(() => {
  fs.rmSync(workerPath, { force: true });
  fs.rmSync(testCommandsModule, { force: true });
});

const EVENT_SCRIPT: Array<[string, Record<string, unknown>]> = [
  ["task_created", { message: "Task created" }],
  ["user_message", { message: "Summarize the release notes" }],
  ["step_started", { step: { id: "step-1", description: "Read notes" } }],
  ["assistant_message", { message: "Reading the notes" }],
  ["tool_call", { tool: "read_file", toolCallId: "call-1", input: { path: "NOTES.md" } }],
  ["tool_result", { tool: "read_file", toolCallId: "call-1", result: "notes" }],
  [
    "approval_requested",
    { approval: { id: "approval-1", type: "run_command", description: "Run tests" } },
  ],
  ["approval_granted", { approvalId: "approval-1" }],
  ["step_completed", { step: { id: "step-1", description: "Read notes" } }],
  ["task_completed", { message: "Done", resultSummary: "Summarized" }],
];

const DERIVED_TABLES = [
  "work_sessions",
  "work_session_turns",
  "work_session_items",
  "work_session_wait_states",
  "work_session_evidence",
  "work_session_outcome_contracts",
  "work_session_projection_cursors",
  "work_session_operational_metrics",
  "session_progress",
];

interface Profile {
  dir: string;
  manager: DatabaseManager;
  taskId: string;
  events: TaskEvent[];
}

const profiles: Profile[] = [];
const clients: DatabaseClient[] = [];
const queues: TimelineProjectionQueue[] = [];
const writers: TimelineWriter[] = [];

afterEach(async () => {
  await Promise.all(writers.splice(0).map((writer) => writer.stop(1_000)));
  await Promise.all(queues.splice(0).map((queue) => queue.stop(1_000)));
  await Promise.all(clients.splice(0).map((client) => client.close(2_000)));
  for (const profile of profiles.splice(0)) {
    profile.manager.close();
    fs.rmSync(profile.dir, { recursive: true, force: true });
  }
  delete process.env.COWORK_USER_DATA_DIR;
});

function createProfile(): Profile {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-timeline-projection-"));
  process.env.COWORK_USER_DATA_DIR = dir;
  const manager = new DatabaseManager();
  const db = manager.getDatabase();
  const workspace = new WorkspaceStore(db).create("timeline", path.join(dir, "ws"), {
    read: true,
    write: true,
    delete: false,
    network: false,
    shell: false,
  });
  const task = new TaskStore(db).create({
    title: "Timeline projection",
    prompt: "Summarize the release notes",
    status: "executing",
    workspaceId: workspace.id,
  });
  const base = Date.now();
  const events = EVENT_SCRIPT.map(([type, payload], index) =>
    normalizeTaskEventToTimelineV2({
      taskId: task.id,
      type,
      payload,
      timestamp: base + index,
      eventId: `event-${index + 1}`,
      seq: index + 1,
    }),
  ).map((event, index) => ({ ...event, id: `event-${index + 1}` }) as TaskEvent);
  const profile = { dir, manager, taskId: task.id, events };
  profiles.push(profile);
  return profile;
}

function hostServices(profile: Profile) {
  const db = profile.manager.getDatabase();
  const protocol = new WorkSessionProtocolService(db);
  return {
    protocol,
    contracts: new WorkSessionContractService(db, protocol),
    progress: new SessionProgressService(db),
  };
}

/** The host side of DB3: commit each event with its outbox row. */
function insertWithOutbox(profile: Profile): TaskEvent[] {
  const db = profile.manager.getDatabase();
  const repo = new TaskEventRepository(db);
  const outbox = new TimelineProjectionOutboxRepository(db);
  return profile.events.map((event) =>
    db
      .transaction(() => {
        const stored = repo.create(event);
        outbox.enqueue(stored.id, stored.taskId);
        return stored;
      })
      .immediate(),
  );
}

/** Today's inline path: insert, then project on the host connection. */
function insertAndProjectInline(profile: Profile): void {
  const repo = new TaskEventRepository(profile.manager.getDatabase());
  const services = hostServices(profile);
  for (const event of profile.events) {
    const stored = repo.create(event);
    expect(projectTimelineEvent(services, stored)).toEqual([]);
  }
}

function derivedState(profile: Profile) {
  const db = profile.manager.getDatabase();
  const counts = Object.fromEntries(
    DERIVED_TABLES.map((table) => [
      table,
      (db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as { total: number }).total,
    ]),
  );
  const items = db
    .prepare(
      "SELECT kind, sequence, source_event_id AS sourceEventId FROM work_session_items ORDER BY sequence",
    )
    .all();
  const waits = db
    .prepare("SELECT kind, status FROM work_session_wait_states ORDER BY rowid")
    .all();
  const outbox = new TimelineProjectionOutboxRepository(db).count();
  // Progress state with task ids and timestamps stripped, so profiles are comparable.
  const progress = (
    db.prepare("SELECT state_json AS state FROM session_progress").all() as Array<{ state: string }>
  ).map((row) =>
    JSON.parse(row.state, (key, value) =>
      key === "taskId" || /At$|timestamp/i.test(key) ? undefined : value,
    ),
  );
  return { counts, items, waits, progress, outbox };
}

async function startClient(profile: Profile, options: { withTestCommands?: boolean } = {}) {
  const client = await DatabaseClient.start({
    dbPath: profile.manager.getDatabasePath(),
    requiredTables: requiredTablesFor(DATABASE_COMMANDS),
    workerPath,
    ...(options.withTestCommands ? { testCommandsModule } : {}),
  });
  clients.push(client);
  return client;
}

function startQueue(client: DatabaseClient) {
  const queue = new TimelineProjectionQueue(client, { leaseMaintenanceIntervalMs: 60_000 });
  queues.push(queue);
  return queue;
}

describe("timeline projections in the database worker", () => {
  it("produces the same derived session state as inline host projections", async () => {
    const inline = createProfile();
    insertAndProjectInline(inline);
    const expected = derivedState(inline);
    expect(expected.items.length).toBeGreaterThan(0);

    const worker = createProfile();
    const stored = insertWithOutbox(worker);
    const queue = startQueue(await startClient(worker));
    for (const event of stored) queue.notifyEnqueued(event.taskId, event.id);
    await queue.flush(worker.taskId);

    expect(derivedState(worker)).toEqual({ ...expected, outbox: 0 });
  });

  it("repairs projections left in the outbox by a run that ended before projecting", async () => {
    const reference = createProfile();
    insertAndProjectInline(reference);

    const crashed = createProfile();
    insertWithOutbox(crashed);
    expect(derivedState(crashed).outbox).toBe(EVENT_SCRIPT.length);

    // A new run drains whatever the previous one left, without re-running any events.
    startQueue(await startClient(crashed));
    const deadline = Date.now() + 5_000;
    while (derivedState(crashed).outbox > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(derivedState(crashed)).toEqual({ ...derivedState(reference), outbox: 0 });
  });

  it("keeps the outbox entry when the worker dies before COMMIT", async () => {
    const reference = createProfile();
    insertAndProjectInline(reference);

    const profile = createProfile();
    insertWithOutbox(profile);
    const client = await startClient(profile, { withTestCommands: true });
    const failure = await client
      .executeCommand("test.drainOneThenExitBeforeCommit", undefined)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DatabaseRequestError);
    expect(failure).toMatchObject({ code: "worker_exited", outcome: "unknown" });
    // Rolled back: nothing projected, nothing dequeued.
    expect(derivedState(profile).outbox).toBe(EVENT_SCRIPT.length);
    expect(derivedState(profile).items).toEqual([]);

    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(client.getState()).toBe("ready");
    const queue = startQueue(client);
    await queue.flush();
    const deadline = Date.now() + 5_000;
    while (derivedState(profile).outbox > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(derivedState(profile)).toEqual({ ...derivedState(reference), outbox: 0 });
  });

  it("does not project twice when the worker dies after COMMIT but before replying", async () => {
    const reference = createProfile();
    insertAndProjectInline(reference);

    const profile = createProfile();
    const stored = insertWithOutbox(profile);
    const client = await startClient(profile, { withTestCommands: true });
    await expect(
      client.executeCommand("test.drainOneThenExitAfterCommit", undefined),
    ).rejects.toMatchObject({ code: "worker_exited", outcome: "unknown" });
    expect(derivedState(profile).outbox).toBe(EVENT_SCRIPT.length - 1);

    await new Promise((resolve) => setTimeout(resolve, 700));
    const queue = startQueue(client);
    for (const event of stored.slice(1)) queue.notifyEnqueued(event.taskId, event.id);
    await queue.flush(profile.taskId);
    expect(derivedState(profile)).toEqual({ ...derivedState(reference), outbox: 0 });
  });

  it("fails the read barrier explicitly while the worker is down, keeping entries queued", async () => {
    const profile = createProfile();
    const stored = insertWithOutbox(profile);
    const client = await DatabaseClient.start({
      dbPath: profile.manager.getDatabasePath(),
      requiredTables: requiredTablesFor(DATABASE_COMMANDS),
      workerPath,
      testCommandsModule,
      maxRestarts: 0,
    });
    clients.push(client);
    await client.executeCommand("test.drainOneThenExitBeforeCommit", undefined).catch(() => null);
    expect(client.getState()).toBe("failed");

    const queue = startQueue(client);
    for (const event of stored) queue.notifyEnqueued(event.taskId, event.id);
    await expect(queue.flush(profile.taskId, 300)).rejects.toThrow(/still pending/);
    expect(derivedState(profile).outbox).toBe(EVENT_SCRIPT.length);
  });

  it("runs lease upkeep in the worker", async () => {
    const profile = createProfile();
    const client = await startClient(profile);
    await expect(client.execute("timeline.maintainLeases", undefined)).resolves.toEqual({
      ok: true,
    });
    await expect(
      client.execute("timeline.drainProjectionOutbox", { limit: 0 }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  describe("with timeline writes in the worker", () => {
    const startWriterBackend = async (profile: Profile) => {
      const client = await startClient(profile);
      const queue = startQueue(client);
      const writer = new TimelineWriter(profile.manager.getDatabase(), client, {
        onEventsCommitted: () => queue.wake(),
      });
      writers.push(writer);
      return { client, queue, writer };
    };

    const enqueueScript = (
      profile: Profile,
      queue: TimelineProjectionQueue,
      writer: TimelineWriter,
    ) =>
      profile.events.map((event) => {
        const prepared = TaskEventRepository.prepareForInsert(event);
        queue.notifyEnqueued(prepared.stored.taskId, prepared.stored.id);
        writer.enqueueTaskEvent(prepared);
        return prepared;
      });

    const waitUntil = async (predicate: () => boolean) => {
      const deadline = Date.now() + 5_000;
      while (!predicate() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(predicate()).toBe(true);
    };

    it("inserts events in the worker and matches inline derived state", async () => {
      const inline = createProfile();
      insertAndProjectInline(inline);

      const profile = createProfile();
      const { queue, writer } = await startWriterBackend(profile);
      enqueueScript(profile, queue, writer);
      expect(writer.pendingCount()).toBe(EVENT_SCRIPT.length);
      await waitUntil(() => writer.pendingCount() === 0);
      await queue.flush(profile.taskId);

      expect(derivedState(profile)).toEqual({ ...derivedState(inline), outbox: 0 });
    });

    it("shows pending rows to a read that races the worker, without a host write or duplicates", async () => {
      const inline = createProfile();
      insertAndProjectInline(inline);

      const profile = createProfile();
      const { queue, writer } = await startWriterBackend(profile);
      enqueueScript(profile, queue, writer);
      // Read before the worker has written anything: the read merges the accepted rows
      // (DB6) and writes nothing on the host.
      const db = profile.manager.getDatabase();
      const committedBefore = (
        db.prepare("SELECT COUNT(*) AS n FROM task_events").get() as {
          n: number;
        }
      ).n;
      const read = new TaskEventRepository(db).findByTaskId(profile.taskId);
      expect(read.map((event) => event.id)).toEqual(profile.events.map((event) => event.id));
      expect((db.prepare("SELECT COUNT(*) AS n FROM task_events").get() as { n: number }).n).toBe(
        committedBefore,
      );
      await waitUntil(() => writer.pendingCount() === 0);
      // Once committed by the worker, the same read returns each event once.
      expect(
        new TaskEventRepository(db).findByTaskId(profile.taskId).map((event) => event.id),
      ).toEqual(profile.events.map((event) => event.id));

      // The worker's batch (already sent or not) must now be a no-op.
      await new Promise((resolve) => setTimeout(resolve, 100));
      await queue.flush(profile.taskId);
      expect(derivedState(profile)).toEqual({ ...derivedState(inline), outbox: 0 });
    });

    it("resolves a commit wait for the rows accepted before it, while later rows keep arriving", async () => {
      const profile = createProfile();
      const { queue, writer } = await startWriterBackend(profile);
      const [first, ...rest] = profile.events;
      const prepared = TaskEventRepository.prepareForInsert(first);
      queue.notifyEnqueued(prepared.stored.taskId, prepared.stored.id);
      writer.enqueueTaskEvent(prepared);
      const waiting = writer.committed(profile.taskId);
      // Later rows for the same task do not hold up the wait for the first one.
      for (const event of rest) {
        const next = TaskEventRepository.prepareForInsert(event);
        queue.notifyEnqueued(next.stored.taskId, next.stored.id);
        writer.enqueueTaskEvent(next);
      }
      await waiting;
      const db = profile.manager.getDatabase();
      expect(db.prepare("SELECT id FROM task_events WHERE id = ?").get(first.id)).toEqual({
        id: first.id,
      });
      await waitUntil(() => writer.pendingCount() === 0);
      await queue.flush(profile.taskId);
    });

    it("resolves an all-tasks commit wait once every accepted row is in the table", async () => {
      const profile = createProfile();
      const { queue, writer } = await startWriterBackend(profile);
      for (const event of profile.events) {
        const prepared = TaskEventRepository.prepareForInsert(event);
        queue.notifyEnqueued(prepared.stored.taskId, prepared.stored.id);
        writer.enqueueTaskEvent(prepared);
      }
      // Range readers wait for this instead of committing the rows on the host.
      await pendingTimelineWritesCommitted(profile.manager.getDatabase());
      const db = profile.manager.getDatabase();
      expect(
        (
          db
            .prepare("SELECT COUNT(*) AS n FROM task_events WHERE task_id = ?")
            .get(profile.taskId) as {
            n: number;
          }
        ).n,
      ).toBe(profile.events.length);
      await queue.flush(profile.taskId);
    });

    it("writes activity and usage rows once, whichever side commits them", async () => {
      const profile = createProfile();
      const { writer } = await startWriterBackend(profile);
      const db = profile.manager.getDatabase();
      const activity = ActivityRepository.prepareForInsert({
        workspaceId: (db.prepare("SELECT workspace_id AS id FROM tasks").get() as { id: string })
          .id,
        taskId: profile.taskId,
        actorType: "agent",
        activityType: "tool_used",
        title: "Read notes",
      } as Parameters<typeof ActivityRepository.prepareForInsert>[0]);
      let usageCommitted = 0;
      writer.enqueueActivity(activity);
      writer.enqueueLlmCall(
        prepareLlmCallSuccess(
          { sourceKind: "test", taskId: profile.taskId, modelId: "stub", providerType: "openai" },
          { inputTokens: 10, outputTokens: 5 },
        ),
        () => {
          usageCommitted += 1;
        },
      );
      // An activity read commits activity rows on the host; usage goes to the worker.
      expect((await new ActivityRepository(db).findById(activity.id))?.id).toBe(activity.id);
      await waitUntil(() => writer.pendingCount() === 0);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const count = (sql: string) => (db.prepare(sql).get() as { total: number }).total;
      expect(count("SELECT COUNT(*) AS total FROM activity_feed")).toBe(1);
      expect(count("SELECT COUNT(*) AS total FROM llm_call_events")).toBe(1);
      expect(usageCommitted).toBe(1);
    });

    it("commits everything left on the host when it stops", async () => {
      const profile = createProfile();
      const { client, queue, writer } = await startWriterBackend(profile);
      await client.close();
      enqueueScript(profile, queue, writer);
      await writer.stop();
      const db = profile.manager.getDatabase();
      expect(
        (db.prepare("SELECT COUNT(*) AS total FROM task_events").get() as { total: number }).total,
      ).toBe(EVENT_SCRIPT.length);
    });
  });
});
