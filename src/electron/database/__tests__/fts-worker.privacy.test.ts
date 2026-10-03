/**
 * The FTS worker's memory searches honour the agent-visibility policy (audit SEC-5,
 * SEC-10): no suppressed/redacted rows, and no private rows from other workspaces,
 * including semantic candidates that come from the embedding caches.
 */
import { createRequire } from "module";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createLocalEmbedding } from "../../memory/local-embedding";

const require = createRequire(import.meta.url);
const BetterSqlite3 = (() => {
  try {
    const mod = require("better-sqlite3") as typeof import("better-sqlite3");
    new mod(":memory:").close();
    return mod;
  } catch {
    return null;
  }
})();

const worker = vi.hoisted(() => ({
  dbPath: "",
  handler: null as null | ((msg: unknown) => void),
  replies: [] as Array<{ id: string; result?: unknown; error?: string }>,
}));

vi.mock("worker_threads", () => ({
  get workerData() {
    return { dbPath: worker.dbPath };
  },
  parentPort: {
    on: (_event: string, handler: (msg: unknown) => void) => {
      worker.handler = handler;
    },
    postMessage: (reply: { id: string; result?: unknown; error?: string }) => {
      worker.replies.push(reply);
    },
  },
}));

const describeWithNativeDb = BetterSqlite3 ? describe : describe.skip;

describeWithNativeDb("fts-worker memory privacy", () => {
  let dir = "";
  let counter = 0;

  function call(method: string, ...args: unknown[]): unknown {
    const id = `req-${++counter}`;
    worker.handler?.({ id, method, args });
    const reply = worker.replies.find((r) => r.id === id);
    if (reply?.error) throw new Error(reply.error);
    return reply?.result;
  }

  beforeAll(async () => {
    if (!BetterSqlite3) return;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fts-worker-privacy-"));
    worker.dbPath = path.join(dir, "db.sqlite");
    const db = new BetterSqlite3(worker.dbPath);
    db.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, task_id TEXT, type TEXT NOT NULL,
        content TEXT NOT NULL, summary TEXT, tokens INTEGER NOT NULL DEFAULT 0,
        is_compressed INTEGER NOT NULL DEFAULT 0, is_private INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE VIRTUAL TABLE memories_fts USING fts5(content, summary, content='memories', content_rowid='rowid');
      CREATE TRIGGER memories_fts_insert AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content, summary) VALUES (NEW.rowid, NEW.content, NEW.summary);
      END;
      CREATE TABLE memory_embeddings (
        memory_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, embedding TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE memory_observation_metadata (
        memory_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, privacy_state TEXT NOT NULL DEFAULT 'normal'
      );
    `);
    const insert = db.prepare(
      `INSERT INTO memories (id, workspace_id, type, content, is_private, created_at, updated_at)
       VALUES (?, ?, 'observation', ?, ?, 1, 1)`,
    );
    const embed = db.prepare(
      "INSERT INTO memory_embeddings (memory_id, workspace_id, embedding, updated_at) VALUES (?, ?, ?, 1)",
    );
    const rows: Array<[string, string, string, number]> = [
      ["visible", "ws-1", "kubernetes rollout plan for the cluster", 0],
      ["own-private", "ws-1", "kubernetes rollout private plan for the cluster", 1],
      ["deleted", "ws-1", "kubernetes rollout deleted plan for the cluster", 0],
      ["redacted", "ws-1", "kubernetes rollout redacted plan for the cluster", 0],
      ["imp-public", "ws-2", "[Imported from ChatGPT] kubernetes rollout plan history", 0],
      ["imp-private", "ws-2", "[Imported from ChatGPT] kubernetes rollout plan private", 1],
      ["other-local", "ws-2", "kubernetes rollout plan for another workspace", 0],
    ];
    for (const [id, ws, content, priv] of rows) {
      insert.run(id, ws, content, priv);
      embed.run(id, ws, JSON.stringify(createLocalEmbedding(content)));
    }
    db.prepare(
      "INSERT INTO memory_observation_metadata (memory_id, workspace_id, privacy_state) VALUES (?, 'ws-1', ?)",
    ).run("deleted", "suppressed");
    db.prepare(
      "INSERT INTO memory_observation_metadata (memory_id, workspace_id, privacy_state) VALUES (?, 'ws-1', ?)",
    ).run("redacted", "redacted");
    db.close();
    await import("../fts-worker");
  });

  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("hybrid search (lexical + semantic) returns only agent-visible rows", () => {
    const ids = (
      call("hybridSearch", "ws-1", "kubernetes rollout plan cluster", 20, true) as Array<{
        id: string;
      }>
    ).map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining(["visible", "own-private", "imp-public"]));
    expect(ids).not.toContain("deleted");
    expect(ids).not.toContain("redacted");
    expect(ids).not.toContain("imp-private");
    expect(ids).not.toContain("other-local");
  });

  it("hybrid search without private rows drops the workspace's private rows too", () => {
    const ids = (
      call("hybridSearch", "ws-1", "kubernetes rollout plan cluster", 20, false) as Array<{
        id: string;
      }>
    ).map((r) => r.id);
    expect(ids).not.toContain("own-private");
    expect(ids).toContain("visible");
  });

  it("the imported lane never crosses workspaces with private rows", () => {
    const ids = (
      call("searchImportedGlobal", "kubernetes rollout", 20, true) as Array<{ id: string }>
    ).map((r) => r.id);
    expect(ids).toEqual(["imp-public"]);
  });

  it("prompt recall skips private, deleted and redacted rows", () => {
    const ids = (
      call("searchLocalForPromptRecall", "ws-1", "kubernetes rollout", 20) as Array<{ id: string }>
    ).map((r) => r.id);
    expect(ids).toEqual(["visible"]);
  });
});
