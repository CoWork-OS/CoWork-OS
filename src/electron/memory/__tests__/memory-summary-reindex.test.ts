import type Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseManager } from "../../database/schema";
import { MemoryStore, WorkspaceStore } from "../../database/repositories";
import { chronicleObservationToMemoryContent } from "../../chronicle/ChronicleProvenance";
import { maintenanceClaimKey } from "../maintenance-claim-sql";
import { createMemoryStatementPort } from "../memory-statement-port";
import { MEMORY_SUMMARY_REINDEX_KEY, runMemorySummaryReindex } from "../MemorySummaryReindex";
import { MemoryCompressionBudget } from "../MemoryCompressionBudget";
import { legacyDeterministicSummary } from "../memory-summary";

// The one-time summary re-index (DATA-5) and the storage cap and compression ledger
// (DATA-7), on a real profile database.

describe("memory summary re-index and archive accounting", () => {
  const cleanups: Array<() => void> = [];
  const previousUserDataDir = process.env.COWORK_USER_DATA_DIR;

  afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
  });

  const profile = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-summary-reindex-"));
    process.env.COWORK_USER_DATA_DIR = dir;
    const manager = new DatabaseManager();
    const db = manager.getDatabase();
    cleanups.push(() => {
      manager.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const workspace = new WorkspaceStore(db).create("W", path.join(dir, "w"), {
      read: true,
      write: true,
      delete: false,
      network: false,
      shell: false,
    });
    return { db, workspace, port: createMemoryStatementPort(db) };
  };

  const chronicle = (windowTitle: string, text: string) =>
    chronicleObservationToMemoryContent({
      appName: "Slack",
      windowTitle,
      localTextSnippet: text,
    } as Parameters<typeof chronicleObservationToMemoryContent>[0]);

  const insert = (
    db: Database.Database,
    row: {
      id: string;
      workspaceId: string;
      content: string;
      summary?: string | null;
      isPrivate?: boolean;
      createdAt?: number;
      observation?: { privacyState?: string; generatedBy?: string; title?: string };
    },
  ) => {
    const createdAt = row.createdAt ?? Date.now() - 60_000;
    const summary =
      row.summary === undefined ? legacyDeterministicSummary(row.content) : row.summary;
    db.prepare(
      `INSERT INTO memories (id, workspace_id, task_id, type, content, summary, tokens,
         is_compressed, is_private, created_at, updated_at)
       VALUES (?, ?, NULL, 'screen_context', ?, ?, 15, 1, ?, ?, ?)`,
    ).run(
      row.id,
      row.workspaceId,
      row.content,
      summary,
      row.isPrivate ? 1 : 0,
      createdAt,
      createdAt,
    );
    if (row.observation) {
      db.prepare(
        `INSERT INTO memory_observation_metadata (memory_id, workspace_id, origin,
           observation_type, title, narrative, content_hash, privacy_state, generated_by,
           created_at, updated_at)
         VALUES (?, ?, 'chronicle', 'screen_context', ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        row.id,
        row.workspaceId,
        row.observation.title ?? "Chronicle observation from the user's local screen context.",
        summary ?? row.content,
        `hash-${row.id}`,
        row.observation.privacyState ?? "normal",
        row.observation.generatedBy ?? "capture",
        createdAt,
        createdAt,
      );
    }
    db.prepare(
      "INSERT INTO memory_embeddings (memory_id, workspace_id, embedding, updated_at) VALUES (?, ?, '[1]', ?)",
    ).run(row.id, row.workspaceId, createdAt);
  };

  const memory = (db: Database.Database, id: string) =>
    db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as Record<string, Any>;
  const observation = (db: Database.Database, id: string) =>
    db.prepare("SELECT * FROM memory_observation_metadata WHERE memory_id = ?").get(id) as Record<
      string,
      Any
    >;
  const embedding = (db: Database.Database, id: string) =>
    (
      db.prepare("SELECT embedding FROM memory_embeddings WHERE memory_id = ?").get(id) as {
        embedding: string;
      }
    ).embedding;
  const marker = (db: Database.Database, key = MEMORY_SUMMARY_REINDEX_KEY) =>
    db.prepare("SELECT value FROM maintenance_state WHERE key = ?").get(key) as
      | { value: string }
      | undefined;

  it("rewrites deterministic summaries, embeddings and observations; leaves edits alone", async () => {
    const { db, workspace, port } = profile();
    const ws = workspace.id;
    insert(db, {
      id: "plain",
      workspaceId: ws,
      content: chronicle("#releases", "ship friday"),
      observation: {},
    });
    insert(db, {
      id: "private",
      workspaceId: ws,
      content: chronicle("#design", "new logo"),
      isPrivate: true,
      observation: { privacyState: "private" },
    });
    insert(db, {
      id: "custom",
      workspaceId: ws,
      content: chronicle("#ops", "pager rota"),
      summary: "Ops rota for October (written by the compression)",
      observation: {},
    });
    insert(db, {
      id: "manual",
      workspaceId: ws,
      content: chronicle("#hr", "offsite"),
      observation: { generatedBy: "manual", title: "My title" },
    });
    insert(db, {
      id: "redacted",
      workspaceId: ws,
      content: "[redacted]",
      summary: "[redacted]",
      isPrivate: true,
      observation: { privacyState: "redacted", generatedBy: "manual", title: "Redacted memory" },
    });
    const before = memory(db, "plain");
    const ftsBefore = db.prepare("SELECT count(*) AS n FROM memories_fts").get() as { n: number };

    const result = await runMemorySummaryReindex(port, { chunkSize: 2 });

    expect(result).toEqual({
      ran: true,
      counts: {
        scanned: 5,
        summariesRewritten: 2,
        embeddingsRewritten: 3,
        observationsRewritten: 3,
        skippedEdited: 2,
        keptCustomSummary: 1,
      },
    });
    const plain = memory(db, "plain");
    expect(plain.summary).toBe(
      "App: Slack · Window: #releases · Observed text (untrusted): ship friday",
    );
    expect(plain.tokens).toBe(Math.ceil(String(plain.content).length / 4));
    expect(plain.updated_at).toBe(before.updated_at);
    expect(embedding(db, "plain")).not.toBe("[1]");
    expect(observation(db, "plain").title).toContain("App: Slack");
    expect(observation(db, "plain").narrative).toContain("ship friday");

    // Private rows keep their privacy.
    expect(memory(db, "private").is_private).toBe(1);
    expect(observation(db, "private").privacy_state).toBe("private");
    expect(memory(db, "private").summary).toContain("#design");

    // A non-deterministic summary is kept; its embedding is rebuilt from the content.
    expect(memory(db, "custom").summary).toBe("Ops rota for October (written by the compression)");
    expect(embedding(db, "custom")).not.toBe("[1]");

    // Hand-edited and redacted rows are untouched.
    expect(observation(db, "manual").title).toBe("My title");
    expect(memory(db, "manual").summary).toBe(
      "Chronicle observation from the user's local screen context.",
    );
    expect(embedding(db, "manual")).toBe("[1]");
    expect(memory(db, "redacted").content).toBe("[redacted]");
    expect(embedding(db, "redacted")).toBe("[1]");

    // The FTS index stays consistent (the update trigger replaced the rows).
    const ftsAfter = db.prepare("SELECT count(*) AS n FROM memories_fts").get() as { n: number };
    expect(ftsAfter.n).toBe(ftsBefore.n);
    const hit = db
      .prepare("SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?")
      .all('"releases"') as unknown[];
    expect(hit.length).toBeGreaterThan(0);

    const stored = JSON.parse(marker(db)!.value);
    expect(stored.counts.summariesRewritten).toBe(2);
    expect(marker(db, `${MEMORY_SUMMARY_REINDEX_KEY}:progress`)).toBeUndefined();
  });

  it("runs only once", async () => {
    const { db, workspace, port } = profile();
    expect((await runMemorySummaryReindex(port)).ran).toBe(true);
    insert(db, { id: "late", workspaceId: workspace.id, content: chronicle("#x", "y") });
    expect(await runMemorySummaryReindex(port)).toEqual({ ran: false, reason: "done" });
    expect(memory(db, "late").summary).toBe(
      "Chronicle observation from the user's local screen context.",
    );
  });

  it("resumes an interrupted run from its stored progress", async () => {
    const { db, workspace, port } = profile();
    for (let index = 0; index < 5; index += 1) {
      insert(db, {
        id: `row-${index}`,
        workspaceId: workspace.id,
        content: chronicle(`#c${index}`, `text ${index}`),
      });
    }
    let chunks = 0;
    const first = await runMemorySummaryReindex(port, {
      chunkSize: 2,
      shouldStop: () => chunks >= 1,
      onChunk: () => {
        chunks += 1;
      },
    });
    expect(first).toEqual({ ran: false, reason: "stopped" });
    expect(marker(db)).toBeUndefined();
    expect(memory(db, "row-0").summary).toContain("#c0");
    expect(memory(db, "row-4").summary).toContain("Chronicle observation");

    const second = await runMemorySummaryReindex(port, { chunkSize: 2 });
    expect(second.ran).toBe(true);
    // Totals cover both runs, and every row was scanned once.
    expect(second.ran && second.counts.scanned).toBe(5);
    expect(second.ran && second.counts.summariesRewritten).toBe(5);
    expect(memory(db, "row-4").summary).toContain("#c4");
  });

  it("skips rows created after the run started", async () => {
    const { db, workspace, port } = profile();
    insert(db, { id: "old", workspaceId: workspace.id, content: chronicle("#a", "b") });
    insert(db, {
      id: "future",
      workspaceId: workspace.id,
      content: chronicle("#c", "d"),
      createdAt: Date.now() + 60_000,
    });
    const result = await runMemorySummaryReindex(port);
    expect(result.ran && result.counts.scanned).toBe(1);
    expect(memory(db, "future").summary).toContain("Chronicle observation");
  });

  it("does not run while another process holds the claim", async () => {
    const { db, workspace, port } = profile();
    insert(db, { id: "row", workspaceId: workspace.id, content: chronicle("#a", "b") });
    db.prepare("INSERT INTO maintenance_state (key, value, updated_at) VALUES (?, ?, ?)").run(
      maintenanceClaimKey(MEMORY_SUMMARY_REINDEX_KEY),
      JSON.stringify({ owner: "node:1:other", expiresAt: Date.now() + 60 * 60 * 1000 }),
      Date.now(),
    );
    expect(await runMemorySummaryReindex(port, { owner: "desktop:2:me" })).toEqual({
      ran: false,
      reason: "held",
    });
    expect(memory(db, "row").summary).toContain("Chronicle observation");
  });

  it("counts embedding and observation bytes in the storage cap", () => {
    const { db, workspace } = profile();
    insert(db, {
      id: "row",
      workspaceId: workspace.id,
      content: "abcd",
      summary: "ab",
      observation: { title: "T" },
    });
    db.prepare("UPDATE memory_embeddings SET embedding = ? WHERE memory_id = 'row'").run(
      "[0.25,0.5]",
    );
    const obs = observation(db, "row");
    const observationBytes =
      String(obs.title).length +
      String(obs.narrative).length +
      String(obs.facts).length +
      String(obs.concepts).length +
      String(obs.files_read).length +
      String(obs.files_modified).length;
    const store = new MemoryStore(db);
    const expected = 4 + 2 + "[0.25,0.5]".length + observationBytes;
    expect(store.getApproxStorageBytes(workspace.id)).toBe(expected);
    expect(store.getOldestForWorkspace(workspace.id, 10)[0]?.approxBytes).toBe(expected);
  });

  it("keeps the compression token ledger across connections and prunes old rows", async () => {
    const { db, workspace, port } = profile();
    const now = Date.now();
    await MemoryCompressionBudget.record(port, workspace.id, 1_500, now - 25 * 60 * 60 * 1000);
    await MemoryCompressionBudget.record(port, workspace.id, 700, now - 60_000);
    expect(await MemoryCompressionBudget.tokensUsed(port, now)).toBe(700);
    expect(await MemoryCompressionBudget.remaining(port, now)).toBe(20_000 - 700);
    await MemoryCompressionBudget.record(port, workspace.id, 10, now + 8 * 24 * 60 * 60 * 1000);
    const rows = db.prepare("SELECT count(*) AS n FROM memory_compression_usage").get() as {
      n: number;
    };
    expect(rows.n).toBe(1);
  });
});
