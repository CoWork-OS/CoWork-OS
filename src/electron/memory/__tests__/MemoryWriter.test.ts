import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryItemsRepository } from "../MemoryItemsRepository";
import { MemoryWriter, type MemoryCandidate, type MemoryWorkspacePolicy } from "../MemoryWriter";
import { getHotMemoryVersion } from "../hot-memory-version";
import { REDACTED_SECRET } from "../sensitive-content";
import { createMemoryItemsTestDb, nativeSqliteAvailable, rowsOf } from "./memory-items-test-db";

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

describeWithSqlite("MemoryWriter", () => {
  let db: Database.Database;
  let writer: MemoryWriter;
  let clock: number;
  let policies: Record<string, MemoryWorkspacePolicy>;

  const candidate = (overrides: Partial<MemoryCandidate> = {}): MemoryCandidate => ({
    content: "Prefers TypeScript over JavaScript",
    kind: "preference",
    scope: "workspace",
    workspaceId: "ws-1",
    source: "curated",
    ...overrides,
  });

  beforeEach(async () => {
    db = await createMemoryItemsTestDb(["ws-1", "ws-2"]);
    clock = 1_000_000;
    policies = {};
    writer = new MemoryWriter({
      repository: new MemoryItemsRepository(db),
      now: () => (clock += 10),
      getWorkspacePolicy: async (workspaceId) => policies[workspaceId] ?? null,
    });
  });

  afterEach(() => {
    MemoryWriter.setInstance(null);
    db.close();
  });

  it("inserts an item with derived subject, trust and hash", async () => {
    const result = await writer.ingest(candidate({ sourceRef: { store: "curated", id: "c1" } }));
    expect(result).toMatchObject({ status: "written", action: "inserted" });
    if (result.status !== "written") throw new Error("not written");
    expect(result.item).toMatchObject({
      workspaceId: "ws-1",
      scope: "workspace",
      scopeRef: null,
      kind: "preference",
      source: "curated",
      trust: 0.85,
      status: "active",
      reinforcedCount: 0,
      sourceRef: { store: "curated", id: "c1" },
    });
    expect(result.item.subjectKey).toMatch(/^preference:[0-9a-f]{16}$/);
  });

  it("dedupes by content hash (case, spacing, trailing punctuation) and reinforces", async () => {
    await writer.ingest(candidate({ confidence: 0.6 }));
    const again = await writer.ingest(
      candidate({ content: "  prefers   typescript over javascript.  ", confidence: 0.9 }),
    );
    expect(again).toMatchObject({ status: "written", action: "reinforced" });
    const rows = rowsOf(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reinforced_count: 1, confidence: 0.9 });
  });

  it("keeps the same text in different scopes and workspaces apart", async () => {
    await writer.ingest(candidate());
    await writer.ingest(candidate({ workspaceId: "ws-2" }));
    await writer.ingest(candidate({ scope: "global", workspaceId: null }));
    expect(rowsOf(db)).toHaveLength(3);
  });

  it("supersedes a single-valued subject and links the new item to the old one", async () => {
    const first = await writer.ingest(
      candidate({ content: "Preferred name: Alice", kind: "identity", scope: "global" }),
    );
    const second = await writer.ingest(
      candidate({ content: "Preferred name: Alicia", kind: "identity", scope: "global" }),
    );
    if (first.status !== "written" || second.status !== "written") throw new Error("skipped");
    expect(first.item.subjectKey).toBe("preferred_name");
    expect(second).toMatchObject({ action: "superseded", supersededIds: [first.item.id] });
    expect(second.item.supersedesId).toBe(first.item.id);
    const statuses = rowsOf(db).map((row) => [row.content, row.status]);
    expect(statuses).toEqual([
      ["Preferred name: Alice", "superseded"],
      ["Preferred name: Alicia", "active"],
    ]);
  });

  it("never lets a lower-trust value supersede a higher-trust one", async () => {
    const stated = await writer.ingest(
      candidate({
        content: "Response style: short answers.",
        scope: "global",
        subjectKey: "response_style",
        source: "user_stated",
      }),
    );
    const inferred = await writer.ingest(
      candidate({
        content: "Response style: detailed answers.",
        scope: "global",
        subjectKey: "response_style",
        source: "inferred",
      }),
    );
    if (stated.status !== "written") throw new Error("skipped");
    expect(inferred).toEqual({ status: "skipped", reason: "outranked", holderId: stated.item.id });

    const restated = await writer.ingest(
      candidate({
        content: "Response style: detailed answers.",
        scope: "global",
        subjectKey: "response_style",
        source: "user_stated",
      }),
    );
    expect(restated).toMatchObject({ status: "written", action: "superseded" });
  });

  it("redacts secrets before storage and drops text that was only a secret", async () => {
    const result = await writer.ingest(
      candidate({
        content: "Deploy key is api_key=sk-abcdefghijklmnopqrstuvwxyz123456 for staging",
      }),
    );
    if (result.status !== "written") throw new Error("skipped");
    expect(result.redactions).toBeGreaterThan(0);
    expect(result.item.content).toContain(REDACTED_SECRET);
    expect(result.item.content).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
    expect(result.item.sourceRef.redactions).toBeGreaterThan(0);

    const secretOnly = await writer.ingest(
      candidate({ content: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" }),
    );
    expect(secretOnly).toEqual({ status: "skipped", reason: "secret_only" });
  });

  it("drops empty, tiny, symbol-only and raw telemetry text", async () => {
    for (const [content, reason] of [
      ["   ", "empty"],
      ["ok", "low_salience"],
      ["--- ### ---", "low_salience"],
      ["Tool called: read_file", "low_salience"],
      ['{"stepId":"s1","status":"done"}', "low_salience"],
    ] as const) {
      expect(await writer.ingest(candidate({ content }))).toEqual({ status: "skipped", reason });
    }
    expect(rowsOf(db)).toHaveLength(0);
  });

  it("truncates long text at a word boundary", async () => {
    const result = await writer.ingest(candidate({ content: "word ".repeat(400) }));
    if (result.status !== "written") throw new Error("skipped");
    expect(result.item.content.length).toBeLessThanOrEqual(1001);
    expect(result.item.content.endsWith("…")).toBe(true);
  });

  it("enforces scope shape and confines third-party text to contact or task scope", async () => {
    expect(await writer.ingest(candidate({ workspaceId: null }))).toEqual({
      status: "skipped",
      reason: "invalid_scope",
    });
    expect(await writer.ingest(candidate({ scope: "contact", scopeRef: null }))).toEqual({
      status: "skipped",
      reason: "invalid_scope",
    });
    expect(
      await writer.ingest(candidate({ scope: "global", workspaceId: null, source: "third_party" })),
    ).toEqual({ status: "skipped", reason: "third_party_scope" });

    const contact = await writer.ingest(
      candidate({
        scope: "contact",
        workspaceId: null,
        scopeRef: "contact-1",
        source: "third_party",
      }),
    );
    if (contact.status !== "written") throw new Error("skipped");
    expect(contact.item).toMatchObject({
      scope: "contact",
      scopeRef: "contact-1",
      privacy: "private",
    });
  });

  it("honours <no-memory> in the originating text", async () => {
    expect(
      await writer.ingest(candidate({ originText: "remember this <no-memory> please" })),
    ).toEqual({ status: "skipped", reason: "no_memory" });
    expect(await writer.ingest(candidate({ noMemory: true }))).toEqual({
      status: "skipped",
      reason: "no_memory",
    });
  });

  it("applies workspace memory settings: off blocks inferred writes, strict makes items private", async () => {
    policies["ws-1"] = { enabled: false };
    expect(await writer.ingest(candidate({ source: "inferred" }))).toEqual({
      status: "skipped",
      reason: "memory_disabled",
    });
    // An explicit act (curation, a user statement) is still recorded.
    expect(await writer.ingest(candidate({ source: "curated" }))).toMatchObject({
      status: "written",
    });
    // A global fact learned in a workspace follows that workspace's settings.
    expect(
      await writer.ingest(
        candidate({
          scope: "global",
          workspaceId: null,
          originWorkspaceId: "ws-1",
          source: "inferred",
        }),
      ),
    ).toEqual({ status: "skipped", reason: "memory_disabled" });

    policies["ws-2"] = { enabled: true, privacyMode: "strict" };
    const strict = await writer.ingest(candidate({ workspaceId: "ws-2", source: "inferred" }));
    if (strict.status !== "written") throw new Error("skipped");
    expect(strict.item.privacy).toBe("private");
  });

  it("treats a changed record with the same source ref as an edit that supersedes it", async () => {
    const ref = { store: "user_profile", id: "fact-1" };
    const first = await writer.ingest(candidate({ sourceRef: ref, pinned: true }));
    const same = await writer.ingest(candidate({ sourceRef: ref, pinned: false, confidence: 0.4 }));
    expect(same).toMatchObject({ status: "written", action: "updated" });
    expect(rowsOf(db)[0]).toMatchObject({ reinforced_count: 0, pinned: 0, confidence: 0.4 });

    const edited = await writer.ingest(candidate({ sourceRef: ref, content: "Prefers Rust" }));
    if (first.status !== "written" || edited.status !== "written") throw new Error("skipped");
    expect(edited).toMatchObject({ action: "superseded", supersededIds: [first.item.id] });
    expect(rowsOf(db, "status = 'active'").map((row) => row.content)).toEqual(["Prefers Rust"]);
  });

  it("is idempotent in migration mode by source ref", async () => {
    const ref = { store: "curated", id: "c-9" };
    const first = await writer.ingest(
      candidate({ sourceRef: ref, mode: "migration", createdAt: 5 }),
    );
    if (first.status !== "written") throw new Error("skipped");
    expect(first.item.createdAt).toBe(5);
    expect(await writer.ingest(candidate({ sourceRef: ref, mode: "migration" }))).toEqual({
      status: "skipped",
      reason: "already_migrated",
      holderId: first.item.id,
    });
    expect(rowsOf(db)).toHaveLength(1);
  });

  it("adopts a named subject for content first stored under a derived key", async () => {
    await writer.ingest(
      candidate({ content: "Prefers concise responses.", scope: "global", source: "inferred" }),
    );
    const detailed = await writer.ingest(
      candidate({
        content: "Prefers detailed explanations when needed.",
        scope: "global",
        source: "inferred",
        subjectKey: "response_length",
      }),
    );
    const concise = await writer.ingest(
      candidate({
        content: "Prefers concise responses.",
        scope: "global",
        source: "inferred",
        subjectKey: "response_length",
      }),
    );
    if (detailed.status !== "written") throw new Error("skipped");
    expect(concise).toMatchObject({
      status: "written",
      action: "reinforced",
      supersededIds: [detailed.item.id],
    });
    const active = rowsOf(db, "status = 'active'");
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({
      subject_key: "response_length",
      content: "Prefers concise responses.",
    });
  });

  it("records closed items as archived without blocking a new active copy", async () => {
    await writer.ingest(
      candidate({ content: "Send the report", kind: "commitment", status: "archived" }),
    );
    const active = await writer.ingest(
      candidate({ content: "Send the report", kind: "commitment" }),
    );
    expect(active).toMatchObject({ status: "written", action: "inserted" });
    expect(rowsOf(db).map((row) => row.status)).toEqual(["archived", "active"]);
  });

  it("forgets by source ref: content scrubbed, every revision, out of full-text search", async () => {
    const ref = { store: "relationship", id: "r-1" };
    await writer.ingest(candidate({ content: "Likes hiking trips", sourceRef: ref }));
    await writer.ingest(candidate({ content: "Likes mountain hiking", sourceRef: ref }));
    const changed = await writer.setStatusBySourceRef("relationship", "r-1", "deleted");
    expect(changed).toHaveLength(2);
    for (const row of rowsOf(db)) {
      expect(row).toMatchObject({ status: "deleted", content: "", pinned: 0 });
      expect(String(row.content_hash)).toMatch(/^deleted:/);
    }
    const hits = db
      .prepare("SELECT COUNT(*) AS n FROM memory_items_fts WHERE memory_items_fts MATCH 'hiking'")
      .get() as { n: number };
    expect(hits.n).toBe(0);
  });

  it("bumps the hot-memory version and notifies listeners on every change", async () => {
    const listener = vi.fn();
    const unsubscribe = MemoryWriter.onChange(listener);
    const before = getHotMemoryVersion();
    await writer.ingest(candidate());
    expect(getHotMemoryVersion()).toBeGreaterThan(before);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "written", workspaceId: "ws-1", scope: "workspace" }),
    );
    const skippedBefore = getHotMemoryVersion();
    await writer.ingest(candidate({ content: "" }));
    expect(getHotMemoryVersion()).toBe(skippedBefore);
    unsubscribe();
  });

  it("serializes fire-and-forget dual writes in call order", async () => {
    MemoryWriter.setInstance(writer);
    const ref = { store: "user_profile", id: "fact-2" };
    MemoryWriter.dualWrite(candidate({ sourceRef: ref, content: "Prefers tea" }), "test");
    MemoryWriter.dualWrite(candidate({ sourceRef: ref, content: "Prefers coffee" }), "test");
    MemoryWriter.dualWriteStatus("user_profile", "fact-2", "deleted", "test");
    await writer.flush();
    expect(rowsOf(db).map((row) => row.status)).toEqual(["deleted", "deleted"]);
  });

  it("is a no-op for dual writes before initialization", () => {
    MemoryWriter.setInstance(null);
    expect(() => MemoryWriter.dualWrite(candidate(), "test")).not.toThrow();
    expect(rowsOf(db)).toHaveLength(0);
  });
});
