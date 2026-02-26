import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import type {
  AgentAutonomyLevel,
  AgentPerformanceReview,
  AgentReviewGenerateRequest,
  AgentReviewRating,
} from "../../shared/types";

function clampRating(raw: number): AgentReviewRating {
  const rounded = Math.round(raw);
  if (rounded <= 1) return 1;
  if (rounded === 2) return 2;
  if (rounded === 3) return 3;
  if (rounded === 4) return 4;
  return 5;
}

function safeJsonParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export class AgentPerformanceReviewService {
  constructor(private db: Database.Database) {}

  generate(request: AgentReviewGenerateRequest): AgentPerformanceReview {
    const periodDays = Math.max(1, Math.min(90, Number(request.periodDays || 7) || 7));
    const periodEnd = Date.now();
    const periodStart = periodEnd - periodDays * 24 * 60 * 60 * 1000;

    // Tasks in period
    const taskRows = this.db
      .prepare(`
      SELECT id, status, created_at, updated_at, completed_at
      FROM tasks
      WHERE workspace_id = ?
        AND assigned_agent_role_id = ?
        AND updated_at >= ?
    `)
      .all(request.workspaceId, request.agentRoleId, periodStart) as Array<{
      id: string;
      status: string;
      created_at: number;
      updated_at: number;
      completed_at: number | null;
    }>;

    const completed = taskRows.filter(
      (t) => t.status === "completed" && typeof t.completed_at === "number",
    );
    const failed = taskRows.filter((t) => t.status === "failed");
    const cancelled = taskRows.filter((t) => t.status === "cancelled");
    const active = taskRows.filter((t) =>
      ["pending", "queued", "planning", "executing", "paused", "blocked"].includes(t.status),
    );

    const durations = completed
      .map((t) => (t.completed_at || 0) - t.created_at)
      .filter((d) => Number.isFinite(d) && d > 0);
    const avgDurationMs =
      durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;

    // Mentions in period (directed to this agent role)
    const mentionCounts = this.db
      .prepare(`
      SELECT
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
        COUNT(*) AS total
      FROM agent_mentions
      WHERE workspace_id = ?
        AND to_agent_role_id = ?
        AND created_at >= ?
    `)
      .get(request.workspaceId, request.agentRoleId, periodStart) as {
      pending: number | null;
      total: number | null;
    };

    const pendingMentions = mentionCounts?.pending ? Number(mentionCounts.pending) : 0;
    const totalMentions = mentionCounts?.total ? Number(mentionCounts.total) : 0;

    // Activity in period (attributed to this agent role)
    const activityCountRow = this.db
      .prepare(`
      SELECT COUNT(*) AS total
      FROM activity_feed
      WHERE workspace_id = ?
        AND agent_role_id = ?
        AND created_at >= ?
    `)
      .get(request.workspaceId, request.agentRoleId, periodStart) as { total: number | null };

    const activityCount = activityCountRow?.total ? Number(activityCountRow.total) : 0;

    // Score (simple, deterministic)
    let score = 3;
    if (completed.length >= 10) score += 1.5;
    else if (completed.length >= 5) score += 1;
    else if (completed.length >= 1) score += 0.5;

    score -= Math.min(2, failed.length * 0.75);
    if (pendingMentions > 0) score -= Math.min(1, pendingMentions * 0.15);

    // Small positive signal if the agent is leaving a trail of activity.
    if (activityCount >= 10) score += 0.25;

    const rating = clampRating(score);

    const metrics: Record<string, number> = {
      periodDays,
      tasksTotal: taskRows.length,
      tasksCompleted: completed.length,
      tasksFailed: failed.length,
      tasksCancelled: cancelled.length,
      tasksActive: active.length,
      avgCompletionMinutes: avgDurationMs ? Math.round(avgDurationMs / 60000) : 0,
      mentionsTotal: totalMentions,
      mentionsPending: pendingMentions,
      activityCount,
    };

    const recommendedAutonomyLevel: AgentAutonomyLevel = (() => {
      if (rating <= 2) return "intern";
      if (rating >= 5 && completed.length >= 5 && failed.length === 0) return "lead";
      if (rating >= 4 && completed.length >= 10 && failed.length === 0) return "lead";
      return "specialist";
    })();

    const rationaleParts: string[] = [];
    rationaleParts.push(
      `Rating derived from recent throughput and reliability over the last ${periodDays} day(s).`,
    );
    if (failed.length > 0) rationaleParts.push(`Failures observed: ${failed.length}.`);
    if (pendingMentions > 0) rationaleParts.push(`Pending mentions: ${pendingMentions}.`);
    if (completed.length > 0 && metrics.avgCompletionMinutes > 0) {
      rationaleParts.push(`Average completion time: ${metrics.avgCompletionMinutes} min.`);
    }

    const summaryLines: string[] = [];
    summaryLines.push(`Period: last ${periodDays} day(s)`);
    summaryLines.push(
      `Tasks: ${completed.length} completed, ${failed.length} failed, ${cancelled.length} cancelled, ${active.length} active`,
    );
    summaryLines.push(`Mentions: ${pendingMentions}/${totalMentions} pending/total`);
    if (metrics.avgCompletionMinutes > 0)
      summaryLines.push(`Avg completion: ${metrics.avgCompletionMinutes} min`);
    summaryLines.push(`Recommended level: ${recommendedAutonomyLevel}`);

    const review: AgentPerformanceReview = {
      id: uuidv4(),
      workspaceId: request.workspaceId,
      agentRoleId: request.agentRoleId,
      periodStart,
      periodEnd,
      rating,
      summary: summaryLines.join("\n"),
      metrics,
      recommendedAutonomyLevel,
      recommendationRationale: rationaleParts.join(" "),
      createdAt: Date.now(),
    };

    this.db
      .prepare(`
      INSERT INTO agent_performance_reviews (
        id, workspace_id, agent_role_id,
        period_start, period_end,
        rating, summary, metrics,
        recommended_autonomy_level, recommendation_rationale,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        review.id,
        review.workspaceId,
        review.agentRoleId,
        review.periodStart,
        review.periodEnd,
        review.rating,
        review.summary,
        JSON.stringify(review.metrics || {}),
        review.recommendedAutonomyLevel || null,
        review.recommendationRationale || null,
        review.createdAt,
      );

    return review;
  }

  getLatest(workspaceId: string, agentRoleId: string): AgentPerformanceReview | undefined {
    const row = this.db
      .prepare(`
      SELECT *
      FROM agent_performance_reviews
      WHERE workspace_id = ? AND agent_role_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `)
      .get(workspaceId, agentRoleId) as Any;
    return row ? this.mapRow(row) : undefined;
  }

  list(workspaceId: string, agentRoleId?: string, limit: number = 30): AgentPerformanceReview[] {
    const lim = Math.max(1, Math.min(200, Number(limit) || 30));
    if (agentRoleId) {
      const rows = this.db
        .prepare(`
        SELECT *
        FROM agent_performance_reviews
        WHERE workspace_id = ? AND agent_role_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `)
        .all(workspaceId, agentRoleId, lim) as Any[];
      return rows.map((r) => this.mapRow(r));
    }

    const rows = this.db
      .prepare(`
      SELECT *
      FROM agent_performance_reviews
      WHERE workspace_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `)
      .all(workspaceId, lim) as Any[];
    return rows.map((r) => this.mapRow(r));
  }

  delete(reviewId: string): boolean {
    const result = this.db
      .prepare("DELETE FROM agent_performance_reviews WHERE id = ?")
      .run(reviewId);
    return result.changes > 0;
  }

  private mapRow(row: Any): AgentPerformanceReview {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      agentRoleId: row.agent_role_id,
      periodStart: row.period_start,
      periodEnd: row.period_end,
      rating: clampRating(Number(row.rating || 3)),
      summary: row.summary,
      metrics: safeJsonParse<Record<string, number>>(row.metrics, {}),
      recommendedAutonomyLevel: (row.recommended_autonomy_level as AgentAutonomyLevel) || undefined,
      recommendationRationale: row.recommendation_rationale || undefined,
      createdAt: row.created_at,
    };
  }
}
