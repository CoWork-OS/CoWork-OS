import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryItemsRepository } from "../MemoryItemsRepository";
import { MemoryWriter } from "../MemoryWriter";
import { RelationshipMemoryService } from "../RelationshipMemoryService";
import { UserProfileService } from "../UserProfileService";
import { responseStyleCandidate } from "../memory-items-lanes";
import { createMemoryItemsTestDb, nativeSqliteAvailable, rowsOf } from "./memory-items-test-db";

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

/**
 * The legacy stores stay the system of record this wave; every write path also lands in
 * memory_items through MemoryWriter (secure settings are not initialized here, so the
 * legacy services keep their state in memory).
 */
describeWithSqlite("memory items dual writes", () => {
  let db: Database.Database;
  let writer: MemoryWriter;

  beforeEach(async () => {
    db = await createMemoryItemsTestDb(["ws-1"]);
    writer = new MemoryWriter({ repository: new MemoryItemsRepository(db) });
    MemoryWriter.setInstance(writer);
    (UserProfileService as unknown as Record<string, unknown>).inMemoryProfile = {
      facts: [],
      updatedAt: 0,
    };
    (RelationshipMemoryService as unknown as Record<string, unknown>).inMemoryProfile = {
      items: [],
      updatedAt: 0,
    };
  });

  afterEach(() => {
    MemoryWriter.setInstance(null);
    db.close();
  });

  it("mirrors profile fact add, update and delete", async () => {
    const fact = UserProfileService.addFact({
      category: "preference",
      value: "Prefers vim keybindings",
      source: "manual",
      pinned: true,
    });
    await writer.flush();
    expect(rowsOf(db)).toMatchObject([
      { content: "Prefers vim keybindings", scope: "global", source: "user_stated", pinned: 1 },
    ]);

    UserProfileService.updateFact({ id: fact.id, value: "Prefers emacs keybindings" });
    await writer.flush();
    expect(rowsOf(db).map((row) => [row.content, row.status])).toEqual([
      ["Prefers vim keybindings", "superseded"],
      ["Prefers emacs keybindings", "active"],
    ]);

    UserProfileService.deleteFact(fact.id);
    await writer.flush();
    expect(rowsOf(db).every((row) => row.status === "deleted" && row.content === "")).toBe(true);
  });

  it("lets a newer belief-derived fact supersede the older one on its subject", async () => {
    UserProfileService.addFact(
      { category: "preference", value: "Prefers concise responses.", source: "conversation" },
      { memorySubjectKey: "response_length" },
    );
    UserProfileService.addFact(
      {
        category: "preference",
        value: "Prefers detailed explanations when needed.",
        source: "conversation",
      },
      { memorySubjectKey: "response_length" },
    );
    await writer.flush();
    const active = rowsOf(db, "status = 'active' AND subject_key = 'response_length'");
    expect(active.map((row) => row.content)).toEqual([
      "Prefers detailed explanations when needed.",
    ]);
    // The legacy profile still holds both (reads are unchanged this wave).
    expect(UserProfileService.getProfile().facts).toHaveLength(2);
  });

  it("drops a profile identity that is not a plausible name", async () => {
    UserProfileService.addFact({
      category: "identity",
      value: "Preferred name: going to the store",
      source: "conversation",
    });
    await writer.flush();
    expect(rowsOf(db)).toHaveLength(0);
  });

  it("mirrors relationship items: mailbox to contact scope, done commitments archived, no history", async () => {
    RelationshipMemoryService.rememberMailboxInsights({
      commitments: [{ text: "Send the signed contract", dueAt: 123 }],
      contactIdentityId: "contact-1",
    });
    RelationshipMemoryService.recordTaskCompletion("Weekly report", "Shipped the report");
    await writer.flush();
    expect(rowsOf(db)).toMatchObject([
      {
        content: "Send the signed contract",
        scope: "contact",
        scope_ref: "contact-1",
        source: "third_party",
        privacy: "private",
        kind: "commitment",
      },
    ]);

    const [item] = RelationshipMemoryService.listItems();
    RelationshipMemoryService.updateItem(item.id, { status: "done" });
    await writer.flush();
    expect(rowsOf(db).map((row) => row.status)).toEqual(["archived"]);

    RelationshipMemoryService.deleteItem(item.id);
    await writer.flush();
    expect(rowsOf(db).map((row) => row.status)).toEqual(["deleted"]);
  });

  it("keeps a user-stated response style over inferred adaptations", async () => {
    const stated = responseStyleCandidate(
      { responseLength: "terse" },
      { source: "user_stated", store: "personality" },
    );
    const inferred = responseStyleCandidate(
      { responseLength: "detailed" },
      { source: "inferred", store: "adaptive_style" },
    );
    MemoryWriter.dualWrite(stated, "test");
    MemoryWriter.dualWrite(inferred, "test");
    await writer.flush();
    const active = rowsOf(db, "status = 'active' AND subject_key = 'response_style'");
    expect(active.map((row) => [row.content, row.source])).toEqual([
      ["Response style: short answers.", "user_stated"],
    ]);
  });
});
