import Database from "better-sqlite3";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PlaybookSkillPromoter } from "../PlaybookSkillPromoter";
import { PlaybookService } from "../PlaybookService";
import { hashMemoryContent, PlaybookEvidenceStore } from "../PlaybookEvidenceStore";

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

// ── Fixture: a synthetic ledger with verifiable source memories ─────────

let db: Database.Database;
let store: PlaybookEvidenceStore;

function addSuccess(
  workspaceId: string,
  taskId: string,
  title: string,
  tools: string[],
  overrides: {
    executionKey?: string;
    grade?: "observed_runtime_success" | "contract_verified";
  } = {},
) {
  const content = `[PLAYBOOK] Task succeeded: "${title}" (${taskId})`;
  const memoryId = `mem-${taskId}-${overrides.executionKey || ""}`;
  db.prepare("INSERT INTO memories (id, content) VALUES (?, ?)").run(memoryId, content);
  return store.record({
    workspaceId,
    taskId,
    executionKey: overrides.executionKey || `task:${taskId}`,
    turnId: null,
    terminalEventId: null,
    sourceMemoryId: memoryId,
    sourceContentHash: hashMemoryContent(content),
    outcome: "success",
    grade: overrides.grade || "observed_runtime_success",
    patternKey: `tools:${[...tools].sort().join(",")}`,
    title,
    approach: `approach ${title}`,
    requestExcerpt: title,
    toolsUsed: tools,
    sourceRefs: [`task:${taskId}`, `memory:${memoryId}`],
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
    db.exec("CREATE TABLE memories (id TEXT PRIMARY KEY, content TEXT)");
    store = new PlaybookEvidenceStore(db);
    PlaybookService.setEvidenceStoreForTesting(store);
  });

  afterEach(() => {
    PlaybookService.setEvidenceStoreForTesting(undefined);
    db.close();
  });

  describe("findCandidates", () => {
    it("returns empty when there is no evidence", () => {
      expect(PlaybookSkillPromoter.findCandidates("ws1")).toEqual([]);
    });

    it("counts distinct linked executions that share an approach", () => {
      const records = ["a", "b", "c"].map((id) =>
        addSuccess("ws1", id, "Generate weekly report", ["web_search", "write_file"]),
      );
      chain(records.map((record) => record.id));
      const [candidate] = PlaybookSkillPromoter.findCandidates("ws1");
      expect(candidate.executionCount).toBe(3);
      expect(candidate.pattern).toBe("Generate weekly report");
      expect(candidate.toolsUsed).toEqual(expect.arrayContaining(["web_search", "write_file"]));
      expect(candidate.sourceEvidence).toHaveLength(3);
      expect(candidate.sourceEvidence[0]).toMatch(/\(observed runtime success\); sources: task:/);
    });

    it("does not count unlinked successes, even with similar titles", () => {
      ["a", "b", "c"].forEach((id) => addSuccess("ws1", id, "Generate weekly report", ["shell"]));
      expect(PlaybookSkillPromoter.findCandidates("ws1")).toEqual([]);
    });

    it("does not join executions whose approaches differ", () => {
      const a = addSuccess("ws1", "a", "Run tests", ["shell"]);
      const b = addSuccess("ws1", "b", "Run tests", ["browser_navigate"]);
      const c = addSuccess("ws1", "c", "Run tests", ["shell"]);
      store.link(b.id, a.id);
      store.link(c.id, b.id);
      expect(PlaybookSkillPromoter.findCandidates("ws1")).toEqual([]);
    });

    it("excludes invalidated evidence and evidence whose memory was deleted", () => {
      const records = ["a", "b", "c"].map((id) => addSuccess("ws1", id, "Deploy", ["shell"]));
      chain(records.map((record) => record.id));
      store.invalidate(records[0].id, "corrected_by_user");
      expect(PlaybookSkillPromoter.findCandidates("ws1")).toEqual([]);
      db.prepare("DELETE FROM memories").run();
      expect(PlaybookSkillPromoter.findCandidates("ws1", 1)).toEqual([]);
    });

    it("respects the threshold", () => {
      const records = ["a", "b"].map((id) => addSuccess("ws1", id, "Deploy", ["shell"]));
      chain(records.map((record) => record.id));
      expect(PlaybookSkillPromoter.findCandidates("ws1", 3)).toEqual([]);
      expect(PlaybookSkillPromoter.findCandidates("ws1", 2)).toHaveLength(1);
    });
  });

  describe("maybePropose", () => {
    it("proposes from evidence with observed-execution wording and provenance", async () => {
      const records = ["a", "b", "c"].map((id) =>
        addSuccess("ws_new_1", id, "Run tests", ["shell"], {
          grade: id === "b" ? "contract_verified" : undefined,
        }),
      );
      chain(records.map((record) => record.id));

      const result = await PlaybookSkillPromoter.maybePropose("ws_new_1", "/workspace");

      expect(result.proposed).toBe(true);
      expect(result.proposalId).toBe("sp_test_123");
      const createArg = mockCreate.mock.calls[0][0];
      expect(createArg.problemStatement).toContain("3 observed successful executions");
      expect(createArg.evidence.join("\n")).toContain("contract verified");
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
