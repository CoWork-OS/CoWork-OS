/**
 * `watchdog_status`: read-only view of the watchdog control loop (src/electron/agent/watchdog)
 * for one task, so an agent or the person can ask why a task was nudged, paused or resumed.
 */
import type { AgentDaemon } from "../daemon";
import type { LLMTool } from "../llm/types";
import type { TaskEvent, WatchdogDecision } from "../../../shared/types";
import { getWatchdogService } from "../watchdog/WatchdogService";
import { WatchdogSettingsManager } from "../watchdog/watchdog-settings";

const DEFAULT_DECISION_LIMIT = 10;
const MAX_DECISION_LIMIT = 50;

function isDecision(value: unknown): value is WatchdogDecision {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.action === "string" && typeof record.pass === "string";
}

function iso(value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? new Date(value).toISOString()
    : undefined;
}

export class WatchdogTools {
  constructor(
    private readonly daemon: Pick<AgentDaemon, "getTask" | "getTaskEvents">,
    private readonly taskId: string,
  ) {}

  static getToolDefinitions(): LLMTool[] {
    return [
      {
        name: "watchdog_status",
        description:
          "Use when someone asks why the watchdog nudged, paused, resumed, re-queued or retried a task, " +
          "or whether the watchdog is watching it. Read-only: returns the watchdog's settings and its recent " +
          "decisions for this task (or another task in the same workspace), each with its reason, the progress " +
          "verdict and the signals behind it.",
        input_schema: {
          type: "object",
          properties: {
            task_id: {
              type: "string",
              description: "Task to explain. Defaults to the current task.",
            },
            limit: {
              type: "number",
              description: `Most recent decisions to return (1-${MAX_DECISION_LIMIT}, default ${DEFAULT_DECISION_LIMIT}).`,
            },
          },
          required: [],
        },
      },
    ];
  }

  watchdogStatus(input: Record<string, unknown> | undefined): Record<string, unknown> {
    const requested = typeof input?.task_id === "string" ? input.task_id.trim() : "";
    const taskId = requested || this.taskId;
    const task = this.daemon.getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} was not found.`);
    if (taskId !== this.taskId) {
      // Decisions quote task content: stay inside the workspace this task works in.
      const current = this.daemon.getTask(this.taskId);
      if (!current || current.workspaceId !== task.workspaceId) {
        throw new Error("watchdog_status can only explain tasks in this task's workspace.");
      }
    }
    const rawLimit = Number(input?.limit ?? DEFAULT_DECISION_LIMIT);
    const limit = Number.isFinite(rawLimit)
      ? Math.min(MAX_DECISION_LIMIT, Math.max(1, Math.floor(rawLimit)))
      : DEFAULT_DECISION_LIMIT;

    const events: TaskEvent[] = this.daemon.getTaskEvents(taskId, { types: ["watchdog"], limit });
    const decisions = events
      .map((event) => {
        const payload =
          event.payload && typeof event.payload === "object"
            ? (event.payload as Record<string, unknown>)
            : {};
        const decision = isDecision(payload.watchdog) ? payload.watchdog : undefined;
        if (!decision) return null;
        return {
          at: iso(decision.at) ?? iso(event.timestamp),
          pass: decision.pass,
          action: decision.action,
          reason: decision.reason,
          ...(typeof payload.message === "string" ? { message: payload.message } : {}),
          ...(decision.verdict ? { verdict: decision.verdict } : {}),
          ...(decision.loopingOn ? { loopingOn: decision.loopingOn } : {}),
          ...(decision.judge ? { judge: decision.judge } : {}),
          ...(decision.driftStrikes !== undefined ? { driftStrikes: decision.driftStrikes } : {}),
          ...(decision.attempt !== undefined ? { attempt: decision.attempt } : {}),
          ...(decision.signals ? { signals: decision.signals } : {}),
          ...(decision.suspendedMs !== undefined
            ? { suspendedSeconds: Math.round(decision.suspendedMs / 1000) }
            : {}),
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

    const service = getWatchdogService();
    const settings = service?.getSettings() ?? WatchdogSettingsManager.loadEffectiveSettings();
    const status = service?.getStatus(taskId);
    const latestAction = [...decisions].reverse().find((decision) => decision.action !== "none");

    return {
      success: true,
      taskId,
      taskStatus: task.status,
      watchdog: {
        enabled: settings.enabled,
        runningInThisProcess: Boolean(service),
        intervalMinutes: settings.intervalMinutes,
        stallMinutes: settings.stallMinutes,
        progressCheckAfterMinutes: settings.progressCheckAfterMinutes,
        allowCancel: settings.allowCancel,
        ...(iso(status?.lastTickAt) ? { lastRunAt: iso(status?.lastTickAt) } : {}),
        ...(iso(status?.lastResumeAt) ? { lastWakeFromSleepAt: iso(status?.lastResumeAt) } : {}),
      },
      ...(status?.task
        ? {
            currentRun: {
              driftStrikes: status.task.driftStrikes,
              pausesForDrift: status.task.driftPauses,
              recoveryAttempts: status.task.recoveryAttempts,
              ...(iso(status.task.lastJudgedAt)
                ? { lastProgressCheckAt: iso(status.task.lastJudgedAt) }
                : {}),
            },
          }
        : {}),
      decisions,
      summary: latestAction
        ? `Last watchdog action: ${latestAction.action} (${latestAction.pass}) at ${latestAction.at}: ${latestAction.reason}`
        : decisions.length > 0
          ? "The watchdog checked this task and took no action."
          : "The watchdog has made no decisions for this task.",
    };
  }
}
