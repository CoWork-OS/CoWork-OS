import { afterEach, describe, expect, it, vi } from "vitest";
import { UsageInsightsService } from "../../../electron/reports/UsageInsightsService";
import type { Workspace } from "../../../shared/types";
import { createBrowserReportDefinitions } from "../browser-report-methods";

afterEach(() => vi.restoreAllMocks());

describe("browser report definitions", () => {
  it("limits usage reports to readable workspaces and clamps desktop-compatible periods", async () => {
    const generate = vi
      .spyOn(UsageInsightsService.prototype, "generate")
      .mockReturnValue({ periodDays: 365 } as never);
    const resolveWorkspace = vi.fn(async (workspaceId: string) =>
      workspaceId === "allowed"
        ? ({ id: workspaceId, permissions: { read: true } } as Workspace)
        : null,
    );
    const definitions = createBrowserReportDefinitions({
      db: {} as never,
      resolveWorkspace,
    });
    const method = definitions.getUsageInsights;
    const args = method.validate?.(["allowed", 900]) ?? [];

    await expect(method.handler(args, {} as never)).resolves.toEqual({ periodDays: 365 });
    expect(generate).toHaveBeenCalledWith("allowed", 365);

    const forbidden = method.validate?.(["restricted", 30]) ?? [];
    await expect(method.handler(forbidden, {} as never)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid report arguments before running a query", () => {
    const definitions = createBrowserReportDefinitions({ db: {} as never });
    expect(() => definitions.getUsageInsights.validate?.(["", 7])).toThrow();
    expect(() => definitions.getUsageInsights.validate?.(["workspace", "30"])).toThrow();
    expect(() => definitions.getUsageInsightsEarliest.validate?.([])).toThrow();
  });
});
