import { buildSync } from "esbuild";
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DatabaseClient } from "../../database/async/DatabaseClient";
import { DATABASE_COMMANDS, requiredTablesFor } from "../../database/async/commands";
import { AgentRoleStore } from "../../agents/AgentRoleRepository";
import { TaskStore } from "../../database/repositories";
import { DatabaseManager } from "../../database/schema";
import { setStatementClient } from "../../database/statements/statement-route";
import { MemoryItemsRepository } from "../MemoryItemsRepository";
import { MemoryWriter } from "../MemoryWriter";
import { createMemoryStatementPort } from "../memory-statement-port";
import { nativeSqliteAvailable } from "./memory-items-test-db";

// memory_items units on both backends: the same MemoryWriter workload through the host
// connection and through the database worker must leave the same rows and results.

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;
const BUILD_DIR = path.resolve("node_modules/.cache/cowork-db-worker-test");
let workerPath: string;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function stable(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, entry) =>
      typeof entry === "string" ? entry.replace(UUID, "<uuid>") : entry,
    ),
  );
}

describeWithSqlite("memory items on the host and in the database worker", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  const previousUserDataDir = process.env.COWORK_USER_DATA_DIR;

  beforeAll(() => {
    fs.mkdirSync(BUILD_DIR, { recursive: true });
    workerPath = path.join(BUILD_DIR, `database-worker-memory-items-${process.pid}.js`);
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

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    setStatementClient(null, null, null);
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    vi.restoreAllMocks();
  });

  async function runWorkload(backend: "host" | "worker") {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cowork-memory-items-${backend}-`));
    process.env.COWORK_USER_DATA_DIR = dir;
    const manager = new DatabaseManager();
    const db = manager.getDatabase();
    let unitCalls = 0;
    let client: DatabaseClient | null = null;
    if (backend === "worker") {
      client = await DatabaseClient.start({
        dbPath: manager.getDatabasePath(),
        requiredTables: requiredTablesFor(DATABASE_COMMANDS),
        workerPath,
      });
      const execute = client.execute.bind(client);
      vi.spyOn(client, "execute").mockImplementation(((name: string, args: unknown) => {
        if (name.startsWith("statements.")) unitCalls += 1;
        return execute(name as Parameters<typeof execute>[0], args as never);
      }) as typeof client.execute);
      setStatementClient("memory", manager.getDatabasePath(), client);
    }
    cleanups.push(async () => {
      await client?.close(2_000);
      manager.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    db.prepare(
      `INSERT INTO workspaces (id, name, path, created_at, permissions) VALUES ('ws', 'Parity', ?, 1, '{}')`,
    ).run(dir);

    let clock = 1_000;
    const repository = new MemoryItemsRepository(db);
    const writer = new MemoryWriter({ repository, now: () => (clock += 1) });
    const base = { kind: "preference", scope: "global", source: "inferred" } as const;
    const role = new AgentRoleStore(db).create({
      name: "parity-bot",
      displayName: "Parity bot",
      capabilities: [],
      heartbeatEnabled: false,
    });
    const task = new TaskStore(db).create({
      title: "Parity capture",
      prompt: "fixture",
      status: "completed",
      workspaceId: "ws",
      assignedAgentRoleId: role.id,
    });
    const attributed = await writer.ingest({
      ...base,
      content: "Parity bot prefers current capture evidence",
      taskId: task.id,
      originWorkspaceId: "ws",
      sourceRef: { store: "fixture", id: "bot-capture" },
    });
    if (attributed.status !== "written") throw Error("Capture failed");
    expect(attributed.item.sourceRef.agentRoleId).toBe(role.id);
    expect(attributed.item.sourceRef.capturedTaskId).toBe(task.id);
    const results = [
      attributed,
      await writer.ingest({ ...base, content: "Prefers concise responses." }),
      await writer.ingest({ ...base, content: "prefers concise responses" }),
      await writer.ingest({
        ...base,
        content: "Prefers detailed explanations.",
        subjectKey: "response_length",
        sourceRef: { store: "awareness", id: "b1" },
      }),
      await writer.ingest({
        ...base,
        content: "Prefers concise responses.",
        subjectKey: "response_length",
        sourceRef: { store: "awareness", id: "b2" },
      }),
      await writer.ingest({
        content: "Send the contract",
        kind: "commitment",
        scope: "contact",
        scopeRef: "contact-1",
        source: "third_party",
      }),
      await writer.ingest({
        content: "Run lint before commits",
        kind: "rule",
        scope: "workspace",
        workspaceId: "ws",
        source: "curated",
        sourceRef: { store: "curated", id: "c1", target: "workspace" },
        mode: "migration",
      }),
      await writer.ingest({
        content: "Run lint before commits",
        kind: "rule",
        scope: "workspace",
        workspaceId: "ws",
        source: "curated",
        sourceRef: { store: "curated", id: "c1" },
        mode: "migration",
      }),
    ];
    const deleted = await writer.setStatusBySourceRef("awareness", "b1", "deleted");
    await repository.recordLaneMigration({ curatedWritten: 1 }, 5_000);
    const result = {
      results,
      deleted: deleted.length,
      list: await repository.list({
        statuses: ["active", "superseded", "deleted"],
        includePrivate: true,
      }),
      view: await repository.listForView("ws", "workspace"),
      bySource: await repository.findBySourceRef("curated", "c1"),
      complete: await repository.isLaneMigrationComplete(),
      // MemoryRecall's memory lane (memory-recall-units.ts).
      recall: await createMemoryStatementPort(db).unit("memoryRecall_searchItems", [
        { workspaceId: "ws", query: "concise lint", limit: 10, now: 10_000 },
      ]),
      recallListing: await createMemoryStatementPort(db).unit("memoryRecall_searchItems", [
        { workspaceId: "ws", query: "", limit: 10, now: 10_000, kinds: ["rule"] },
      ]),
    };
    return { result: stable(result), unitCalls };
  }

  it("returns the same results on either backend", async () => {
    const host = await runWorkload("host");
    setStatementClient(null, null, null);
    const worker = await runWorkload("worker");
    expect(host.unitCalls).toBe(0);
    expect(worker.unitCalls).toBeGreaterThan(8);
    expect(worker.result).toEqual(host.result);
    const result = host.result as {
      complete: boolean;
      view: unknown[];
      deleted: number;
      recall: unknown[];
      recallListing: unknown[];
    };
    expect(result.complete).toBe(true);
    expect(result.recall.length).toBeGreaterThan(0);
    expect(result.recallListing).toHaveLength(1);
    expect(result.view).toHaveLength(1);
    expect(result.deleted).toBe(1);
  }, 60_000);
});
