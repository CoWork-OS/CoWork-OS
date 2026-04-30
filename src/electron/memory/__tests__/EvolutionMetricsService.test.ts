import { describe, it, expect, vi, beforeEach } from "vitest";
import { EvolutionMetricsService } from "../EvolutionMetricsService";

// ── Mocks ─────────────────────────────────────────────────────────────

const mockSearch = vi.fn();
vi.mock("../MemoryService", () => ({
  MemoryService: {
    search: (...args: unknown[]) => mockSearch(...args),
  },
}));

vi.mock("../AdaptiveStyleEngine", () => ({
  AdaptiveStyleEngine: {
    getAdaptationHistory: vi.fn().mockReturnValue([]),
    getObservationStats: vi.fn().mockReturnValue({
      totalMessages: 0,
      weeklyAdaptations: 0,
      maxWeeklyDrift: 3,
      enabled: true,
      lastAdaptationAt: 0,
    }),
  },
}));

vi.mock("../../settings/personality-manager", () => ({
  PersonalityManager: {
    getRelationshipStats: vi.fn().mockReturnValue({
      tasksCompleted: 42,
      projectsCount: 3,
      daysTogether: 15,
      nextMilestone: 50,
    }),
  },
}));

vi.mock("../../knowledge-graph/KnowledgeGraphService", () => ({
  KnowledgeGraphService: {
    getStats: vi.fn().mockReturnValue({
      entityCount: 25,
      edgeCount: 40,
      observationCount: 100,
      entityTypeDistribution: [],
    }),
  },
}));

// ── Tests ─────────────────────────────────────────────────────────────

describe("EvolutionMetricsService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearch.mockReturnValue([]);
  });

  describe("computeSnapshot", () => {
    it("computes a complete evolution snapshot", async () => {
      const snapshot = await EvolutionMetricsService.computeSnapshot("ws1");

      expect(snapshot.computedAt).toBeDefined();
      expect(snapshot.daysTogether).toBe(15);
      expect(snapshot.tasksCompleted).toBe(42);
      expect(snapshot.metrics.length).toBe(5);
      expect(snapshot.overallScore).toBeGreaterThanOrEqual(0);
      expect(snapshot.overallScore).toBeLessThanOrEqual(100);
    });

    it("includes all expected metric IDs", async () => {
      const snapshot = await EvolutionMetricsService.computeSnapshot("ws1");
      const metricIds = snapshot.metrics.map((m) => m.id);

      expect(metricIds).toContain("correction_rate");
      expect(metricIds).toContain("adaptation_velocity");
      expect(metricIds).toContain("knowledge_growth");
      expect(metricIds).toContain("task_success_rate");
      expect(metricIds).toContain("style_alignment");
    });

    it("reports knowledge graph stats", async () => {
      const snapshot = await EvolutionMetricsService.computeSnapshot("ws1");
      const kgMetric = snapshot.metrics.find((m) => m.id === "knowledge_growth")!;

      expect(kgMetric.value).toBe(25);
      expect(kgMetric.unit).toBe(" entities");
      expect(kgMetric.detail).toContain("25 entities");
      expect(kgMetric.detail).toContain("40 relationships");
    });

    it("computes task success rate from playbook data", async () => {
      mockSearch.mockImplementation((_ws: string, query: string) => {
        if (query.includes("[PLAYBOOK] Task")) {
          return [
            { type: "insight", snippet: "[PLAYBOOK] Task succeeded: \"Deploy\"", createdAt: Date.now() },
            { type: "insight", snippet: "[PLAYBOOK] Task succeeded: \"Build\"", createdAt: Date.now() },
            { type: "insight", snippet: "[PLAYBOOK] Task failed: \"Test\"", createdAt: Date.now() },
          ];
        }
        return [];
      });

      const snapshot = await EvolutionMetricsService.computeSnapshot("ws1");
      const successRate = snapshot.metrics.find((m) => m.id === "task_success_rate")!;

      expect(successRate.value).toBe(67); // 2/3 = 67%
      expect(successRate.detail).toContain("2 succeeded");
      expect(successRate.detail).toContain("1 failed");
    });

    it("detects improving correction rate", async () => {
      const now = Date.now();
      const oneWeekAgo = now - 8 * 24 * 60 * 60 * 1000;
      const twoWeeksAgo = now - 15 * 24 * 60 * 60 * 1000;

      mockSearch.mockImplementation((_ws: string, query: string) => {
        if (query.includes("failed")) {
          return [
            // Recent: only 1 failure
            { type: "insight", snippet: "[PLAYBOOK] Task failed: \"A\"", createdAt: now - 100000 },
            // Older period: 6 failures (high rate)
            { type: "insight", snippet: "[PLAYBOOK] Task failed: \"B\"", createdAt: oneWeekAgo },
            { type: "insight", snippet: "[PLAYBOOK] Task failed: \"C\"", createdAt: oneWeekAgo - 1000 },
            { type: "insight", snippet: "[PLAYBOOK] Task failed: \"D\"", createdAt: twoWeeksAgo },
            { type: "insight", snippet: "[PLAYBOOK] Task failed: \"E\"", createdAt: twoWeeksAgo - 1000 },
            { type: "insight", snippet: "[PLAYBOOK] Task failed: \"F\"", createdAt: twoWeeksAgo - 2000 },
            { type: "insight", snippet: "[PLAYBOOK] Task failed: \"G\"", createdAt: twoWeeksAgo - 3000 },
          ];
        }
        return [];
      });

      const snapshot = await EvolutionMetricsService.computeSnapshot("ws1");
      const correctionRate = snapshot.metrics.find((m) => m.id === "correction_rate")!;

      expect(correctionRate.trend).toBe("improving");
      expect(correctionRate.value).toBe(1); // only 1 recent failure
    });
  });

  describe("formatForBriefing", () => {
    it("produces human-readable summary", async () => {
      const snapshot = await EvolutionMetricsService.computeSnapshot("ws1");
      const formatted = EvolutionMetricsService.formatForBriefing(snapshot);

      expect(formatted).toContain("AGENT EVOLUTION");
      expect(formatted).toContain("Day 15");
      expect(formatted).toContain("42 tasks completed");
      expect(formatted).toContain("Overall Evolution Score");
    });

    it("shows trend indicators", async () => {
      const snapshot = await EvolutionMetricsService.computeSnapshot("ws1");
      const formatted = EvolutionMetricsService.formatForBriefing(snapshot);

      // Should contain at least one trend indicator
      expect(formatted).toMatch(/\[[+\-=]\]/);
    });
  });

  describe("overall score", () => {
    it("stays within 0-100 range", async () => {
      const snapshot = await EvolutionMetricsService.computeSnapshot("ws1");
      expect(snapshot.overallScore).toBeGreaterThanOrEqual(0);
      expect(snapshot.overallScore).toBeLessThanOrEqual(100);
    });

    it("increases with knowledge graph size", async () => {
      // First snapshot with empty KG
      vi.mocked(
        (await import("../../knowledge-graph/KnowledgeGraphService")).KnowledgeGraphService.getStats,
      ).mockReturnValueOnce({
        entityCount: 0,
        edgeCount: 0,
        observationCount: 0,
        entityTypeDistribution: [],
      });
      const snapshot1 = await EvolutionMetricsService.computeSnapshot("ws1");

      // Second snapshot with larger KG
      vi.mocked(
        (await import("../../knowledge-graph/KnowledgeGraphService")).KnowledgeGraphService.getStats,
      ).mockReturnValueOnce({
        entityCount: 100,
        edgeCount: 200,
        observationCount: 500,
        entityTypeDistribution: [],
      });
      const snapshot2 = await EvolutionMetricsService.computeSnapshot("ws1");

      expect(snapshot2.overallScore).toBeGreaterThanOrEqual(snapshot1.overallScore);
    });
  });
});
