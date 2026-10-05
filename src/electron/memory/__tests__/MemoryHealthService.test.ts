import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import thresholds from "../../../shared/memory-health-thresholds.json";
import {
  MEMORY_HEALTH_MAINTENANCE_KEYS,
  MEMORY_HEALTH_STUCK_AFTER_MS,
  MEMORY_HEALTH_THRESHOLDS,
} from "../../../shared/memory-health-types";
import { MemoryHealthService, evaluateMemoryHealth } from "../MemoryHealthService";
import { createMemoryStatementPort } from "../memory-statement-port";
import type { MemoryHealthCounts } from "../memory-health-sql";
import { nativeSqliteAvailable } from "./memory-items-test-db";

// Memory Hub "Sources" and "Health" over a real profile schema (DatabaseManager). The
// health numbers must match scripts/qa/memory-health.mjs on the same database.

type Db = import("better-sqlite3").Database;

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 5, 12);

const script = await import("../../../../scripts/qa/memory-health.mjs");

const { DatabaseManager } = nativeSqliteAvailable
  ? await import("../../database/schema")
  : ({} as typeof import("../../database/schema"));
const { WorkspaceStore } = nativeSqliteAvailable
  ? await import("../../database/repositories")
  : ({} as typeof import("../../database/repositories"));

const permissions = { read: true, write: true, delete: false, network: false, shell: false };

describe("memory health thresholds", () => {
  it("are the ones scripts/qa/memory-health.mjs uses", () => {
    expect(script.CI_THRESHOLDS).toEqual(thresholds.ci);
    expect(script.MEMORY_MAINTENANCE_KEYS).toEqual(MEMORY_HEALTH_MAINTENANCE_KEYS);
    expect(script.parseArgs([]).stuckAfterMs).toBe(MEMORY_HEALTH_STUCK_AFTER_MS);
    // The Hub warns no later than CI fails.
    for (const [key, value] of Object.entries(thresholds.ci)) {
      expect(MEMORY_HEALTH_THRESHOLDS[key as keyof typeof MEMORY_HEALTH_THRESHOLDS]).toBe(value);
    }
  });
});

describe("evaluateMemoryHealth", () => {
  const empty: MemoryHealthCounts = {
    archive: null,
    memoryItems: null,
    heartbeat: null,
    dreaming: null,
    embeddings: null,
    pendingWrites: null,
    database: { totalBytes: 4096, freelistBytes: 0 },
    markers: null,
  };

  it("skips checks whose tables are missing", () => {
    const checks = evaluateMemoryHealth(empty, { llmEnabled: false, llmDailyBudget: 20_000 });
    const status = Object.fromEntries(checks.map((check) => [check.id, check.status]));
    expect(status).toMatchObject({
      archive_telemetry_ratio: "skip",
      memory_items_duplicate_rate: "skip",
      stuck_heartbeat_runs: "skip",
      dreaming_last_run: "skip",
      dreaming_llm_budget: "info",
      orphan_embeddings: "skip",
      database_size: "pass",
      migration_markers: "skip",
    });
  });

  it("warns when AI synthesis used more than its daily budget", () => {
    const counts: MemoryHealthCounts = {
      ...empty,
      dreaming: { stuck: 0, lastRunAt: NOW, failedLast7d: 0, llmTokensLastDay: 30_000 },
    };
    const budget = evaluateMemoryHealth(counts, {
      llmEnabled: true,
      llmDailyBudget: 20_000,
    }).find((check) => check.id === "dreaming_llm_budget");
    expect(budget).toMatchObject({ status: "warn", value: 1.5, op: "<=", threshold: 1 });
    expect(budget?.detail).toContain("30,000 of 20,000");
  });
});

describe.skipIf(!nativeSqliteAvailable)("MemoryHealthService", () => {
  const cleanups: Array<() => void> = [];
  const previousUserDataDir = process.env.COWORK_USER_DATA_DIR;

  afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
  });

  function profile(): { db: Db; ws: string; other: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-memory-hub-health-"));
    process.env.COWORK_USER_DATA_DIR = dir;
    const manager = new DatabaseManager();
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    cleanups.push(() => manager.close());
    const db = manager.getDatabase();
    const workspaces = new WorkspaceStore(db);
    const ws = workspaces.create("W", path.join(dir, "w"), permissions).id;
    const other = workspaces.create("O", path.join(dir, "o"), permissions).id;
    return { db, ws, other };
  }

  let seq = 0;
  const addMemory = (
    db: Db,
    workspaceId: string,
    content: string,
    options: { type?: string; private?: boolean; createdAt?: number } = {},
  ) => {
    seq += 1;
    const createdAt = options.createdAt ?? NOW;
    db.prepare(
      `INSERT INTO memories (id, workspace_id, type, content, tokens, is_private, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
    ).run(
      `m${seq}`,
      workspaceId,
      options.type ?? "observation",
      content,
      options.private ? 1 : 0,
      createdAt,
      createdAt,
    );
    return `m${seq}`;
  };
  const addItem = (
    db: Db,
    item: {
      workspaceId: string | null;
      scope?: string;
      source?: string;
      store?: string;
      hash?: string;
      status?: string;
    },
  ) => {
    seq += 1;
    db.prepare(
      `INSERT INTO memory_items (id, workspace_id, scope, scope_ref, kind, subject_key, content,
         source, source_ref, trust, status, pinned, content_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'preference', ?, 'x', ?, ?, 1, ?, 0, ?, ?, ?)`,
    ).run(
      `i${seq}`,
      item.workspaceId,
      item.scope ?? "workspace",
      item.scope === "contact" ? "c1" : null,
      `preference:${seq}`,
      item.source ?? "user_stated",
      JSON.stringify(item.store ? { store: item.store, id: `r${seq}` } : {}),
      item.status ?? "active",
      item.hash ?? `h${seq}`,
      NOW,
      NOW,
    );
  };

  function seed(db: Db, ws: string, other: string) {
    // Facts: two in the workspace, one global, one import, one contact; an archived item
    // and another workspace's item are not counted for this workspace. (An active duplicate
    // cannot be written: idx_memory_items_active_hash.)
    addItem(db, { workspaceId: ws, store: "memory_hub", hash: "dup" });
    addItem(db, { workspaceId: ws, store: "memory_hub" });
    addItem(db, { workspaceId: ws, store: "memory_hub", hash: "dup", status: "archived" });
    addItem(db, { workspaceId: null, scope: "global", source: "inferred", store: "agent_tool" });
    addItem(db, { workspaceId: ws, source: "import", store: "import" });
    addItem(db, { workspaceId: null, scope: "contact", source: "third_party", store: "mailbox" });
    addItem(db, { workspaceId: other, store: "memory_hub" });

    // Archive: 2 of 6 rows in the workspace are telemetry, 1 duplicate.
    const first = addMemory(db, ws, "Tool called: read_file");
    addMemory(db, ws, "[core-trace:abc] trace");
    addMemory(db, ws, "User prefers tabs", { type: "preference" });
    addMemory(db, ws, "  user prefers TABS ", { type: "preference" });
    addMemory(db, ws, "Screen showed the build log", { type: "screen_context", private: true });
    addMemory(db, ws, '[Imported from ChatGPT — "Trip"]\nLikes window seats');
    addMemory(db, other, "Other workspace row");
    db.prepare(
      `INSERT INTO memory_observation_metadata (memory_id, workspace_id, origin, observation_type,
         title, narrative, content_hash, created_at, updated_at)
       VALUES (?, ?, 'task', 'observation', 't', 'n', 'h', ?, ?)`,
    ).run(first, ws, NOW, NOW);

    db.prepare(
      "INSERT INTO memory_embeddings (memory_id, workspace_id, embedding, updated_at) VALUES (?, ?, '[]', ?)",
    ).run(first, ws, NOW);
    db.pragma("foreign_keys = OFF");
    db.prepare(
      "INSERT INTO memory_embeddings (memory_id, workspace_id, embedding, updated_at) VALUES ('gone', ?, '[]', ?)",
    ).run(ws, NOW);
    db.pragma("foreign_keys = ON");

    db.prepare(
      `INSERT INTO heartbeat_runs (id, run_type, status, created_at, updated_at, started_at)
       VALUES ('h1', 'dispatch', 'running', ?, ?, ?), ('h2', 'pulse', 'running', ?, ?, ?)`,
    ).run(NOW - 2 * HOUR, NOW - 2 * HOUR, NOW - 2 * HOUR, NOW - 60_000, NOW - 60_000, NOW - 60_000);

    const run = db.prepare(
      `INSERT INTO dreaming_runs (id, workspace_id, scope_kind, scope_ref, status, trigger_source,
         started_at, created_at, llm_tokens)
       VALUES (?, ?, 'workspace', ?, ?, 'manual', ?, ?, ?)`,
    );
    run.run("d1", ws, ws, "failed", NOW - 2 * DAY, NOW - 2 * DAY, 0);
    run.run("d2", ws, ws, "completed", NOW - HOUR, NOW - HOUR, 1200);
    run.run("d3", ws, ws, "failed", NOW - 10 * DAY, NOW - 10 * DAY, 0);

    db.prepare(
      `INSERT INTO pending_memory_writes (id, workspace_id, target, action, origin, summary,
         payload_json, status, created_at)
       VALUES ('p1', ?, 'memory', 'add', 'auto_capture', 's', '{}', 'pending', ?)`,
    ).run(ws, NOW);

    db.prepare(
      `INSERT INTO kg_entity_types (id, workspace_id, name, created_at) VALUES ('t1', ?, 'person', ?)`,
    ).run(ws, NOW);
    db.prepare(
      `INSERT INTO kg_entities (id, workspace_id, entity_type_id, name, created_at, updated_at)
       VALUES ('e1', ?, 't1', 'Ada', ?, ?), ('e2', ?, 't1', 'Linus', ?, ?)`,
    ).run(ws, NOW, NOW, ws, NOW, NOW);
    db.prepare(
      `INSERT INTO kg_edges (id, workspace_id, source_entity_id, target_entity_id, edge_type, created_at)
       VALUES ('g1', ?, 'e1', 'e2', 'knows', ?)`,
    ).run(ws, NOW);
    db.prepare(
      `INSERT INTO kg_observations (id, entity_id, content, created_at) VALUES ('o1', 'e1', 'x', ?)`,
    ).run(NOW);
  }

  function service(db: Db, settings: Record<string, unknown> = {}) {
    return new MemoryHealthService({
      port: createMemoryStatementPort(db),
      getSettings: () => settings as never,
      getSupermemoryStatus: () => ({ enabled: true, connected: false }),
      getChronicleEnabled: () => true,
      now: () => NOW,
    });
  }

  it("counts the workspace's sources without reading content", async () => {
    const { db, ws, other } = profile();
    seed(db, ws, other);
    const report = await service(db).sources(ws);

    expect(report.workspaceId).toBe(ws);
    expect(report.facts.total).toBe(5);
    expect(report.facts.bySource).toEqual([
      { key: "user_stated", workspace: 2, global: 0, contacts: 0 },
      { key: "import", workspace: 1, global: 0, contacts: 0 },
      { key: "inferred", workspace: 0, global: 1, contacts: 0 },
      { key: "third_party", workspace: 0, global: 0, contacts: 1 },
    ]);
    expect(Object.fromEntries(report.facts.byStore.map((row) => [row.key, row]))).toMatchObject({
      memory_hub: { workspace: 2, global: 0 },
      agent_tool: { global: 1 },
      import: { workspace: 1 },
      mailbox: { contacts: 1 },
    });
    expect(report.archive).toMatchObject({ total: 6, private: 1 });
    expect(report.archive.byType).toContainEqual({ key: "preference", count: 2 });
    expect(report.archive.byOrigin).toEqual([
      { key: "unknown", count: 5 },
      { key: "task", count: 1 },
    ]);
    expect(report.imports).toEqual({ archiveRows: 1, facts: 1 });
    expect(report.chronicle).toEqual({ enabled: true, archiveRows: 1 });
    expect(report.supermemory).toEqual({ enabled: true, connected: false, remoteRefs: 0 });
    expect(report.knowledgeGraph).toEqual({
      entities: 2,
      edges: 1,
      observations: 1,
      byType: [{ key: "person", count: 2 }],
    });
    expect(JSON.stringify(report)).not.toMatch(/tabs|window seats|build log|Ada/i);

    const empty = await service(db).sources(other);
    // Ties are ordered by key.
    expect(empty.facts.bySource).toEqual([
      { key: "inferred", workspace: 0, global: 1, contacts: 0 },
      { key: "third_party", workspace: 0, global: 0, contacts: 1 },
      { key: "user_stated", workspace: 1, global: 0, contacts: 0 },
    ]);
    expect(empty.archive.total).toBe(1);
  });

  it("matches the qa:memory-health numbers and flags breaches", async () => {
    const { db, ws, other } = profile();
    seed(db, ws, other);
    const report = await service(db, {
      dreamingLlmEnabled: true,
      dreamingLlmDailyTokenBudget: 1000,
    }).health();
    const byId = Object.fromEntries(report.checks.map((check) => [check.id, check]));

    const reference = script.collectReport(
      db,
      { dbstat: false, top: 5, stuckAfterMs: MEMORY_HEALTH_STUCK_AFTER_MS },
      NOW,
    );
    expect(byId.archive_telemetry_ratio.value).toBeCloseTo(reference.archive.telemetryRatio);
    expect(byId.archive_duplicate_rate.value).toBeCloseTo(reference.archive.duplicateRate);
    expect(byId.memory_items_duplicate_rate.value).toBeCloseTo(reference.memoryItems.duplicateRate);
    expect(byId.stuck_heartbeat_runs.value).toBe(reference.heartbeat.stuck);
    expect(byId.stuck_dreaming_runs.value).toBe(reference.dreaming.stuck);
    expect(byId.orphan_embeddings.value).toBe(reference.embeddings.orphans);
    expect(byId.pending_memory_writes.value).toBe(reference.pendingWrites.pending);

    expect(byId.archive_telemetry_ratio).toMatchObject({ status: "warn", value: 2 / 7 });
    expect(byId.memory_items_duplicate_rate).toMatchObject({ status: "pass", value: 0 });
    expect(byId.stuck_heartbeat_runs).toMatchObject({ status: "warn", value: 1 });
    expect(byId.stuck_dreaming_runs).toMatchObject({ status: "pass", value: 0 });
    expect(byId.dreaming_failures).toMatchObject({ status: "warn", value: 1 });
    expect(byId.dreaming_last_run).toMatchObject({ status: "info", value: NOW - HOUR });
    expect(byId.dreaming_llm_budget).toMatchObject({ status: "warn", value: 1.2 });
    expect(byId.orphan_embeddings).toMatchObject({ status: "warn", value: 1 });
    expect(byId.pending_memory_writes).toMatchObject({ status: "pass", value: 1 });
    expect(byId.database_size.status).toBe("pass");
    expect(byId.migration_markers.status).not.toBe("skip");
    expect(report.ok).toBe(false);
    expect(report.generatedAt).toBe(NOW);
  });
});
