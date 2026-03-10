import { describe, expect, it, vi } from "vitest";
import { DEFAULT_BRIEFING_CONFIG } from "../types";
import { DAILY_BRIEFING_MARKER, syncDailyBriefingCronJob } from "../briefing-scheduler";

describe("syncDailyBriefingCronJob", () => {
  it("removes managed briefing jobs when the briefing is disabled", async () => {
    const remove = vi.fn().mockResolvedValue({ ok: true, removed: true });
    const cronService = {
      list: vi.fn().mockResolvedValue([
        {
          id: "job-1",
          workspaceId: "ws-1",
          name: "Daily Briefing: ws-1",
          description: `Managed daily briefing trigger. [${DAILY_BRIEFING_MARKER}]`,
        },
      ]),
      add: vi.fn(),
      update: vi.fn(),
      remove,
    };

    await syncDailyBriefingCronJob(cronService as never, "ws-1", {
      ...DEFAULT_BRIEFING_CONFIG,
      enabled: false,
    });

    expect(remove).toHaveBeenCalledWith("job-1");
    expect(cronService.add).not.toHaveBeenCalled();
    expect(cronService.update).not.toHaveBeenCalled();
  });

  it("updates one managed job and removes duplicates when enabled", async () => {
    const update = vi.fn().mockResolvedValue({ ok: true });
    const remove = vi.fn().mockResolvedValue({ ok: true, removed: true });
    const cronService = {
      list: vi.fn().mockResolvedValue([
        {
          id: "job-primary",
          workspaceId: "ws-1",
          name: "Daily Briefing: ws-1",
          description: `Managed daily briefing trigger. [${DAILY_BRIEFING_MARKER}]`,
        },
        {
          id: "job-duplicate",
          workspaceId: "ws-1",
          name: "Daily Briefing: ws-1",
          description: `Managed daily briefing trigger. [${DAILY_BRIEFING_MARKER}]`,
        },
      ]),
      add: vi.fn(),
      update,
      remove,
    };

    await syncDailyBriefingCronJob(cronService as never, "ws-1", {
      ...DEFAULT_BRIEFING_CONFIG,
      enabled: true,
      scheduleTime: "09:30",
    });

    expect(update).toHaveBeenCalledWith(
      "job-primary",
      expect.objectContaining({
        enabled: true,
        schedule: { kind: "cron", expr: "30 9 * * *" },
      }),
    );
    expect(remove).toHaveBeenCalledWith("job-duplicate");
    expect(cronService.add).not.toHaveBeenCalled();
  });
});
