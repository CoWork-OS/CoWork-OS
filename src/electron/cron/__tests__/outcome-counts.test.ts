import { beforeEach, describe, expect, it, vi } from "vitest";
import { summarizeCronRunSuccess } from "../../../shared/cron-outcomes";
import {
  cronRunKey,
  reconcileCronOutcomeCounts,
  recordCronRunCompletion,
  resetCronOutcomeCounts,
} from "../outcome-counts";
import type { CronJobStatus, CronJobState, CronRunHistoryEntry } from "../types";

function entry(status: CronJobStatus | string, runAtMs: number): CronRunHistoryEntry {
  return { runAtMs, durationMs: 1, status: status as CronJobStatus };
}

function record(state: CronJobState, status: CronJobStatus, runAtMs: number, max = 10) {
  return recordCronRunCompletion(
    state,
    { ...entry(status, runAtMs), runKey: cronRunKey(runAtMs) },
    max,
  );
}

describe("versioned cron outcome counts", () => {
  it("counts one run of each category exactly once", () => {
    const state: CronJobState = {};
    const statuses: CronJobStatus[] = [
      "ok",
      "partial_success",
      "needs_user_action",
      "error",
      "timeout",
      "cancelled",
      "skipped",
    ];
    statuses.forEach((status, index) => record(state, status, index + 1));
    expect(state.outcomeCounts?.counts).toEqual({
      ok: 1,
      partial_success: 1,
      needs_user_action: 1,
      error: 1,
      timeout: 1,
      cancelled: 1,
      skipped: 1,
      legacyUnknown: 0,
    });
    const summary = summarizeCronRunSuccess(state.outcomeCounts!.counts);
    expect(summary.knownAttempts).toBe(6);
    expect(summary.ratePercent).toBe(17);
    // Legacy fields keep legacy semantics for existing callers.
    expect(state.totalRuns).toBe(7);
    expect(state.successfulRuns).toBe(3);
    expect(state.failedRuns).toBe(4);
  });

  it("100 needs-action runs are 0% run success, not 100%", () => {
    const state: CronJobState = {};
    for (let i = 0; i < 100; i++) record(state, "needs_user_action", i + 1, 10);
    expect(state.successfulRuns).toBe(100);
    expect(summarizeCronRunSuccess(state.outcomeCounts!.counts).ratePercent).toBe(0);
  });

  it("all skipped runs produce no rate", () => {
    const state: CronJobState = {};
    record(state, "skipped", 1);
    record(state, "skipped", 2);
    const summary = summarizeCronRunSuccess(state.outcomeCounts!.counts);
    expect(summary.ratePercent).toBeNull();
    expect(summary.skipped).toBe(2);
  });

  it("ignores a repeated completion for the same run", () => {
    const state: CronJobState = {};
    expect(record(state, "ok", 5)).toBe(true);
    expect(record(state, "error", 5)).toBe(false);
    expect(state.totalRuns).toBe(1);
    expect(state.runHistory).toHaveLength(1);
    expect(state.outcomeCounts!.counts.error).toBe(0);
  });

  it("migrates old totals with ten retained rows without fabricating a lifetime rate", () => {
    const history = Array.from({ length: 10 }, (_, i) => entry(i < 7 ? "ok" : "error", 100 - i));
    const state: CronJobState = {
      totalRuns: 250,
      successfulRuns: 240,
      failedRuns: 10,
      runHistory: history,
    };
    const counts = reconcileCronOutcomeCounts(state);
    expect(counts.counts.ok).toBe(7);
    expect(counts.counts.error).toBe(3);
    expect(counts.counts.legacyUnknown).toBe(240);
    expect(counts.coveredTotalRuns).toBe(250);
    const summary = summarizeCronRunSuccess(counts.counts);
    expect(summary.ratePercent).toBe(70);
    expect(summary.unclassified).toBe(240);
    // The old cumulative successfulRuns is not split into guessed categories.
    expect(counts.counts.partial_success).toBe(0);
  });

  it("keeps unknown historic statuses unknown", () => {
    const state: CronJobState = { totalRuns: 2, runHistory: [entry("mystery", 2), entry("ok", 1)] };
    expect(reconcileCronOutcomeCounts(state).counts).toMatchObject({ ok: 1, legacyUnknown: 1 });
  });

  it("is idempotent across reloads", () => {
    const state: CronJobState = { totalRuns: 3, runHistory: [entry("ok", 3), entry("error", 2)] };
    const first = structuredClone(reconcileCronOutcomeCounts(state));
    const reloaded = JSON.parse(JSON.stringify(state)) as CronJobState;
    expect(reconcileCronOutcomeCounts(reloaded)).toEqual(first);
    expect(reconcileCronOutcomeCounts(reloaded)).toEqual(first);
  });

  it("detects a later legacy writer and classifies only its new retained records", () => {
    const state: CronJobState = {};
    record(state, "ok", 1);
    // An older build records two more runs: bumps totals and history, not the counts.
    state.totalRuns = 3;
    state.successfulRuns = 3;
    state.runHistory!.unshift(entry("needs_user_action", 3), entry("partial_success", 2));
    const counts = reconcileCronOutcomeCounts(state);
    expect(counts.counts).toMatchObject({ ok: 1, needs_user_action: 1, partial_success: 1 });
    expect(counts.counts.legacyUnknown).toBe(0);
    expect(counts.coveredTotalRuns).toBe(3);
    // Unrecoverable gap (history trimmed by the legacy writer) becomes unknown.
    state.totalRuns = 6;
    expect(reconcileCronOutcomeCounts(state).counts.legacyUnknown).toBe(3);
  });

  it("clearing history resets both representations and later runs count normally", () => {
    const state: CronJobState = {};
    record(state, "ok", 1);
    record(state, "error", 2);
    resetCronOutcomeCounts(state);
    expect(state.totalRuns).toBe(0);
    expect(summarizeCronRunSuccess(state.outcomeCounts!.counts).ratePercent).toBeNull();
    record(state, "ok", 3);
    expect(state.outcomeCounts!.counts).toMatchObject({ ok: 1, error: 0 });
    expect(state.totalRuns).toBe(1);
  });
});

// Service-level behavior: classification of the durable task result.
vi.mock("electron", () => ({ app: { getPath: vi.fn().mockReturnValue("/mock/user/data") } }));
vi.mock("../store", () => ({
  loadCronStore: vi.fn().mockResolvedValue({ version: 1, jobs: [] }),
  saveCronStore: vi.fn().mockResolvedValue(undefined),
  resolveCronStorePath: vi.fn().mockImplementation((p) => p || "/mock/cron/jobs.json"),
}));
vi.mock("../webhook", () => ({
  CronWebhookServer: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    getAddress: vi.fn().mockReturnValue(null),
    setTriggerHandler: vi.fn(),
    setJobLookup: vi.fn(),
  })),
}));

import { CronService } from "../service";
import type { CronServiceDeps } from "../types";

describe("CronService run outcome classification", () => {
  let clock = 1_000_000;
  beforeEach(() => {
    clock = 1_000_000;
  });

  async function runOnce(
    taskStatus: Record<string, unknown>,
    overrides: Partial<CronServiceDeps> = {},
    jobExtras: Record<string, unknown> = {},
  ) {
    const service = new CronService({
      cronEnabled: true,
      storePath: "/test/cron/jobs.json",
      createTask: vi.fn().mockResolvedValue({ id: "task-1" }),
      getTaskStatus: vi.fn().mockResolvedValue(taskStatus),
      nowMs: () => clock++,
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      ...overrides,
    } as CronServiceDeps);
    await service.start();
    const added = await service.add({
      name: "Job",
      enabled: true,
      workspaceId: "ws",
      taskPrompt: "Do it",
      schedule: { kind: "every", everyMs: 60_000 },
      ...jobExtras,
    });
    if (!added.ok) throw new Error(added.error);
    await service.run(added.job.id, "force");
    const history = await service.getRunHistory(added.job.id);
    await service.stop();
    return history!;
  }

  it("keeps cancellation distinct from failure", async () => {
    const history = await runOnce({ status: "cancelled" });
    expect(history.entries[0].status).toBe("cancelled");
    expect(history.outcomeCounts.cancelled).toBe(1);
    expect(history.outcomeCounts.error).toBe(0);
  });

  it("classifies a completed task with a failed terminal status as an error", async () => {
    const history = await runOnce({ status: "completed", terminalStatus: "failed" });
    expect(history.entries[0].status).toBe("error");
    expect(history.outcomeCounts.ok).toBe(0);
  });

  it("a successful run with failed delivery keeps both facts", async () => {
    const history = await runOnce(
      { status: "completed", terminalStatus: "ok" },
      { deliverToChannel: vi.fn().mockRejectedValue(new Error("channel down")) },
      { delivery: { enabled: true, channelType: "slack", channelId: "C1" } },
    );
    expect(history.outcomeCounts.ok).toBe(1);
    expect(history.entries[0].status).toBe("ok");
    // The failed delivery is queued for retry; the execution outcome is untouched.
    expect(history.entries[0].deliverableStatus).toBe("queued");
  });
});

describe("CronService follow-up and workflow runs", () => {
  async function runJob(job: Record<string, unknown>, overrides: Partial<CronServiceDeps>) {
    const service = new CronService({
      cronEnabled: true,
      storePath: "/test/cron/jobs.json",
      createTask: vi.fn().mockResolvedValue({ id: "unused" }),
      nowMs: (() => {
        let clock = 2_000_000;
        return () => clock++;
      })(),
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      ...overrides,
    } as CronServiceDeps);
    await service.start();
    const added = await service.add({
      name: "Job",
      enabled: true,
      workspaceId: "ws",
      taskPrompt: "Do it",
      schedule: { kind: "every", everyMs: 60_000 },
      ...job,
    } as never);
    if (!added.ok) throw new Error(added.error);
    await service.run(added.job.id, "force");
    const history = await service.getRunHistory(added.job.id);
    await service.stop();
    return history!;
  }

  it("classifies a delivered thread follow-up by the thread's durable result", async () => {
    const history = await runJob(
      { runMode: "thread_follow_up", targetTaskId: "thread-1" },
      {
        sendTaskMessage: vi.fn().mockResolvedValue({ queued: false }),
        getTaskStatus: vi
          .fn()
          .mockResolvedValue({ status: "completed", terminalStatus: "needs_user_action" }),
      },
    );
    expect(history.entries[0].status).toBe("needs_user_action");
    expect(history.outcomeCounts.ok).toBe(0);
  });

  it("does not count a merely sent message as success when the thread failed", async () => {
    const history = await runJob(
      { runMode: "thread_follow_up", targetTaskId: "thread-1" },
      {
        sendTaskMessage: vi.fn().mockResolvedValue({ queued: false }),
        getTaskStatus: vi.fn().mockResolvedValue({ status: "failed", error: "boom" }),
      },
    );
    expect(history.entries[0].status).toBe("error");
  });

  it("records a follow-up queued behind an active run as skipped, not success", async () => {
    const history = await runJob(
      { runMode: "thread_follow_up", targetTaskId: "thread-1" },
      {
        sendTaskMessage: vi.fn().mockResolvedValue({ queued: true }),
        getTaskStatus: vi.fn().mockResolvedValue({ status: "executing" }),
      },
    );
    expect(history.entries[0].status).toBe("skipped");
    expect(summarizeCronRunSuccess(history.outcomeCounts).ratePercent).toBeNull();
  });

  it.each(["queued", "running"])(
    "records a workflow run that is still %s as an unknown outcome",
    async (workflowStatus) => {
      const history = await runJob(
        { runMode: "workflow", workflowRoutineId: "routine-1" },
        {
          executeWorkflow: vi.fn().mockResolvedValue({ runId: "r1", status: workflowStatus }),
        },
      );
      expect(history.entries[0].status).toBe("unknown");
      expect(history.outcomeCounts.legacyUnknown).toBe(1);
      expect(history.outcomeCounts.partial_success).toBe(0);
    },
  );
});
