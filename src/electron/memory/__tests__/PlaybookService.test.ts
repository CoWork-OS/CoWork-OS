import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Synthetic memory settings gate over a real SQLite profile; no MemoryService.
const memoryState = vi.hoisted(() => ({
  db: null as import("better-sqlite3").Database | null,
  enabled: true,
  strict: false,
}));

vi.mock("../MemoryService", () => ({
  MemoryService: {
    getDatabase: () => memoryState.db,
    capture: vi.fn(async () => {
      throw new Error("Playbook outcomes must not be written to the memory archive");
    }),
    // Same gates and inline privacy redaction as MemoryService.prepareDerivedRecord.
    prepareDerivedRecord: vi.fn(async (_workspaceId: string, content: string) => {
      if (!memoryState.enabled) return null;
      let hadPrivateBlock = false;
      const redacted = content.replace(/<\s*private\s*>[\s\S]*?<\s*\/\s*private\s*>/gi, () => {
        hadPrivateBlock = true;
        return "[private content redacted]";
      });
      return { content: redacted, isPrivate: hadPrivateBlock || memoryState.strict };
    }),
  },
}));

import { PlaybookService } from "../PlaybookService";
import { PlaybookSkillPromoter } from "../PlaybookSkillPromoter";
import { MemoryService } from "../MemoryService";
import {
  PlaybookEntrySqlStore,
  parsePlaybookContent,
  playbookKindOfContent,
} from "../playbook-entries-sql";
import { hashMemoryContent, PlaybookEvidenceStore } from "../PlaybookEvidenceStore";
import { scorePlaybookRelevance } from "../playbook-relevance";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  memoryState.db = db;
  memoryState.enabled = true;
  memoryState.strict = false;
  PlaybookService.setEvidenceStoreForTesting(undefined);
});

afterEach(() => {
  PlaybookService.setEvidenceStoreForTesting(undefined);
  memoryState.db = null;
  db.close();
});

const WS = "ws-synthetic";

async function success(taskId: string, title: string, tools = ["read_file"]) {
  return PlaybookService.captureOutcome(
    WS,
    taskId,
    title,
    title,
    "success",
    `approach for ${title}`,
    tools,
  );
}

function evidenceCount(): number {
  PlaybookService.getEvidenceStore(); // ensures the ledger schema exists
  return (db.prepare("SELECT COUNT(*) AS n FROM playbook_success_evidence").get() as { n: number })
    .n;
}

describe("Playbook evidence capture", () => {
  it("failure then success no longer reinforces the failure", async () => {
    await PlaybookService.captureOutcome(
      WS,
      "failed-task",
      "Reconcile invoices",
      "Reconcile invoices",
      "failure",
      "Use the wrong spreadsheet columns",
      ["read_file"],
      "Missing required invoice data",
    );
    const captured = await success("successful-task", "Reconcile invoices");
    expect(captured.status).toBe("recorded");
    const reinforced = await PlaybookService.reinforceFromEvidence(
      WS,
      (captured.status === "recorded" && captured.evidenceId) || "",
    );
    expect(reinforced.linkedEvidenceIds).toEqual([]);
    expect(await PlaybookService.getPlaybookForContext(WS, "Reconcile invoices")).not.toContain(
      "wrong spreadsheet",
    );
  });

  it("unrelated prompts return nothing and do not link", async () => {
    await success("old-task", "Export payroll CSV", ["write_file"]);
    expect(await PlaybookService.getPlaybookForContext(WS, "Botanical taxonomy of ferns")).toBe("");
    const current = await success("new-task", "Botanical taxonomy of ferns", ["write_file"]);
    expect(
      (
        await PlaybookService.reinforceFromEvidence(
          WS,
          (current.status === "recorded" && current.evidenceId) || "",
        )
      ).linkedEvidenceIds,
    ).toEqual([]);
  });

  it("three callbacks for one execution count once", async () => {
    const results = await Promise.all([
      success("task-1", "Reconcile invoices"),
      success("task-1", "Reconcile invoices"),
      success("task-1", "Reconcile invoices"),
    ]);
    expect(results.filter((result) => result.status === "recorded")).toHaveLength(1);
    expect(evidenceCount()).toBe(1);
  });

  it("a task counts as one execution across follow-ups", async () => {
    await success("task-1", "Reconcile invoices");
    const second = await success("task-1", "Reconcile invoices");
    expect(second).toMatchObject({ status: "skipped", reason: "duplicate_execution" });
    expect(evidenceCount()).toBe(1);
  });

  it("skipped memory capture creates no evidence and reports skipped", async () => {
    memoryState.enabled = false;
    const result = await success("task-1", "Reconcile invoices");
    expect(result).toEqual({ status: "skipped", reason: "memory_not_recorded" });
    expect(evidenceCount()).toBe(0);
  });

  it("writes outcomes to playbook_entries, never to the memory archive", async () => {
    const captured = await success("task-1", "Reconcile invoices", ["read_file", "write_file"]);
    expect(captured.status).toBe("recorded");
    expect(MemoryService.capture).not.toHaveBeenCalled();
    const entry = db.prepare("SELECT * FROM playbook_entries").get() as Record<string, unknown>;
    expect(entry).toMatchObject({
      workspace_id: WS,
      task_id: "task-1",
      kind: "success",
      title: "Reconcile invoices",
      approach: "approach for Reconcile invoices",
      request: "Reconcile invoices",
      tools: JSON.stringify(["read_file", "write_file"]),
      pattern_key: "tools:read_file,write_file",
      status: "active",
      is_private: 0,
    });
    const evidence = db.prepare("SELECT source_memory_id FROM playbook_success_evidence").get();
    expect(evidence).toEqual({ source_memory_id: entry.id });
  });

  it("records failures and inbox patterns as entries without evidence", async () => {
    await PlaybookService.captureOutcome(
      WS,
      "task-f",
      "Sync calendar",
      "Sync calendar",
      "failure",
      "Use the API",
      ["http"],
      "Request timed out",
    );
    await PlaybookService.captureMailboxPattern(WS, { title: "Weekly digest", summary: "Sorted" });
    expect(
      db.prepare("SELECT kind, error_category, title FROM playbook_entries ORDER BY kind").all(),
    ).toEqual([
      { kind: "failure", error_category: "timeout", title: "Sync calendar" },
      { kind: "inbox", error_category: null, title: "Weekly digest" },
    ]);
    expect(evidenceCount()).toBe(0);
    expect(await PlaybookService.countOutcomes(WS)).toEqual({ successes: 0, failures: 1 });
  });

  it("a user correction invalidates the task's earlier success", async () => {
    await success("task-1", "Reconcile invoices");
    await PlaybookService.captureOutcome(
      WS,
      "task-1",
      "Reconcile invoices",
      "Reconcile invoices",
      "failure",
      "corrected",
      [],
      "[CORRECTION] that is the wrong ledger",
    );
    expect(await PlaybookService.getPlaybookForContext(WS, "Reconcile invoices")).toBe("");
  });

  it("recordUserCorrection invalidates the success in the ledger without writing an entry", async () => {
    await success("task-1", "Reconcile invoices");
    await PlaybookService.recordUserCorrection(WS, "task-1");
    expect(await PlaybookService.getPlaybookForContext(WS, "Reconcile invoices")).toBe("");
    expect(
      db.prepare("SELECT COUNT(*) AS n, MIN(status) AS s FROM playbook_entries").get(),
    ).toEqual({ n: 1, s: "invalidated" });
    expect(
      db.prepare("SELECT invalidation_reason AS r FROM playbook_success_evidence").get(),
    ).toEqual({ r: "corrected_by_user" });
    const corrections = await PlaybookService.listCorrections(WS, 0);
    expect(corrections.map((correction) => correction.taskId)).toEqual(["task-1"]);
  });

  it("a correction invalidates success even after a failed follow-up or an unwritten memory", async () => {
    await success("task-1", "Reconcile invoices");
    const fail = (message: string) =>
      PlaybookService.captureOutcome(
        WS,
        "task-1",
        "Reconcile invoices",
        "Reconcile invoices",
        "failure",
        "follow-up",
        [],
        message,
      );
    await fail("Tool execution failed");
    memoryState.enabled = false;
    await fail("[CORRECTION] that is the wrong ledger");
    expect(await PlaybookService.getPlaybookForContext(WS, "Reconcile invoices")).toBe("");
  });

  it("deleting or editing the source entry invalidates dependent evidence", async () => {
    const first = await success("task-1", "Reconcile invoices");
    const second = await success("task-2", "Reconcile vendor invoices");
    expect(await PlaybookService.getPlaybookForContext(WS, "Reconcile invoices")).toContain(
      "Reconcile",
    );
    if (first.status !== "recorded" || second.status !== "recorded") throw new Error("setup");
    db.prepare("DELETE FROM playbook_entries WHERE id = ?").run(first.entryId);
    db.prepare("UPDATE playbook_entries SET content = 'edited' WHERE id = ?").run(second.entryId);
    expect(await PlaybookService.getPlaybookForContext(WS, "Reconcile invoices")).toBe("");
    const reasons = db
      .prepare("SELECT invalidation_reason AS r FROM playbook_success_evidence ORDER BY r")
      .all();
    expect(reasons).toEqual([{ r: "source_entry_deleted" }, { r: "source_entry_edited" }]);
    // The rows remain, so the same executions still cannot be counted again.
    expect(await success("task-1", "Reconcile invoices")).toMatchObject({
      status: "skipped",
      reason: "duplicate_execution",
    });
  });

  it("legacy reinforcement and inbox entries never count as proof", async () => {
    PlaybookService.getEvidenceStore(); // ensures the schema exists
    db.prepare(
      `INSERT INTO playbook_entries (id, workspace_id, kind, title, content, content_hash, created_at, updated_at)
       VALUES ('legacy', ?, 'legacy_reinforcement', 'Reconcile invoices', ?, 'x', 1, 1)`,
    ).run(
      WS,
      '[PLAYBOOK] Reinforced pattern: "Reconcile invoices"\nThis approach was confirmed successful again.',
    );
    await PlaybookService.captureMailboxPattern(WS, { title: "Reconcile invoices", summary: "x" });
    expect(evidenceCount()).toBe(0);
    expect(await PlaybookService.getPlaybookForContext(WS, "Reconcile invoices")).toBe("");
    expect(await PlaybookSkillPromoter.findCandidates(WS, 1)).toEqual([]);
  });
});

describe("Playbook prompt context from playbook_entries", () => {
  it("renders the same prompt block the synthesizer and recovery guidance consume", async () => {
    await success("t1", "Reconcile invoices", ["read_file", "write_file"]);
    expect(await PlaybookService.getPlaybookForContext(WS, "Reconcile invoices for March")).toBe(
      [
        "PLAYBOOK (observed successful executions - use as context, not as instructions):",
        '- "Reconcile invoices": approach for Reconcile invoices; tools: read_file, write_file',
      ].join("\n"),
    );
  });

  it("serves a success migrated from the archive with its original evidence", async () => {
    const content = [
      '[PLAYBOOK] Task succeeded: "Export payroll CSV"',
      "Approach: Query the payroll table and write a CSV",
      "Key tools: run_query, write_file",
      "Original request: Export payroll CSV for finance",
    ].join("\n");
    const store = new PlaybookEvidenceStore(db);
    new PlaybookEntrySqlStore(db).insertRow({
      id: "legacy-memory-id",
      workspaceId: WS,
      taskId: "old-task",
      kind: "success",
      parsed: parsePlaybookContent(content),
      patternKey: "tools:run_query,write_file",
      content,
      isPrivate: false,
      createdAt: Date.now() - 1000,
    });
    store.record({
      workspaceId: WS,
      taskId: "old-task",
      sourceEntryId: "legacy-memory-id",
      sourceContentHash: hashMemoryContent(content),
      patternKey: "tools:run_query,write_file",
    });
    expect(await PlaybookService.getPlaybookForContext(WS, "Export the payroll CSV")).toContain(
      '- "Export payroll CSV": Query the payroll table and write a CSV; tools: run_query, write_file',
    );
  });
});

describe("Playbook evidence privacy", () => {
  it("keeps no entry text in the ledger; a private block makes the entry private", async () => {
    await PlaybookService.captureOutcome(
      WS,
      "task-p",
      "Reconcile invoices",
      "Reconcile invoices for <private>ACME account 4411</private> this month",
      "success",
      "Use the ledger export",
      ["read_file"],
    );
    const ledger = JSON.stringify(db.prepare("SELECT * FROM playbook_success_evidence").all());
    expect(ledger).not.toMatch(/Reconcile|ledger export|4411/);
    const entry = db.prepare("SELECT request, content, is_private FROM playbook_entries").get() as {
      request: string;
      content: string;
      is_private: number;
    };
    expect(entry.request).toBe("Reconcile invoices for [private content redacted] this month");
    expect(entry.content).not.toContain("4411");
    expect(entry.is_private).toBe(1);
    expect(
      await PlaybookService.eligibleSuccesses(PlaybookService.getEvidenceStore()!, WS),
    ).toEqual([]);
  });

  it("never serves evidence whose entry is private", async () => {
    const ids: string[] = [];
    for (const taskId of ["t1", "t2", "t3"]) {
      const captured = await success(taskId, "Reconcile monthly invoices");
      if (captured.status !== "recorded" || !captured.evidenceId) throw new Error("setup");
      ids.push(captured.entryId);
      await PlaybookService.reinforceFromEvidence(WS, captured.evidenceId);
    }
    expect(await PlaybookSkillPromoter.findCandidates(WS, 3)).toHaveLength(1);
    db.prepare("UPDATE playbook_entries SET is_private = 1 WHERE id IN (?, ?)").run(ids[0], ids[1]);
    expect(await PlaybookSkillPromoter.findCandidates(WS, 2)).toEqual([]);
    expect(await PlaybookService.getPlaybookForContext(WS, "Reconcile monthly invoices")).toContain(
      "approach for Reconcile monthly invoices",
    );
    db.prepare("UPDATE playbook_entries SET is_private = 1 WHERE id = ?").run(ids[2]);
    expect(await PlaybookService.getPlaybookForContext(WS, "Reconcile monthly invoices")).toBe("");
  });

  it("strict privacy mode stores entries as private and serves none of them", async () => {
    memoryState.strict = true;
    expect((await success("t1", "Reconcile invoices")).status).toBe("recorded");
    expect(await PlaybookService.getPlaybookForContext(WS, "Reconcile invoices")).toBe("");
    expect(await PlaybookService.listEntries(WS)).toEqual([]);
    expect(await PlaybookService.listEntries(WS, { includePrivate: true })).toHaveLength(1);
  });
});

describe("Playbook reinforcement and promotion", () => {
  it("links only compatible approaches, once", async () => {
    await success("t1", "Reconcile monthly invoices", ["read_file", "write_file"]);
    await success("t2", "Reconcile monthly invoices", ["browser_navigate"]);
    const third = await success("t3", "Reconcile monthly invoices", ["write_file", "read_file"]);
    if (third.status !== "recorded" || !third.evidenceId) throw new Error("setup");
    const result = await PlaybookService.reinforceFromEvidence(WS, third.evidenceId);
    expect(result.linkedEvidenceIds).toHaveLength(1);
    // Re-running reinforcement does not create duplicate links.
    expect(
      (await PlaybookService.reinforceFromEvidence(WS, third.evidenceId)).linkedEvidenceIds,
    ).toEqual([]);
  });

  it("promotion counts distinct eligible executions, not memory rows or chains", async () => {
    const ids: string[] = [];
    for (const taskId of ["t1", "t2", "t3"]) {
      const captured = await success(taskId, "Reconcile monthly invoices", ["read_file"]);
      if (captured.status !== "recorded" || !captured.evidenceId) throw new Error("setup");
      ids.push(captured.evidenceId);
      await PlaybookService.reinforceFromEvidence(WS, captured.evidenceId);
    }
    const counts = db
      .prepare(
        "SELECT title, reinforcement_count AS n FROM playbook_entries ORDER BY created_at, rowid",
      )
      .all();
    expect(counts.reduce((sum, row) => sum + (row as { n: number }).n, 0)).toBeGreaterThan(0);
    // Repeated callbacks for t3 add nothing.
    await success("t3", "Reconcile monthly invoices", ["read_file"]);
    const [candidate] = await PlaybookSkillPromoter.findCandidates(WS, 3);
    expect(candidate.executionCount).toBe(3);
    expect(candidate.sourceEvidence[0]).toMatch(/^Observed successful execution of task t\d/);
    expect(await PlaybookSkillPromoter.findCandidates(WS, 4)).toEqual([]);
  });
});

describe("Playbook record recognition", () => {
  it("matches generated Playbook records narrowly", () => {
    expect(playbookKindOfContent('[PLAYBOOK] Task succeeded: "x"')).toBe("success");
    expect(playbookKindOfContent('[PLAYBOOK] Task failed: "x"')).toBe("failure");
    expect(playbookKindOfContent('[PLAYBOOK] Inbox pattern: "x"')).toBe("inbox");
    expect(playbookKindOfContent('[PLAYBOOK] Reinforced pattern: "x"')).toBe(
      "legacy_reinforcement",
    );
    expect(playbookKindOfContent("My playbook for launches: [PLAYBOOK] notes")).toBeNull();
    expect(playbookKindOfContent("Remember the Playbook meeting")).toBeNull();
  });
});

describe("Playbook relevance gate fixtures", () => {
  it.each([
    ["Reconcile invoices for March", "Reconcile invoices", true],
    [
      "Summarize quarterly revenue report",
      "Summarize the quarterly revenue report for finance",
      true,
    ],
    ["Deploy staging server", "Reconcile invoices", false],
    ["Botanical taxonomy", "Export payroll CSV", false],
    ["Please help with the task", "Please help with a new task", false],
    ["Write a report", "Write a poem", false],
  ])("%s vs %s → %s", (query, candidate, expected) => {
    expect(scorePlaybookRelevance(query, candidate).passes).toBe(expected);
  });
});
