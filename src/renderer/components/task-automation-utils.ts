import type { LucideIcon } from "lucide-react";
import { BookOpen, Bug, ListTodo, MessageCircle, ShieldAlert, Sparkles } from "lucide-react";
import type { Task, Workspace } from "../../shared/types";
import { BUILTIN_ACCESS_PROFILE_IDS } from "../../shared/access-profiles";

export type TaskAutomationRunMode = "chat" | "local" | "worktree";
export type TaskAutomationTargetMode = "new_task" | "thread_follow_up";
export type TaskAutomationSchedulePreset =
  | "every30m"
  | "hourly"
  | "daily"
  | "weekdays"
  | "weekly"
  | "custom";

export type TaskAutomationSchedule =
  | { kind: "at"; atMs: number }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | { kind: "cron"; expr: string; tz?: string };

export type TaskRoutineTriggerPreset = TaskAutomationSchedulePreset | "manual";

export interface TaskRoutineCreatePayload {
  name: string;
  description: string;
  enabled: boolean;
  workspaceId: string;
  instructions: string;
  executionTarget: {
    kind: "workspace" | "worktree";
  };
  contextBindings: {
    metadata: Record<string, string>;
  };
  connectorPolicy: {
    mode: "prefer";
    connectorIds: string[];
  };
  connectors: string[];
  approvalPolicy: {
    mode: "inherit" | "confirm_external";
  };
  outputs: Array<{ kind: "task_only" }>;
  triggers: Array<
    | {
        type: "manual";
        enabled: boolean;
      }
    | {
        type: "schedule";
        enabled: boolean;
        schedule: TaskAutomationSchedule;
      }
  >;
}

export interface TaskAutomationTemplate {
  id: string;
  name: string;
  prompt: string;
  schedulePreset: Exclude<TaskAutomationSchedulePreset, "custom">;
  icon: LucideIcon;
}

export const TASK_AUTOMATION_TEMPLATES: TaskAutomationTemplate[] = [
  {
    id: "daily-summary",
    name: "Daily summary",
    prompt:
      "Summarize yesterday's workspace activity and list the follow-up actions that need attention.",
    schedulePreset: "daily",
    icon: ListTodo,
  },
  {
    id: "recent-changes",
    name: "Scan recent changes",
    prompt:
      "Scan recent commits since the last run, or the last 24 hours, for likely bugs and propose minimal fixes.",
    schedulePreset: "daily",
    icon: Bug,
  },
  {
    id: "ci-failures",
    name: "CI failure summary",
    prompt:
      "Summarize CI failures and flaky tests from the last CI window; suggest the highest-impact fixes.",
    schedulePreset: "hourly",
    icon: ShieldAlert,
  },
  {
    id: "weekly-update",
    name: "Weekly update",
    prompt:
      "Synthesize this week's PRs, rollouts, incidents, and reviews into a concise weekly update.",
    schedulePreset: "weekly",
    icon: BookOpen,
  },
  {
    id: "inbox-checkin",
    name: "Inbox check-in",
    prompt:
      "Check for urgent inbox or integration updates and summarize anything that needs my attention.",
    schedulePreset: "every30m",
    icon: MessageCircle,
  },
  {
    id: "regression-watch",
    name: "Regression watch",
    prompt:
      "Compare recent changes to available benchmarks, traces, or logs and flag regressions early.",
    schedulePreset: "daily",
    icon: Sparkles,
  },
];

export function buildTaskAutomationSchedule(
  preset: TaskAutomationSchedulePreset,
  customCron: string,
): TaskAutomationSchedule | null {
  const anchorMs = Date.now();
  switch (preset) {
    case "every30m":
      return { kind: "every", everyMs: 30 * 60 * 1000, anchorMs };
    case "hourly":
      return { kind: "every", everyMs: 60 * 60 * 1000, anchorMs };
    case "daily":
      return { kind: "cron", expr: "0 9 * * *" };
    case "weekdays":
      return { kind: "cron", expr: "0 9 * * 1-5" };
    case "weekly":
      return { kind: "cron", expr: "0 9 * * 1" };
    case "custom": {
      const expr = customCron.trim();
      return expr ? { kind: "cron", expr } : null;
    }
  }
}

export function buildTaskAutomationPrompt(prompt: string, task: Task, deeplink: string): string {
  const sourceLines = [
    "",
    "---",
    `Source task: ${task.title}`,
    `Source task ID: ${task.id}`,
    deeplink ? `Source link: ${deeplink}` : null,
  ].filter((line): line is string => line !== null);
  return `${prompt.trim()}${sourceLines.join("\n")}`;
}

export function buildTaskRoutineCreate({
  task,
  workspace,
  name,
  prompt,
  runMode,
  targetMode = "new_task",
  triggerPreset,
  schedule,
  deeplink,
}: BuildTaskRoutineCreateParams): TaskRoutineCreatePayload {
  const workspaceId = task.workspaceId || workspace?.id || "";
  const effectiveTargetMode = runMode === "worktree" ? "new_task" : targetMode;
  const triggers: TaskRoutineCreatePayload["triggers"] =
    triggerPreset === "manual" || !schedule
      ? [{ type: "manual", enabled: true }]
      : [
          { type: "schedule", enabled: true, schedule },
          { type: "manual", enabled: true },
        ];

  return {
    name: name.trim(),
    description: `Created from task ${task.id}${deeplink ? ` (${deeplink})` : ""}`,
    enabled: true,
    workspaceId,
    instructions: buildTaskAutomationPrompt(prompt, task, deeplink),
    executionTarget: {
      kind: runMode === "worktree" ? "worktree" : "workspace",
    },
    contextBindings: {
      metadata: {
        source: "task_session",
        sourceTaskId: task.id,
        sourceTaskTitle: task.title,
        automationRunMode: effectiveTargetMode,
        ...(effectiveTargetMode === "thread_follow_up"
          ? {
              runMode: "thread_follow_up",
              targetTaskId: task.id,
              threadAutomation: "true",
            }
          : {}),
        ...(task.sessionId ? { sourceSessionId: task.sessionId } : {}),
        ...(deeplink ? { sourceLink: deeplink } : {}),
      },
    },
    connectorPolicy: {
      mode: "prefer",
      connectorIds: [],
    },
    connectors: [],
    approvalPolicy: {
      mode: runMode === "local" ? "confirm_external" : "inherit",
    },
    outputs: [{ kind: "task_only" }],
    triggers,
  };
}

export interface BuildTaskAutomationCronJobCreateParams {
  task: Task;
  workspace: Workspace | null;
  name: string;
  prompt: string;
  runMode: TaskAutomationRunMode;
  targetMode?: TaskAutomationTargetMode;
  schedule: TaskAutomationSchedule;
  deeplink: string;
}

export interface BuildTaskRoutineCreateParams {
  task: Task;
  workspace: Workspace | null;
  name: string;
  prompt: string;
  runMode: TaskAutomationRunMode;
  targetMode?: TaskAutomationTargetMode;
  triggerPreset: TaskRoutineTriggerPreset;
  schedule: TaskAutomationSchedule | null;
  deeplink: string;
}

export function buildTaskAutomationCronJobCreate({
  task,
  workspace,
  name,
  prompt,
  runMode,
  targetMode = "new_task",
  schedule,
  deeplink,
}: BuildTaskAutomationCronJobCreateParams) {
  const workspaceId = task.workspaceId || workspace?.id || "";
  const effectiveTargetMode = runMode === "worktree" ? "new_task" : targetMode;
  return {
    name: name.trim(),
    description: `Created from task ${task.id}${deeplink ? ` (${deeplink})` : ""}`,
    enabled: true,
    accessProfileId: task.agentConfig?.accessProfileId || BUILTIN_ACCESS_PROFILE_IDS.askForApproval,
    allowUserInput: false,
    deleteAfterRun: false,
    schedule,
    workspaceId,
    taskTitle: task.title,
    taskPrompt: buildTaskAutomationPrompt(prompt, task, deeplink),
    runMode: effectiveTargetMode,
    targetTaskId: effectiveTargetMode === "thread_follow_up" ? task.id : undefined,
    threadAutomation:
      effectiveTargetMode === "thread_follow_up"
        ? {
            sourceTaskId: task.id,
            sourceTaskTitle: task.title,
            sourceLink: deeplink || undefined,
            wakeObjective: prompt.trim(),
            includeContextBrief: true,
          }
        : undefined,
  };
}
