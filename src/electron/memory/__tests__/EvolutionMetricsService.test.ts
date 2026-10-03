import { describe, it, expect, vi, beforeEach } from "vitest";
import { EvolutionMetricsService } from "../EvolutionMetricsService";

// ── Mocks ─────────────────────────────────────────────────────────────

const mockSearch = vi.fn();
vi.mock("../MemoryService", () => ({
  MemoryService: {
    search: (...args: unknown[]) => mockSearch(...args),
    searchByContentMarker: (...args: unknown[]) => mockSearch(...args),
  },
}));

const mockCountOutcomes = vi.fn();
const mockListCorrections = vi.fn();
vi.mock("../PlaybookService", () => ({
  PlaybookService: {
    countOutcomes: (...args: unknown[]) => mockCountOutcomes(...args),
    listCorrections: (...args: unknown[]) => mockListCorrections(...args),
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
    mockCountOutcomes.mockResolvedValue({ successes: 0, failures: 0 });
    mockListCorrections.mockResolvedValue([]);
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

    it("computes task success rate from playbook entries", async () => {
      mockCountOutcomes.mockResolvedValue({ successes: 2, failures: 1 });

      const snapshot = await EvolutionMetricsService.computeSnapshot("ws1");
      const successRate = snapshot.metrics.find((m) => m.id === "task_success_rate")!;

      expect(successRate.value).toBe(67); // 2/3 = 67%
      expect(successRate.detail).toContain("2 succeeded");
      expect(successRate.detail).toContain("1 failed");
      expect(mockSearch).not.toHaveBeenCalledWith(
        "ws1",
        expect.stringContaining("[PLAYBOOK]"),
        expect.anything(),
      );
    });

    it("bases the correction rate on user corrections, not on task failures", async () => {
      const now = Date.now();
      const oneWeekAgo = now - 8 * 24 * 60 * 60 * 1000;
      const twoWeeksAgo = now - 15 * 24 * 60 * 60 * 1000;
      // Many failures, none of them corrections: no correction is reported.
      mockCountOutcomes.mockResolvedValue({ successes: 1, failures: 12 });

      const snapshot = await EvolutionMetricsService.computeSnapshot("ws1");
      const correctionRate = snapshot.metrics.find((m) => m.id === "correction_rate")!;
      expect(correctionRate.value).toBe(0);
      expect(correctionRate.trend).toBe("stable");

      // Archive [CORRECTION] rows and Playbook corrections, one per task.
      mockSearch.mockImplementation((_ws: string, marker: string) => {
        if (!marker.startsWith("[CORRECTION]")) return [];
        return [
          {
            id: "m1",
            type: "insight",
            snippet: "[CORRECTION] A",
            taskId: "t-recent",
            createdAt: now - 100_000,
          },
          {
            id: "m2",
            type: "insight",
            snippet: "[CORRECTION] B",
            taskId: "t-b",
            createdAt: oneWeekAgo,
          },
          {
            id: "m3",
            type: "insight",
            snippet: "[CORRECTION] C",
            taskId: "t-c",
            createdAt: oneWeekAgo - 1000,
          },
          {
            id: "m4",
            type: "insight",
            snippet: "[CORRECTION] D",
            taskId: "t-d",
            createdAt: twoWeeksAgo,
          },
          // A second correction of the same task counts once.
          {
            id: "m5",
            type: "insight",
            snippet: "[CORRECTION] D2",
            taskId: "t-d",
            createdAt: twoWeeksAgo + 1000,
          },
        ];
      });
      mockListCorrections.mockResolvedValue([
        { taskId: "t-e", at: twoWeeksAgo - 1000 },
        { taskId: "t-f", at: twoWeeksAgo - 2000 },
        { taskId: "t-g", at: twoWeeksAgo - 3000 },
        // Already counted from the archive row.
        { taskId: "t-b", at: oneWeekAgo + 5000 },
      ]);

      const improving = (await EvolutionMetricsService.computeSnapshot("ws1")).metrics.find(
        (m) => m.id === "correction_rate",
      )!;
      expect(improving.value).toBe(1); // only t-recent this week
      expect(improving.trend).toBe("improving"); // 6 older corrections over 3 weeks
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
        (await import("../../knowledge-graph/KnowledgeGraphService")).KnowledgeGraphService
          .getStats,
      ).mockReturnValueOnce({
        entityCount: 0,
        edgeCount: 0,
        observationCount: 0,
        entityTypeDistribution: [],
      });
      const snapshot1 = await EvolutionMetricsService.computeSnapshot("ws1");

      // Second snapshot with larger KG
      vi.mocked(
        (await import("../../knowledge-graph/KnowledgeGraphService")).KnowledgeGraphService
          .getStats,
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
