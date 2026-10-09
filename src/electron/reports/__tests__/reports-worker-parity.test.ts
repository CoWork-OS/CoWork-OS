import { buildSync } from "esbuild";
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DatabaseClient } from "../../database/async/DatabaseClient";
import { DATABASE_COMMANDS, requiredTablesFor } from "../../database/async/commands";
import { TaskStore, WorkspaceStore } from "../../database/repositories";
import { DatabaseManager } from "../../database/schema";
import {
  setReportReaderClient,
  setStatementClient,
} from "../../database/statements/statement-route";
import { reportsStatements } from "../reports-statement-port";

// The reports domain on both backends (async SQLite migration plan, DB6): same results
// through the host connection and through the worker, with reads on the reporting reader.

const BUILD_DIR = path.resolve("node_modules/.cache/cowork-db-worker-test");
let workerPath: string;

beforeAll(() => {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  workerPath = path.join(BUILD_DIR, `database-worker-reports-${process.pid}.js`);
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

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function stable(value: unknown, start: number): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, entry) => {
      if (typeof entry === "string") return entry.replace(UUID, "<uuid>");
      if (
        typeof entry === "number" &&
        entry >= start - 3 * 86_400_000 &&
        entry < start + 3_600_000
      ) {
        return "<time>";
      }
      return entry;
    }),
  );
}

describe("reports on the host and in the database worker", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  const previousUserDataDir = process.env.COWORK_USER_DATA_DIR;

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    setStatementClient(null, null, null);
    setReportReaderClient(null, null);
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    vi.restoreAllMocks();
  });

  async function runWorkload(backend: "host" | "worker") {
    const dir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), `cowork-reports-${backend}-`)),
    );
    process.env.COWORK_USER_DATA_DIR = dir;
    const manager = new DatabaseManager();
    const db = manager.getDatabase();
    const calls = { writer: 0, reader: 0 };
    const clients: DatabaseClient[] = [];
    if (backend === "worker") {
      const writer = await DatabaseClient.start({
        dbPath: manager.getDatabasePath(),
        requiredTables: requiredTablesFor(DATABASE_COMMANDS),
        workerPath,
      });
      const reader = await DatabaseClient.start({
        dbPath: manager.getDatabasePath(),
        requiredTables: [],
        workerPath,
        readonly: true,
      });
      clients.push(writer, reader);
      for (const [client, kind] of [
        [writer, "writer"],
        [reader, "reader"],
      ] as const) {
        const execute = client.execute.bind(client);
        vi.spyOn(client, "execute").mockImplementation(((name: string, args: unknown) => {
          if (name.startsWith("statements.")) calls[kind] += 1;
          return execute(name as Parameters<typeof execute>[0], args as never);
        }) as typeof client.execute);
      }
      setStatementClient("reports", manager.getDatabasePath(), writer);
      setReportReaderClient(manager.getDatabasePath(), reader);
    }
    cleanups.push(async () => {
      for (const client of clients) await client.close(2_000);
      manager.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    const start = Date.now();
    const workspaceDir = path.join(dir, "ws");
    fs.mkdirSync(workspaceDir);
    const workspace = new WorkspaceStore(db).create("Reports", workspaceDir, {
      read: true,
      write: true,
      delete: false,
      network: false,
      shell: false,
    });
    const tasks = new TaskStore(db);
    for (const [title, status] of [
      ["Done", "completed"],
      ["Running", "executing"],
      ["Stuck", "failed"],
    ] as const) {
      tasks.create({ title, prompt: title, status, workspaceId: workspace.id });
    }

    const reports = reportsStatements(db);
    return {
      calls,
      result: stable(
        {
          completed: await reports.unit("briefing_countTasks", [workspace.id, "completed"]),
          executing: await reports.unit("briefing_countTasks", [workspace.id, "executing"]),
          recentFailed: await reports.unit("briefing_countTasks", [
            workspace.id,
            "failed",
            start - 60_000,
          ]),
          scheduled: await reports.unit("briefing_countScheduledTasks", [workspace.id]),
          earliest: (await reports.unit("usage_getEarliestActivityMs", [workspace.id])) !== null,
        },
        start,
      ),
    };
  }

  it("returns the same results, with reads on the reporting reader", async () => {
    const host = await runWorkload("host");
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    setStatementClient(null, null, null);
    setReportReaderClient(null, null);
    vi.restoreAllMocks();
    const worker = await runWorkload("worker");

    expect(host.calls).toEqual({ writer: 0, reader: 0 });
    // Report units are all reads: none of them may queue ahead of writes.
    expect(worker.calls.writer).toBe(0);
    expect(worker.calls.reader).toBeGreaterThanOrEqual(5);
    expect(worker.result).toEqual(host.result);
    const result = host.result as Record<string, Any>;
    expect(result.completed).toBe(1);
    expect(result.executing).toBe(1);
    expect(result.recentFailed).toBe(1);
    expect(result.scheduled).toBe(0);
    expect(result.earliest).toBe(true);
  });
});
