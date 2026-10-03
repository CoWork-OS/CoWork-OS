import { createRequire } from "module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DurableContextService } from "../DurableContextService";
import { MemoryFeaturesManager } from "../../settings/memory-features-manager";

const databases: Array<import("better-sqlite3").Database> = [];

const require = createRequire(import.meta.url);
const BetterSqlite3Module = (() => {
  try {
    return require("better-sqlite3") as typeof import("better-sqlite3");
  } catch {
    return null;
  }
})();

const BetterSqlite3 = (() => {
  if (!BetterSqlite3Module) return null;
  try {
    const probe = new BetterSqlite3Module(":memory:");
    probe.close();
    return BetterSqlite3Module;
  } catch {
    return null;
  }
})();

const describeWithNativeDb = BetterSqlite3 ? describe : describe.skip;

function enableDurableContext(): void {
  vi.spyOn(MemoryFeaturesManager, "loadSettings").mockReturnValue({
    durableContextEnabled: true,
    durableContextMode: "experimental",
    durableContextLargePayloadThreshold: 20,
  });
}

function disableDurableContext(): void {
  vi.spyOn(MemoryFeaturesManager, "loadSettings").mockReturnValue({
    durableContextEnabled: false,
    durableContextMode: "off",
  });
}

function createDb(): import("better-sqlite3").Database {
  if (!BetterSqlite3) throw new Error("better-sqlite3 unavailable");
  const db = new BetterSqlite3(":memory:");
  databases.push(db);
  DurableContextService.setDatabaseForTests(db);
  return db;
}

afterEach(() => {
  DurableContextService.setDatabaseForTests(null);
  for (const db of databases.splice(0)) {
    db.close();
  }
  vi.restoreAllMocks();
});

describeWithNativeDb("DurableContextService", () => {
  it("records searchable task messages without re-indexing injected memory blocks", async () => {
    enableDurableContext();
    createDb();

    await DurableContextService.recordHistory({
      workspaceId: "ws-1",
      taskId: "task-1",
      source: "test",
      messages: [
        { role: "user", content: "Remember the alpha migration constraint." },
        {
          role: "assistant",
          content: "<cowork_recall_hints>\nUse search_memories.\n</cowork_recall_hints>",
        },
        { role: "assistant", content: "We chose the beta rollout path." },
      ],
    });

    const hits = await DurableContextService.search({
      workspaceId: "ws-1",
      taskId: "task-1",
      query: "alpha migration",
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.kind).toBe("message");
    expect(hits[0]?.snippet).toContain("alpha migration constraint");

    const injectedHits = await DurableContextService.search({
      workspaceId: "ws-1",
      taskId: "task-1",
      query: "cowork_recall_hints",
    });
    expect(injectedHits).toHaveLength(0);
  });

  it("does not re-index durable context tool result payloads", async () => {
    enableDurableContext();
    createDb();

    await DurableContextService.recordHistory({
      workspaceId: "ws-1",
      taskId: "task-1",
      source: "test",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call-context-grep",
              content: JSON.stringify({
                results: [
                  {
                    id: "dcm_existing",
                    kind: "message",
                    taskId: "task-1",
                    snippet: "Project codename: Lantern Harbor",
                  },
                  // context_recall mixes in conversation-index events (dce_).
                  {
                    id: "dce_17",
                    kind: "message",
                    role: "user",
                    snippet: "Lantern Harbor is the codename",
                  },
                ],
                totalFound: 2,
              }),
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call-shell",
              content: "shell output mentions Lantern Harbor as a file name",
            },
          ],
        },
      ],
    });

    const hits = await DurableContextService.search({
      workspaceId: "ws-1",
      taskId: "task-1",
      query: "Lantern Harbor",
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.snippet).toContain("shell output");
    expect(hits[0]?.snippet).not.toContain("dcm_existing");
  });

  it("prefers direct facts over execution wrapper messages", async () => {
    enableDurableContext();
    createDb();

    await DurableContextService.recordHistory({
      workspaceId: "ws-1",
      taskId: "task-1",
      source: "test",
      messages: [
        { role: "user", content: "Execute this step: Lantern Harbor" },
        { role: "assistant", content: "Lantern Harbor" },
      ],
    });

    const hits = await DurableContextService.search({
      workspaceId: "ws-1",
      taskId: "task-1",
      query: "Lantern Harbor",
    });
    expect(hits[0]?.snippet).toBe("assistant: Lantern Harbor");
  });

  it("keeps durable searches scoped to the requested task", async () => {
    enableDurableContext();
    createDb();

    await DurableContextService.recordHistory({
      workspaceId: "ws-1",
      taskId: "task-source",
      source: "test",
      messages: [{ role: "user", content: "The rollback phrase is blue anchor." }],
    });
    await DurableContextService.recordHistory({
      workspaceId: "ws-1",
      taskId: "task-other",
      source: "test",
      messages: [{ role: "user", content: "This task has no rollback phrase." }],
    });

    expect(
      await DurableContextService.search({
        workspaceId: "ws-1",
        taskId: "task-other",
        query: "blue anchor",
      }),
    ).toEqual([]);
    expect(
      await DurableContextService.search({
        workspaceId: "ws-1",
        taskId: "task-source",
        query: "blue anchor",
      }),
    ).toHaveLength(1);
  });

  it("stores compaction summaries linked back to source messages", async () => {
    enableDurableContext();
    createDb();

    const summaryId = await DurableContextService.recordCompactionSummary({
      workspaceId: "ws-1",
      taskId: "task-1",
      removedMessages: [
        { role: "user", content: "We investigated old workspace search behavior." },
        { role: "assistant", content: "The key tradeoff was retrieval precision." },
      ],
      summaryBlock:
        "<cowork_compaction_summary>\nSummary-only marker: build a source-linked tree index.\n</cowork_compaction_summary>",
      contextLabel: "test compaction",
    });

    expect(summaryId).toMatch(/^dcs_/);
    const hits = await DurableContextService.search({
      workspaceId: "ws-1",
      taskId: "task-1",
      query: "source-linked tree",
    });
    expect(hits[0]?.id).toBe(summaryId);
    expect(hits[0]?.kind).toBe("summary");
    expect(hits[0]?.sourceMessageCount).toBe(2);

    const described = await DurableContextService.describe({
      workspaceId: "ws-1",
      taskId: "task-1",
      id: summaryId || "",
    });
    expect(described?.kind).toBe("summary");
    expect(described?.text).toContain("source-linked tree index");
    expect(described?.text).not.toContain("cowork_compaction_summary");
    expect(described?.sourceMessages).toHaveLength(2);
    expect(described?.sourceMessages?.[0]?.text).toContain("old workspace search");
  });

  it("does not read or write durable context while disabled", async () => {
    disableDurableContext();
    createDb();

    await DurableContextService.recordHistory({
      workspaceId: "ws-1",
      taskId: "task-1",
      source: "test",
      messages: [{ role: "user", content: "Do not persist this disabled message." }],
    });

    expect(
      await DurableContextService.search({
        workspaceId: "ws-1",
        taskId: "task-1",
        query: "disabled message",
      }),
    ).toEqual([]);
  });

  it("stores large messages by reference while keeping a retrievable preview", async () => {
    enableDurableContext();
    createDb();

    const longText = Array.from({ length: 120 }, (_, index) => `payload-${index}`).join(" ");
    await DurableContextService.recordHistory({
      workspaceId: "ws-1",
      taskId: "task-1",
      source: "test",
      messages: [{ role: "assistant", content: longText }],
    });

    const hits = await DurableContextService.search({
      workspaceId: "ws-1",
      taskId: "task-1",
      query: "payload-1",
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.snippet).toContain("large_payload_ref");

    const described = await DurableContextService.describe({
      workspaceId: "ws-1",
      taskId: "task-1",
      id: hits[0]?.id || "",
    });
    expect(described?.largePayload?.id).toMatch(/^dcp_/);
    expect(described?.largePayload?.preview).toContain("payload-119");
  });

  it("links overlapping summaries into a parent DAG", async () => {
    enableDurableContext();
    const db = createDb();

    const firstSummary = await DurableContextService.recordCompactionSummary({
      workspaceId: "ws-1",
      taskId: "task-1",
      removedMessages: [
        { role: "user", content: "alpha decision one" },
        { role: "assistant", content: "alpha decision two" },
      ],
      summaryBlock: "Alpha summary",
    });
    const secondSummary = await DurableContextService.recordCompactionSummary({
      workspaceId: "ws-1",
      taskId: "task-1",
      removedMessages: [
        { role: "user", content: "alpha decision one" },
        { role: "assistant", content: "alpha decision two" },
        { role: "user", content: "alpha decision three" },
      ],
      summaryBlock: "Rolled up alpha summary",
    });

    const parent = db
      .prepare(
        `SELECT parent_summary_id
         FROM durable_context_summary_parents
         WHERE summary_id = ?`,
      )
      .get(secondSummary) as { parent_summary_id?: string } | undefined;
    expect(parent?.parent_summary_id).toBe(firstSummary);
    const described = await DurableContextService.describe({
      workspaceId: "ws-1",
      taskId: "task-1",
      id: secondSummary || "",
    });
    expect(described?.depth).toBe(1);
  });

  it("clears durable context for a workspace", async () => {
    enableDurableContext();
    createDb();

    await DurableContextService.recordHistory({
      workspaceId: "ws-1",
      taskId: "task-1",
      source: "test",
      messages: [{ role: "user", content: "erase this durable context" }],
    });

    expect(await DurableContextService.clearWorkspace("ws-1")).toBeGreaterThan(0);
    expect(
      await DurableContextService.search({
        workspaceId: "ws-1",
        taskId: "task-1",
        query: "erase this",
      }),
    ).toEqual([]);
  });

  it("records a growing history incrementally and indexes each message once", async () => {
    enableDurableContext();
    const db = createDb();
    const history: Array<{ role: "user" | "assistant"; content: string }> = [];
    const ftsRows = () =>
      (db.prepare(`SELECT COUNT(*) AS n FROM durable_context_fts`).get() as { n: number }).n;

    for (let turn = 1; turn <= 6; turn += 1) {
      history.push({ role: turn % 2 ? "user" : "assistant", content: `turn ${turn} note` });
      await DurableContextService.recordHistory({
        workspaceId: "ws-inc",
        taskId: "task-inc",
        source: "runtime_history",
        messages: [...history],
      });
    }

    const rows = db
      .prepare(`SELECT seq, content_text FROM durable_context_messages ORDER BY seq`)
      .all() as Array<{ seq: number; content_text: string }>;
    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(ftsRows()).toBe(6);

    const spy = vi.spyOn(db, "prepare");
    await DurableContextService.recordHistory({
      workspaceId: "ws-inc",
      taskId: "task-inc",
      source: "runtime_history",
      messages: [...history],
    });
    // Nothing new: the unchanged history is not sent to the store at all.
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();

    // A rewritten history (compaction) is sent whole but duplicates stay single.
    await DurableContextService.recordHistory({
      workspaceId: "ws-inc",
      taskId: "task-inc",
      source: "runtime_history",
      messages: [{ role: "user", content: "summary of earlier turns" }, ...history.slice(-2)],
    });
    expect(ftsRows()).toBe(7);
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM durable_context_messages`).get() as { n: number }).n,
    ).toBe(7);
  });

  it("caps the stored body of very large payloads", async () => {
    enableDurableContext();
    const db = createDb();
    await DurableContextService.recordHistory({
      workspaceId: "ws-big",
      taskId: "task-big",
      source: "test",
      messages: [{ role: "assistant", content: `start ${"x ".repeat(400_000)}` }],
    });
    const payload = db
      .prepare(
        `SELECT byte_length, length(content_text) AS stored FROM durable_context_large_payloads`,
      )
      .get() as { byte_length: number; stored: number };
    expect(payload.byte_length).toBeGreaterThan(700_000);
    expect(payload.stored).toBeLessThan(300_000);
  });

  it("searches with uppercase operators, file names and accents through FTS", async () => {
    enableDurableContext();
    const db = createDb();

    await DurableContextService.recordHistory({
      workspaceId: "ws-1",
      taskId: "task-1",
      source: "test",
      messages: [
        { role: "user", content: "Compare cats AND dogs in executor.ts" },
        { role: "assistant", content: "Die Größe passt; 100% done_now" },
      ],
    });
    // Without FTS the LIKE fallback would run; drop it to prove FTS answers.
    const like = vi.spyOn(db, "prepare");

    const operators = await DurableContextService.search({
      workspaceId: "ws-1",
      query: "cats AND dogs",
    });
    expect(operators.map((hit) => hit.snippet)).toEqual([
      "user: Compare cats AND dogs in executor.ts",
    ]);
    const files = await DurableContextService.search({ workspaceId: "ws-1", query: "executor.ts" });
    expect(files).toHaveLength(1);
    const accents = await DurableContextService.search({ workspaceId: "ws-1", query: "größe" });
    expect(accents).toHaveLength(1);
    expect(like.mock.calls.some(([sql]) => String(sql).includes("content_text LIKE"))).toBe(false);

    // The LIKE fallback matches `%` and `_` literally.
    const percent = await DurableContextService.search({ workspaceId: "ws-1", query: "0% d" });
    expect(percent).toHaveLength(1);
    const underscore = await DurableContextService.search({ workspaceId: "ws-1", query: "e_n" });
    expect(underscore).toHaveLength(1);
    const literal = await DurableContextService.search({ workspaceId: "ws-1", query: "s_d%" });
    expect(literal).toEqual([]);
  });
});
