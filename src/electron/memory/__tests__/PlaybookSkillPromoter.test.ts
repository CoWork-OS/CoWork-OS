import Database from "better-sqlite3";
import { PlaybookEvidenceLedger } from "../PlaybookEvidenceLedger";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PlaybookSkillPromoter } from "../PlaybookSkillPromoter";
import { PlaybookService } from "../PlaybookService";
import { hashMemoryContent, PlaybookEvidenceStore } from "../PlaybookEvidenceStore";
import { PlaybookEntrySqlStore, parsePlaybookContent } from "../playbook-entries-sql";

// ── Mocks ─────────────────────────────────────────────────────────────

vi.mock("../MemoryService", () => ({
  MemoryService: {
    getDatabase: () => undefined,
    capture: vi.fn(),
  },
}));

const mockCreate = vi.fn();
vi.mock("../../agent/skills/SkillProposalService", () => ({
  SkillProposalService: class {
    create(...args: unknown[]) {
      return mockCreate(...args);
    }
  },
}));

// ── Fixture: a synthetic ledger with verifiable source entries ──────────

let db: Database.Database;
let store: PlaybookEvidenceStore;

function addSuccess(workspaceId: string, taskId: string, title: string, tools: string[]) {
  const content = [
    `[PLAYBOOK] Task succeeded: "${title}"`,
    `Approach: approach ${title}`,
    `Key tools: ${tools.join(", ")}`,
    `Original request: ${title} (${taskId})`,
  ].join("\n");
  const entryId = `entry-${taskId}`;
  new PlaybookEntrySqlStore(db).insertRow({
    id: entryId,
    workspaceId,
    taskId,
    kind: "success",
    parsed: parsePlaybookContent(content),
    patternKey: `tools:${[...tools].sort().join(",")}`,
    content,
    isPrivate: false,
    createdAt: 1,
  });
  return store.record({
    workspaceId,
    taskId,
    sourceEntryId: entryId,
    sourceContentHash: hashMemoryContent(content),
    patternKey: `tools:${[...tools].sort().join(",")}`,
  }).record;
}

function chain(ids: string[]) {
  for (let i = 1; i < ids.length; i++) store.link(ids[i], ids[i - 1]);
}

describe("PlaybookSkillPromoter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate.mockResolvedValue({ proposal: { id: "sp_test_123", status: "pending" } });
    db = new Database(":memory:");
    store = new PlaybookEvidenceStore(db);
    PlaybookService.setEvidenceStoreForTesting(PlaybookEvidenceLedger.open(db));
  });

  afterEach(() => {
    PlaybookService.setEvidenceStoreForTesting(undefined);
    db.close();
  });

  describe("findCandidates", () => {
    it("returns empty when there is no evidence", async () => {
      expect(await PlaybookSkillPromoter.findCandidates("ws1")).toEqual([]);
    });

    it("counts distinct linked executions that share an approach", async () => {
      const records = ["a", "b", "c"].map((id) =>
        addSuccess("ws1", id, "Generate weekly report", ["web_search", "write_file"]),
      );
      chain(records.map((record) => record.id));
      const [candidate] = await PlaybookSkillPromoter.findCandidates("ws1");
      expect(candidate.executionCount).toBe(3);
      expect(candidate.pattern).toBe("Generate weekly report");
      expect(candidate.toolsUsed).toEqual(expect.arrayContaining(["web_search", "write_file"]));
      expect(candidate.sourceEvidence).toHaveLength(3);
      expect(candidate.sourceEvidence[0]).toMatch(
        /^Observed successful execution of task [abc] \(playbook entry entry-[abc]\)$/,
      );
      expect(candidate.requestExcerpts).toHaveLength(3);
    });

    it("does not count unlinked successes, even with similar titles", async () => {
      ["a", "b", "c"].forEach((id) => addSuccess("ws1", id, "Generate weekly report", ["shell"]));
      expect(await PlaybookSkillPromoter.findCandidates("ws1")).toEqual([]);
    });

    it("does not join executions whose approaches differ", async () => {
      const a = addSuccess("ws1", "a", "Run tests", ["shell"]);
      const b = addSuccess("ws1", "b", "Run tests", ["browser_navigate"]);
      const c = addSuccess("ws1", "c", "Run tests", ["shell"]);
      store.link(b.id, a.id);
      store.link(c.id, b.id);
      expect(await PlaybookSkillPromoter.findCandidates("ws1")).toEqual([]);
    });

    it("excludes invalidated evidence and evidence whose entry was deleted", async () => {
      const records = ["a", "b", "c"].map((id) => addSuccess("ws1", id, "Deploy", ["shell"]));
      chain(records.map((record) => record.id));
      store.invalidate(records[0].id, "corrected_by_user");
      expect(await PlaybookSkillPromoter.findCandidates("ws1")).toEqual([]);
      db.prepare("DELETE FROM playbook_entries").run();
      expect(await PlaybookSkillPromoter.findCandidates("ws1", 1)).toEqual([]);
    });

    it("respects the threshold", async () => {
      const records = ["a", "b"].map((id) => addSuccess("ws1", id, "Deploy", ["shell"]));
      chain(records.map((record) => record.id));
      expect(await PlaybookSkillPromoter.findCandidates("ws1", 3)).toEqual([]);
      expect(await PlaybookSkillPromoter.findCandidates("ws1", 2)).toHaveLength(1);
    });
  });

  describe("maybePropose", () => {
    it("proposes from evidence with observed-execution wording and provenance", async () => {
      const records = ["a", "b", "c"].map((id) =>
        addSuccess("ws_new_1", id, "Run tests", ["shell"]),
      );
      chain(records.map((record) => record.id));

      const result = await PlaybookSkillPromoter.maybePropose("ws_new_1", "/workspace");

      expect(result.proposed).toBe(true);
      expect(result.proposalId).toBe("sp_test_123");
      const createArg = mockCreate.mock.calls[0][0];
      expect(createArg.problemStatement).toContain("3 observed successful executions");
      expect(createArg.provenance).toEqual({
        source: "playbook_evidence",
        evidenceIds: expect.arrayContaining(records.map((record) => record.id)),
        executionCount: 3,
      });
      expect(createArg.draftSkill.category).toBe("auto-promoted");
      expect(createArg.draftSkill.icon).toBe("zap");
    });

    it("returns no_candidates when no patterns meet threshold", async () => {
      const result = await PlaybookSkillPromoter.maybePropose("ws_new_2", "/workspace");
      expect(result.proposed).toBe(false);
      expect(result.reason).toBe("no_candidates");
    });

    it("handles duplicate proposals gracefully", async () => {
      const records = ["a", "b", "c"].map((id) => addSuccess("ws_new_3", id, "Deploy", ["shell"]));
      chain(records.map((record) => record.id));
      mockCreate.mockResolvedValue({ duplicateOf: "sp_existing" });

      const result = await PlaybookSkillPromoter.maybePropose("ws_new_3", "/workspace");
      expect(result.proposed).toBe(false);
      expect(result.reason).toContain("duplicate");
    });
  });
});
