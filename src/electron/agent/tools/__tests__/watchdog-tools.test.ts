import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../watchdog/watchdog-settings", () => ({
  WatchdogSettingsManager: {
    loadEffectiveSettings: () => ({
      enabled: false,
      intervalMinutes: 5,
      stallMinutes: 20,
      progressCheckAfterMinutes: 15,
      allowCancel: false,
    }),
  },
}));

import type { Task, TaskEvent } from "../../../../shared/types";
import { setWatchdogService, type WatchdogService } from "../../watchdog/WatchdogService";
import { WatchdogTools } from "../watchdog-tools";

const tasks = new Map<string, Task>([
  ["current", { id: "current", status: "executing", workspaceId: "ws-1" } as Task],
  ["sibling", { id: "sibling", status: "paused", workspaceId: "ws-1" } as Task],
  ["foreign", { id: "foreign", status: "executing", workspaceId: "ws-2" } as Task],
]);

function watchdogEvent(taskId: string, timestamp: number, watchdog: Record<string, unknown>) {
  return {
    id: `e-${timestamp}`,
    taskId,
    timestamp,
    type: "timeline_step_updated",
    legacyType: "watchdog",
    payload: { message: "Watchdog: you appear to be looping on npm test", watchdog },
    schemaVersion: 2,
  } as TaskEvent;
}

function daemon(events: TaskEvent[] = []) {
  return {
    getTask: vi.fn((taskId: string) => tasks.get(taskId)),
    getTaskEvents: vi.fn(() => events),
  };
}

afterEach(() => setWatchdogService(null));

describe("WatchdogTools", () => {
  it("defines a read-only watchdog_status tool that says when to use it", () => {
    const [definition] = WatchdogTools.getToolDefinitions();
    expect(definition.name).toBe("watchdog_status");
    expect(definition.description).toMatch(/^Use when someone asks why the watchdog/);
    expect(definition.input_schema.required).toEqual([]);
  });

  it("explains the latest decision for the current task", () => {
    const events = [
      watchdogEvent("current", 1_000, {
        taskId: "current",
        pass: "progress",
        action: "none",
        reason: "Steady.",
        at: 1_000,
        verdict: "progressing",
      }),
      watchdogEvent("current", 2_000, {
        taskId: "current",
        pass: "progress",
        action: "steer",
        reason: "Keeps rerunning npm test.",
        at: 2_000,
        verdict: "drifting",
        loopingOn: "npm test",
        judge: "model:anthropic/haiku",
        driftStrikes: 1,
        signals: { progressScore: 0, loopRiskIndex: 0.8, repeatedFingerprintCount: 3 },
      }),
    ];
    const source = daemon(events);
    const result = new WatchdogTools(source, "current").watchdogStatus({ limit: 500 });

    expect(source.getTaskEvents).toHaveBeenCalledWith("current", {
      types: ["watchdog"],
      limit: 50,
    });
    expect(result).toMatchObject({
      success: true,
      taskId: "current",
      watchdog: { enabled: false, runningInThisProcess: false, intervalMinutes: 5 },
      summary: expect.stringContaining("Last watchdog action: steer (progress)"),
    });
    expect(result.decisions).toEqual([
      expect.objectContaining({ action: "none", verdict: "progressing" }),
      expect.objectContaining({
        action: "steer",
        loopingOn: "npm test",
        judge: "model:anthropic/haiku",
        driftStrikes: 1,
        message: "Watchdog: you appear to be looping on npm test",
      }),
    ]);
  });

  it("includes the running watchdog's view of the task", () => {
    setWatchdogService({
      getSettings: () => ({
        enabled: true,
        intervalMinutes: 5,
        stallMinutes: 20,
        progressCheckAfterMinutes: 15,
        allowCancel: false,
      }),
      getStatus: () => ({
        enabled: true,
        intervalMinutes: 5,
        lastTickAt: 5_000,
        task: { driftStrikes: 1, driftPauses: 0, recoveryAttempts: 0, lastJudgedAt: 4_000 },
      }),
    } as unknown as WatchdogService);
    const result = new WatchdogTools(daemon(), "current").watchdogStatus({});
    expect(result).toMatchObject({
      watchdog: {
        enabled: true,
        runningInThisProcess: true,
        lastRunAt: new Date(5_000).toISOString(),
      },
      currentRun: { driftStrikes: 1, pausesForDrift: 0, recoveryAttempts: 0 },
      summary: "The watchdog has made no decisions for this task.",
    });
  });

  it("explains another task in the same workspace but not one elsewhere", () => {
    const tools = new WatchdogTools(daemon(), "current");
    expect(tools.watchdogStatus({ task_id: "sibling" })).toMatchObject({ taskId: "sibling" });
    expect(() => tools.watchdogStatus({ task_id: "foreign" })).toThrow(/this task's workspace/);
    expect(() => tools.watchdogStatus({ task_id: "missing" })).toThrow(/not found/);
  });
});
