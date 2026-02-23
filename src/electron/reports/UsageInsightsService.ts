import Database from "better-sqlite3";

export interface UsageInsights {
  periodStart: number;
  periodEnd: number;
  workspaceId: string;
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

  formatted: string;
}

/**
 * Aggregates usage data from the tasks and task_events tables
 * to produce weekly/monthly insight reports.
 */
export class UsageInsightsService {
  constructor(private db: Database.Database) {}

  generate(workspaceId: string, periodDays = 7): UsageInsights {
    const now = Date.now();
    const periodStart = now - periodDays * 24 * 60 * 60 * 1000;
    const periodEnd = now;

    const taskMetrics = this.getTaskMetrics(workspaceId, periodStart, periodEnd);
    const costMetrics = this.getCostMetrics(workspaceId, periodStart, periodEnd);
    const activityPattern = this.getActivityPattern(workspaceId, periodStart, periodEnd);
    const topSkills = this.getTopSkills(workspaceId, periodStart, periodEnd);

    const formatted = this.formatReport(
      periodDays,
      taskMetrics,
      costMetrics,
      activityPattern,
      topSkills,
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
      formatted,
    };
  }

  private getTaskMetrics(
    workspaceId: string,
    periodStart: number,
    periodEnd: number,
  ): UsageInsights["taskMetrics"] {
    // Single query with GROUP BY instead of 4 separate count queries
    const rows = this.db
      .prepare(
        `SELECT status, COUNT(*) as count,
                AVG(CASE WHEN status = 'completed' AND completed_at IS NOT NULL THEN completed_at - created_at END) as avg_time
         FROM tasks
         WHERE workspace_id = ? AND created_at >= ? AND created_at <= ?
         GROUP BY status`,
      )
      .all(workspaceId, periodStart, periodEnd) as Array<{
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
    workspaceId: string,
    periodStart: number,
    periodEnd: number,
  ): UsageInsights["costMetrics"] {
    let totalCost = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    const modelMap = new Map<string, { cost: number; calls: number }>();

    try {
      const rows = this.db
        .prepare(
          `SELECT te.payload
           FROM task_events te
           JOIN tasks t ON te.task_id = t.id
           WHERE t.workspace_id = ? AND te.type = 'llm_usage'
             AND te.timestamp >= ? AND te.timestamp <= ?`,
        )
        .all(workspaceId, periodStart, periodEnd) as Array<{ payload: string }>;

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
    workspaceId: string,
    periodStart: number,
    periodEnd: number,
  ): UsageInsights["activityPattern"] {
    const tasksByDayOfWeek = Array.from({ length: 7 }, () => 0);
    const tasksByHour = Array.from({ length: 24 }, () => 0);

    try {
      const rows = this.db
        .prepare(
          "SELECT created_at FROM tasks WHERE workspace_id = ? AND created_at >= ? AND created_at <= ?",
        )
        .all(workspaceId, periodStart, periodEnd) as Array<{ created_at: number }>;

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
    workspaceId: string,
    periodStart: number,
    periodEnd: number,
  ): UsageInsights["topSkills"] {
    try {
      const rows = this.db
        .prepare(
          `SELECT te.payload
           FROM task_events te
           JOIN tasks t ON te.task_id = t.id
           WHERE t.workspace_id = ? AND te.type = 'skill_used'
             AND te.timestamp >= ? AND te.timestamp <= ?`,
        )
        .all(workspaceId, periodStart, periodEnd) as Array<{ payload: string }>;

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

  private formatReport(
    periodDays: number,
    taskMetrics: UsageInsights["taskMetrics"],
    costMetrics: UsageInsights["costMetrics"],
    activityPattern: UsageInsights["activityPattern"],
    topSkills: UsageInsights["topSkills"],
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

    // Activity pattern
    lines.push("**Activity Pattern:**");
    lines.push(`- Most active day: ${activityPattern.mostActiveDay}`);
    lines.push(
      `- Peak hour: ${activityPattern.mostActiveHour}:00–${activityPattern.mostActiveHour + 1}:00`,
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
