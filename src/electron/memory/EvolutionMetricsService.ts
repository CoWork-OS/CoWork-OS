/**
 * EvolutionMetricsService — Quantifies agent improvement over time
 *
 * Computes key evolution metrics that demonstrate the agent is getting
 * better at serving the user. Designed for the "Agent ROI Dashboard"
 * and injection into daily briefings.
 *
 * Metrics computed:
 *   1. Correction Rate Trend — Are user corrections decreasing over time?
 *   2. Adaptation Velocity — How fast is the agent learning new facts/styles?
 *   3. Skill Automation Rate — What fraction of tasks use auto-promoted skills?
 *   4. Style Alignment Score — How well does the agent match user preferences?
 *   5. Knowledge Graph Growth — Is the agent's understanding expanding?
 *   6. Task Success Rate — Overall success/failure trend
 *
 * All data is sourced from existing services — no new storage layer needed.
 * The service is stateless (computes on-demand from live data).
 */

import { MemoryService } from "./MemoryService";
import { AdaptiveStyleEngine } from "./AdaptiveStyleEngine";
import { PlaybookService } from "./PlaybookService";

// ─── Types ────────────────────────────────────────────────────────────

export interface EvolutionSnapshot {
  /** ISO timestamp of when this snapshot was computed. */
  computedAt: string;
  /** How many days the agent has been active. */
  daysTogether: number;
  /** Total tasks completed. */
  tasksCompleted: number;
  /** Individual metrics. */
  metrics: EvolutionMetric[];
  /** Overall evolution score (0-100). */
  overallScore: number;
}

export interface EvolutionMetric {
  /** Machine-readable metric ID. */
  id: string;
  /** Human-readable label. */
  label: string;
  /** Current value. */
  value: number;
  /** Unit of measurement. */
  unit: string;
  /** Trend direction compared to previous period. */
  trend: "improving" | "stable" | "declining";
  /** Short explanation. */
  detail: string;
}

// ─── Constants ────────────────────────────────────────────────────────

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** The archive row the daemon writes once per detected mid-task user correction. */
const CORRECTION_MARKER = "[CORRECTION] User corrected agent";

// ─── Main Service ─────────────────────────────────────────────────────

export class EvolutionMetricsService {
  /**
   * Compute a full evolution snapshot for a workspace.
   * Pulls data from PersonalityManager, MemoryService, KnowledgeGraphService,
   * AdaptiveStyleEngine, and FeedbackService.
   */
  static async computeSnapshot(workspaceId: string): Promise<EvolutionSnapshot> {
    const metrics: EvolutionMetric[] = [];

    // 1. Relationship stats (tasks, days together)
    let daysTogether = 0;
    let tasksCompleted = 0;
    try {
      const { PersonalityManager } = await import("../settings/personality-manager");
      const stats = PersonalityManager.getRelationshipStats();
      daysTogether = stats.daysTogether;
      tasksCompleted = stats.tasksCompleted;
    } catch {
      // optional
    }

    // 2. Correction rate trend
    metrics.push(await this.computeCorrectionRate(workspaceId));

    // 3. Adaptation velocity
    metrics.push(this.computeAdaptationVelocity());

    // 4. Knowledge graph growth
    metrics.push(await this.computeKnowledgeGrowth(workspaceId));

    // 5. Task success rate
    metrics.push(await this.computeTaskSuccessRate(workspaceId));

    // 6. Style alignment score
    metrics.push(this.computeStyleAlignment());

    // Overall score: weighted average of individual metrics (normalized 0-100)
    const overallScore = this.computeOverallScore(metrics);

    return {
      computedAt: new Date().toISOString(),
      daysTogether,
      tasksCompleted,
      metrics,
      overallScore,
    };
  }

  /**
   * Generate a briefing-ready summary string from the evolution snapshot.
   */
  static formatForBriefing(snapshot: EvolutionSnapshot): string {
    const lines = [
      `AGENT EVOLUTION (Day ${snapshot.daysTogether}, ${snapshot.tasksCompleted} tasks completed):`,
    ];

    for (const metric of snapshot.metrics) {
      const trendIcon =
        metric.trend === "improving" ? "+" : metric.trend === "declining" ? "-" : "=";
      lines.push(
        `  [${trendIcon}] ${metric.label}: ${metric.value}${metric.unit} — ${metric.detail}`,
      );
    }

    lines.push(`  Overall Evolution Score: ${snapshot.overallScore}/100`);
    return lines.join("\n");
  }

  // ─── Individual Metric Computers ───────────────────────────────────

  /**
   * Correction rate: tasks the user actually corrected, this week vs. the weekly average of
   * the three weeks before. A correction is a `[CORRECTION]` archive row (the daemon's
   * mid-task correction detection), a Playbook failure classified as a user correction, or
   * success evidence invalidated as `corrected_by_user` (PlaybookService.recordUserCorrection).
   * Each task counts once, at its earliest correction. Other task failures (tool errors,
   * timeouts, rate limits) are not corrections and do not count.
   */
  private static async computeCorrectionRate(workspaceId: string): Promise<EvolutionMetric> {
    try {
      const now = Date.now();
      const since = now - ONE_WEEK_MS * 4;
      const [archived, playbook] = await Promise.all([
        MemoryService.searchByContentMarker(workspaceId, CORRECTION_MARKER, 500),
        PlaybookService.listCorrections(workspaceId, since),
      ]);
      const correctedAt = new Map<string, number>();
      const note = (key: string, at: number) => {
        if (at < since) return;
        const existing = correctedAt.get(key);
        if (existing === undefined || at < existing) correctedAt.set(key, at);
      };
      for (const row of archived) {
        // The marker lookup matched the stored content; the snippet may be its summary.
        if (row.type !== "insight") continue;
        note(row.taskId ? `task:${row.taskId}` : `memory:${row.id}`, row.createdAt);
      }
      for (const correction of playbook) note(`task:${correction.taskId}`, correction.at);

      const times = [...correctedAt.values()];
      const recentCorrections = times.filter((at) => now - at < ONE_WEEK_MS).length;
      const olderCorrections = times.filter((at) => now - at >= ONE_WEEK_MS).length;

      // Compute weekly average for the older period (3 weeks)
      const olderWeeklyAvg = olderCorrections / 3;
      let trend: "improving" | "stable" | "declining" = "stable";
      if (olderWeeklyAvg > 0) {
        if (recentCorrections < olderWeeklyAvg * 0.7) trend = "improving";
        else if (recentCorrections > olderWeeklyAvg * 1.3) trend = "declining";
      }

      return {
        id: "correction_rate",
        label: "Correction Rate",
        value: recentCorrections,
        unit: "/week",
        trend,
        detail:
          trend === "improving"
            ? "Fewer corrections needed this week"
            : trend === "declining"
              ? "More corrections this week than average"
              : "Correction rate is stable",
      };
    } catch {
      return {
        id: "correction_rate",
        label: "Correction Rate",
        value: 0,
        unit: "/week",
        trend: "stable",
        detail: "Insufficient data",
      };
    }
  }

  /**
   * Adaptation velocity: how many style adaptations have occurred.
   */
  private static computeAdaptationVelocity(): EvolutionMetric {
    try {
      const history = AdaptiveStyleEngine.getAdaptationHistory();
      const stats = AdaptiveStyleEngine.getObservationStats();

      const now = Date.now();
      const recentAdaptations = history.filter((h) => now - h.appliedAt < ONE_WEEK_MS * 4).length;

      return {
        id: "adaptation_velocity",
        label: "Style Adaptations",
        value: recentAdaptations,
        unit: " total",
        trend: recentAdaptations > 0 ? "improving" : "stable",
        detail: stats.enabled
          ? `${stats.totalMessages} messages observed, ${recentAdaptations} adaptations applied`
          : "Adaptive style engine disabled",
      };
    } catch {
      return {
        id: "adaptation_velocity",
        label: "Style Adaptations",
        value: 0,
        unit: " total",
        trend: "stable",
        detail: "Adaptive style engine not available",
      };
    }
  }

  /**
   * Knowledge graph growth: entity and relationship counts.
   */
  private static async computeKnowledgeGrowth(workspaceId: string): Promise<EvolutionMetric> {
    try {
      const { KnowledgeGraphService } = await import("../knowledge-graph/KnowledgeGraphService");
      const stats = await KnowledgeGraphService.getStats(workspaceId);

      return {
        id: "knowledge_growth",
        label: "Knowledge Graph",
        value: stats.entityCount,
        unit: " entities",
        trend: stats.entityCount > 0 ? "improving" : "stable",
        detail: `${stats.entityCount} entities, ${stats.edgeCount} relationships, ${stats.observationCount} observations`,
      };
    } catch {
      return {
        id: "knowledge_growth",
        label: "Knowledge Graph",
        value: 0,
        unit: " entities",
        trend: "stable",
        detail: "Knowledge graph not available",
      };
    }
  }

  /**
   * Task success rate: ratio of successful vs. failed Playbook entries.
   */
  private static async computeTaskSuccessRate(workspaceId: string): Promise<EvolutionMetric> {
    try {
      const { successes, failures } = await PlaybookService.countOutcomes(workspaceId);
      const total = successes + failures;

      if (total === 0) {
        return {
          id: "task_success_rate",
          label: "Task Success Rate",
          value: 0,
          unit: "%",
          trend: "stable",
          detail: "No playbook data yet",
        };
      }

      const rate = Math.round((successes / total) * 100);
      return {
        id: "task_success_rate",
        label: "Task Success Rate",
        value: rate,
        unit: "%",
        trend: rate >= 80 ? "improving" : rate >= 60 ? "stable" : "declining",
        detail: `${successes} succeeded, ${failures} failed out of ${total} recorded tasks`,
      };
    } catch {
      return {
        id: "task_success_rate",
        label: "Task Success Rate",
        value: 0,
        unit: "%",
        trend: "stable",
        detail: "Insufficient data",
      };
    }
  }

  /**
   * Style alignment: based on how many adaptations were triggered by negative
   * feedback vs. organic pattern matching. Fewer negative-feedback-driven
   * adaptations = better alignment.
   */
  private static computeStyleAlignment(): EvolutionMetric {
    try {
      const history = AdaptiveStyleEngine.getAdaptationHistory();

      if (history.length === 0) {
        return {
          id: "style_alignment",
          label: "Style Alignment",
          value: 100,
          unit: "%",
          trend: "stable",
          detail: "No adaptations yet — using default style",
        };
      }

      // Count feedback-driven vs. pattern-driven adaptations
      const feedbackDriven = history.filter((h) => h.reason.includes("feedback")).length;
      const patternDriven = history.filter((h) => h.reason.includes("pattern")).length;

      // Higher pattern-driven ratio = agent is proactively aligning
      // Score: 100% if all pattern-driven, lower if many feedback corrections
      const alignmentScore =
        history.length > 0
          ? Math.round(((patternDriven + 0.5 * feedbackDriven) / history.length) * 100)
          : 100;

      return {
        id: "style_alignment",
        label: "Style Alignment",
        value: Math.min(100, alignmentScore),
        unit: "%",
        trend:
          feedbackDriven === 0
            ? "improving"
            : feedbackDriven < patternDriven
              ? "stable"
              : "declining",
        detail: `${patternDriven} proactive adaptations, ${feedbackDriven} from user feedback`,
      };
    } catch {
      return {
        id: "style_alignment",
        label: "Style Alignment",
        value: 0,
        unit: "%",
        trend: "stable",
        detail: "Style engine not available",
      };
    }
  }

  // ─── Composite Score ───────────────────────────────────────────────

  /**
   * Compute an overall evolution score (0-100) from individual metrics.
   */
  private static computeOverallScore(metrics: EvolutionMetric[]): number {
    if (metrics.length === 0) return 0;

    // Weight each metric's trend contribution
    let score = 50; // Start at neutral

    for (const metric of metrics) {
      switch (metric.trend) {
        case "improving":
          score += 10;
          break;
        case "declining":
          score -= 8;
          break;
        // "stable" adds nothing
      }
    }

    // Bonus for high task success rate
    const successRate = metrics.find((m) => m.id === "task_success_rate");
    if (successRate && successRate.value > 0) {
      score += Math.round((successRate.value - 50) / 5); // +0 to +10 for 50-100%
    }

    // Bonus for knowledge graph size
    const kg = metrics.find((m) => m.id === "knowledge_growth");
    if (kg && kg.value > 0) {
      score += Math.min(10, Math.round(kg.value / 10)); // +1 per 10 entities, max +10
    }

    return Math.max(0, Math.min(100, score));
  }
}
