/**
 * Knowledge graph data quality (audit DATA-10), on real SQLite: extraction precision,
 * case-insensitive names and the duplicate merge, free-mail domains, observation dedupe,
 * source precedence, decay by reinforcement, memory-settings gating and the one-time
 * cleanup (idempotent, claimed).
 */
import { createRequire } from "module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MailboxEvent } from "../../../shared/mailbox";
import { createMemoryStatementPort } from "../../memory/memory-statement-port";
import { KnowledgeGraphService } from "../KnowledgeGraphService";
import { KnowledgeGraphStore } from "../knowledge-graph-sql";
import {
  KG_CLEANUP_MIGRATION_KEY,
  KG_NORMALIZED_NAME_INDEX,
  ensureKnowledgeGraphQualitySchema,
} from "../knowledge-graph-maintenance-sql";
import { runKnowledgeGraphCleanup } from "../KnowledgeGraphCleanup";
import {
  domainOrganizationLabel,
  extractTechnologyMentions,
  isAutomatedSenderAddress,
  isFreeMailDomain,
  isNoisyAutoTechnologyName,
  normalizeEntityName,
} from "../kg-extraction";
import { KnowledgeGraphTools } from "../../agent/tools/knowledge-graph-tools";

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
type DB = import("better-sqlite3").Database;
const databases: DB[] = [];

const DAY = 24 * 60 * 60 * 1000;

/** The pre-DATA-10 schema (no normalized_name / fingerprint columns), as on old profiles. */
function createLegacyDb(): DB {
  const db = new BetterSqlite3!(":memory:");
  databases.push(db);
  db.exec(`
    CREATE TABLE kg_entity_types (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT,
      color TEXT, icon TEXT, is_builtin INTEGER DEFAULT 0, created_at INTEGER NOT NULL,
      UNIQUE(workspace_id, name)
    );
    CREATE TABLE kg_entities (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, entity_type_id TEXT NOT NULL,
      name TEXT NOT NULL, description TEXT, properties TEXT DEFAULT '{}',
      confidence REAL DEFAULT 1.0, source TEXT DEFAULT 'manual', source_task_id TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(workspace_id, entity_type_id, name)
    );
    CREATE TABLE kg_edges (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, source_entity_id TEXT NOT NULL,
      target_entity_id TEXT NOT NULL, edge_type TEXT NOT NULL, properties TEXT DEFAULT '{}',
      confidence REAL DEFAULT 1.0, source TEXT DEFAULT 'manual', source_task_id TEXT,
      created_at INTEGER NOT NULL, valid_from INTEGER, valid_to INTEGER
    );
    CREATE UNIQUE INDEX idx_kg_edges_current_unique
      ON kg_edges(workspace_id, source_entity_id, target_entity_id, edge_type)
      WHERE valid_to IS NULL;
    CREATE TABLE kg_observations (
      id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, content TEXT NOT NULL,
      source TEXT DEFAULT 'manual', source_task_id TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE memory_settings (
      workspace_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1,
      auto_capture INTEGER NOT NULL DEFAULT 1, privacy_mode TEXT NOT NULL DEFAULT 'normal'
    );
    CREATE TABLE contact_identities (id TEXT PRIMARY KEY, kg_entity_id TEXT);
  `);
  return db;
}

let seq = 0;
function legacyType(db: DB, ws: string, name: string): string {
  const existing = db
    .prepare("SELECT id FROM kg_entity_types WHERE workspace_id = ? AND name = ?")
    .get(ws, name) as { id: string } | undefined;
  if (existing) return existing.id;
  const id = `type-${++seq}`;
  db.prepare(
    "INSERT INTO kg_entity_types (id, workspace_id, name, created_at) VALUES (?, ?, ?, 0)",
  ).run(id, ws, name);
  return id;
}

function legacyEntity(
  db: DB,
  ws: string,
  type: string,
  name: string,
  opts: { source?: string; description?: string; properties?: object; createdAt?: number } = {},
): string {
  const id = `ent-${++seq}`;
  const at = opts.createdAt ?? 1_000 + seq;
  db.prepare(
    `INSERT INTO kg_entities (id, workspace_id, entity_type_id, name, description, properties,
       confidence, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0.85, ?, ?, ?)`,
  ).run(
    id,
    ws,
    legacyType(db, ws, type),
    name,
    opts.description ?? null,
    JSON.stringify(opts.properties ?? {}),
    opts.source ?? "auto",
    at,
    at,
  );
  return id;
}

function legacyEdge(
  db: DB,
  ws: string,
  from: string,
  to: string,
  type: string,
  source = "auto",
): string {
  const id = `edge-${++seq}`;
  db.prepare(
    `INSERT INTO kg_edges (id, workspace_id, source_entity_id, target_entity_id, edge_type,
       source, created_at, valid_from) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, ws, from, to, type, source, 1_000 + seq, 1_000 + seq);
  return id;
}

function legacyObservation(db: DB, entityId: string, content: string, source = "auto"): string {
  const id = `obs-${++seq}`;
  db.prepare(
    "INSERT INTO kg_observations (id, entity_id, content, source, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, entityId, content, source, 1_000 + seq);
  return id;
}

function entitiesNamed(db: DB, ws: string, type: string): Array<Record<string, Any>> {
  return db
    .prepare(
      `SELECT e.* FROM kg_entities e JOIN kg_entity_types t ON t.id = e.entity_type_id
       WHERE e.workspace_id = ? AND t.name = ? ORDER BY e.name`,
    )
    .all(ws, type) as Array<Record<string, Any>>;
}

function resetService(): void {
  const service = KnowledgeGraphService as Any;
  if (service.cleanupTimer) clearTimeout(service.cleanupTimer);
  service.cleanupTimer = undefined;
  service.repo = null;
  service.port = null;
  service.initialized = false;
  service.lastDecayRun = new Map();
}

function mailEvent(overrides: Partial<MailboxEvent> & { payload?: Record<string, unknown> }) {
  return {
    id: "evt-1",
    fingerprint: "fp-1",
    type: "thread_classified",
    workspaceId: "ws",
    timestamp: 1,
    threadId: "thread-1",
    subject: "Quarterly planning",
    summary: "Planning the next quarter",
    evidenceRefs: [],
    payload: {},
    ...overrides,
  } as MailboxEvent;
}

beforeEach(() => resetService());
afterEach(() => {
  resetService();
  for (const db of databases.splice(0)) db.close();
});

// ─── Pure rules ────────────────────────────────────────────────────────

describe("technology extraction precision", () => {
  it("ignores English words in prose", () => {
    const prose =
      "Let's go ahead and rest for a bit. We should express our thanks, react calmly, " +
      "and remove the rust from the gate. Go team! I will go test it tomorrow, then go build a shed.";
    expect(extractTechnologyMentions(prose)).toEqual([]);
  });

  it("does not match names inside paths or URLs", () => {
    const text = "Edited src/electron/main.ts and https://react.dev/learn plus lib/go/util.ts";
    expect(extractTechnologyMentions(text)).toEqual([]);
  });

  it("accepts ambiguous names only in code-ish contexts", () => {
    expect(extractTechnologyMentions("Run `go` from the shell")).toEqual(["Go"]);
    expect(extractTechnologyMentions("Updated cmd/server/main.go to log errors")).toEqual(["Go"]);
    expect(extractTechnologyMentions("$ go build ./...")).toEqual(["Go"]);
    expect(extractTechnologyMentions("We upgraded to Go 1.22 last week")).toEqual(["Go"]);
    expect(extractTechnologyMentions("The parser is written in Rust")).toEqual(["Rust"]);
    expect(extractTechnologyMentions("Bumped the version in Cargo.toml")).toEqual(["Rust"]);
    expect(extractTechnologyMentions("import express from 'express';")).toEqual(["Express"]);
    expect(extractTechnologyMentions("npm install --save express cors")).toEqual(["Express"]);
    expect(extractTechnologyMentions("Added an Express server for the webhook")).toEqual([
      "Express",
    ]);
    expect(extractTechnologyMentions("Wrapped it in a React component")).toEqual(["React"]);
    expect(extractTechnologyMentions('import { useState } from "react";')).toEqual(["React"]);
    expect(extractTechnologyMentions("Migrated the app to React 18")).toEqual(["React"]);
  });

  it("matches English-word names only in canonical casing", () => {
    expect(extractTechnologyMentions("Exposed a REST API for clients")).toEqual(["REST"]);
    expect(extractTechnologyMentions("The RESTful endpoints are documented")).toEqual(["REST"]);
    expect(extractTechnologyMentions("a restful weekend; the electron microscope")).toEqual([]);
    expect(extractTechnologyMentions("Packaged the Electron app")).toEqual(["Electron"]);
    expect(extractTechnologyMentions("gave the team a tailwind")).toEqual([]);
  });

  it("matches distinctive names in any casing and canonicalizes them", () => {
    expect(extractTechnologyMentions("ported from javascript to typescript on postgres")).toEqual([
      "TypeScript",
      "JavaScript",
      "PostgreSQL",
    ]);
  });

  it("normalizes names and classifies noisy legacy technology names", () => {
    expect(normalizeEntityName("  GO ")).toBe("go");
    expect(normalizeEntityName("Node.js")).toBe(normalizeEntityName("node.JS"));
    expect(isNoisyAutoTechnologyName("go")).toBe(true);
    expect(isNoisyAutoTechnologyName("Go")).toBe(true);
    expect(isNoisyAutoTechnologyName("rest")).toBe(true);
    expect(isNoisyAutoTechnologyName("REST")).toBe(false);
    expect(isNoisyAutoTechnologyName("electron")).toBe(true);
    expect(isNoisyAutoTechnologyName("Electron")).toBe(false);
    expect(isNoisyAutoTechnologyName("TypeScript")).toBe(false);
  });
});

describe("mail domains", () => {
  it("recognizes free-mail and relay providers", () => {
    for (const domain of [
      "gmail.com",
      "googlemail.com",
      "outlook.com",
      "hotmail.co.uk",
      "yahoo.com.tr",
      "icloud.com",
      "me.com",
      "proton.me",
      "protonmail.com",
      "privaterelay.appleid.com",
      "users.noreply.github.com",
      "gmx.de",
    ]) {
      expect(isFreeMailDomain(domain), domain).toBe(true);
    }
    for (const domain of ["acme.com", "github.com", "amazon.co.uk", "nokia.com"]) {
      expect(isFreeMailDomain(domain), domain).toBe(false);
    }
  });

  it("derives the organization from the registrable domain", () => {
    expect(domainOrganizationLabel("news.amazon.com")).toBe("amazon");
    expect(domainOrganizationLabel("mail.acme.co.uk")).toBe("acme");
    expect(domainOrganizationLabel("bildirim.turkiye.gov.tr")).toBe("turkiye");
    expect(domainOrganizationLabel("acme.io")).toBe("acme");
  });

  it("recognizes automated senders", () => {
    expect(isAutomatedSenderAddress("noreply@acme.com")).toBe(true);
    expect(isAutomatedSenderAddress("no-reply@acme.com")).toBe(true);
    expect(isAutomatedSenderAddress("notifications@github.com")).toBe(true);
    expect(isAutomatedSenderAddress("jane.doe@acme.com")).toBe(false);
  });
});

// ─── Storage ───────────────────────────────────────────────────────────

describeWithNativeDb("case-insensitive entity names", () => {
  it("merges legacy case duplicates and adds a unique normalized-name index", () => {
    const db = createLegacyDb();
    const ws = "ws";
    const upper = legacyEntity(db, ws, "technology", "Go", { description: "Technology: Go" });
    const lower = legacyEntity(db, ws, "technology", "go", {
      source: "manual",
      description: "The Go language, used for the sync service",
    });
    const shout = legacyEntity(db, ws, "technology", "GO");
    const service = legacyEntity(db, ws, "service", "sync");
    const other = legacyEntity(db, "ws-2", "technology", "go");
    legacyEdge(db, ws, service, upper, "uses");
    legacyEdge(db, ws, service, lower, "uses", "manual"); // collapses with the first
    legacyEdge(db, ws, upper, shout, "related_to"); // becomes a self-loop
    legacyObservation(db, upper, "Compiles fast");
    legacyObservation(db, shout, "compiles   FAST");
    legacyObservation(db, lower, "Used by sync", "manual");
    db.prepare("INSERT INTO contact_identities (id, kg_entity_id) VALUES ('c1', ?)").run(shout);

    expect(ensureKnowledgeGraphQualitySchema(db)).toBe(2);

    const techs = entitiesNamed(db, ws, "technology");
    expect(techs).toHaveLength(1);
    const [go] = techs;
    expect(go.id).toBe(lower); // manual wins as canonical
    expect(go.name).toBe("Go"); // canonical technology casing
    expect(go.normalized_name).toBe("go");
    expect(go.source).toBe("manual");
    expect(go.description).toBe("The Go language, used for the sync service");
    expect(go.description_source).toBe("manual");
    const edges = db.prepare("SELECT * FROM kg_edges").all() as Array<Record<string, Any>>;
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ source_entity_id: service, target_entity_id: lower });
    const observations = db
      .prepare("SELECT content FROM kg_observations WHERE entity_id = ? ORDER BY content")
      .all(lower) as Array<{ content: string }>;
    expect(observations.map((o) => o.content)).toEqual(["Compiles fast", "Used by sync"]);
    expect(
      (db.prepare("SELECT kg_entity_id FROM contact_identities").get() as Any).kg_entity_id,
    ).toBe(lower);
    // Other workspaces are untouched.
    expect(entitiesNamed(db, "ws-2", "technology").map((e) => e.id)).toEqual([other]);
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(KG_NORMALIZED_NAME_INDEX),
    ).toBeTruthy();
    // Idempotent.
    expect(ensureKnowledgeGraphQualitySchema(db)).toBe(0);

    // Later writes resolve any casing to the one entity.
    const store = new KnowledgeGraphStore(db);
    const again = store.upsertEntity(ws, { entityType: "technology", name: "gO" }, "auto");
    expect(again.id).toBe(lower);
    expect(entitiesNamed(db, ws, "technology")).toHaveLength(1);
  });
});

describeWithNativeDb("source precedence", () => {
  it("never lets a lower-precedence source replace a description", async () => {
    const db = createLegacyDb();
    KnowledgeGraphService.initialize(db, { scheduleCleanup: false });
    const ws = "ws";
    const manual = await KnowledgeGraphService.createEntity(
      ws,
      { entityType: "person", name: "Dana", description: "Head of design" },
      "manual",
    );
    const auto = await KnowledgeGraphService.createEntity(
      ws,
      { entityType: "person", name: "dana", description: "Email contact dana@x.io" },
      "auto",
    );
    expect(auto.id).toBe(manual.id);
    expect(auto.description).toBe("Head of design");
    const agent = await KnowledgeGraphService.createEntity(
      ws,
      { entityType: "person", name: "Dana", description: "Designer" },
      "agent",
    );
    expect(agent.description).toBe("Head of design");
    expect(agent.source).toBe("manual");

    // An explicit agent update keeps the manual description but applies the rest.
    const updated = await KnowledgeGraphService.updateEntity(ws, {
      entityId: manual.id,
      description: "Overwritten",
      confidence: 0.4,
    });
    expect(updated?.description).toBe("Head of design");
    expect(updated?.confidence).toBeCloseTo(0.4);

    // Auto → agent: the agent may overwrite and the entity becomes agent-owned.
    const extracted = await KnowledgeGraphService.createEntity(
      ws,
      { entityType: "technology", name: "Redis", description: "Technology: Redis" },
      "auto",
    );
    const curated = await KnowledgeGraphService.createEntity(
      ws,
      {
        entityType: "technology",
        name: "redis",
        description: "Session cache",
        properties: { port: 6379 },
      },
      "agent",
    );
    expect(curated.id).toBe(extracted.id);
    expect(curated.description).toBe("Session cache");
    expect(curated.descriptionSource).toBe("agent");
    expect(curated.source).toBe("agent");
    const reExtracted = await KnowledgeGraphService.createEntity(
      ws,
      {
        entityType: "technology",
        name: "Redis",
        description: "Technology: Redis",
        properties: { port: 1 },
      },
      "auto",
    );
    expect(reExtracted.description).toBe("Session cache");
    expect(reExtracted.properties.port).toBe(6379);
  });
});

describeWithNativeDb("confidence decay", () => {
  it("decays by last reinforcement and leaves updated_at alone", () => {
    const db = createLegacyDb();
    const store = new KnowledgeGraphStore(db);
    const now = Date.now();
    const stale = store.upsertEntity("ws", { entityType: "technology", name: "Vite" }, "auto");
    const fresh = store.upsertEntity("ws", { entityType: "technology", name: "Django" }, "auto");
    const manual = store.upsertEntity("ws", { entityType: "technology", name: "Flask" }, "manual");
    // Both are old; only `fresh` was reinforced recently.
    db.prepare("UPDATE kg_entities SET created_at = ?, updated_at = ?, last_seen_at = ?").run(
      now - 90 * DAY,
      now - 60 * DAY,
      now - 45 * DAY,
    );
    db.prepare("UPDATE kg_entities SET last_seen_at = ? WHERE id = ?").run(now - DAY, fresh.id);

    expect(store.applyConfidenceDecay("ws", 0.5, 0.3, now)).toBe(1);
    const rows = Object.fromEntries(
      (db.prepare("SELECT id, confidence, updated_at FROM kg_entities").all() as Any[]).map(
        (row) => [row.id, row],
      ),
    );
    expect(rows[stale.id].confidence).toBeCloseTo(0.425);
    expect(rows[stale.id].updated_at).toBe(now - 60 * DAY);
    expect(rows[fresh.id].confidence).toBeCloseTo(0.85);
    expect(rows[manual.id].confidence).toBe(1);

    // Reinforcement (re-extraction) moves last_seen_at, so the entity stops decaying.
    store.upsertEntity("ws", { entityType: "technology", name: "vite" }, "auto");
    expect(store.applyConfidenceDecay("ws", 0.5, 0.3, now + 1)).toBe(0);
  });
});

describeWithNativeDb("mailbox ingest", () => {
  function setup() {
    const db = createLegacyDb();
    KnowledgeGraphService.initialize(db, { scheduleCleanup: false });
    return db;
  }

  it("creates no organization or works_at edge for free-mail senders", async () => {
    const db = setup();
    await KnowledgeGraphService.ingestMailboxEvent(
      "ws",
      mailEvent({ payload: { senderEmail: "jane@gmail.com", senderName: "Jane Doe" } }),
    );
    expect(entitiesNamed(db, "ws", "person").map((e) => e.name)).toEqual(["Jane Doe"]);
    expect(entitiesNamed(db, "ws", "organization")).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM kg_edges").get()).toEqual({ n: 0 });
  });

  it("names the organization after the registrable domain and skips automated senders", async () => {
    const db = setup();
    await KnowledgeGraphService.ingestMailboxEvent(
      "ws",
      mailEvent({ payload: { senderEmail: "sam@mail.acme.co.uk", senderName: "Sam Lee" } }),
    );
    const [org] = entitiesNamed(db, "ws", "organization");
    expect(org.name).toBe("Acme");
    expect(JSON.parse(org.properties).domain).toBe("mail.acme.co.uk");
    expect(db.prepare("SELECT edge_type FROM kg_edges").all()).toEqual([{ edge_type: "works_at" }]);

    await KnowledgeGraphService.ingestMailboxEvent(
      "ws",
      mailEvent({
        id: "evt-2",
        fingerprint: "fp-2",
        payload: { senderEmail: "noreply@news.acme.co.uk", senderName: "Acme" },
      }),
    );
    expect(entitiesNamed(db, "ws", "person").map((e) => e.name)).toEqual(["Sam Lee"]);
    expect(entitiesNamed(db, "ws", "organization")).toHaveLength(1);
  });

  it("adds one observation per event, however often it is delivered", async () => {
    const db = setup();
    const event = mailEvent({ payload: { senderEmail: "sam@acme.com", senderName: "Sam" } });
    await KnowledgeGraphService.ingestMailboxEvent("ws", event);
    await KnowledgeGraphService.ingestMailboxEvent("ws", event);
    const count = () =>
      (db.prepare("SELECT COUNT(*) AS n FROM kg_observations").get() as { n: number }).n;
    expect(count()).toBe(2); // person + organization
    await KnowledgeGraphService.ingestMailboxEvent(
      "ws",
      mailEvent({
        id: "evt-2",
        fingerprint: "fp-2",
        subject: "Contract renewal",
        payload: { senderEmail: "sam@acme.com", senderName: "Sam" },
      }),
    );
    expect(count()).toBe(4);
  });
});

describeWithNativeDb("memory settings gate automatic writes", () => {
  const prompt = "Set up the API in `src/api/server.ts` using TypeScript";

  async function techCount(db: DB): Promise<number> {
    return entitiesNamed(db, "ws", "technology").length;
  }

  it("skips extraction and mailbox ingest when workspace memory is disabled", async () => {
    const db = createLegacyDb();
    KnowledgeGraphService.initialize(db, { scheduleCleanup: false });
    db.prepare("INSERT INTO memory_settings (workspace_id, enabled) VALUES ('ws', 0)").run();
    await KnowledgeGraphService.extractEntitiesFromTaskResult("ws", "t1", prompt, "Done.");
    await KnowledgeGraphService.ingestMailboxEvent(
      "ws",
      mailEvent({ payload: { senderEmail: "sam@acme.com", senderName: "Sam" } }),
    );
    expect(db.prepare("SELECT COUNT(*) AS n FROM kg_entities").get()).toEqual({ n: 0 });

    db.prepare("UPDATE memory_settings SET enabled = 1, privacy_mode = 'disabled'").run();
    await KnowledgeGraphService.extractEntitiesFromTaskResult("ws", "t1", prompt, "Done.");
    expect(await techCount(db)).toBe(0);

    // Explicit (agent) writes still work with memory off.
    await KnowledgeGraphService.createEntity("ws", { entityType: "technology", name: "Redis" });
    expect(await techCount(db)).toBe(1);

    db.prepare("UPDATE memory_settings SET privacy_mode = 'normal'").run();
    await KnowledgeGraphService.extractEntitiesFromTaskResult("ws", "t1", prompt, "Done.");
    expect(entitiesNamed(db, "ws", "technology").map((e) => e.name)).toEqual([
      "Redis",
      "TypeScript",
    ]);
  });

  it("honors <no-memory> in the task or the event", async () => {
    const db = createLegacyDb();
    KnowledgeGraphService.initialize(db, { scheduleCleanup: false });
    await KnowledgeGraphService.extractEntitiesFromTaskResult(
      "ws",
      "t1",
      `<no-memory> ${prompt}`,
      "Done.",
    );
    await KnowledgeGraphService.ingestMailboxEvent(
      "ws",
      mailEvent({
        summary: "<no-memory> private",
        payload: { senderEmail: "sam@acme.com", senderName: "Sam" },
      }),
    );
    expect(db.prepare("SELECT COUNT(*) AS n FROM kg_entities").get()).toEqual({ n: 0 });
  });

  it("blocks kg_* write tools in a <no-memory> task but not reads", async () => {
    const db = createLegacyDb();
    KnowledgeGraphService.initialize(db, { scheduleCleanup: false });
    const daemon = { getTask: () => ({ prompt: "<no-memory> map the stack" }) } as Any;
    const tools = new KnowledgeGraphTools({ id: "ws" } as Any, daemon, "task-1");
    const blocked = await tools.executeTool("kg_create_entity", {
      entity_type: "technology",
      name: "Redis",
    });
    expect(blocked.error).toMatch(/no-memory/);
    const search = await tools.executeTool("kg_search", { query: "Redis" });
    expect(search.error).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS n FROM kg_entities").get()).toEqual({ n: 0 });
  });

  it("extracts precisely from a real task summary", async () => {
    const db = createLegacyDb();
    KnowledgeGraphService.initialize(db, { scheduleCleanup: false });
    await KnowledgeGraphService.extractEntitiesFromTaskResult(
      "ws",
      "t1",
      "Go ahead and fix the login flow, then rest the old REST client",
      "Fixed it; the express route now works. Let's go!",
    );
    expect(entitiesNamed(db, "ws", "technology").map((e) => e.name)).toEqual(["REST"]);
  });
});

describeWithNativeDb("one-time cleanup", () => {
  function seedNoise(db: DB) {
    const ws = "ws";
    const ids = {
      goAuto: legacyEntity(db, ws, "technology", "go"),
      restAuto: legacyEntity(db, ws, "technology", "rest"),
      electronLower: legacyEntity(db, ws, "technology", "electron"),
      electron: legacyEntity(db, ws, "technology", "Electron"),
      typescript: legacyEntity(db, ws, "technology", "TypeScript"),
      expressProtected: legacyEntity(db, ws, "technology", "express"),
      reactManual: legacyEntity(db, ws, "technology", "React", { source: "manual" }),
      person: legacyEntity(db, ws, "person", "Jane", { properties: { source: "mailbox" } }),
      gmail: legacyEntity(db, ws, "organization", "Gmail", {
        properties: { source: "mailbox", domain: "gmail.com" },
      }),
      relay: legacyEntity(db, ws, "organization", "Privaterelay", {
        properties: { source: "mailbox", domain: "privaterelay.appleid.com" },
      }),
      gmailAgent: legacyEntity(db, "ws-2", "organization", "Gmail", { source: "agent" }),
      amazon: legacyEntity(db, ws, "organization", "Amazon", {
        properties: { source: "mailbox", domain: "amazon.com" },
      }),
      news: legacyEntity(db, ws, "organization", "News", {
        description: "Mailbox contact organization news",
        properties: { source: "mailbox", domain: "news.amazon.com" },
      }),
      accounts: legacyEntity(db, ws, "organization", "Accounts", {
        description: "Mailbox contact organization accounts",
        properties: { source: "mailbox", domain: "accounts.google.com" },
      }),
      acmeCo: legacyEntity(db, ws, "organization", "Acme Corp", {
        properties: { source: "mailbox", domain: "mail.acme.com" },
      }),
      noreply: legacyEntity(db, ws, "person", "Amazon.com", {
        description: "Email contact no-reply@amazon.com",
        properties: { source: "mailbox", email: "no-reply@amazon.com" },
      }),
      // Older rows without an email property: the address is read from the description.
      notifier: legacyEntity(db, ws, "person", "GitHub", {
        description: "Email contact notifications@github.com",
        properties: { source: "mailbox" },
      }),
      noreplyProtected: legacyEntity(db, ws, "person", "Shop bot", {
        properties: { source: "mailbox", email: "noreply@shop.example" },
      }),
      noreplyAgent: legacyEntity(db, ws, "person", "Alerts", {
        source: "agent",
        properties: { source: "mailbox", email: "alerts@ops.example" },
      }),
    };
    legacyEdge(db, ws, ids.noreply, ids.news, "works_at");
    legacyObservation(db, ids.noreply, "Mailbox event: order shipped");
    legacyObservation(db, ids.noreplyProtected, "Sends the weekly invoice", "agent");
    legacyObservation(db, ids.expressProtected, "Chosen for the webhook server", "agent");
    legacyEdge(db, ws, ids.person, ids.gmail, "works_at");
    legacyEdge(db, ws, ids.person, ids.news, "works_at");
    legacyObservation(db, ids.person, "Mailbox event: x · Hello");
    legacyObservation(db, ids.person, "Mailbox event: x ·  hello");
    legacyObservation(db, ids.news, "Newsletter");
    return ids;
  }

  it("removes noise, keeps manual and agent data, and runs once", async () => {
    const db = createLegacyDb();
    const ids = seedNoise(db);
    const port = createMemoryStatementPort(db);

    const result = await runKnowledgeGraphCleanup(port);
    expect(result).toEqual({
      ran: true,
      counts: {
        caseDuplicatesMerged: 1, // electron → Electron
        noisyTechnologiesDeleted: 2, // go, rest
        freeMailOrganizationsDeleted: 2,
        freeMailEdgesDeleted: 1,
        subdomainOrganizationsFixed: 2,
        automatedSendersDeleted: 2, // no-reply@amazon.com, notifications@github.com
        observationsDeduped: 1,
      },
    });
    // Automated senders: unprotected mailbox rows go with their edges and observations;
    // one an agent observed and one an agent created stay.
    expect(entitiesNamed(db, "ws", "person").map((e) => e.name)).toEqual([
      "Alerts",
      "Jane",
      "Shop bot",
    ]);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM kg_observations WHERE entity_id = ?").get(ids.noreply),
    ).toEqual({ n: 0 });

    expect(entitiesNamed(db, "ws", "technology").map((e) => e.name)).toEqual([
      "Electron",
      "React",
      "TypeScript",
      "express", // an agent observation protects it
    ]);
    const orgs = entitiesNamed(db, "ws", "organization");
    expect(orgs.map((e) => e.name)).toEqual(["Acme Corp", "Amazon", "Google"]);
    // "News" merged into Amazon: its works_at edge and observation moved there.
    const amazon = orgs.find((e) => e.name === "Amazon")!;
    expect(amazon.id).toBe(ids.amazon);
    expect(db.prepare("SELECT target_entity_id FROM kg_edges").all()).toEqual([
      { target_entity_id: ids.amazon },
    ]);
    expect(
      db.prepare("SELECT content FROM kg_observations WHERE entity_id = ?").all(ids.amazon),
    ).toEqual([{ content: "Newsletter" }]);
    expect(orgs.find((e) => e.name === "Google")!.description).toBe(
      "Mailbox contact organization google",
    );
    // An agent-created "Gmail" is never deleted.
    expect(entitiesNamed(db, "ws-2", "organization").map((e) => e.id)).toEqual([ids.gmailAgent]);
    expect(
      db.prepare("SELECT 1 FROM maintenance_state WHERE key = ?").get(KG_CLEANUP_MIGRATION_KEY),
    ).toBeTruthy();

    // Idempotent: the marker stops a second run, and re-running the phases changes nothing.
    expect(await runKnowledgeGraphCleanup(port)).toEqual({ ran: false, reason: "done" });
    db.prepare("DELETE FROM maintenance_state").run();
    const again = await runKnowledgeGraphCleanup(port);
    expect(again.ran && Object.values(again.counts).every((n) => n === 0)).toBe(true);
  });

  it("does not run while another process holds the claim", async () => {
    const db = createLegacyDb();
    seedNoise(db);
    const port = createMemoryStatementPort(db);
    db.exec(
      "CREATE TABLE maintenance_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)",
    );
    db.prepare("INSERT INTO maintenance_state VALUES (?, ?, 0)").run(
      `${KG_CLEANUP_MIGRATION_KEY}:claim`,
      JSON.stringify({ owner: "daemon:1:other", expiresAt: Date.now() + 60_000 }),
    );
    expect(await runKnowledgeGraphCleanup(port, { owner: "desktop:2:me" })).toEqual({
      ran: false,
      reason: "held",
    });
    expect(entitiesNamed(db, "ws", "technology").map((e) => e.name)).toContain("go");
  });
});
