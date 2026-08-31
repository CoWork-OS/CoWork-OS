import { beforeEach, describe, expect, it } from "vitest";

import { TaskEventRepository } from "../repositories";

type ReplayRow = {
  id: string;
  task_id: string;
  timestamp: number;
  type: string;
  payload: string;
  schema_version: number;
  event_id: string;
  seq: number;
  ts: number;
  status: string;
  step_id: null;
  group_id: null;
  actor: string;
  legacy_type: string;
};

class FakeReplayDb {
  rows: ReplayRow[] = [];
  preparedSqls: string[] = [];

  prepare(sql: string): {
    all: (...args: unknown[]) => unknown[];
    get: (...args: unknown[]) => unknown;
  } {
    this.preparedSqls.push(sql);
    return {
      all: (...args: unknown[]) => this.selectRows(sql, args),
      get: (...args: unknown[]) => {
        const rows = this.selectRows(sql, args);
        const row = rows[0];
        return row && sql.includes("AS timeline_order")
          ? { ...row, timeline_order: row.seq ?? row.timestamp }
          : row;
      },
    };
  }

  private selectRows(sql: string, args: unknown[]): ReplayRow[] {
    const taskId = String(args[0] ?? "");
    const typeMatch = sql.match(/COALESCE\(legacy_type, type\) IN \(([^)]*)\)/);
    const typeCount = (typeMatch?.[1]?.match(/\?/g) ?? []).length;
    const hasBoundary = sql.includes("COALESCE(seq, timestamp) > ?");
    const typeStart = hasBoundary ? 6 : 1;
    const types = args.slice(typeStart, typeStart + typeCount).map(String);
    const boundaryOrder = hasBoundary ? Number(args[1]) : Number.NEGATIVE_INFINITY;
    const boundaryTimestamp = hasBoundary ? Number(args[3]) : Number.NEGATIVE_INFINITY;
    const boundaryId = hasBoundary ? String(args[5] ?? "") : "";
    const hasLimit = sql.includes("LIMIT ?");
    const limit = hasLimit ? Number(args[args.length - 1]) : Number.POSITIVE_INFINITY;
    const requiresSnapshot = sql.includes("= 'conversation_snapshot'");
    const requestedEventId = sql.includes("(id = ? OR event_id = ?)") ? String(args[1]) : null;

    return this.rows
      .filter((row) => row.task_id === taskId)
      .filter(
        (row) =>
          !requestedEventId || row.id === requestedEventId || row.event_id === requestedEventId,
      )
      .filter(
        (row) =>
          !hasBoundary ||
          row.seq > boundaryOrder ||
          (row.seq === boundaryOrder &&
            (row.timestamp > boundaryTimestamp ||
              (row.timestamp === boundaryTimestamp && row.id > boundaryId))),
      )
      .filter((row) => !requiresSnapshot || row.legacy_type === "conversation_snapshot")
      .filter((row) => types.length === 0 || types.includes(row.legacy_type || row.type))
      .sort((a, b) => b.seq - a.seq || b.timestamp - a.timestamp || b.id.localeCompare(a.id))
      .slice(0, limit);
  }
}

describe("TaskEventRepository bounded replay queries", () => {
  let db: FakeReplayDb;
  let repo: TaskEventRepository;

  beforeEach(() => {
    db = new FakeReplayDb();
    repo = new TaskEventRepository(db as never);
  });

  function insert(
    id: string,
    timestamp: number,
    legacyType: string,
    payload = {},
    seq = timestamp,
  ): void {
    db.rows.push({
      id,
      task_id: "task-1",
      timestamp,
      type: "timeline_evidence_attached",
      payload: JSON.stringify(payload),
      schema_version: 2,
      event_id: id,
      seq,
      ts: timestamp,
      status: "completed",
      step_id: null,
      group_id: null,
      actor: "assistant",
      legacy_type: legacyType,
    });
  }

  it("loads only the newest conversation snapshot", () => {
    insert("snapshot-1", 10, "conversation_snapshot", { version: 1 });
    insert("snapshot-2", 20, "conversation_snapshot", { version: 2 });

    expect(repo.findLatestConversationSnapshot("task-1")?.id).toBe("snapshot-2");
  });

  it("returns a bounded, filtered replay tail in chronological order", () => {
    insert("before", 5, "task_list_updated");
    insert("tail-1", 11, "task_list_updated");
    insert("noise", 12, "command_output");
    insert("tail-2", 13, "llm_usage");
    insert("tail-3", 14, "task_list_updated");

    const events = repo.findReplayTailAfterCursor(
      "task-1",
      { order: 10, timestamp: 10, id: "boundary" },
      ["task_list_updated", "llm_usage"],
      2,
    );

    expect(events.map((event) => event.id)).toEqual(["tail-2", "tail-3"]);
  });

  it("does not omit later events that share the boundary timestamp", () => {
    insert("boundary", 10, "task_list_updated", {}, 10);
    insert("same-order-later-id", 10, "task_list_updated", {}, 10);
    insert("later-seq", 10, "llm_usage", {}, 11);

    const cursor = repo.findEventCursorById("task-1", "boundary");
    expect(cursor).toEqual({ order: 10, timestamp: 10, id: "boundary" });
    expect(
      repo
        .findReplayTailAfterCursor("task-1", cursor!, ["task_list_updated", "llm_usage"], 10)
        .map((event) => event.id),
    ).toEqual(["same-order-later-id", "later-seq"]);
  });

  it("pushes type and limit filtering into the database query", () => {
    insert("file-1", 1, "file_modified");
    insert("noise", 2, "command_output");
    insert("file-2", 3, "file_modified");

    const events = repo.findByTaskIdAndTypes("task-1", ["file_modified"], 1);

    expect(events.map((event) => event.id)).toEqual(["file-2"]);
    expect(db.preparedSqls.at(-1)).toContain("LIMIT ?");
  });
});
