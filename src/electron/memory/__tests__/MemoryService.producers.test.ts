/**
 * Memory producers through the shared hygiene (docs/memory-engine.md §1, §8 item 7):
 * the archive capture's salience gate and `noMemory` option, and the gated import API
 * (`MemoryService.openImportSession`, used by the ChatGPT importer and pasted imports):
 * settings, redaction, `<no-memory>`, salience, dedupe across re-imports and workspaces,
 * the observation sidecar, and imported facts as `import` memory items whose lifecycle
 * follows their archive row. Archive rows live in in-memory SQLite through the real
 * capture SQL; memory items through a real MemoryWriter.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemorySettings } from "../../database/repositories";
import { insertCapturedMemory } from "../memory-capture-sql";
import { createMemoryStatementPort } from "../memory-statement-port";
import { MemoryWriter } from "../MemoryWriter";
import { MemoryItemsRepository } from "../MemoryItemsRepository";
import { MemoryRepoService } from "../repo/MemoryRepoService";
import { parseMemoryRepoEntries } from "../repo/memory-repo-format";
import { createMemoryItemsTestDb, nativeSqliteAvailable, rowsOf } from "./memory-items-test-db";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp/cowork-test" } }));
vi.mock("../../agent/llm", () => ({
  LLMProviderFactory: {
    createProvider: vi.fn(),
    getSettings: vi.fn(() => ({ modelKey: "m", providerType: "openai" })),
    getModelId: vi.fn(() => "m"),
  },
}));

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

let MemoryService: typeof import("../MemoryService").MemoryService;
let IMPORT_FACT_STORE: string;

const TOKEN = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";

describeWithSqlite("memory producers", () => {
  let db: Database.Database;
  let settings: Record<string, MemorySettings>;

  const archiveRows = (where = "1 = 1", ...params: unknown[]) =>
    db
      .prepare(`SELECT * FROM memories WHERE ${where} ORDER BY created_at, rowid`)
      .all(...params) as Array<Record<string, unknown>>;

  const settingsFor = (workspaceId: string, patch: Partial<MemorySettings> = {}) => {
    settings[workspaceId] = { ...settings[workspaceId], ...patch };
  };

  beforeEach(async () => {
    db = await createMemoryItemsTestDb(["ws-1", "ws-2"]);
    db.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, task_id TEXT, type TEXT NOT NULL,
        content TEXT NOT NULL, summary TEXT, tokens INTEGER NOT NULL DEFAULT 0,
        is_compressed INTEGER NOT NULL DEFAULT 0, is_private INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        reference_count INTEGER DEFAULT 0, last_referenced_at INTEGER
      );
      CREATE TABLE memory_embeddings (
        memory_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, embedding TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE memory_observation_metadata (
        memory_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, task_id TEXT,
        origin TEXT NOT NULL DEFAULT 'unknown', observation_type TEXT NOT NULL,
        title TEXT NOT NULL, subtitle TEXT, narrative TEXT NOT NULL,
        facts TEXT NOT NULL DEFAULT '[]', concepts TEXT NOT NULL DEFAULT '[]',
        files_read TEXT NOT NULL DEFAULT '[]', files_modified TEXT NOT NULL DEFAULT '[]',
        tools TEXT NOT NULL DEFAULT '[]', source_event_ids TEXT NOT NULL DEFAULT '[]',
        content_hash TEXT NOT NULL, capture_reason TEXT NOT NULL DEFAULT 'memory_capture',
        privacy_state TEXT NOT NULL DEFAULT 'normal', generated_by TEXT NOT NULL DEFAULT 'capture',
        migration_status TEXT NOT NULL DEFAULT 'current',
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
    `);
    const base: MemorySettings = {
      workspaceId: "ws-1",
      enabled: true,
      autoCapture: true,
      compressionEnabled: false,
      retentionDays: 90,
      maxStorageMb: 100,
      privacyMode: "normal",
      excludedPatterns: [],
    };
    settings = { "ws-1": { ...base }, "ws-2": { ...base, workspaceId: "ws-2" } };

    ({ MemoryService, IMPORT_FACT_STORE } = await import("../MemoryService"));
    const { MemoryObservationService } = await import("../MemoryObservationService");
    (MemoryObservationService as Any).store = {
      suppressedIds: vi.fn(async () => new Set<string>()),
    };
    const state = MemoryService as Any;
    state.memoryRepo = {
      insertCaptured: (write: Any) => db.transaction(() => insertCapturedMemory(db, write))(),
      findById: (id: string) => {
        const row = db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as Any;
        return row
          ? {
              id: row.id,
              workspaceId: row.workspace_id,
              type: row.type,
              content: row.content,
              isPrivate: row.is_private === 1,
              tokens: row.tokens,
              isCompressed: row.is_compressed === 1,
              createdAt: row.created_at,
              updatedAt: row.updated_at,
            }
          : undefined;
      },
      update: (id: string, patch: { content?: string }) => {
        if (patch.content !== undefined) {
          db.prepare("UPDATE memories SET content = ? WHERE id = ?").run(patch.content, id);
        }
      },
      deleteByIds: (workspaceId: string, ids: string[]) =>
        ids.reduce(
          (count, id) =>
            count +
            db
              .prepare("DELETE FROM memories WHERE workspace_id = ? AND id = ?")
              .run(workspaceId, id).changes,
          0,
        ),
      deleteImported: (workspaceId: string) =>
        db
          .prepare(
            "DELETE FROM memories WHERE workspace_id = ? AND content LIKE '[Imported from %'",
          )
          .run(workspaceId).changes,
      getApproxStorageBytes: () => 0,
    };
    state.embeddingRepo = {
      deleteByMemoryIds: vi.fn(),
      deleteImported: vi.fn(),
    };
    state.settingsRepo = { getOrCreate: vi.fn(async (id: string) => settings[id]) };
    state.sql = createMemoryStatementPort(db);
    state.markdownIndex = null;
    state.ftsWorker = null;
    state.workspaceRepo = undefined;
    state.initialized = true;
    state.compressionQueue = [];
    state.compressionQueueEntries = new Map();
    state.compressionDiagnosticsByWorkspace = new Map();
    state.compressionBudgetByWorkspace = new Map();
    state.embeddingBackfillInProgress = new Set(["ws-1", "ws-2"]);
    state.importedEmbeddingBackfillInProgress = true;
    state.promptRecallCache = new Map();

    MemoryWriter.setInstance(
      new MemoryWriter({
        repository: new MemoryItemsRepository(db),
        getWorkspacePolicy: async (id) => settings[id] ?? null,
        bumpHotMemoryVersion: () => undefined,
      }),
    );
  });

  afterEach(async () => {
    MemoryWriter.setInstance(null);
    const { MemoryObservationService } = await import("../MemoryObservationService");
    (MemoryObservationService as Any).store = null;
    vi.restoreAllMocks();
    db.close();
  });

  describe("archive capture", () => {
    const capture = (content: string, options: Record<string, unknown> = {}) =>
      MemoryService.capture("ws-1", undefined, "observation", content, false, {
        skipMemoryWriteGate: true,
        allowExternalMirror: false,
        ...options,
      });

    it("drops low-salience text and captures marked <no-memory> by the caller", async () => {
      expect(await capture("  ")).toBeNull();
      expect(await capture("--- ... ---")).toBeNull();
      expect(await capture("ok")).toBeNull();
      expect(await capture('Tool called: {"name":"x"}')).toBeNull();
      expect(await capture("Fixed the flaky login test", { noMemory: true })).toBeNull();
      expect(await capture("Fixed the flaky login test")).not.toBeNull();
      expect(archiveRows()).toHaveLength(1);
    });

    it("dedupes an identical capture by content hash", async () => {
      const first = await capture("Fixed the flaky login test");
      const second = await capture("fixed the  flaky login test");
      expect(second?.id).toBe(first?.id);
      expect(archiveRows()).toHaveLength(1);
    });
  });

  describe("gated import API", () => {
    const header = '[Imported from ChatGPT — "Stack" (conv:c-1)]';
    const fact = { kind: "preference" as const, importer: "chatgpt", conversationId: "c-1" };

    it("refuses imports when memory is off or privacy mode is disabled", async () => {
      settingsFor("ws-1", { enabled: false });
      await expect(MemoryService.openImportSession({ workspaceId: "ws-1" })).rejects.toThrow(
        /disabled/,
      );
      settingsFor("ws-1", { enabled: true, privacyMode: "disabled" });
      await expect(MemoryService.openImportSession({ workspaceId: "ws-1" })).rejects.toThrow(
        /privacy mode/,
      );
    });

    it("imports while auto-capture is off (an explicit user act)", async () => {
      settingsFor("ws-1", { autoCapture: false });
      const session = await MemoryService.openImportSession({ workspaceId: "ws-1" });
      expect(
        await session.add({ type: "insight", body: "Uses Vim keybindings", header }),
      ).toMatchObject({
        status: "created",
      });
    });

    it("redacts secrets, honours <no-memory>, salience and excluded patterns", async () => {
      settingsFor("ws-1", { excludedPatterns: ["payroll"] });
      const session = await MemoryService.openImportSession({ workspaceId: "ws-1" });
      const stored = await session.add({
        type: "insight",
        body: `Deploy bot token is ${TOKEN} for the staging cluster`,
        header,
      });
      expect(stored.status).toBe("created");
      expect(
        await session.add({ type: "insight", body: "Secret plan <no-memory>", header }),
      ).toEqual({
        status: "filtered",
        reason: "no_memory",
      });
      expect(await session.add({ type: "insight", body: "!!", header })).toEqual({
        status: "filtered",
        reason: "low_salience",
      });
      expect(await session.add({ type: "insight", body: TOKEN, header })).toEqual({
        status: "filtered",
        reason: "secret_only",
      });
      expect(
        await session.add({ type: "insight", body: "Asked about payroll dates", header }),
      ).toEqual({ status: "filtered", reason: "excluded" });

      const rows = archiveRows();
      expect(rows).toHaveLength(1);
      expect(String(rows[0].content)).toMatch(/^\[Imported from ChatGPT/);
      expect(String(rows[0].content)).not.toContain(TOKEN);
      expect(String(rows[0].content)).toContain("[REDACTED_SECRET]");
      // The observation sidecar and the embedding are written with the row.
      expect(
        db.prepare("SELECT origin, capture_reason FROM memory_observation_metadata").all(),
      ).toEqual([{ origin: "import", capture_reason: "memory_import" }]);
      expect(db.prepare("SELECT COUNT(*) AS n FROM memory_embeddings").get()).toEqual({ n: 1 });
    });

    it("dedupes within an import, across re-imports and across workspaces", async () => {
      const first = await MemoryService.openImportSession({ workspaceId: "ws-1" });
      expect((await first.add({ type: "insight", body: "Uses Postgres 16", header })).status).toBe(
        "created",
      );
      // Same text under a different title, in the same import.
      expect(
        await first.add({
          type: "insight",
          body: "uses  postgres 16",
          header: '[Imported from ChatGPT — "Other title"]',
        }),
      ).toEqual({ status: "duplicate" });
      await first.finish();

      // A re-import, here and in another workspace (non-private imports are visible there).
      const again = await MemoryService.openImportSession({ workspaceId: "ws-1" });
      expect(await again.add({ type: "insight", body: "Uses Postgres 16", header })).toEqual({
        status: "duplicate",
      });
      const elsewhere = await MemoryService.openImportSession({ workspaceId: "ws-2" });
      expect(await elsewhere.add({ type: "insight", body: "Uses Postgres 16", header })).toEqual({
        status: "duplicate",
      });
      expect(archiveRows()).toHaveLength(1);
    });

    it("keeps private imports in their workspace and does not dedupe against them elsewhere", async () => {
      settingsFor("ws-1", { privacyMode: "strict" });
      const strict = await MemoryService.openImportSession({ workspaceId: "ws-1" });
      expect(strict.isPrivate).toBe(true);
      await strict.add({ type: "insight", body: "Uses Postgres 16", header });
      const other = await MemoryService.openImportSession({ workspaceId: "ws-2" });
      expect((await other.add({ type: "insight", body: "Uses Postgres 16", header })).status).toBe(
        "created",
      );
      expect(archiveRows().map((row) => [row.workspace_id, row.is_private])).toEqual([
        ["ws-1", 1],
        ["ws-2", 0],
      ]);
    });

    it("writes imported facts as import items (never user_stated), private when the row is", async () => {
      const session = await MemoryService.openImportSession({ workspaceId: "ws-1" });
      const outcome = await session.add({
        type: "observation",
        body: "Prefers TypeScript",
        header,
        fact,
      });
      expect(outcome).toMatchObject({ status: "created", factItemId: expect.any(String) });
      const archiveId = outcome.status === "created" ? outcome.memory.id : "";
      const items = rowsOf(db);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        kind: "preference",
        scope: "workspace",
        workspace_id: "ws-1",
        source: "import",
        privacy: "normal",
        content: "Prefers TypeScript",
      });
      expect(JSON.parse(String(items[0].source_ref))).toMatchObject({
        store: IMPORT_FACT_STORE,
        id: archiveId,
        importer: "chatgpt",
        conversationId: "c-1",
      });

      const privateSession = await MemoryService.openImportSession({
        workspaceId: "ws-2",
        forcePrivate: true,
      });
      await privateSession.add({ type: "observation", body: "Works in Lisbon", header, fact });
      expect(rowsOf(db, "workspace_id = 'ws-2'")[0]).toMatchObject({ privacy: "private" });
    });

    it("forgets an imported fact with its row, and archives it while the row is ignored", async () => {
      const session = await MemoryService.openImportSession({ workspaceId: "ws-1" });
      const outcome = await session.add({
        type: "observation",
        body: "Prefers TypeScript",
        header,
        fact,
      });
      const archiveId = outcome.status === "created" ? outcome.memory.id : "";

      await MemoryService.setImportedPromptRecallIgnored("ws-1", archiveId, true);
      expect(rowsOf(db).map((row) => row.status)).toEqual(["archived"]);
      await MemoryService.setImportedPromptRecallIgnored("ws-1", archiveId, false);
      expect(rowsOf(db, "status = 'active'")).toHaveLength(1);

      expect(await MemoryService.deleteImportedEntry("ws-1", archiveId)).toBe(true);
      expect(rowsOf(db, "status = 'active'")).toHaveLength(0);
      expect(rowsOf(db, "status = 'deleted'").length).toBeGreaterThan(0);
    });

    it("leaves a matching fact another source holds when its import is deleted", async () => {
      await MemoryWriter.get()!.ingest({
        content: "Prefers TypeScript",
        kind: "preference",
        scope: "workspace",
        workspaceId: "ws-1",
        source: "user_stated",
        sourceRef: { store: "agent_tool", id: "r-1" },
      });
      const session = await MemoryService.openImportSession({ workspaceId: "ws-1" });
      const outcome = await session.add({
        type: "observation",
        body: "Prefers TypeScript",
        header,
        fact,
      });
      const archiveId = outcome.status === "created" ? outcome.memory.id : "";
      await MemoryService.deleteImported("ws-1");
      expect(archiveRows()).toHaveLength(0);
      expect(rowsOf(db)).toEqual([
        expect.objectContaining({ source: "user_stated", status: "active" }),
      ]);
      expect(archiveId).not.toBe("");
    });

    it("deletes every imported fact of a workspace with Delete imported", async () => {
      const session = await MemoryService.openImportSession({ workspaceId: "ws-1" });
      await session.add({ type: "observation", body: "Prefers TypeScript", header, fact });
      await session.add({ type: "observation", body: "Uses a standing desk", header, fact });
      await MemoryService.deleteImported("ws-1");
      expect(rowsOf(db, "status = 'active'")).toHaveLength(0);
    });

    describe("with the memory folder running", () => {
      let base: string;
      let repo: MemoryRepoService;
      const meLines = () =>
        parseMemoryRepoEntries(fs.readFileSync(path.join(repo.root, "me.md"), "utf8"));

      beforeEach(async () => {
        base = fs.mkdtempSync(path.join(os.tmpdir(), "memory-import-folder-"));
        repo = new MemoryRepoService({ root: path.join(base, "memory"), runtime: "node" });
        await repo.start();
        MemoryRepoService.setInstance(repo);
      });

      afterEach(() => {
        MemoryRepoService.setInstance(null);
        fs.rmSync(base, { recursive: true, force: true });
      });

      it("writes imported facts to me.md as agent lines tagged source: import", async () => {
        const session = await MemoryService.openImportSession({ workspaceId: "ws-1" });
        const outcome = await session.add({
          type: "observation",
          body: "Prefers TypeScript",
          header,
          fact,
        });
        const archiveId = outcome.status === "created" ? outcome.memory.id : "";
        expect(outcome).toMatchObject({ factItemId: expect.stringMatching(/^repo:me\.md#L\d+$/) });
        expect(rowsOf(db)).toHaveLength(0);
        expect(meLines()).toEqual([
          expect.objectContaining({
            text: "Prefers TypeScript",
            by: "agent",
            kind: "preference",
            metadata: expect.objectContaining({ source: "import", import: `ws-1/${archiveId}` }),
          }),
        ]);

        // Ignoring the row forgets the line; un-ignoring writes it again.
        await MemoryService.setImportedPromptRecallIgnored("ws-1", archiveId, true);
        expect(meLines()).toEqual([]);
        await MemoryService.setImportedPromptRecallIgnored("ws-1", archiveId, false);
        expect(meLines().map((line) => line.text)).toEqual(["Prefers TypeScript"]);
        expect(await MemoryService.deleteImportedEntry("ws-1", archiveId)).toBe(true);
        expect(meLines()).toEqual([]);
      });

      it("keeps private imports out of the folder and deletes a workspace's imported lines", async () => {
        const privateSession = await MemoryService.openImportSession({
          workspaceId: "ws-2",
          forcePrivate: true,
        });
        await privateSession.add({ type: "observation", body: "Works in Lisbon", header, fact });
        expect(rowsOf(db, "workspace_id = 'ws-2'")[0]).toMatchObject({ privacy: "private" });

        const session = await MemoryService.openImportSession({ workspaceId: "ws-1" });
        await session.add({ type: "observation", body: "Prefers TypeScript", header, fact });
        await session.add({ type: "observation", body: "Uses a standing desk", header, fact });
        expect(meLines()).toHaveLength(2);
        await MemoryService.deleteImported("ws-1");
        expect(meLines()).toEqual([]);
      });
    });

    it("stores a categorized export as typed facts, per category", async () => {
      const result = await MemoryService.importFromText({
        workspaceId: "ws-1",
        provider: "ChatGPT",
        forcePrivate: false,
        pastedText: [
          "```",
          "## Instructions",
          "[2024-03-01] - Never use emoji in replies.",
          "## Identity",
          "[unknown] - Lives in Lisbon.",
          "## Projects",
          "[2025-01-10] - Atlas: a CLI for log search, in beta.",
          "```",
          "This is not the complete set; more remain.",
        ].join("\n"),
      });
      expect(result).toMatchObject({
        entriesDetected: 3,
        memoriesCreated: 3,
        byCategory: { instructions: 1, identity: 1, projects: 1 },
        incomplete: true,
      });
      expect(archiveRows().map((row) => [row.type, row.content])).toEqual([
        [
          "observation",
          '[Imported from ChatGPT — "Memory export (pasted) · Instructions"]\n[2024-03-01] - Never use emoji in replies.',
        ],
        [
          "observation",
          '[Imported from ChatGPT — "Memory export (pasted) · Identity"]\nLives in Lisbon.',
        ],
        [
          "observation",
          '[Imported from ChatGPT — "Memory export (pasted) · Projects"]\n[2025-01-10] - Atlas: a CLI for log search, in beta.',
        ],
      ]);
      expect(rowsOf(db).map((row) => [row.kind, row.source])).toEqual([
        ["rule", "import"],
        ["identity", "import"],
        ["project_fact", "import"],
      ]);
    });

    it("pasted imports go through the same gate and are private by default", async () => {
      const result = await MemoryService.importFromText({
        workspaceId: "ws-1",
        provider: "Gemini",
        pastedText: `- Prefers dark mode\n- Prefers dark mode\n- <no-memory> diary\n- ${TOKEN}`,
      });
      expect(result).toMatchObject({
        entriesDetected: 4,
        memoriesCreated: 1,
        duplicatesSkipped: 3,
      });
      expect(archiveRows()).toEqual([
        expect.objectContaining({
          is_private: 1,
          content: '[Imported from Gemini — "Memory export (pasted)"]\nPrefers dark mode',
        }),
      ]);
      settingsFor("ws-1", { privacyMode: "disabled" });
      await expect(
        MemoryService.importFromText({
          workspaceId: "ws-1",
          provider: "x",
          pastedText: "- a fact",
        }),
      ).rejects.toThrow(/privacy mode/);
    });
  });
});
