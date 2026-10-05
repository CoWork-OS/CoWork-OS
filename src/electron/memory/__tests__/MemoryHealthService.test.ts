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
import {
  MemoryHealthService,
  evaluateMemoryHealth,
  evaluateMemoryRepoDreamHealth,
  evaluateMemoryRepoHealth,
} from "../MemoryHealthService";
import type {
  MemoryRepoDreamSummary,
  MemoryRepoDreamsReport,
} from "../../../shared/memory-repo-types";
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
    embeddings: null,
    pendingWrites: null,
    database: { totalBytes: 4096, freelistBytes: 0 },
    markers: null,
  };

  it("skips checks whose tables are missing", () => {
    const checks = evaluateMemoryHealth(empty);
    const status = Object.fromEntries(checks.map((check) => [check.id, check.status]));
    expect(status).toMatchObject({
      archive_telemetry_ratio: "skip",
      memory_items_duplicate_rate: "skip",
      stuck_heartbeat_runs: "skip",
      orphan_embeddings: "skip",
      database_size: "pass",
      migration_markers: "skip",
    });
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

  function service(db: Db) {
    return new MemoryHealthService({
      port: createMemoryStatementPort(db),
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
    const report = await service(db).health();
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
    expect(byId.orphan_embeddings.value).toBe(reference.embeddings.orphans);
    expect(byId.pending_memory_writes.value).toBe(reference.pendingWrites.pending);

    expect(byId.archive_telemetry_ratio).toMatchObject({ status: "warn", value: 2 / 7 });
    expect(byId.memory_items_duplicate_rate).toMatchObject({ status: "pass", value: 0 });
    expect(byId.stuck_heartbeat_runs).toMatchObject({ status: "warn", value: 1 });
    // The heuristic curator's runs (still in the profile) no longer produce checks.
    expect(Object.keys(byId).filter((id) => id.startsWith("dreaming"))).toEqual([]);
    expect(byId.orphan_embeddings).toMatchObject({ status: "warn", value: 1 });
    expect(byId.pending_memory_writes).toMatchObject({ status: "pass", value: 1 });
    expect(byId.database_size.status).toBe("pass");
    expect(byId.migration_markers.status).not.toBe("skip");
    expect(report.ok).toBe(false);
    expect(report.generatedAt).toBe(NOW);
  });
});

describe("memory folder health (service-only; not in qa:memory-health)", () => {
  const ready = {
    enabled: true,
    root: "/Users/sam/CoWork Memory",
    ready: true,
    writable: true,
    gitAvailable: true,
    clean: true,
    entryFileBytes: 900,
    inboxEntries: 0,
    lastWriteError: null,
  };
  const byId = (checks: ReturnType<typeof evaluateMemoryRepoHealth>) =>
    Object.fromEntries(checks.map((check) => [check.id, check]));

  it("skips when the folder is off and passes when it is ready and clean", () => {
    expect(evaluateMemoryRepoHealth({ ...ready, enabled: false })).toEqual([
      expect.objectContaining({ id: "memory_repo", status: "skip" }),
    ]);
    const checks = byId(evaluateMemoryRepoHealth(ready));
    expect(checks.memory_repo.status).toBe("pass");
    expect(checks.memory_repo_entry_file).toMatchObject({
      status: "pass",
      value: 900,
      threshold: 4096,
      unit: "bytes",
    });
    expect(checks.memory_repo_inbox).toMatchObject({ status: "info", value: 0 });
  });

  it("warns when the folder is not ready or its status cannot be read", () => {
    const [check] = evaluateMemoryRepoHealth({
      ...ready,
      ready: false,
      problem: "the folder is not a memory repo (no MEMORY.md)",
    });
    expect(check).toMatchObject({ id: "memory_repo", status: "warn" });
    expect(check.detail).toContain("no MEMORY.md");
    expect(evaluateMemoryRepoHealth(null)).toEqual([
      expect.objectContaining({ id: "memory_repo", status: "warn" }),
    ]);
  });

  it("warns for missing git, uncommitted edits, a failed write and an oversized MEMORY.md", () => {
    expect(
      byId(evaluateMemoryRepoHealth({ ...ready, gitAvailable: false })).memory_repo,
    ).toMatchObject({
      status: "warn",
      detail: expect.stringContaining("git not found"),
    });
    expect(byId(evaluateMemoryRepoHealth({ ...ready, clean: false })).memory_repo.status).toBe(
      "warn",
    );
    expect(
      byId(evaluateMemoryRepoHealth({ ...ready, lastWriteError: "busy" })).memory_repo.detail,
    ).toContain("last write failed: busy");
    expect(
      byId(evaluateMemoryRepoHealth({ ...ready, entryFileBytes: 5000 })).memory_repo_entry_file
        .status,
    ).toBe("warn");
    expect(
      byId(evaluateMemoryRepoHealth({ ...ready, inboxEntries: 3 })).memory_repo_inbox,
    ).toMatchObject({
      status: "info",
      value: 3,
      detail: expect.stringContaining("3 entries"),
    });
  });

  it("adds the folder checks to the health report and lets them fail the report", async () => {
    const counts: MemoryHealthCounts = {
      archive: null,
      memoryItems: null,
      heartbeat: null,
      embeddings: null,
      pendingWrites: null,
      database: { totalBytes: 4096, freelistBytes: 0 },
      markers: null,
    };
    const build = (status: () => Promise<typeof ready>) =>
      new MemoryHealthService({
        port: { unit: (async () => counts) as never },
        getSupermemoryStatus: () => ({ enabled: false, connected: false }),
        getChronicleEnabled: () => false,
        getMemoryRepoStatus: status,
        now: () => NOW,
      });
    const ok = await build(async () => ready).health();
    expect(ok.checks.map((check) => check.id)).toContain("memory_repo_inbox");
    expect(ok.ok).toBe(true);
    const failing = await build(async () => ({ ...ready, gitAvailable: false })).health();
    expect(failing.ok).toBe(false);
    const unreadable = await build(async () => {
      throw new Error("boom");
    }).health();
    expect(unreadable.checks.find((check) => check.id === "memory_repo")?.status).toBe("warn");
  });
});

describe("memory folder dreaming health (service-only)", () => {
  const ready = {
    enabled: true,
    root: "/Users/sam/CoWork Memory",
    ready: true,
    writable: true,
    gitAvailable: true,
  };
  const dream = (overrides: Partial<MemoryRepoDreamSummary> = {}): MemoryRepoDreamSummary => ({
    id: "d1",
    trigger: "daily",
    status: "completed",
    startedAt: NOW - 2 * HOUR,
    finishedAt: NOW - 2 * HOUR,
    summary: "",
    tokens: 1000,
    autoCount: 2,
    undone: false,
    canUndo: true,
    reviewCount: 0,
    reviewStatus: null,
    rejected: 0,
    operations: [],
    ...overrides,
  });
  const report = (
    dreams: MemoryRepoDreamSummary[],
    extra: Partial<MemoryRepoDreamsReport> = {},
  ) => ({
    dreams,
    tokensUsedToday: 1000,
    dailyBudget: 50_000,
    dreamingEnabled: true,
    folderReady: true,
    pendingReviews: dreams.filter((entry) => entry.reviewStatus === "pending").length,
    ...extra,
  });

  it("skips while the folder or dreaming is off", () => {
    expect(evaluateMemoryRepoDreamHealth({ ...ready, enabled: false }, null, NOW).status).toBe(
      "skip",
    );
    expect(evaluateMemoryRepoDreamHealth({ ...ready, ready: false }, null, NOW).status).toBe(
      "skip",
    );
    expect(
      evaluateMemoryRepoDreamHealth(ready, report([], { dreamingEnabled: false }), NOW),
    ).toMatchObject({
      id: "memory_repo_dreaming",
      label: "Memory folder dreaming",
      status: "skip",
    });
  });

  it("shows the last run as info", () => {
    expect(evaluateMemoryRepoDreamHealth(ready, report([]), NOW)).toMatchObject({
      status: "info",
      detail: expect.stringContaining("No dream yet"),
    });
    const check = evaluateMemoryRepoDreamHealth(ready, report([dream()]), NOW);
    expect(check.status).toBe("info");
    expect(check.detail).toContain("Last dream 2026-10-05 10:00 UTC");
    expect(check.detail).toContain("1,000 of 50,000 tokens");
  });

  it("warns on a failed dream in the last 7 days or a review waiting more than 7 days", () => {
    expect(
      evaluateMemoryRepoDreamHealth(
        ready,
        report([dream({ status: "failed", error: "provider down" })]),
        NOW,
      ),
    ).toMatchObject({ status: "warn", detail: expect.stringContaining("provider down") });
    expect(
      evaluateMemoryRepoDreamHealth(
        ready,
        report([dream({ status: "failed", startedAt: NOW - 8 * DAY, finishedAt: NOW - 8 * DAY })]),
        NOW,
      ).status,
    ).toBe("info");
    expect(
      evaluateMemoryRepoDreamHealth(
        ready,
        report([
          dream({
            reviewStatus: "pending",
            reviewCount: 2,
            finishedAt: NOW - 8 * DAY,
            startedAt: NOW - 8 * DAY,
          }),
        ]),
        NOW,
      ),
    ).toMatchObject({
      status: "warn",
      value: 1,
      detail: expect.stringContaining("more than 7 days"),
    });
    expect(
      evaluateMemoryRepoDreamHealth(
        ready,
        report([dream({ reviewStatus: "pending", reviewCount: 1 })]),
        NOW,
      ),
    ).toMatchObject({ status: "info", detail: expect.stringContaining("1 waiting for review") });
    expect(evaluateMemoryRepoDreamHealth(ready, null, NOW).status).toBe("warn");
  });

  it("is added to the report only when the folder is ready", async () => {
    const counts: MemoryHealthCounts = {
      archive: null,
      memoryItems: null,
      heartbeat: null,
      embeddings: null,
      pendingWrites: null,
      database: { totalBytes: 4096, freelistBytes: 0 },
      markers: null,
    };
    let dreamsCalls = 0;
    const build = (status: typeof ready) =>
      new MemoryHealthService({
        port: { unit: (async () => counts) as never },
        getSupermemoryStatus: () => ({ enabled: false, connected: false }),
        getChronicleEnabled: () => false,
        getMemoryRepoStatus: async () => status,
        getMemoryRepoDreams: async () => {
          dreamsCalls += 1;
          return report([dream({ status: "failed", error: "boom" })]);
        },
        now: () => NOW,
      });
    const failing = await build(ready).health();
    expect(failing.checks.find((check) => check.id === "memory_repo_dreaming")?.status).toBe(
      "warn",
    );
    expect(failing.ok).toBe(false);
    const off = await build({ ...ready, enabled: false }).health();
    expect(off.checks.find((check) => check.id === "memory_repo_dreaming")?.status).toBe("skip");
    expect(dreamsCalls).toBe(1);
  });
});
