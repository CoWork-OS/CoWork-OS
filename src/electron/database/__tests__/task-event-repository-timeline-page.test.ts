import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskEventRepository } from "../repositories";

type Any = any;

describe("TaskEventRepository.findTimelinePage", () => {
  let db: FakeTaskEventDb;
  let repo: TaskEventRepository;

  beforeEach(() => {
    db = new FakeTaskEventDb();
    repo = new TaskEventRepository(db as never);
  });

  function insertEvent(input: {
    id: string;
    taskId?: string;
    timestamp?: number;
    seq?: number;
    legacyType?: string;
    payload?: unknown;
  }): void {
    db.rows.push({
      id: input.id,
      task_id: input.taskId ?? "task-1",
      timestamp: input.timestamp ?? 1000,
      type: "timeline_evidence_attached",
      payload: JSON.stringify(input.payload ?? { title: input.id }),
      payload_bytes: Buffer.byteLength(JSON.stringify(input.payload ?? { title: input.id })),
      schema_version: 2,
      event_id: input.id,
      seq: input.seq ?? 10,
      ts: input.timestamp ?? 1000,
      status: "completed",
      step_id: null,
      group_id: null,
      actor: "assistant",
      legacy_type: input.legacyType ?? "file_created",
    });
  }

  it("uses a stable id cursor so equal timestamp rows are not skipped", () => {
    insertEvent({ id: "evt-a" });
    insertEvent({ id: "evt-b" });
    insertEvent({ id: "evt-c" });

    const first = repo.findTimelinePage({ taskId: "task-1", limit: 2 });
    const second = repo.findTimelinePage({
      taskId: "task-1",
      limit: 2,
      cursor: first.nextCursor,
    });

    expect(first.events.map((event) => event.id)).toEqual(["evt-b", "evt-c"]);
    expect(first.nextCursor).toMatchObject({ id: "evt-b" });
    expect(second.events.map((event) => event.id)).toEqual(["evt-a"]);
  });

  it("caps large event payloads and exposes full payload through event detail", () => {
    const largeText = "x".repeat(96 * 1024);
    insertEvent({ id: "evt-large", payload: { text: largeText } });

    const page = repo.findTimelinePage({
      taskId: "task-1",
      limit: 10,
      byteLimit: 32 * 1024,
      singleEventByteLimit: 8 * 1024,
    });
    const event = page.events[0]!;

    expect(page.summary.truncatedEventCount).toBe(1);
    expect(event.payload?.__coworkPayloadTruncated).toBe(true);

    const detail = repo.findEventDetailById("evt-large");
    expect(detail.event?.payload?.text).toBe(largeText);
    expect(detail.payloadBytes).toBeGreaterThan(64 * 1024);
    expect(page.summary.databaseReadBytesEstimate).toBeLessThan(16 * 1024);
    const timelineQuery = db.preparedSqls.find(
      (sql) => sql.includes("timeline_order") && sql.includes("CASE"),
    );
    expect(timelineQuery).not.toContain("SELECT\n          *");
    expect(timelineQuery).toContain("SUBSTR");
  });

  it("scopes event detail lookups to the selected task and allowed child output events", () => {
    insertEvent({ id: "parent-detail", taskId: "parent", legacyType: "plan_created" });
    insertEvent({ id: "child-detail", taskId: "child", legacyType: "file_created" });
    insertEvent({ id: "child-noise", taskId: "child", legacyType: "llm_usage" });
    insertEvent({ id: "unrelated-detail", taskId: "unrelated", legacyType: "file_created" });

    expect(repo.findEventDetailById("parent-detail", { taskId: "parent" }).event?.id).toBe(
      "parent-detail",
    );
    expect(
      repo.findEventDetailById("child-detail", {
        taskId: "parent",
        additionalTaskIds: ["child"],
        additionalTaskEventTypes: ["file_created"],
      }).event?.id,
    ).toBe("child-detail");
    expect(
      repo.findEventDetailById("child-noise", {
        taskId: "parent",
        additionalTaskIds: ["child"],
        additionalTaskEventTypes: ["file_created"],
      }).event,
    ).toBeNull();
    expect(repo.findEventDetailById("unrelated-detail", { taskId: "parent" }).event).toBeNull();
  });

  it("can include only selected child output events for collaborative roots", () => {
    insertEvent({ id: "parent-event", taskId: "parent", legacyType: "plan_created" });
    insertEvent({ id: "child-file", taskId: "child", legacyType: "file_created" });
    insertEvent({ id: "child-noise", taskId: "child", legacyType: "llm_usage" });

    const page = repo.findTimelinePage({
      taskId: "parent",
      additionalTaskIds: ["child"],
      additionalTaskEventTypes: ["file_created"],
      limit: 10,
    });

    expect(page.events.map((event) => event.id)).toEqual(["child-file", "parent-event"]);
  });

  it("pins the task plan into the first page when recent history excludes it", () => {
    insertEvent({
      id: "plan",
      seq: 1,
      timestamp: 1,
      legacyType: "plan_created",
      payload: {
        plan: {
          steps: [{ id: "step-1", description: "Inspect the task", status: "pending" }],
        },
      },
    });
    insertEvent({ id: "middle", seq: 2, timestamp: 2, legacyType: "file_created" });
    insertEvent({ id: "latest", seq: 3, timestamp: 3, legacyType: "file_created" });

    const page = repo.findTimelinePage({ taskId: "task-1", limit: 1 });

    expect(page.events.map((event) => event.id)).toEqual(["plan", "latest"]);
    expect(page.summary.planStepCount).toBe(1);
    expect(page.hasMoreHistory).toBe(true);
    expect(page.nextCursor).toMatchObject({ id: "latest" });
  });

  it("does not pin the task plan into older cursor pages", () => {
    insertEvent({ id: "plan", seq: 1, timestamp: 1, legacyType: "plan_created" });
    insertEvent({ id: "middle", seq: 2, timestamp: 2, legacyType: "file_created" });
    insertEvent({ id: "latest", seq: 3, timestamp: 3, legacyType: "file_created" });

    const first = repo.findTimelinePage({ taskId: "task-1", limit: 1 });
    const second = repo.findTimelinePage({
      taskId: "task-1",
      limit: 1,
      cursor: first.nextCursor,
    });

    expect(first.events.map((event) => event.id)).toEqual(["plan", "latest"]);
    expect(second.events.map((event) => event.id)).toEqual(["middle"]);
  });

  it("splits child output scope into indexable chunk queries without dropping later child ids", () => {
    const childTaskIds = Array.from({ length: 505 }, (_, index) => `child-${index}`);
    insertEvent({ id: "parent-event", taskId: "parent", legacyType: "plan_created" });
    insertEvent({ id: "late-child-file", taskId: "child-504", legacyType: "file_created" });

    const page = repo.findTimelinePage({
      taskId: "parent",
      additionalTaskIds: childTaskIds,
      additionalTaskEventTypes: ["file_created"],
      limit: 10,
    });

    expect(page.events.map((event) => event.id)).toContain("late-child-file");

    const timelineSelects = db.preparedSqls.filter((sql) => sql.includes("FROM task_events"));
    expect(timelineSelects.some((sql) => sql.includes("task_id IN"))).toBe(true);
    expect(timelineSelects.filter((sql) => sql.includes("task_id IN")).length).toBeGreaterThan(1);
    expect(timelineSelects.some((sql) => sql.includes("task_id = ? OR"))).toBe(false);
  });
});

describe("TaskEventRepository.findTimelinePage sqlite integration", () => {
  let sqliteLoadError: unknown = null;
  let db: Any = null;
  let repo: TaskEventRepository | null = null;

  beforeEach(async () => {
    sqliteLoadError = null;
    db = null;
    repo = null;
    try {
      const sqlite = await import("better-sqlite3");
      const Database = sqlite.default;
      db = new Database(":memory:");
      db.exec(`
        CREATE TABLE task_events (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          type TEXT NOT NULL,
          payload TEXT,
          schema_version INTEGER,
          event_id TEXT,
          seq INTEGER,
          ts INTEGER,
          status TEXT,
          step_id TEXT,
          group_id TEXT,
          actor TEXT,
          legacy_type TEXT
        );
      `);
      repo = new TaskEventRepository(db);
    } catch (error) {
      sqliteLoadError = error;
    }
  });

  afterEach(() => {
    db?.close?.();
  });

  function skipIfSqliteUnavailable(): boolean {
    if (!sqliteLoadError) return false;
    console.warn(
      "[task-event-repository-timeline-page] skipping sqlite integration:",
      sqliteLoadError instanceof Error ? sqliteLoadError.message : String(sqliteLoadError),
    );
    return true;
  }

  function insertSqliteEvent(input: { id: string; timestamp?: number; seq?: number }): void {
    db.prepare(`
      INSERT INTO task_events (
        id,
        task_id,
        timestamp,
        type,
        payload,
        schema_version,
        event_id,
        seq,
        ts,
        status,
        step_id,
        group_id,
        actor,
        legacy_type
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      "task-1",
      input.timestamp ?? 1000,
      "timeline_evidence_attached",
      JSON.stringify({ title: input.id }),
      2,
      input.id,
      input.seq ?? 10,
      input.timestamp ?? 1000,
      "completed",
      null,
      null,
      "assistant",
      "file_created",
    );
  }

  it("runs the stable cursor query against real sqlite when the native binding is loadable", () => {
    if (skipIfSqliteUnavailable()) return;
    insertSqliteEvent({ id: "evt-a" });
    insertSqliteEvent({ id: "evt-b" });
    insertSqliteEvent({ id: "evt-c" });

    const first = repo!.findTimelinePage({ taskId: "task-1", limit: 2 });
    const second = repo!.findTimelinePage({
      taskId: "task-1",
      limit: 2,
      cursor: first.nextCursor,
    });

    expect(first.events.map((event) => event.id)).toEqual(["evt-b", "evt-c"]);
    expect(second.events.map((event) => event.id)).toEqual(["evt-a"]);
  });
});

type FakeTaskEventRow = {
  id: string;
  task_id: string;
  timestamp: number;
  type: string;
  payload: string;
  payload_bytes: number;
  schema_version: number;
  event_id: string;
  seq: number;
  ts: number;
  status: string;
  step_id: string | null;
  group_id: string | null;
  actor: string;
  legacy_type: string;
  timeline_order?: number;
};

class FakeTaskEventDb {
  rows: FakeTaskEventRow[] = [];
  preparedSqls: string[] = [];

  prepare(sql: string): {
    all: (...args: unknown[]) => FakeTaskEventRow[];
    get: (...args: unknown[]) => FakeTaskEventRow | undefined;
  } {
    this.preparedSqls.push(sql);
    return {
      all: (...args: unknown[]) => this.selectRows(sql, args),
      get: (...args: unknown[]) => {
        if (
          sql.includes("WHERE task_id = ?") &&
          sql.includes("COALESCE(legacy_type, type) IN (?)")
        ) {
          const taskId = String(args[0] ?? "");
          const type = String(args[1] ?? "");
          return this.rows
            .filter((row) => row.task_id === taskId && (row.legacy_type || row.type) === type)
            .map((row) => ({ ...row, timeline_order: row.seq ?? row.timestamp }))
            .sort((a, b) => {
              const orderDelta = (b.timeline_order ?? 0) - (a.timeline_order ?? 0);
              if (orderDelta !== 0) return orderDelta;
              const timestampDelta = b.timestamp - a.timestamp;
              if (timestampDelta !== 0) return timestampDelta;
              return b.id.localeCompare(a.id);
            })[0];
        }
        const id = String(args[0] ?? "");
        const row = this.rows.find((candidate) => candidate.id === id || candidate.event_id === id);
        if (!row || !sql.includes("AND task_id")) return row;
        if (sql.includes("task_id = ?")) {
          return row.task_id === String(args[2] ?? "") ? row : undefined;
        }
        const taskIdInMatch = sql.match(/task_id IN \(([^)]*)\)/);
        const typeMatch = sql.match(/COALESCE\(legacy_type, type\) IN \(([^)]*)\)/);
        const taskIdCount = (taskIdInMatch?.[1]?.match(/\?/g) ?? []).length;
        const typeCount = (typeMatch?.[1]?.match(/\?/g) ?? []).length;
        const taskIds = args.slice(2, 2 + taskIdCount).map(String);
        const types = args.slice(2 + taskIdCount, 2 + taskIdCount + typeCount).map(String);
        return taskIds.includes(row.task_id) && types.includes(row.legacy_type || row.type)
          ? row
          : undefined;
      },
    };
  }

  private selectRows(sql: string, args: unknown[]): FakeTaskEventRow[] {
    const limit = Number(args[args.length - 1]) || 100;
    const countPlaceholders = (pattern: RegExp): number => {
      const match = sql.match(pattern);
      return (match?.[1]?.match(/\?/g) ?? []).length;
    };
    const taskIdInCount = countPlaceholders(/task_id IN \(([^)]*)\)/);
    const typeCount = countPlaceholders(/COALESCE\(legacy_type, type\) IN \(([^)]*)\)/);
    const scopedTaskIds =
      taskIdInCount > 0 ? args.slice(0, taskIdInCount).map(String) : [String(args[0] ?? "")];
    const scopedTypes =
      typeCount > 0 ? args.slice(taskIdInCount, taskIdInCount + typeCount).map(String) : [];
    const cursorStart = taskIdInCount > 0 ? taskIdInCount + typeCount : 1;
    const hasStableCursor = sql.includes("timestamp = ? AND id < ?");
    const hasLegacyCursor = !hasStableCursor && sql.includes("timestamp < ?");
    const cursorOrder = hasStableCursor || hasLegacyCursor ? Number(args[cursorStart]) : null;
    const cursorTimestamp =
      hasStableCursor || hasLegacyCursor ? Number(args[cursorStart + 2]) : null;
    const cursorId = hasStableCursor ? String(args[cursorStart + 4] ?? "") : null;

    return this.rows
      .filter((row) => {
        if (!scopedTaskIds.includes(row.task_id)) return false;
        return scopedTypes.length === 0 || scopedTypes.includes(row.legacy_type || row.type);
      })
      .filter((row) => {
        if (cursorOrder === null || cursorTimestamp === null) return true;
        const order = row.seq ?? row.timestamp;
        if (order < cursorOrder) return true;
        if (order !== cursorOrder) return false;
        if (row.timestamp < cursorTimestamp) return true;
        if (!cursorId) return false;
        return row.timestamp === cursorTimestamp && row.id < cursorId;
      })
      .map((row) => ({ ...row, timeline_order: row.seq ?? row.timestamp }))
      .sort((a, b) => {
        const orderDelta = (b.timeline_order ?? 0) - (a.timeline_order ?? 0);
        if (orderDelta !== 0) return orderDelta;
        const timestampDelta = b.timestamp - a.timestamp;
        if (timestampDelta !== 0) return timestampDelta;
        return b.id.localeCompare(a.id);
      })
      .slice(0, limit);
  }
}
