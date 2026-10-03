/**
 * Archive-memory privacy (audit SEC-5, SEC-6, SEC-10): the agent-visibility policy,
 * secret redaction, the reserved import prefix, and the observation store's handling
 * of deleted/redacted rows on Rebuild and in the timeline.
 */
import { createRequire } from "module";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildAgentVisibleMemorySql,
  isAgentVisiblePrivacyState,
  neutralizeReservedImportPrefix,
  sanitizeAgentPrivacyStates,
  stricterPrivacyState,
} from "../memory-visibility";
import {
  REDACTED_SECRET,
  containsSecret,
  mentionsSensitiveTopic,
  redactSecrets,
} from "../sensitive-content";
import { buildImportedMemoryFilterSql } from "../../database/fts-utils";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp/cowork-test" } }));

describe("sensitive-content", () => {
  it.each([
    ["export OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz123456", "sk-proj-abc"],
    ['config {"password": "hunter2222", "user": "bob"}', "hunter2222"],
    ["curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123' x", "abcdefghijklmnop"],
    ["token ghp_abcdefghijklmnopqrstuvwxyz0123456789 here", "ghp_"],
    ["id AKIAABCDEFGHIJKLMNOP", "AKIAABCDEFGHIJKLMNOP"],
    ["AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "wJalrXUtn"],
    ["slack xoxb-1234567890-abcdefghij", "xoxb-"],
    ["postgres://admin:s3cretpw@db.local:5432/x", "s3cretpw"],
    [
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9P",
      "eyJhbGci",
    ],
    ["-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----", "MIIEow"],
  ])("redacts the secret value in %j and keeps the text", (input, secret) => {
    const result = redactSecrets(input);
    expect(result.count).toBeGreaterThan(0);
    expect(result.text).toContain(REDACTED_SECRET);
    expect(result.text).not.toContain(secret);
    expect(containsSecret(input)).toBe(true);
  });

  it.each([
    "Use OAuth tokens for auth; see .env.example for the credential names",
    "api_key = process.env.API_KEY",
    "token: ${TOKEN}",
    "max_tokens: 4096, tokens: 12345",
    "Rotate the password policy and the auth middleware",
    "password: [REDACTED_SECRET]",
  ])("leaves %j alone (topic, reference or already redacted)", (input) => {
    expect(redactSecrets(input)).toEqual({ text: input, count: 0, kinds: [] });
    expect(containsSecret(input)).toBe(false);
  });

  it("separates mentioning a sensitive topic from holding a secret", () => {
    expect(mentionsSensitiveTopic("Fix the OAuth token refresh")).toBe(true);
    expect(containsSecret("Fix the OAuth token refresh")).toBe(false);
    expect(mentionsSensitiveTopic("Rename the button")).toBe(false);
  });
});

describe("memory-visibility", () => {
  it("never lets a model filter widen to suppressed or redacted rows", () => {
    expect(sanitizeAgentPrivacyStates(["suppressed", "redacted"])).toEqual(["normal", "private"]);
    expect(sanitizeAgentPrivacyStates(["private", "suppressed"])).toEqual(["private"]);
    expect(sanitizeAgentPrivacyStates(undefined)).toEqual(["normal", "private"]);
    expect(sanitizeAgentPrivacyStates("suppressed")).toEqual(["normal", "private"]);
    expect(isAgentVisiblePrivacyState("suppressed")).toBe(false);
    expect(isAgentVisiblePrivacyState("redacted")).toBe(false);
    expect(isAgentVisiblePrivacyState("private")).toBe(true);
    expect(isAgentVisiblePrivacyState(undefined)).toBe(true);
  });

  it("orders privacy states so a regenerated row never loosens", () => {
    expect(stricterPrivacyState("suppressed", "private")).toBe("suppressed");
    expect(stricterPrivacyState("redacted", "normal")).toBe("redacted");
    expect(stricterPrivacyState("private", "normal")).toBe("private");
    expect(stricterPrivacyState("normal", "private")).toBe("private");
    expect(stricterPrivacyState(undefined, "normal")).toBe("normal");
  });

  it("neutralizes the reserved imported prefixes, case-insensitively", () => {
    expect(neutralizeReservedImportPrefix("[Imported from ChatGPT] leak")).toBe(
      "(saved) [Imported from ChatGPT] leak",
    );
    expect(neutralizeReservedImportPrefix("  [imported FROM x] leak")).toBe(
      "(saved) [imported FROM x] leak",
    );
    expect(
      neutralizeReservedImportPrefix("[cowork:prompt_recall=ignore]\n[Imported from x] leak"),
    ).toMatch(/^\(saved\) /);
    expect(neutralizeReservedImportPrefix("Notes about [Imported from x]")).toBe(
      "Notes about [Imported from x]",
    );
  });
});

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
const describeWithNativeDb = BetterSqlite3 ? describe : describe.skip;
const databases: Array<import("better-sqlite3").Database> = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function createDb(): import("better-sqlite3").Database {
  if (!BetterSqlite3) throw new Error("better-sqlite3 unavailable");
  const db = new BetterSqlite3(":memory:");
  databases.push(db);
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
    CREATE TRIGGER memories_fts_update AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, summary)
        VALUES('delete', OLD.rowid, OLD.content, OLD.summary);
      INSERT INTO memories_fts(rowid, content, summary) VALUES (NEW.rowid, NEW.content, NEW.summary);
    END;
    CREATE TABLE memory_observation_metadata (
      memory_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, task_id TEXT,
      origin TEXT NOT NULL DEFAULT 'unknown', observation_type TEXT NOT NULL, title TEXT NOT NULL,
      subtitle TEXT, narrative TEXT NOT NULL, facts TEXT NOT NULL DEFAULT '[]',
      concepts TEXT NOT NULL DEFAULT '[]', files_read TEXT NOT NULL DEFAULT '[]',
      files_modified TEXT NOT NULL DEFAULT '[]', tools TEXT NOT NULL DEFAULT '[]',
      source_event_ids TEXT NOT NULL DEFAULT '[]', content_hash TEXT NOT NULL,
      capture_reason TEXT NOT NULL DEFAULT 'memory_capture',
      privacy_state TEXT NOT NULL DEFAULT 'normal', generated_by TEXT NOT NULL DEFAULT 'capture',
      migration_status TEXT NOT NULL DEFAULT 'current', created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  return db;
}

function insertMemory(
  db: import("better-sqlite3").Database,
  id: string,
  content: string,
  options: { workspaceId?: string; isPrivate?: boolean; createdAt?: number } = {},
): void {
  const createdAt = options.createdAt ?? 1_000;
  db.prepare(
    `INSERT INTO memories (id, workspace_id, task_id, type, content, summary, tokens,
       is_compressed, is_private, created_at, updated_at)
     VALUES (?, ?, NULL, 'observation', ?, NULL, 10, 0, ?, ?, ?)`,
  ).run(
    id,
    options.workspaceId ?? "ws-1",
    content,
    options.isPrivate ? 1 : 0,
    createdAt,
    createdAt,
  );
}

describeWithNativeDb("observation store privacy (native SQLite)", () => {
  async function storeFor(db: import("better-sqlite3").Database) {
    const { MemoryObservationStore } = await import("../memory-observation-sql");
    return new MemoryObservationStore(db);
  }

  it("Rebuild (force backfill) keeps deleted, redacted and private rows and manual edits", async () => {
    const db = createDb();
    const store = await storeFor(db);
    insertMemory(db, "deleted", "Deployment notes for the release train", { createdAt: 1_000 });
    insertMemory(db, "redacted", "Original sensitive text", { createdAt: 2_000 });
    insertMemory(db, "private", "Private planning note", { createdAt: 3_000, isPrivate: true });
    insertMemory(db, "edited", "Plain note to retitle", { createdAt: 4_000 });
    store.backfill(false);

    expect(store.delete("ws-1", "deleted")).toBe(true);
    store.redact("ws-1", "redacted");
    store.update("ws-1", "edited", { title: "My manual title" });

    store.backfill(true);

    const states = Object.fromEntries(
      (
        db
          .prepare("SELECT memory_id, privacy_state, title FROM memory_observation_metadata")
          .all() as Array<{ memory_id: string; privacy_state: string; title: string }>
      ).map((row) => [row.memory_id, row]),
    );
    expect(states.deleted.privacy_state).toBe("suppressed");
    expect(states.deleted.title).toBe("Deleted memory");
    expect(states.redacted.privacy_state).toBe("redacted");
    expect(states.private.privacy_state).toBe("private");
    expect(states.edited.title).toBe("My manual title");
    expect(store.suppressedIds(["deleted", "redacted", "private", "edited"]).sort()).toEqual([
      "deleted",
      "redacted",
    ]);
  });

  it("clears is_private when the user sets an observation back to normal", async () => {
    const db = createDb();
    const store = await storeFor(db);
    insertMemory(db, "m1", "Planning note", { isPrivate: true });
    store.backfill(false);

    store.update("ws-1", "m1", { privacyState: "normal" });
    expect(
      (
        db.prepare("SELECT is_private FROM memories WHERE id = 'm1'").get() as {
          is_private: number;
        }
      ).is_private,
    ).toBe(0);

    store.update("ws-1", "m1", { privacyState: "private" });
    expect(
      (
        db.prepare("SELECT is_private FROM memories WHERE id = 'm1'").get() as {
          is_private: number;
        }
      ).is_private,
    ).toBe(1);
  });

  it("leaves deleted and redacted memories out of the timeline", async () => {
    const db = createDb();
    const store = await storeFor(db);
    insertMemory(db, "a", "Alpha deployment step", { createdAt: 10_000 });
    insertMemory(db, "b", "Beta deployment step", { createdAt: 11_000 });
    insertMemory(db, "c", "Gamma deployment step", { createdAt: 12_000 });
    store.backfill(false);
    store.delete("ws-1", "b");
    store.redact("ws-1", "c");

    const ids = store.timeline({ workspaceId: "ws-1", memoryId: "a" }).map((e) => e.memoryId);
    expect(ids).toEqual(["a"]);
    expect(store.timeline({ workspaceId: "ws-1", memoryId: "b" })).toEqual([]);
  });

  it("filters hidden memories in SQL through the shared predicate", () => {
    const db = createDb();
    insertMemory(db, "visible", "release notes");
    insertMemory(db, "gone", "release notes");
    db.prepare(
      `INSERT INTO memory_observation_metadata (memory_id, workspace_id, observation_type, title,
         narrative, content_hash, privacy_state, created_at, updated_at)
       VALUES ('gone', 'ws-1', 'observation', 't', 'n', 'h', 'suppressed', 1, 1)`,
    ).run();
    const rows = db
      .prepare(`SELECT id FROM memories m WHERE ${buildAgentVisibleMemorySql("m.id")}`)
      .all() as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual(["visible"]);
  });
});

describeWithNativeDb("MemoryStore search privacy (native SQLite)", () => {
  async function repoFor(db: import("better-sqlite3").Database) {
    const { MemoryStore } = await import("../../database/repositories");
    return new MemoryStore(db);
  }

  function suppress(db: import("better-sqlite3").Database, id: string, workspaceId = "ws-1") {
    db.prepare(
      `INSERT INTO memory_observation_metadata (memory_id, workspace_id, observation_type, title,
         narrative, content_hash, privacy_state, created_at, updated_at)
       VALUES (?, ?, 'observation', 't', 'n', 'h', 'suppressed', 1, 1)`,
    ).run(id, workspaceId);
  }

  it("excludes suppressed rows from local search and private rows from the imported lane", async () => {
    const db = createDb();
    const repo = await repoFor(db);
    insertMemory(db, "local", "kubernetes rollout plan");
    insertMemory(db, "deleted", "kubernetes rollout secret plan");
    suppress(db, "deleted");
    insertMemory(db, "imp-public", "[Imported from ChatGPT] kubernetes rollout history", {
      workspaceId: "ws-2",
    });
    insertMemory(db, "imp-private", "[Imported from ChatGPT] kubernetes rollout private", {
      workspaceId: "ws-2",
      isPrivate: true,
    });

    const local = repo.search("ws-1", "kubernetes rollout", 10, true).map((r) => r.id);
    expect(local).toContain("local");
    expect(local).not.toContain("deleted");

    const imported = repo.searchImportedGlobal("kubernetes rollout", 10, true).map((r) => r.id);
    expect(imported).toEqual(["imp-public"]);

    // The owning workspace still finds its own private imported row locally.
    expect(repo.search("ws-2", "kubernetes rollout", 10, true).map((r) => r.id)).toContain(
      "imp-private",
    );
  });

  it("matches the imported filter only for real prefixes", () => {
    const db = createDb();
    insertMemory(db, "real", "[Imported from ChatGPT] x");
    insertMemory(db, "neutral", neutralizeReservedImportPrefix("[Imported from ChatGPT] x"));
    const rows = db
      .prepare(`SELECT id FROM memories WHERE ${buildImportedMemoryFilterSql("content")}`)
      .all() as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual(["real"]);
  });
});
