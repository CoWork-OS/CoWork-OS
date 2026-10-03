import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AwarenessBelief, UserFact } from "../../../shared/types";
import { MemoryItemsRepository } from "../MemoryItemsRepository";
import { runMemoryItemsLaneMigration, type LegacyLaneSources } from "../MemoryItemsLaneMigration";
import { MemoryWriter } from "../MemoryWriter";
import { MEMORY_ITEMS_LANE_MIGRATION_KEY } from "../memory-items-sql";
import type { RelationshipMemoryItem } from "../RelationshipMemoryService";
import { createMemoryItemsTestDb, nativeSqliteAvailable, rowsOf } from "./memory-items-test-db";

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

const fact = (overrides: Partial<UserFact>): UserFact => ({
  id: "fact",
  category: "preference",
  value: "Prefers dark mode",
  confidence: 0.8,
  source: "manual",
  firstSeenAt: 100,
  lastUpdatedAt: 100,
  ...overrides,
});

const relationship = (overrides: Partial<RelationshipMemoryItem>): RelationshipMemoryItem => ({
  id: "rel",
  layer: "preferences",
  text: "Likes morning meetings",
  confidence: 0.7,
  source: "conversation",
  createdAt: 100,
  updatedAt: 100,
  ...overrides,
});

const belief = (overrides: Partial<AwarenessBelief>): AwarenessBelief => ({
  id: "belief",
  beliefType: "user_preference",
  subject: "response_length",
  value: "Prefers concise responses.",
  confidence: 0.88,
  evidenceRefs: [],
  source: "conversation",
  promotionStatus: "promoted",
  createdAt: 100,
  updatedAt: 100,
  ...overrides,
});

describeWithSqlite("memory items lane migration", () => {
  let db: Database.Database;
  let writer: MemoryWriter;
  let sources: LegacyLaneSources;

  beforeEach(async () => {
    db = await createMemoryItemsTestDb(["ws-1"]);
    writer = new MemoryWriter({ repository: new MemoryItemsRepository(db) });
    const insertCurated = db.prepare(
      `INSERT INTO curated_memory_entries (id, workspace_id, task_id, target, kind, content,
         normalized_key, source, confidence, status, created_at, updated_at)
       VALUES (?, 'ws-1', NULL, ?, ?, ?, ?, ?, 0.85, ?, ?, ?)`,
    );
    insertCurated.run(
      "c-user",
      "user",
      "preference",
      "Prefers pnpm",
      "k1",
      "agent_tool",
      "active",
      10,
      10,
    );
    insertCurated.run(
      "c-rule",
      "workspace",
      "workflow_rule",
      "Run lint before commits",
      "k2",
      "user_edit",
      "active",
      11,
      11,
    );
    insertCurated.run(
      "c-distill",
      "workspace",
      "project_fact",
      "Uses SQLite in a worker",
      "k3",
      "distill",
      "active",
      12,
      12,
    );
    insertCurated.run(
      "c-gone",
      "workspace",
      "project_fact",
      "Removed fact",
      "k4",
      "agent_tool",
      "archived",
      13,
      13,
    );

    sources = {
      userProfileFacts: () => [
        fact({
          id: "f-name",
          category: "identity",
          value: "Preferred name: Sam",
          source: "conversation",
          lastUpdatedAt: 50,
        }),
        fact({
          id: "f-pin",
          value: "Prefers dark mode",
          pinned: true,
          source: "manual",
          lastUpdatedAt: 60,
        }),
        fact({
          id: "f-junk",
          category: "identity",
          value: "Preferred name: going to",
          lastUpdatedAt: 70,
        }),
        fact({
          id: "f-concise",
          value: "Prefers concise responses.",
          source: "conversation",
          lastUpdatedAt: 80,
        }),
      ],
      relationshipItems: () => [
        relationship({ id: "r-pref" }),
        relationship({
          id: "r-history",
          layer: "history",
          text: "Completed task: x",
          source: "task",
        }),
        relationship({
          id: "r-mail",
          layer: "commitments",
          text: "Send the signed contract",
          source: "mailbox",
          status: "open",
          contactIdentityId: "contact-7",
          dueAt: 999,
        }),
        relationship({ id: "r-done", layer: "commitments", text: "Book flights", status: "done" }),
      ],
      awarenessBeliefs: () => [
        belief({
          id: "b-new",
          value: "Prefers detailed explanations when needed.",
          updatedAt: 300,
        }),
        belief({ id: "b-old", value: "Prefers concise responses.", updatedAt: 200 }),
        belief({
          id: "b-device",
          beliefType: "device_context",
          subject: "app",
          value: "Uses VS Code",
        }),
      ],
      adaptiveResponseStyle: () => ({
        style: {
          responseLength: "terse",
          explanationDepth: "expert",
          emojiUsage: "none",
          codeCommentStyle: "minimal",
        },
        reason: "feedback: user prefers shorter responses",
      }),
      userName: () => "Samuel",
    };
  });

  afterEach(() => db.close());

  it("copies every lane once, maps kinds, scopes and provenance, and records the marker", async () => {
    const result = await runMemoryItemsLaneMigration(writer, sources);
    expect(result.ran).toBe(true);

    const active = rowsOf(db, "status = 'active'");
    const byRef = (store: string, id: string) =>
      rowsOf(db).find((row) => {
        const ref = JSON.parse(String(row.source_ref));
        return ref.store === store && ref.id === id;
      });

    // Curated: workspace scope, curated (distill → inferred), user lane pinned, archived skipped.
    expect(byRef("curated", "c-user")).toMatchObject({
      kind: "preference",
      source: "curated",
      pinned: 1,
      scope: "workspace",
      workspace_id: "ws-1",
      created_at: 10,
    });
    expect(byRef("curated", "c-rule")).toMatchObject({ kind: "rule", pinned: 0 });
    expect(byRef("curated", "c-distill")).toMatchObject({
      kind: "project_fact",
      source: "inferred",
    });
    expect(byRef("curated", "c-gone")).toBeUndefined();

    // Profile: global; junk identity dropped; manual → user_stated with pin.
    expect(byRef("user_profile", "f-pin")).toMatchObject({
      scope: "global",
      source: "user_stated",
      pinned: 1,
    });
    expect(byRef("user_profile", "f-junk")).toBeUndefined();

    // Relationship: history skipped, mailbox → contact scope, third_party, private; done → archived.
    expect(byRef("relationship", "r-history")).toBeUndefined();
    expect(byRef("relationship", "r-mail")).toMatchObject({
      scope: "contact",
      scope_ref: "contact-7",
      source: "third_party",
      privacy: "private",
      workspace_id: null,
    });
    expect(byRef("relationship", "r-done")).toMatchObject({
      status: "archived",
      kind: "commitment",
    });

    // Awareness: contradiction resolved by recency on the response_length subject.
    const length = active.filter((row) => row.subject_key === "response_length");
    expect(length).toHaveLength(1);
    expect(length[0].content).toBe("Prefers detailed explanations when needed.");
    expect(rowsOf(db, "content = 'Uses VS Code'")).toHaveLength(0);

    // Adaptive style: one response_style subject.
    const style = active.filter((row) => row.subject_key === "response_style");
    expect(style).toHaveLength(1);
    expect(style[0]).toMatchObject({ source: "inferred", kind: "preference" });

    // The confirmed stored name outranks the inferred profile name.
    const names = active.filter((row) => row.subject_key === "preferred_name");
    expect(names.map((row) => [row.content, row.source])).toEqual([
      ["Preferred name: Samuel", "user_confirmed"],
    ]);

    expect(result.lanes.curated).toMatchObject({ read: 3, written: 3, failed: 0 });
    expect(result.lanes.relationship).toMatchObject({ read: 4, written: 3, skipped: 1 });
    const marker = db
      .prepare("SELECT value FROM maintenance_state WHERE key = ?")
      .get(MEMORY_ITEMS_LANE_MIGRATION_KEY) as { value: string } | undefined;
    expect(marker).toBeDefined();
  });

  it("does nothing once the marker exists, and a forced re-run adds no duplicates", async () => {
    await runMemoryItemsLaneMigration(writer, sources);
    const count = rowsOf(db).length;
    expect((await runMemoryItemsLaneMigration(writer, sources)).ran).toBe(false);

    db.prepare("DELETE FROM maintenance_state WHERE key = ?").run(MEMORY_ITEMS_LANE_MIGRATION_KEY);
    const rerun = await runMemoryItemsLaneMigration(writer, sources);
    expect(rerun.ran).toBe(true);
    expect(rowsOf(db)).toHaveLength(count);
    expect(rerun.lanes.curated.written).toBe(0);
  });

  it("does not record completion when a lane cannot be read, so the run is retried", async () => {
    sources.userProfileFacts = () => {
      throw new Error("Settings user-profile could not be read (decryption_failed)");
    };
    const result = await runMemoryItemsLaneMigration(writer, sources);
    expect(result.lanes.userProfile.failed).toBe(1);
    expect(await new MemoryItemsRepository(db).isLaneMigrationComplete()).toBe(false);
    // The other lanes were still copied.
    expect(rowsOf(db, "json_extract(source_ref, '$.store') = 'curated'")).toHaveLength(3);
  });
});
