import { buildSync } from "esbuild";
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseClient } from "../async/DatabaseClient";
import { DATABASE_COMMANDS, requiredTablesFor } from "../async/commands";
import { TaskRepository } from "../repository-facades";
import { DatabaseManager } from "../schema";
import { setStatementClient } from "../statements/statement-route";
import { HookSessionRepository } from "../../hooks/hook-session-repository-facades";
import { CouncilConfigRepository } from "../../council/council-repository-facades";

// Rollback (async SQLite migration plan, DB7): both backends read and write one schema, so
// rolling back is a restart on the other backend after the worker drains. One profile goes
// worker -> host -> worker; every step sees everything the previous steps committed.

const BUILD_DIR = path.resolve("node_modules/.cache/cowork-db-worker-test");
let workerPath: string;

beforeAll(() => {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  workerPath = path.join(BUILD_DIR, `database-worker-rollback-${process.pid}.js`);
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

describe("rolling a profile back and forward between backends", () => {
  it("keeps every committed write across worker -> host -> worker restarts", async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cowork-rollback-")));
    const previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = dir;
    const run = async (backend: "worker" | "host", label: string) => {
      // A fresh "run" of the app on this profile.
      const manager = new DatabaseManager();
      const db = manager.getDatabase();
      let client: DatabaseClient | null = null;
      if (backend === "worker") {
        client = await DatabaseClient.start({
          dbPath: manager.getDatabasePath(),
          requiredTables: requiredTablesFor(DATABASE_COMMANDS),
          workerPath,
        });
        for (const domain of ["storage", "services"]) {
          setStatementClient(domain, manager.getDatabasePath(), client);
        }
      }
      const tasks = new TaskRepository(db);
      const hooks = new HookSessionRepository(db);
      const councils = new CouncilConfigRepository(db);
      const task = await tasks.create({
        title: `Task from ${label}`,
        prompt: "Rollback check",
        status: "pending",
        workspaceId: "ws-1",
        source: "manual",
      } as never);
      await hooks.create(`hook:${label}`, task.id);
      await councils.create({
        workspaceId: "ws-1",
        name: `Council from ${label}`,
        schedule: { kind: "every", everyMs: 3_600_000 },
        participants: [
          { providerType: "openai", modelKey: "gpt-5", seatLabel: "A" },
          { providerType: "anthropic", modelKey: "sonnet", seatLabel: "B" },
        ],
        judgeSeatIndex: 1,
      } as never);
      const seen = {
        tasks: (await tasks.findByWorkspace("ws-1")).map((row) => row.title).sort(),
        hooks: await Promise.all(
          ["worker-1", "host", "worker-2"].map(async (key) =>
            Boolean(await hooks.findBySessionKey(`hook:${key}`)),
          ),
        ),
        councils: (await councils.listByWorkspace("ws-1")).map((row) => row.name).sort(),
        schemaVersion: db.pragma("user_version", { simple: true }),
      };
      // Roll back cleanly: drain the worker before the next run takes over.
      const closed = client ? await client.close(5_000) : { drained: true };
      setStatementClient(null, null, null);
      manager.close();
      return { seen, closed };
    };
    try {
      const bootstrap = new DatabaseManager();
      bootstrap
        .getDatabase()
        .prepare(
          `INSERT INTO workspaces (id, name, path, created_at, permissions) VALUES (?, ?, ?, ?, ?)`,
        )
        .run("ws-1", "Workspace", path.join(dir, "workspace"), 1, "{}");
      bootstrap.close();

      const first = await run("worker", "worker-1");
      const rolledBack = await run("host", "host");
      const rolledForward = await run("worker", "worker-2");

      expect(first.closed).toMatchObject({ drained: true });
      expect(rolledForward.closed).toMatchObject({ drained: true });
      expect(rolledBack.seen.tasks).toEqual(["Task from host", "Task from worker-1"]);
      expect(rolledBack.seen.hooks).toEqual([true, true, false]);
      expect(rolledForward.seen).toMatchObject({
        tasks: ["Task from host", "Task from worker-1", "Task from worker-2"],
        hooks: [true, true, true],
        councils: ["Council from host", "Council from worker-1", "Council from worker-2"],
      });
      // Neither backend changes the schema on its own.
      expect(
        new Set([first, rolledBack, rolledForward].map((r) => r.seen.schemaVersion)).size,
      ).toBe(1);
    } finally {
      if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
      else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
