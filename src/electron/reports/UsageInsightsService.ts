import Database from "better-sqlite3";

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export interface UsageInsights {
  periodStart: number;
  periodEnd: number;
  workspaceId: string | null;
  generatedAt: number;

  taskMetrics: {
    totalCreated: number;
    completed: number;
    failed: number;
    cancelled: number;
    avgCompletionTimeMs: number | null;
  };

  costMetrics: {
    totalCost: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    costByModel: Array<{ model: string; cost: number; calls: number }>;
  };

  activityPattern: {
    /** Tasks created per day-of-week (0=Sun..6=Sat) */
    tasksByDayOfWeek: number[];
    /** Tasks created per hour bucket (0-23) */
    tasksByHour: number[];
    mostActiveDay: string;
    mostActiveHour: number;
  };

  topSkills: Array<{ skill: string; count: number }>;

  awuMetrics: {
    /** Number of successfully completed tasks (terminal_status = 'ok' or 'partial_success') */
    awuCount: number;
    /** Total tokens consumed across all tasks in the period */
    totalTokens: number;
    /** Total cost across all tasks in the period */
    totalCost: number;
    /** Tokens per AWU (lower is better); null if awuCount === 0 */
    tokensPerAwu: number | null;
    /** Cost per AWU (lower is better); null if awuCount === 0 */
    costPerAwu: number | null;
    /** AWUs per dollar (higher is better); null if totalCost === 0 */
    awuPerDollar: number | null;
    /** Trend comparison vs previous period */
    trend: {
      previousAwuCount: number;
      previousTokensPerAwu: number | null;
      previousCostPerAwu: number | null;
      /** Percentage change in tokensPerAwu: negative means improvement */
      tokensPerAwuChange: number | null;
      /** Percentage change in costPerAwu: negative means improvement */
      costPerAwuChange: number | null;
    };
  };

  formatted: string;
}

/** Returns a SQL WHERE fragment and params for optional workspace filtering. */
function wsFilter(
  workspaceId: string | null,
  alias: string,
): { clause: string; params: unknown[] } {
  if (workspaceId) return { clause: `${alias}workspace_id = ? AND `, params: [workspaceId] };
  return { clause: "", params: [] };
}

/**
 * Aggregates usage data from the tasks and task_events tables
 * to produce weekly/monthly insight reports.
 */
export class UsageInsightsService {
  constructor(private db: Database.Database) {}

  generate(workspaceId: string | null, periodDays = 7): UsageInsights {
    const now = Date.now();
    const periodStart = now - periodDays * 24 * 60 * 60 * 1000;
    const periodEnd = now;

    const taskMetrics = this.getTaskMetrics(workspaceId, periodStart, periodEnd);
    const costMetrics = this.getCostMetrics(workspaceId, periodStart, periodEnd);
    const activityPattern = this.getActivityPattern(workspaceId, periodStart, periodEnd);
    const topSkills = this.getTopSkills(workspaceId, periodStart, periodEnd);
    const awuMetrics = this.getAwuMetrics(workspaceId, periodStart, periodEnd, costMetrics);

    const formatted = this.formatReport(
      periodDays,
      taskMetrics,
      costMetrics,
      activityPattern,
      topSkills,
      awuMetrics,
    );

    return {
      periodStart,
      periodEnd,
      workspaceId,
      generatedAt: now,
      taskMetrics,
      costMetrics,
      activityPattern,
      topSkills,
      awuMetrics,
      formatted,
    };
  }

  private getTaskMetrics(
    workspaceId: string | null,
    periodStart: number,
    periodEnd: number,
  ): UsageInsights["taskMetrics"] {
    const ws = wsFilter(workspaceId, "");
    const rows = this.db
      .prepare(
        `SELECT status, COUNT(*) as count,
                AVG(CASE WHEN status = 'completed' AND completed_at IS NOT NULL THEN completed_at - created_at END) as avg_time
         FROM tasks
         WHERE ${ws.clause}created_at >= ? AND created_at <= ?
         GROUP BY status`,
      )
      .all(...ws.params, periodStart, periodEnd) as Array<{
      status: string;
      count: number;
      avg_time: number | null;
    }>;

    const statusMap = new Map(rows.map((r) => [r.status, r]));
    const totalCreated = rows.reduce((sum, r) => sum + r.count, 0);
    const avgTime = statusMap.get("completed")?.avg_time ?? null;

    return {
      totalCreated,
      completed: statusMap.get("completed")?.count ?? 0,
      failed: statusMap.get("failed")?.count ?? 0,
      cancelled: statusMap.get("cancelled")?.count ?? 0,
      avgCompletionTimeMs: avgTime,
    };
  }

  private getCostMetrics(
    workspaceId: string | null,
    periodStart: number,
    periodEnd: number,
  ): UsageInsights["costMetrics"] {
    let totalCost = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    const modelMap = new Map<string, { cost: number; calls: number }>();

    try {
      const ws = wsFilter(workspaceId, "t.");
      const rows = this.db
        .prepare(
          `SELECT te.payload
           FROM task_events te
           JOIN tasks t ON te.task_id = t.id
           WHERE ${ws.clause}te.type = 'llm_usage'
             AND te.timestamp >= ? AND te.timestamp <= ?`,
        )
        .all(...ws.params, periodStart, periodEnd) as Array<{ payload: string }>;

      for (const row of rows) {
        try {
          const payload = JSON.parse(row.payload);
          const deltaCost = payload.delta?.cost ?? 0;
          const deltaInput = payload.delta?.inputTokens ?? 0;
          const deltaOutput = payload.delta?.outputTokens ?? 0;
          const modelKey = payload.modelKey || payload.modelId || "unknown";

          totalCost += deltaCost;
          totalInputTokens += deltaInput;
          totalOutputTokens += deltaOutput;

          const existing = modelMap.get(modelKey) || { cost: 0, calls: 0 };
          existing.cost += deltaCost;
          existing.calls += 1;
          modelMap.set(modelKey, existing);
        } catch {
          // Skip malformed payloads
        }
      }
    } catch {
      // task_events table may not exist or query may fail
    }

    const costByModel = Array.from(modelMap.entries())
      .map(([model, data]) => ({ model, ...data }))
      .sort((a, b) => b.cost - a.cost);

    return { totalCost, totalInputTokens, totalOutputTokens, costByModel };
  }

  private getActivityPattern(
    workspaceId: string | null,
    periodStart: number,
    periodEnd: number,
  ): UsageInsights["activityPattern"] {
    const tasksByDayOfWeek = Array.from({ length: 7 }, () => 0);
    const tasksByHour = Array.from({ length: 24 }, () => 0);

    try {
      const ws = wsFilter(workspaceId, "");
      const rows = this.db
        .prepare(
          `SELECT created_at FROM tasks WHERE ${ws.clause}created_at >= ? AND created_at <= ?`,
        )
        .all(...ws.params, periodStart, periodEnd) as Array<{ created_at: number }>;

      for (const row of rows) {
        const d = new Date(row.created_at);
        tasksByDayOfWeek[d.getDay()] += 1;
        tasksByHour[d.getHours()] += 1;
      }
    } catch {
      // Gracefully handle missing table
    }

    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const maxDayIdx = tasksByDayOfWeek.indexOf(Math.max(...tasksByDayOfWeek));
    const mostActiveDay = dayNames[maxDayIdx] || "N/A";
    const mostActiveHour = tasksByHour.indexOf(Math.max(...tasksByHour));

    return { tasksByDayOfWeek, tasksByHour, mostActiveDay, mostActiveHour };
  }

  private getTopSkills(
    workspaceId: string | null,
    periodStart: number,
    periodEnd: number,
  ): UsageInsights["topSkills"] {
    try {
      const ws = wsFilter(workspaceId, "t.");
      const rows = this.db
        .prepare(
          `SELECT te.payload
           FROM task_events te
           JOIN tasks t ON te.task_id = t.id
           WHERE ${ws.clause}te.type = 'skill_used'
             AND te.timestamp >= ? AND te.timestamp <= ?`,
        )
        .all(...ws.params, periodStart, periodEnd) as Array<{ payload: string }>;

      const skillCounts = new Map<string, number>();
      for (const row of rows) {
        try {
          const payload = JSON.parse(row.payload);
          const skill = payload.skillName || payload.name || "unknown";
          skillCounts.set(skill, (skillCounts.get(skill) || 0) + 1);
        } catch {
          // Skip
        }
      }

      return Array.from(skillCounts.entries())
        .map(([skill, count]) => ({ skill, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);
    } catch {
      return [];
    }
  }

  private countAwus(workspaceId: string | null, periodStart: number, periodEnd: number): number {
    try {
      const ws = wsFilter(workspaceId, "");
      const row = this.db
        .prepare(
          `SELECT COUNT(*) as count FROM tasks
           WHERE ${ws.clause}completed_at >= ? AND completed_at <= ?
             AND status = 'completed'
             AND (terminal_status IN ('ok', 'partial_success') OR terminal_status IS NULL)`,
        )
        .get(...ws.params, periodStart, periodEnd) as { count: number } | undefined;
      return row?.count ?? 0;
    } catch {
      return 0;
    }
  }

  private getPeriodCost(
    workspaceId: string | null,
    periodStart: number,
    periodEnd: number,
  ): { totalCost: number; totalInputTokens: number; totalOutputTokens: number } {
    let totalCost = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    try {
      const ws = wsFilter(workspaceId, "t.");
      const rows = this.db
        .prepare(
          `SELECT te.payload
           FROM task_events te
           JOIN tasks t ON te.task_id = t.id
           WHERE ${ws.clause}te.type = 'llm_usage'
             AND te.timestamp >= ? AND te.timestamp <= ?`,
        )
        .all(...ws.params, periodStart, periodEnd) as Array<{ payload: string }>;
      for (const row of rows) {
        try {
          const payload = JSON.parse(row.payload);
          totalCost += payload.delta?.cost ?? 0;
          totalInputTokens += payload.delta?.inputTokens ?? 0;
          totalOutputTokens += payload.delta?.outputTokens ?? 0;
        } catch {
          // Skip malformed
        }
      }
    } catch {
      // Gracefully handle
    }
    return { totalCost, totalInputTokens, totalOutputTokens };
  }

  private getAwuMetrics(
    workspaceId: string | null,
    periodStart: number,
    periodEnd: number,
    costMetrics: UsageInsights["costMetrics"],
  ): UsageInsights["awuMetrics"] {
    const awuCount = this.countAwus(workspaceId, periodStart, periodEnd);

    const totalTokens = costMetrics.totalInputTokens + costMetrics.totalOutputTokens;
    const totalCost = costMetrics.totalCost;

    const tokensPerAwu = awuCount > 0 ? Math.round(totalTokens / awuCount) : null;
    const costPerAwu = awuCount > 0 ? totalCost / awuCount : null;
    const awuPerDollar = totalCost > 0 ? awuCount / totalCost : null;

    // Compute previous period for trend comparison
    const periodLengthMs = periodEnd - periodStart;
    const prevStart = periodStart - periodLengthMs;
    const prevEnd = periodStart;

    const previousAwuCount = this.countAwus(workspaceId, prevStart, prevEnd);
    const prevCost = this.getPeriodCost(workspaceId, prevStart, prevEnd);
    const prevTokens = prevCost.totalInputTokens + prevCost.totalOutputTokens;

    const previousTokensPerAwu =
      previousAwuCount > 0 ? Math.round(prevTokens / previousAwuCount) : null;
    const previousCostPerAwu = previousAwuCount > 0 ? prevCost.totalCost / previousAwuCount : null;

    const tokensPerAwuChange =
      tokensPerAwu !== null && previousTokensPerAwu !== null && previousTokensPerAwu > 0
        ? ((tokensPerAwu - previousTokensPerAwu) / previousTokensPerAwu) * 100
        : null;

    const costPerAwuChange =
      costPerAwu !== null && previousCostPerAwu !== null && previousCostPerAwu > 0
        ? ((costPerAwu - previousCostPerAwu) / previousCostPerAwu) * 100
        : null;

    return {
      awuCount,
      totalTokens,
      totalCost,
      tokensPerAwu,
      costPerAwu,
      awuPerDollar,
      trend: {
        previousAwuCount,
        previousTokensPerAwu,
        previousCostPerAwu,
        tokensPerAwuChange,
        costPerAwuChange,
      },
    };
  }

  private formatReport(
    periodDays: number,
    taskMetrics: UsageInsights["taskMetrics"],
    costMetrics: UsageInsights["costMetrics"],
    activityPattern: UsageInsights["activityPattern"],
    topSkills: UsageInsights["topSkills"],
    awuMetrics: UsageInsights["awuMetrics"],
  ): string {
    const lines: string[] = [];
    const label = periodDays === 7 ? "Weekly" : `${periodDays}-Day`;

    lines.push(`**${label} Usage Insights**`, "");

    // Task overview
    lines.push("**Tasks:**");
    lines.push(
      `- ${taskMetrics.totalCreated} created, ${taskMetrics.completed} completed, ${taskMetrics.failed} failed`,
    );
    if (taskMetrics.avgCompletionTimeMs !== null) {
      const avgMins = Math.round(taskMetrics.avgCompletionTimeMs / 60000);
      lines.push(`- Average completion time: ${avgMins} min`);
    }
    lines.push("");

    // Cost overview
    if (costMetrics.totalCost > 0) {
      lines.push("**Cost & Tokens:**");
      lines.push(`- Total cost: $${costMetrics.totalCost.toFixed(4)}`);
      lines.push(
        `- Tokens: ${(costMetrics.totalInputTokens / 1000).toFixed(1)}K input, ${(costMetrics.totalOutputTokens / 1000).toFixed(1)}K output`,
      );
      if (costMetrics.costByModel.length > 0) {
        lines.push("- By model:");
        for (const m of costMetrics.costByModel.slice(0, 5)) {
          lines.push(`  - ${m.model}: $${m.cost.toFixed(4)} (${m.calls} calls)`);
        }
      }
      lines.push("");
    }

    // AWU Efficiency
    if (awuMetrics.awuCount > 0) {
      lines.push("**Agent Efficiency (AWU):**");
      lines.push(`- Work units completed: ${awuMetrics.awuCount}`);
      if (awuMetrics.tokensPerAwu !== null) {
        lines.push(`- Tokens per AWU: ${formatTokens(awuMetrics.tokensPerAwu)}`);
      }
      if (awuMetrics.costPerAwu !== null) {
        lines.push(`- Cost per AWU: $${awuMetrics.costPerAwu.toFixed(4)}`);
      }
      if (awuMetrics.awuPerDollar !== null) {
        lines.push(`- AWUs per dollar: ${awuMetrics.awuPerDollar.toFixed(1)}`);
      }
      if (awuMetrics.trend.tokensPerAwuChange !== null) {
        const dir = awuMetrics.trend.tokensPerAwuChange <= 0 ? "improved" : "worsened";
        lines.push(
          `- Efficiency trend: ${dir} by ${Math.abs(awuMetrics.trend.tokensPerAwuChange).toFixed(0)}% vs previous period`,
        );
      }
      lines.push("");
    }

    // Activity pattern
    lines.push("**Activity Pattern:**");
    lines.push(`- Most active day: ${activityPattern.mostActiveDay}`);
    lines.push(
      `- Peak hour: ${activityPattern.mostActiveHour}:00\u2013${activityPattern.mostActiveHour + 1}:00`,
    );
    lines.push("");

    // Top skills
    if (topSkills.length > 0) {
      lines.push("**Top Skills:**");
      for (const s of topSkills.slice(0, 5)) {
        lines.push(`- ${s.skill}: ${s.count} uses`);
      }
    }

    return lines.join("\n");
  }
}
