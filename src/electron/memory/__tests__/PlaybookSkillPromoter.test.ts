import { describe, it, expect, vi, beforeEach } from "vitest";
import { PlaybookSkillPromoter } from "../PlaybookSkillPromoter";

// ── Mocks ─────────────────────────────────────────────────────────────

const mockSearch = vi.fn();
vi.mock("../MemoryService", () => ({
  MemoryService: {
    search: (...args: unknown[]) => mockSearch(...args),
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

// ── Tests ─────────────────────────────────────────────────────────────

describe("PlaybookSkillPromoter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate.mockResolvedValue({ proposal: { id: "sp_test_123" } });
  });

  describe("findCandidates", () => {
    it("returns empty when no reinforcements exist", () => {
      mockSearch.mockReturnValue([]);
      const candidates = PlaybookSkillPromoter.findCandidates("ws1");
      expect(candidates).toEqual([]);
    });

    it("returns candidates when patterns are reinforced enough times", () => {
      // Simulate 3 reinforcements of the same pattern
      mockSearch.mockReturnValue([
        {
          id: "m1",
          type: "insight",
          snippet: '[PLAYBOOK] Reinforced pattern: "Deploy service"\nTools: shell, git_commit\nOriginal request: deploy the API',
          relevanceScore: 0.9,
          createdAt: Date.now(),
          source: "db",
        },
        {
          id: "m2",
          type: "insight",
          snippet: '[PLAYBOOK] Reinforced pattern: "Deploy service"\nTools: shell\nOriginal request: deploy to production',
          relevanceScore: 0.8,
          createdAt: Date.now(),
          source: "db",
        },
        {
          id: "m3",
          type: "insight",
          snippet: '[PLAYBOOK] Reinforced pattern: "Deploy service"\nTools: shell, git_commit\nOriginal request: deploy the service',
          relevanceScore: 0.7,
          createdAt: Date.now(),
          source: "db",
        },
      ]);

      const candidates = PlaybookSkillPromoter.findCandidates("ws1");
      expect(candidates.length).toBe(1);
      expect(candidates[0].reinforcementCount).toBe(3);
      expect(candidates[0].toolsUsed).toContain("shell");
      expect(candidates[0].requestExcerpts.length).toBeGreaterThan(0);
    });

    it("does not return candidates below threshold", () => {
      mockSearch.mockReturnValue([
        {
          id: "m1",
          type: "insight",
          snippet: '[PLAYBOOK] Reinforced pattern: "Deploy service"\nTools: shell',
          relevanceScore: 0.9,
          createdAt: Date.now(),
          source: "db",
        },
      ]);

      const candidates = PlaybookSkillPromoter.findCandidates("ws1", 3);
      expect(candidates).toEqual([]);
    });

    it("groups patterns by normalized task description", () => {
      mockSearch.mockReturnValue([
        {
          id: "m1",
          type: "insight",
          snippet: '[PLAYBOOK] Reinforced pattern: "Deploy Service"\nTools: shell',
          relevanceScore: 0.9,
          createdAt: Date.now(),
          source: "db",
        },
        {
          id: "m2",
          type: "insight",
          snippet: '[PLAYBOOK] Reinforced pattern: "deploy service"\nTools: git_commit',
          relevanceScore: 0.8,
          createdAt: Date.now(),
          source: "db",
        },
        {
          id: "m3",
          type: "insight",
          snippet: '[PLAYBOOK] Reinforced pattern: "Deploy Service"\nTools: shell',
          relevanceScore: 0.7,
          createdAt: Date.now(),
          source: "db",
        },
      ]);

      const candidates = PlaybookSkillPromoter.findCandidates("ws1");
      expect(candidates.length).toBe(1);
      expect(candidates[0].reinforcementCount).toBe(3);
      // Should collect unique tools from all entries
      expect(candidates[0].toolsUsed).toContain("shell");
      expect(candidates[0].toolsUsed).toContain("git_commit");
    });

    it("ignores non-reinforcement entries", () => {
      mockSearch.mockReturnValue([
        {
          id: "m1",
          type: "insight",
          snippet: '[PLAYBOOK] Task succeeded: "Deploy service"',
          relevanceScore: 0.9,
          createdAt: Date.now(),
          source: "db",
        },
        {
          id: "m2",
          type: "observation",
          snippet: 'Reinforced pattern: "Deploy service"',
          relevanceScore: 0.8,
          createdAt: Date.now(),
          source: "db",
        },
      ]);

      const candidates = PlaybookSkillPromoter.findCandidates("ws1");
      expect(candidates).toEqual([]);
    });
  });

  describe("maybePropose", () => {
    it("creates a skill proposal when candidates exist", async () => {
      mockSearch.mockReturnValue([
        {
          id: "m1",
          type: "insight",
          snippet: '[PLAYBOOK] Reinforced pattern: "Run tests"\nTools: shell\nOriginal request: run the test suite',
          relevanceScore: 0.9,
          createdAt: Date.now(),
          source: "db",
        },
        {
          id: "m2",
          type: "insight",
          snippet: '[PLAYBOOK] Reinforced pattern: "Run tests"\nTools: shell\nOriginal request: execute tests',
          relevanceScore: 0.8,
          createdAt: Date.now(),
          source: "db",
        },
        {
          id: "m3",
          type: "insight",
          snippet: '[PLAYBOOK] Reinforced pattern: "Run tests"\nTools: shell\nOriginal request: run tests',
          relevanceScore: 0.7,
          createdAt: Date.now(),
          source: "db",
        },
      ]);

      const result = await PlaybookSkillPromoter.maybePropose("ws_new_1", "/workspace");

      expect(result.proposed).toBe(true);
      expect(result.proposalId).toBe("sp_test_123");
      expect(mockCreate).toHaveBeenCalledTimes(1);

      const createArg = mockCreate.mock.calls[0][0];
      expect(createArg.problemStatement).toContain("Recurring task pattern");
      expect(createArg.draftSkill.category).toBe("auto-promoted");
      expect(createArg.draftSkill.icon).toBe("zap");
    });

    it("returns no_candidates when no patterns meet threshold", async () => {
      mockSearch.mockReturnValue([]);

      const result = await PlaybookSkillPromoter.maybePropose("ws_new_2", "/workspace");
      expect(result.proposed).toBe(false);
      expect(result.reason).toBe("no_candidates");
    });

    it("handles duplicate proposals gracefully", async () => {
      mockSearch.mockReturnValue([
        {
          id: "m1",
          type: "insight",
          snippet: '[PLAYBOOK] Reinforced pattern: "Deploy"\nTools: shell',
          relevanceScore: 0.9,
          createdAt: Date.now(),
          source: "db",
        },
        {
          id: "m2",
          type: "insight",
          snippet: '[PLAYBOOK] Reinforced pattern: "Deploy"\nTools: shell',
          relevanceScore: 0.8,
          createdAt: Date.now(),
          source: "db",
        },
        {
          id: "m3",
          type: "insight",
          snippet: '[PLAYBOOK] Reinforced pattern: "Deploy"\nTools: shell',
          relevanceScore: 0.7,
          createdAt: Date.now(),
          source: "db",
        },
      ]);

      mockCreate.mockResolvedValue({ duplicateOf: "sp_existing" });

      const result = await PlaybookSkillPromoter.maybePropose("ws_new_3", "/workspace");
      expect(result.proposed).toBe(false);
      expect(result.reason).toContain("duplicate");
    });
  });
});
