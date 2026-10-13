import {
  classifyTaskActivity,
  indexDevicesByNode,
  isLocalTaskNode,
  type AttentionItem,
} from "../../shared/attention";
import { getAccessProfileLabel } from "../../shared/access-profiles";
import { deriveCanonicalTaskStatus } from "../../shared/task-status";
import type { AgentAutonomyLevel, Task } from "../../shared/types";

/**
 * The Team view: everyone and everything that works on the user's behalf, shown as
 * teammates. Agent roles and bots, scheduled tasks and automations each say what they are
 * doing, what they wait on the user for, and where to change them. Devices are the places
 * the work runs.
 *
 * Nothing here grants or changes permissions. How much a teammate may do alone is shown as
 * it is configured (access profile, autonomy level) and changed where it is set today.
 */

/** The agent role fields the Team view reads. */
export interface TeamRole {
  id: string;
  name: string;
  displayName: string;
  description?: string;
  icon?: string;
  color?: string;
  isSystem: boolean;
  isActive: boolean;
  roleKind?: string;
  sourceTemplateId?: string;
  autonomyLevel?: AgentAutonomyLevel;
  heartbeatEnabled?: boolean;
  pulseEveryMinutes?: number;
  heartbeatIntervalMinutes?: number;
  heartbeatStatus?: string;
  lastHeartbeatAt?: number;
  autoPausedAt?: number | null;
}

export type TeamSchedule =
  | { kind: "at"; atMs: number }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | { kind: "cron"; expr: string; tz?: string };

/** The scheduled-task fields the Team view reads. */
export interface TeamCronJob {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  accessProfileId?: string;
  schedule: TeamSchedule;
  workspaceId: string;
  taskPrompt: string;
  assignedAgentRoleId?: string;
  /** Set when an automation's schedule trigger compiled into this job. */
  workflowRoutineId?: string;
  state: {
    nextRunAtMs?: number;
    runningAtMs?: number;
    lastRunAtMs?: number;
    lastStatus?: string;
    lastTaskId?: string;
    runHistory?: Array<{ runAtMs: number; status: string; taskId?: string }>;
  };
}

/** The automation fields the Team view reads. */
export interface TeamRoutine {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  workspaceId: string;
  triggers?: Array<{ type: string; enabled?: boolean }>;
  updatedAt?: number;
}

export interface TeamDeviceInput {
  id: string;
  name: string;
  role: "local" | "remote";
  status: string;
  /** The node id tasks routed to the device carry. */
  taskNodeId?: string | null;
  clientId?: string;
}

export type TeamMemberKind = "bot" | "agent" | "schedule" | "automation";
export type TeamMemberState = "needs" | "running" | "idle" | "off";

export type TeamOpenTarget =
  | { type: "bots" }
  | { type: "schedules" }
  | { type: "routine"; routineId: string };

export interface TeamRecentItem {
  id: string;
  title: string;
  statusLabel: string;
  at: number;
  taskId?: string;
}

export interface TeamMember {
  id: string;
  kind: TeamMemberKind;
  kindLabel: string;
  name: string;
  /** Role colour, when the role has one. */
  color?: string;
  state: TeamMemberState;
  /** One line under the name: what it is doing or waiting for. */
  status: string;
  /** What it is responsible for, in its own description or prompt. */
  description?: string;
  /** Short labelled facts: where it works, when it runs, how much it may do alone. */
  facts: Array<{ label: string; value: string }>;
  /** Queue items waiting on the user for this teammate. */
  waiting: AttentionItem[];
  recent: TeamRecentItem[];
  open: TeamOpenTarget;
  /** Scheduled tasks can be paused and resumed from here. */
  schedule?: { cronJobId: string; enabled: boolean };
  lastActiveAt: number;
}

export interface TeamDevice {
  id: string;
  name: string;
  local: boolean;
  online: boolean;
  statusLabel: string;
  running: number;
  waiting: number;
}

export interface TeamModel {
  members: TeamMember[];
  devices: TeamDevice[];
}

const RECENT_LIMIT = 5;

const AUTONOMY_LABEL: Record<AgentAutonomyLevel, string> = {
  intern: "Intern",
  specialist: "Specialist",
  lead: "Lead",
};

const TRIGGER_LABEL: Record<string, string> = {
  schedule: "on a schedule",
  api: "when called from the API",
  connector_event: "on a connector event",
  channel_event: "on a channel message",
  mailbox_event: "when mail arrives",
  github_event: "on a GitHub event",
  manual: "when you start it",
};

const CRON_STATUS_LABEL: Record<string, string> = {
  ok: "Done",
  partial_success: "Partly done",
  needs_user_action: "Needs you",
  error: "Failed",
  skipped: "Skipped",
  timeout: "Timed out",
  cancelled: "Cancelled",
};

function clip(text: string | undefined, max: number): string | undefined {
  const clean = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return undefined;
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

function formatWhen(timestamp: number, now: number): string {
  const date = new Date(timestamp);
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const sameDay = new Date(now).toDateString() === date.toDateString();
  if (sameDay) return `today ${time}`;
  return `${date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} ${time}`;
}

/** "Every 15 minutes", "Once, Oct 14 9:00 AM", or the cron expression. */
export function describeTeamSchedule(schedule: TeamSchedule): string {
  switch (schedule.kind) {
    case "at":
      return `Once, ${new Date(schedule.atMs).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })}`;
    case "every": {
      const units: Array<[number, string]> = [
        [86_400_000, "day"],
        [3_600_000, "hour"],
        [60_000, "minute"],
      ];
      for (const [size, unit] of units) {
        if (schedule.everyMs >= size) {
          const count = Math.round(schedule.everyMs / size);
          return count === 1 ? `Every ${unit}` : `Every ${count} ${unit}s`;
        }
      }
      return `Every ${Math.max(1, Math.round(schedule.everyMs / 1000))} seconds`;
    }
    case "cron":
      return schedule.tz ? `Cron ${schedule.expr} (${schedule.tz})` : `Cron ${schedule.expr}`;
  }
}

function taskStatusLabel(task: Task, waiting: boolean): string {
  if (waiting) return "Needs you";
  const activity = classifyTaskActivity(task);
  if (activity?.category) return activity.label;
  const status = deriveCanonicalTaskStatus(task);
  if (status === "failed") return "Failed";
  if (status === "cancelled") return "Cancelled";
  if (status === "pending" || status === "queued") return "Queued";
  return task.terminalStatus === "partial_success" ? "Partly done" : "Done";
}

/** A user-made bot, as opposed to a built-in or template-backed role. */
function isBotRole(role: TeamRole): boolean {
  return (
    role.isSystem !== true &&
    role.roleKind !== "system" &&
    role.roleKind !== "persona_template" &&
    !role.sourceTemplateId
  );
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function buildTeamModel(input: {
  roles: readonly TeamRole[];
  cronJobs: readonly TeamCronJob[];
  routines: readonly TeamRoutine[];
  devices: readonly TeamDeviceInput[];
  tasks: readonly Task[];
  attention: readonly AttentionItem[];
  workspaceNames: ReadonlyMap<string, string>;
  localLabel: string;
  now: number;
}): TeamModel {
  const { now } = input;
  const roots = input.tasks.filter((task) => !task.parentTaskId);
  const tasksById = new Map(input.tasks.map((task) => [task.id, task]));
  const waitingByTask = new Map<string, AttentionItem[]>();
  for (const item of input.attention) {
    if (!item.taskId) continue;
    waitingByTask.set(item.taskId, [...(waitingByTask.get(item.taskId) ?? []), item]);
  }
  const project = (workspaceId: string) => input.workspaceNames.get(workspaceId) ?? "No project";

  const members: TeamMember[] = [];

  // Agent roles: bots you made, plus built-in agents that have work or check in on their own.
  for (const role of input.roles) {
    if (!role.isActive) continue;
    const roleTasks = roots
      .filter((task) => task.assignedAgentRoleId === role.id)
      .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
    const bot = isBotRole(role);
    if (!bot && !role.heartbeatEnabled && roleTasks.length === 0) continue;

    // The queue attributes each decision to the roles whose work it is in, including work
    // they delegated, as Bots does. An item without owners falls back to its session's own
    // assignee.
    const waiting = input.attention.filter((item) => {
      if (item.ownerAgentRoleIds) return item.ownerAgentRoleIds.includes(role.id);
      const task = item.taskId ? tasksById.get(item.taskId) : undefined;
      return task?.assignedAgentRoleId === role.id;
    });
    const running = roleTasks.filter((task) => classifyTaskActivity(task)?.category === "running");
    const lastWorkAt = roleTasks[0]?.updatedAt || 0;
    const lastCheckInAt = role.lastHeartbeatAt || 0;
    const lastActiveAt = Math.max(lastWorkAt, lastCheckInAt);
    let state: TeamMemberState = "idle";
    // A Heartbeat check-in is not work; say which one happened last.
    let status = lastWorkAt
      ? `Last active ${formatWhen(lastWorkAt, now)}`
      : lastCheckInAt
        ? `Last checked in ${formatWhen(lastCheckInAt, now)}`
        : "No work yet";
    if (role.autoPausedAt) {
      state = "off";
      status = "Paused: monthly budget reached";
    } else if (waiting.length > 0) {
      state = "needs";
      status = `Waiting on you · ${plural(waiting.length, "decision")}`;
    } else if (running.length > 0) {
      state = "running";
      status = `Running ${clip(running[0].title, 60) ?? "a session"}`;
    } else if (role.heartbeatStatus === "running") {
      state = "running";
      status = "Checking in now";
    }

    const facts: TeamMember["facts"] = [];
    if (role.autonomyLevel) {
      facts.push({ label: "Autonomy level", value: AUTONOMY_LABEL[role.autonomyLevel] });
    }
    if (role.heartbeatEnabled) {
      const minutes = role.pulseEveryMinutes || role.heartbeatIntervalMinutes || 15;
      facts.push({ label: "Checks in", value: `Every ${plural(minutes, "minute")}` });
    }

    members.push({
      id: `role:${role.id}`,
      kind: bot ? "bot" : "agent",
      kindLabel: bot ? "Bot" : "Agent",
      name: role.displayName || role.name,
      color: role.color,
      state,
      status,
      description: clip(role.description, 280),
      facts,
      waiting,
      recent: roleTasks.slice(0, RECENT_LIMIT).map((task) => ({
        id: task.id,
        taskId: task.id,
        title: clip(task.title, 90) ?? "Session",
        statusLabel: taskStatusLabel(task, waitingByTask.has(task.id)),
        at: task.updatedAt || task.createdAt,
      })),
      open: { type: "bots" },
      lastActiveAt,
    });
  }

  // Scheduled tasks. Jobs compiled from an automation's schedule belong to that automation.
  const agentNames = new Map(input.roles.map((role) => [role.id, role.displayName || role.name]));
  for (const job of input.cronJobs) {
    if (job.workflowRoutineId) continue;
    const history = job.state.runHistory ?? [];
    const waiting = history
      .flatMap((entry) => (entry.taskId ? (waitingByTask.get(entry.taskId) ?? []) : []))
      .filter((item, index, all) => all.findIndex((other) => other.id === item.id) === index);
    let state: TeamMemberState = "idle";
    let status = job.state.nextRunAtMs
      ? `Next run ${formatWhen(job.state.nextRunAtMs, now)}`
      : "No run scheduled";
    if (!job.enabled) {
      state = "off";
      status = "Paused";
    } else if (waiting.length > 0 || job.state.lastStatus === "needs_user_action") {
      state = "needs";
      status =
        waiting.length > 0
          ? `Waiting on you · ${plural(waiting.length, "decision")}`
          : "Last run needs you";
    } else if (job.state.runningAtMs) {
      state = "running";
      status = "Running now";
    }

    const facts: TeamMember["facts"] = [
      { label: "Runs", value: describeTeamSchedule(job.schedule) },
      { label: "Project", value: project(job.workspaceId) },
      { label: "May do alone", value: getAccessProfileLabel(job.accessProfileId) },
    ];
    const owner = job.assignedAgentRoleId ? agentNames.get(job.assignedAgentRoleId) : undefined;
    if (owner) facts.push({ label: "Done by", value: owner });

    members.push({
      id: `cron:${job.id}`,
      kind: "schedule",
      kindLabel: "Schedule",
      name: job.name,
      state,
      status,
      description: clip(job.description || job.taskPrompt, 280),
      facts,
      waiting,
      recent: history.slice(0, RECENT_LIMIT).map((entry, index) => ({
        id: `${job.id}:${entry.runAtMs}:${index}`,
        taskId: entry.taskId,
        title: formatWhen(entry.runAtMs, now),
        statusLabel: CRON_STATUS_LABEL[entry.status] ?? entry.status,
        at: entry.runAtMs,
      })),
      open: { type: "schedules" },
      schedule: { cronJobId: job.id, enabled: job.enabled },
      lastActiveAt: Math.max(job.state.lastRunAtMs || 0, job.state.runningAtMs || 0),
    });
  }

  // Automations (Automation Studio flows and prompt routines).
  for (const routine of input.routines) {
    const triggers = (routine.triggers ?? []).filter((trigger) => trigger.enabled !== false);
    const when = [
      ...new Set(triggers.map((trigger) => TRIGGER_LABEL[trigger.type] ?? "on an event")),
    ];
    members.push({
      id: `routine:${routine.id}`,
      kind: "automation",
      kindLabel: "Automation",
      name: routine.name,
      state: routine.enabled ? "idle" : "off",
      status: routine.enabled
        ? when.length > 0
          ? `Runs ${when.join(", ")}`
          : "Runs when you start it"
        : "Off",
      description: clip(routine.description, 280),
      facts: [{ label: "Project", value: project(routine.workspaceId) }],
      waiting: [],
      recent: [],
      open: { type: "routine", routineId: routine.id },
      lastActiveAt: routine.updatedAt || 0,
    });
  }

  const STATE_ORDER: Record<TeamMemberState, number> = { needs: 0, running: 1, idle: 2, off: 3 };
  members.sort(
    (a, b) =>
      STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
      b.lastActiveAt - a.lastActiveAt ||
      a.name.localeCompare(b.name),
  );

  // Devices: this machine, then every remote device the app manages. Tasks name their device
  // by node id, which differs from the device id.
  const devicesByNode = indexDevicesByNode(
    input.devices.filter((device) => device.role === "remote"),
  );
  const deviceOf = (task: Task) =>
    isLocalTaskNode(task.targetNodeId)
      ? undefined
      : (devicesByNode.get(task.targetNodeId as string)?.id ?? task.targetNodeId);
  const running = (deviceId?: string) =>
    roots.filter(
      (task) => deviceOf(task) === deviceId && classifyTaskActivity(task)?.category === "running",
    ).length;
  const waiting = (deviceId?: string) =>
    input.attention.filter((item) =>
      deviceId ? item.place.deviceId === deviceId : item.place.kind === "local" && item.taskId,
    ).length;
  const devices: TeamDevice[] = [
    {
      id: "local",
      name: input.localLabel,
      local: true,
      online: true,
      statusLabel: "This device",
      running: running(undefined),
      waiting: waiting(undefined),
    },
    ...input.devices
      .filter((device) => device.role === "remote")
      .map((device) => {
        const online = device.status === "connected";
        const statusLabel = online
          ? "Online"
          : device.status === "disconnected"
            ? "Offline"
            : device.status === "error"
              ? "Connection problem"
              : "Connecting";
        return {
          id: device.id,
          name: device.name,
          local: false,
          online,
          statusLabel,
          running: running(device.id),
          waiting: waiting(device.id),
        };
      }),
  ];

  return { members, devices };
}

/** "OB" for "Ops bot", "W" for "Weekly". */
export function teamInitials(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const letters = words.length === 1 ? words[0][0] : words[0][0] + words[1][0];
  return letters.toLocaleUpperCase();
}
