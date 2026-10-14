import type Database from "better-sqlite3";
import { buildSync } from "esbuild";
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeTaskEventToTimelineV2 } from "../../../shared/timeline-v2";
import type { TaskStatus } from "../../../shared/types";
import { DatabaseClient } from "../async/DatabaseClient";
import { DATABASE_COMMANDS, requiredTablesFor } from "../async/commands";
import {
  FOLLOW_UP_RECOVERY_TASK_STATUSES,
  FollowUpRecoveryStore,
  hasUnstartedFollowUpReceipt,
} from "../follow-up-recovery-sql";
import { TaskEventRepository, TaskStore, WorkspaceStore } from "../repositories";
import { storageStatements } from "../repository-facades";
import { DatabaseManager } from "../schema";
import { setReportReaderClient, setStatementClient } from "../statements/statement-route";

// The startup follow-up recovery scan (taskEvent_findUnstartedFollowUpTaskIds) must pick
// exactly the tasks the host's per-task receipt check would, on either backend.

const BUILD_DIR = path.resolve("node_modules/.cache/cowork-db-worker-test");
let workerPath: string;

beforeAll(() => {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  workerPath = path.join(BUILD_DIR, `database-worker-follow-up-${process.pid}.js`);
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
});

afterAll(() => {
  fs.rmSync(workerPath, { force: true });
});

type Receipt = Record<string, unknown> & { seq?: number; timestamp?: number };

const followUp = (messageId: string, deliveryStatus: string, extra: Receipt = {}): Receipt => ({
  message: "Please also check the tests",
  messageId,
  deliveryMode: "follow_up",
  deliveryStatus,
  ...extra,
});

describe("startup follow-up recovery scan", () => {
  const previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
  let dir: string;
  let manager: DatabaseManager;
  let db: Database.Database;
  let workspaceId: string;
  let eventCounter = 0;
  const taskIds = new Map<string, string>();
  const cleanups: Array<() => Promise<void> | void> = [];

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cowork-follow-up-scan-")));
    process.env.COWORK_USER_DATA_DIR = dir;
    manager = new DatabaseManager();
    db = manager.getDatabase();
    const workspaceDir = path.join(dir, "ws");
    fs.mkdirSync(workspaceDir);
    workspaceId = new WorkspaceStore(db).create("Follow-ups", workspaceDir, {
      read: true,
      write: true,
      delete: false,
      network: false,
      shell: false,
    }).id;
    taskIds.clear();
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    setStatementClient(null, null, null);
    setReportReaderClient(null, null);
    manager.close();
    fs.rmSync(dir, { recursive: true, force: true });
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    vi.restoreAllMocks();
  });

  function addTask(name: string, status: TaskStatus): string {
    const task = new TaskStore(db).create({ title: name, prompt: name, status, workspaceId });
    taskIds.set(name, task.id);
    return task.id;
  }

  /** A receipt as the daemon journals it: a timeline v2 row with legacy type user_message. */
  function addReceipt(taskId: string, payload: Receipt): void {
    eventCounter += 1;
    const { seq = eventCounter, timestamp = 1_000 + eventCounter, ...rest } = payload;
    const eventId = `receipt-${eventCounter}`;
    const event = normalizeTaskEventToTimelineV2({
      taskId,
      type: "user_message",
      payload: rest,
      timestamp,
      eventId,
      seq,
    });
    new TaskEventRepository(db).create({ ...event, id: eventId });
  }

  /** A pre-timeline-v2 row: type user_message, no legacy type, raw payload text. */
  function addLegacyRow(taskId: string, payloadText: string): void {
    eventCounter += 1;
    db.prepare(
      `INSERT INTO task_events (id, task_id, timestamp, type, payload, schema_version)
       VALUES (?, ?, ?, 'user_message', ?, 1)`,
    ).run(`legacy-${eventCounter}`, taskId, 1_000 + eventCounter, payloadText);
  }

  function seedProfile(): void {
    addReceipt(addTask("completed-started", "completed"), followUp("m1", "started"));
    addReceipt(addTask("cancelled-queued", "cancelled"), followUp("m2", "queued"));
    addReceipt(addTask("blocked-started", "blocked"), followUp("m3", "started"));
    // `status` stands in for `deliveryStatus` on older receipts.
    addLegacyRow(
      addTask("failed-legacy-queued", "failed"),
      JSON.stringify({ messageId: "m4", deliveryMode: "follow_up", status: "queued" }),
    );

    const superseded = addTask("completed-superseded", "completed");
    addReceipt(superseded, followUp("m5", "queued"));
    addReceipt(superseded, followUp("m5", "accepted", { providerDispatchStatus: "completed" }));

    // Timeline order is seq first: the later timestamp does not make a receipt latest.
    const seqAccepted = addTask("completed-seq-accepted", "completed");
    addReceipt(seqAccepted, followUp("m6", "accepted", { seq: 20, timestamp: 1 }));
    addReceipt(seqAccepted, followUp("m6", "queued", { seq: 10, timestamp: 9_999 }));
    const seqQueued = addTask("completed-seq-queued", "completed");
    addReceipt(seqQueued, followUp("m7", "accepted", { seq: 10, timestamp: 9_999 }));
    addReceipt(seqQueued, followUp("m7", "queued", { seq: 20, timestamp: 1 }));

    const twoMessages = addTask("paused-second-message-started", "paused");
    addReceipt(twoMessages, followUp("m8", "accepted"));
    addReceipt(twoMessages, followUp("m9", "started"));

    addReceipt(
      addTask("completed-agent-message", "completed"),
      followUp("m10", "queued", { deliveryMode: "message" }),
    );
    addReceipt(addTask("completed-mentions-follow-up", "completed"), {
      message: "Use the follow_up flag",
      messageId: "m11",
      deliveryStatus: "queued",
    });
    addReceipt(addTask("completed-blank-message-id", "completed"), followUp("  ", "queued"));
    addLegacyRow(
      addTask("completed-malformed", "completed"),
      '{"messageId":"m12","deliveryMode":"follow_up","deliveryStatus":"queued"',
    );
    addReceipt(addTask("executing-started", "executing"), followUp("m13", "started"));
    addReceipt(addTask("interrupted-queued", "interrupted"), followUp("m14", "queued"));
    addTask("completed-no-receipts", "completed");
  }

  const expectedNames = [
    "blocked-started",
    "cancelled-queued",
    "completed-seq-queued",
    "completed-started",
    "failed-legacy-queued",
    "paused-second-message-started",
  ];

  const namesOf = (ids: readonly string[]) => {
    const byId = new Map([...taskIds].map(([name, id]) => [id, name]));
    return ids.map((id) => byId.get(id) ?? id).sort();
  };

  /** The host's per-task check, as the daemon's full-scan fallback runs it. */
  function hostCandidates(): string[] {
    const statuses: readonly string[] = FOLLOW_UP_RECOVERY_TASK_STATUSES;
    const tasks = new TaskStore(db);
    const events = new TaskEventRepository(db);
    return [...taskIds.values()].filter((taskId) => {
      const task = tasks.findById(taskId);
      if (!task || !statuses.includes(task.status)) return false;
      const receipts = events.findByTaskIdAndTypes(taskId, ["user_message"]);
      return hasUnstartedFollowUpReceipt(receipts.map((event) => event.payload));
    });
  }

  it("finds the tasks whose latest follow-up receipt is queued or started", () => {
    seedProfile();

    const scanned = new FollowUpRecoveryStore(db).findUnstartedFollowUpTaskIds();

    expect(namesOf(scanned)).toEqual(expectedNames);
    expect(namesOf(scanned)).toEqual(namesOf(hostCandidates()));
  });

  it("reads only follow-up candidate rows through the event type indexes", () => {
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT e.task_id FROM task_events e
         WHERE (e.legacy_type = 'user_message' OR (e.legacy_type IS NULL AND e.type = 'user_message'))
           AND instr(e.payload, 'follow_up') > 0`,
      )
      .all() as Array<{ detail: string }>;
    const details = plan.map((row) => row.detail).join("\n");

    expect(details).not.toMatch(/^SCAN e$/m);
    expect(details).toMatch(/legacy_type/);
  });

  it("runs as a report unit on the reporting reader of the database worker", async () => {
    seedProfile();
    const dbPath = manager.getDatabasePath();
    const writer = await DatabaseClient.start({
      dbPath,
      requiredTables: requiredTablesFor(DATABASE_COMMANDS),
      workerPath,
    });
    cleanups.push(() => writer.close(2_000).then(() => undefined));
    const reader = await DatabaseClient.start({
      dbPath,
      requiredTables: [],
      readonly: true,
      workerPath,
    });
    cleanups.push(() => reader.close(2_000).then(() => undefined));
    const writerExecute = vi.spyOn(writer, "execute");
    const readerExecute = vi.spyOn(reader, "execute");
    setStatementClient("storage", dbPath, writer);
    setReportReaderClient(dbPath, reader);

    const port = storageStatements(db);
    const scanned = await port.unit("taskEvent_findUnstartedFollowUpTaskIds", []);

    expect(port.usesWorker()).toBe(true);
    expect(namesOf(scanned)).toEqual(expectedNames);
    expect(readerExecute).toHaveBeenCalledWith(
      "statements.readUnit",
      expect.objectContaining({
        domain: "storage",
        name: "taskEvent_findUnstartedFollowUpTaskIds",
      }),
    );
    expect(writerExecute).not.toHaveBeenCalled();
  });
});
