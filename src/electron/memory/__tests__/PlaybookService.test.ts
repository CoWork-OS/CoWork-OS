import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Synthetic in-memory memory adapter over a real SQLite `memories` table; no profile.
const memoryState = vi.hoisted(() => ({
  db: null as import("better-sqlite3").Database | null,
  enabled: true,
  suppressed: new Set<string>(),
}));

vi.mock("../MemoryObservationService", () => ({
  MemoryObservationService: {
    suppressedIds: async (memoryIds: string[]) =>
      new Set(memoryIds.filter((memoryId) => memoryState.suppressed.has(memoryId))),
  },
}));

vi.mock("../MemoryService", () => ({
  MemoryService: {
    getDatabase: () => memoryState.db,
    capture: vi.fn(
      async (_workspaceId: string, taskId: string | undefined, type: string, content: string) => {
        if (!memoryState.enabled || !memoryState.db) return null;
        // Same inline privacy redaction MemoryService.capture applies.
        content = content.replace(
          /<\s*private\s*>[\s\S]*?<\s*\/\s*private\s*>/gi,
          "[private content redacted]",
        );
        const id = randomUUID();
        memoryState.db
          .prepare("INSERT INTO memories (id, task_id, type, content) VALUES (?, ?, ?, ?)")
          .run(id, taskId ?? null, type, content);
        return { id, content, type, taskId };
      },
    ),
  },
}));

import { PlaybookService } from "../PlaybookService";
import { PlaybookSkillPromoter } from "../PlaybookSkillPromoter";
import { isGeneratedPlaybookContent } from "../playbook-markers";
import { scorePlaybookRelevance } from "../playbook-relevance";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(
    "CREATE TABLE memories (id TEXT PRIMARY KEY, task_id TEXT, type TEXT, content TEXT, is_private INTEGER NOT NULL DEFAULT 0)",
  );
  memoryState.db = db;
  memoryState.enabled = true;
  memoryState.suppressed.clear();
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

  it("recordUserCorrection invalidates the success in the ledger without writing a memory", async () => {
    await success("task-1", "Reconcile invoices");
    const memoriesBefore = (db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number })
      .n;
    await PlaybookService.recordUserCorrection(WS, "task-1");
    expect(await PlaybookService.getPlaybookForContext(WS, "Reconcile invoices")).toBe("");
    expect(db.prepare("SELECT COUNT(*) AS n FROM memories").get()).toEqual({ n: memoriesBefore });
    expect(
      db.prepare("SELECT invalidation_reason AS r FROM playbook_success_evidence").get(),
    ).toEqual({ r: "corrected_by_user" });
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

  it("deleting or editing the source memory invalidates dependent evidence", async () => {
    const first = await success("task-1", "Reconcile invoices");
    const second = await success("task-2", "Reconcile vendor invoices");
    expect(await PlaybookService.getPlaybookForContext(WS, "Reconcile invoices")).toContain(
      "Reconcile",
    );
    if (first.status !== "recorded" || second.status !== "recorded") throw new Error("setup");
    db.prepare("DELETE FROM memories WHERE id = ?").run(first.memoryId);
    db.prepare("UPDATE memories SET content = 'edited' WHERE id = ?").run(second.memoryId);
    expect(await PlaybookService.getPlaybookForContext(WS, "Reconcile invoices")).toBe("");
    const reasons = db
      .prepare("SELECT invalidation_reason AS r FROM playbook_success_evidence ORDER BY r")
      .all();
    expect(reasons).toEqual([{ r: "source_memory_deleted" }, { r: "source_memory_edited" }]);
    // The rows remain, so the same executions still cannot be counted again.
    expect(await success("task-1", "Reconcile invoices")).toMatchObject({
      status: "skipped",
      reason: "duplicate_execution",
    });
  });

  it("legacy reinforcement and inbox memories never count as proof", async () => {
    db.prepare("INSERT INTO memories (id, type, content) VALUES (?, 'insight', ?)").run(
      "legacy",
      '[PLAYBOOK] Reinforced pattern: "Reconcile invoices"\nThis approach was confirmed successful again.',
    );
    await PlaybookService.captureMailboxPattern(WS, { title: "Reconcile invoices", summary: "x" });
    expect(evidenceCount()).toBe(0);
    expect(await PlaybookService.getPlaybookForContext(WS, "Reconcile invoices")).toBe("");
    expect(await PlaybookSkillPromoter.findCandidates(WS, 1)).toEqual([]);
  });
});

describe("Playbook evidence privacy", () => {
  it("keeps no memory text in the ledger; readers see the memory as stored", async () => {
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
    const [success] = await PlaybookService.eligibleSuccesses(
      PlaybookService.getEvidenceStore()!,
      WS,
    );
    expect(success.request).toBe("Reconcile invoices for [private content redacted] this month");
  });

  it("never serves evidence whose memory is private or suppressed in Memory Hub", async () => {
    const ids: string[] = [];
    for (const taskId of ["t1", "t2", "t3"]) {
      const captured = await success(taskId, "Reconcile monthly invoices");
      if (captured.status !== "recorded" || !captured.evidenceId) throw new Error("setup");
      ids.push(captured.memoryId);
      await PlaybookService.reinforceFromEvidence(WS, captured.evidenceId);
    }
    expect(await PlaybookSkillPromoter.findCandidates(WS, 3)).toHaveLength(1);
    db.prepare("UPDATE memories SET is_private = 1 WHERE id = ?").run(ids[0]);
    memoryState.suppressed.add(ids[1]);
    expect(await PlaybookSkillPromoter.findCandidates(WS, 2)).toEqual([]);
    expect(await PlaybookService.getPlaybookForContext(WS, "Reconcile monthly invoices")).toContain(
      "approach for Reconcile monthly invoices",
    );
    memoryState.suppressed.add(ids[2]);
    expect(await PlaybookService.getPlaybookForContext(WS, "Reconcile monthly invoices")).toBe("");
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
    expect((await PlaybookService.reinforceFromEvidence(WS, third.evidenceId)).linkedEvidenceIds).toEqual(
      [],
    );
  });

  it("promotion counts distinct eligible executions, not memory rows or chains", async () => {
    const ids: string[] = [];
    for (const taskId of ["t1", "t2", "t3"]) {
      const captured = await success(taskId, "Reconcile monthly invoices", ["read_file"]);
      if (captured.status !== "recorded" || !captured.evidenceId) throw new Error("setup");
      ids.push(captured.evidenceId);
      await PlaybookService.reinforceFromEvidence(WS, captured.evidenceId);
    }
    // Repeated callbacks for t3 add nothing.
    await success("t3", "Reconcile monthly invoices", ["read_file"]);
    const [candidate] = await PlaybookSkillPromoter.findCandidates(WS, 3);
    expect(candidate.executionCount).toBe(3);
    expect(candidate.sourceEvidence[0]).toMatch(/^Observed successful execution of task t\d/);
    expect(await PlaybookSkillPromoter.findCandidates(WS, 4)).toEqual([]);
  });
});

describe("Playbook recall isolation", () => {
  it("matches generated Playbook rows narrowly", () => {
    expect(isGeneratedPlaybookContent('[PLAYBOOK] Task succeeded: "x"')).toBe(true);
    expect(isGeneratedPlaybookContent('[PLAYBOOK] Reinforced pattern: "x"')).toBe(true);
    expect(isGeneratedPlaybookContent("My playbook for launches: [PLAYBOOK] notes")).toBe(false);
    expect(isGeneratedPlaybookContent("Remember the Playbook meeting")).toBe(false);
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
