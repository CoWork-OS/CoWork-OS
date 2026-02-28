import { describe, expect, it } from "vitest";
import { UsageInsightsService } from "../UsageInsightsService";

describe("UsageInsightsService", () => {
  it("counts legacy completed tasks with NULL terminal_status as AWUs", () => {
    const db = {
      prepare: (sql: string) => ({
        all: () => [],
        get: () => {
          if (sql.includes("COUNT(*) as count FROM tasks")) {
            expect(sql).toContain("completed_at >= ? AND completed_at <= ?");
            expect(sql).not.toContain("created_at >= ? AND created_at <= ?");
            // Distinguish whether the AWU query includes the legacy NULL fallback.
            return { count: sql.includes("terminal_status IS NULL") ? 2 : 1 };
          }
          return { count: 0 };
        },
      }),
    };

    const service = new UsageInsightsService(
      db as ConstructorParameters<typeof UsageInsightsService>[0],
    );
    const insights = service.generate("ws-1", 7);

    expect(insights.awuMetrics.awuCount).toBe(2);
  });
});
