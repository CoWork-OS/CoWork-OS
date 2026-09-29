import { buildSync } from "esbuild";
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DatabaseClient } from "../../database/async/DatabaseClient";
import { DATABASE_COMMANDS, requiredTablesFor } from "../../database/async/commands";
import { DatabaseManager } from "../../database/schema";
import { setStatementClient } from "../../database/statements/statement-route";
import { KnowledgeGraphRepository } from "../../knowledge-graph/KnowledgeGraphRepository";
import { MemoryFeaturesManager } from "../../settings/memory-features-manager";
import { createBoxBrainRepository } from "../BoxBrainRepository";
import { DreamingRepository } from "../DreamingRepository";
import { DurableContextService } from "../DurableContextService";
import { MarkdownMemoryIndexService } from "../MarkdownMemoryIndexService";
import { MemoryObservationService } from "../MemoryObservationService";
import { MemoryTierService } from "../MemoryTierService";
import { createMemoryStatementPort } from "../memory-statement-port";
import { PlaybookEvidenceLedger } from "../PlaybookEvidenceLedger";
import { hashMemoryContent } from "../PlaybookEvidenceStore";

// The memory domain on both backends (async SQLite migration plan, DB6): the same
// workload through the host connection and through the database worker must return the
// same results. Random ids and wall-clock times are masked before comparing.

const BUILD_DIR = path.resolve("node_modules/.cache/cowork-db-worker-test");
let workerPath: string;

beforeAll(() => {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  workerPath = path.join(BUILD_DIR, `database-worker-memory-${process.pid}.js`);
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
// Durable context ids hash in a conversation id that has a random suffix.
const DURABLE_ID = /\bdc[cmps]_[0-9a-f]{24}(?:_[0-9a-f]{8})?/g;

/** Mask values that differ between two runs of the same workload. */
function stable(value: unknown, start: number): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, entry) => {
      if (typeof entry === "string") {
        return entry.replace(UUID, "<uuid>").replace(DURABLE_ID, "<durable-id>");
      }
      if (typeof entry === "number" && entry >= start - 60_000 && entry < start + 3_600_000) {
        return "<now>";
      }
      if (key === "rank" || key === "score" || key === "relevanceScore") return "<score>";
      return entry;
    }),
  );
}

describe("memory domain on the host and in the database worker", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  const previousUserDataDir = process.env.COWORK_USER_DATA_DIR;

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    setStatementClient(null, null, null);
    DurableContextService.setDatabaseForTests(null);
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    vi.restoreAllMocks();
  });

  async function runWorkload(backend: "host" | "worker") {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cowork-memory-${backend}-`));
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
    vi.spyOn(MemoryFeaturesManager, "loadSettings").mockReturnValue({
      durableContextEnabled: true,
    } as ReturnType<typeof MemoryFeaturesManager.loadSettings>);

    const start = Date.now();
    const workspaceDir = path.join(dir, "workspace");
    fs.mkdirSync(path.join(workspaceDir, "notes"), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, "notes", "release.md"),
      "# Release plan\n\nShip the database worker after the parity suite passes.\n",
    );
    fs.writeFileSync(
      path.join(workspaceDir, "notes", "budget.md"),
      "# Budget\n\nQuarterly invoices are reconciled every Friday.\n",
    );
    // Distinct modification times, so "most recent" is the same on both runs.
    fs.utimesSync(path.join(workspaceDir, "notes", "budget.md"), 1_700_000_000, 1_700_000_000);
    fs.utimesSync(path.join(workspaceDir, "notes", "release.md"), 1_700_000_060, 1_700_000_060);
    db.prepare(
      `INSERT INTO workspaces (id, name, path, created_at, permissions) VALUES ('ws', 'Parity', ?, ?, '{}')`,
    ).run(workspaceDir, start);
    const insertMemory = db.prepare(
      `INSERT INTO memories (id, workspace_id, type, content, tokens, created_at, updated_at)
       VALUES (?, 'ws', 'insight', ?, 10, ?, ?)`,
    );
    insertMemory.run("mem-old", "stale note", start - 30 * 86_400_000, start - 30 * 86_400_000);
    insertMemory.run("mem-plan", "Reconcile invoices with the ledger export", start, start);
    db.prepare("UPDATE memories SET reference_count = 5 WHERE id = 'mem-plan'").run();

    const sql = createMemoryStatementPort(db);
    const result: Record<string, unknown> = {};

    result.tiers = await MemoryTierService.runPromotionPass(sql);

    const kg = new KnowledgeGraphRepository(sql);
    const person = await kg.upsertEntity("ws", { entityType: "person", name: "Ada" }, "auto");
    const merged = await kg.upsertEntity(
      "ws",
      { entityType: "person", name: "Ada", description: "Engineer", properties: { team: "db" } },
      "auto",
    );
    const org = await kg.upsertEntity(
      "ws",
      { entityType: "organization", name: "CoWork" },
      "agent",
    );
    const edge = await kg.createEdgeChecked(
      "ws",
      { sourceEntityId: person.id, targetEntityId: org.id, edgeType: "works_at" },
      "agent",
      undefined,
      start,
    );
    const duplicate = await kg.createEdgeChecked(
      "ws",
      { sourceEntityId: person.id, targetEntityId: org.id, edgeType: "works_at" },
      "agent",
      undefined,
      start,
    );
    result.kg = {
      merged,
      sameEdge: duplicate.id === edge.id,
      context: await kg.contextEntities("ws", "Ada", 5),
      stats: await kg.getStats("ws").then((stats) => ({
        ...stats,
        // Ties in the distribution are ordered by random type ids.
        entityTypeDistribution: [...stats.entityTypeDistribution].sort((a, b) =>
          a.typeName.localeCompare(b.typeName),
        ),
      })),
      selfLoop: await kg
        .createEdgeChecked(
          "ws",
          { sourceEntityId: person.id, targetEntityId: person.id, edgeType: "knows" },
          "agent",
          undefined,
          start,
        )
        .catch((error: Error) => error.message),
    };

    const ledger = PlaybookEvidenceLedger.open(db, () => start);
    const recorded = await ledger.record({
      workspaceId: "ws",
      taskId: "task-1",
      sourceMemoryId: "mem-plan",
      sourceContentHash: hashMemoryContent("Reconcile invoices with the ledger export"),
      patternKey: "tools:ledger",
    });
    // Recorded against content the memory no longer has: reading it invalidates it.
    const edited = await ledger.record({
      workspaceId: "ws",
      taskId: "task-2",
      sourceMemoryId: "mem-old",
      sourceContentHash: hashMemoryContent("content before an edit"),
      patternKey: "tools:ledger",
    });
    result.playbook = {
      created: recorded.created,
      readable: (await ledger.listReadable("ws")).map(({ record, content }) => [
        record.taskId,
        content,
      ]),
      editedActive: (await ledger.get(edited.record.id))?.invalidatedAt === null,
      linked: (await ledger.linkAll(recorded.record.id, [edited.record.id])).length,
      invalidated: await ledger.invalidateTask("ws", "task-1", "corrected_by_user"),
      readableAfter: (await ledger.listReadable("ws")).length,
    };

    const dreaming = new DreamingRepository(db);
    const run = await dreaming.createRun({
      workspaceId: "ws",
      scopeKind: "workspace",
      scopeRef: "ws",
      status: "running",
      triggerSource: "manual",
      evidenceCount: 1,
      candidateCount: 0,
      startedAt: start,
    });
    const [candidate] = await dreaming.bulkCreateCandidates([
      {
        runId: run.id,
        workspaceId: "ws",
        action: "curated_add",
        target: "curated_memory",
        proposedValue: "Invoices close on Friday",
        rationale: "Seen twice",
        confidence: 0.8,
        evidenceRefs: [],
        status: "proposed",
      },
    ]);
    result.dreaming = {
      reviewed: await dreaming.reviewCandidate({ id: candidate.id, status: "accepted" }),
      runs: await dreaming.listRuns({ workspaceId: "ws" }),
    };

    const box = createBoxBrainRepository(db);
    const source = await box.ensureSource("ws", "box-server", {
      enabled: true,
      rootFolderId: "0",
      syncIntervalMinutes: 60,
      maxItemsPerRun: 10,
      includeContent: true,
      useBoxAiSummaries: false,
      improvementEnabled: false,
      maxContentChars: 1000,
    });
    await box.upsertItem({
      sourceId: source.id,
      workspaceId: "ws",
      boxId: "file-1",
      boxType: "file",
      name: "plan.md",
      sourceUrl: "https://example.test/file-1",
      status: "indexed",
      lastSeenAt: start,
    });
    result.box = await box.listItems(source.id);

    MemoryObservationService.initialize(db);
    const memory = {
      id: "mem-plan",
      workspaceId: "ws",
      type: "insight" as const,
      content: "Reconcile invoices with the ledger export",
      tokens: 10,
      isCompressed: false,
      isPrivate: false,
      createdAt: start,
      updatedAt: start,
    };
    await MemoryObservationService.createForMemory(memory, { origin: "task" });
    result.observations = {
      search: await MemoryObservationService.search({ workspaceId: "ws", query: "invoices" }),
      redacted: await MemoryObservationService.redact("ws", "mem-plan"),
      suppressed: [...(await MemoryObservationService.suppressedIds(["mem-plan", "mem-old"]))],
    };

    DurableContextService.setDatabaseForTests(db);
    await DurableContextService.recordHistory({
      workspaceId: "ws",
      taskId: "task-1",
      messages: [
        { role: "user", content: "Where is the release checklist?" },
        { role: "assistant", content: "The release checklist is in notes/release.md." },
      ],
      source: "parity",
    });
    const summaryId = await DurableContextService.recordCompactionSummary({
      workspaceId: "ws",
      taskId: "task-1",
      removedMessages: [{ role: "user", content: "Where is the release checklist?" }],
      summaryBlock: "User asked for the release checklist location.",
    });
    result.durable = {
      summaryId,
      search: await DurableContextService.search({ workspaceId: "ws", query: "release checklist" }),
      describe: await DurableContextService.describe({ workspaceId: "ws", id: summaryId || "" }),
    };

    const markdown = new MarkdownMemoryIndexService(db);
    await markdown.syncWorkspace("ws", workspaceDir, true);
    result.markdown = {
      search: await markdown.search("ws", workspaceDir, "database worker parity", 5, () => true),
      recent: await markdown.getRecentSnippets("ws", workspaceDir, 5, () => true),
    };
    markdown.shutdown();

    return { unitCalls, result: stable(result, start) };
  }

  it("returns the same results on either backend", async () => {
    const host = await runWorkload("host");
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    setStatementClient(null, null, null);
    vi.restoreAllMocks();
    const worker = await runWorkload("worker");

    expect(host.unitCalls).toBe(0);
    expect(worker.unitCalls).toBeGreaterThan(25);
    expect(worker.result).toEqual(host.result);

    const result = host.result as Record<string, Record<string, unknown>>;
    expect(result.tiers).toEqual({ promoted: 1, evicted: 1 });
    expect(result.kg.sameEdge).toBe(true);
    expect(result.kg.selfLoop).toBe("Cannot create an edge from an entity to itself");
    expect(result.playbook).toEqual({
      created: true,
      readable: [["task-1", "Reconcile invoices with the ledger export"]],
      editedActive: false,
      linked: 1,
      invalidated: 1,
      readableAfter: 0,
    });
    expect(result.observations.suppressed).toEqual(["mem-plan"]);
    expect((result.durable.search as unknown[]).length).toBeGreaterThan(0);
    expect((result.markdown.search as Array<{ path: string }>)[0]?.path).toBe("notes/release.md");
  });
});
