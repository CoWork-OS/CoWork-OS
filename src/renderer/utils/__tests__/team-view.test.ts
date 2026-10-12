import { describe, expect, it } from "vitest";
import type { AttentionItem } from "../../../shared/attention";
import type { Task } from "../../../shared/types";
import {
  buildTeamModel,
  describeTeamSchedule,
  teamInitials,
  type TeamCronJob,
  type TeamRole,
} from "../team-view";

const NOW = new Date(2026, 9, 12, 9, 0).getTime();
const HOUR = 3_600_000;

function role(id: string, overrides: Partial<TeamRole> = {}): TeamRole {
  return {
    id,
    name: id,
    displayName: `Role ${id}`,
    isSystem: false,
    isActive: true,
    ...overrides,
  };
}

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    prompt: "",
    status: "completed",
    workspaceId: "ws",
    createdAt: NOW - 2 * HOUR,
    updatedAt: NOW - HOUR,
    ...overrides,
  } as Task;
}

function job(id: string, overrides: Partial<TeamCronJob> = {}): TeamCronJob {
  return {
    id,
    name: `Job ${id}`,
    enabled: true,
    schedule: { kind: "every", everyMs: 15 * 60_000 },
    workspaceId: "ws",
    taskPrompt: "Refresh the weekly metrics sheet",
    state: { nextRunAtMs: NOW + HOUR },
    ...overrides,
  };
}

const approval = (taskId: string, deviceId?: string) =>
  ({
    id: `approval:${taskId}`,
    kind: "approval",
    state: "Approval needed",
    title: "Send the report",
    createdAt: NOW,
    urgent: true,
    actor: { kind: "agent", name: "x" },
    origin: { kind: "you", label: "" },
    place: deviceId
      ? { kind: "remote", label: "Mac mini", deviceId }
      : { kind: "local", label: "" },
    taskId,
    ref: { type: "approval", approvalId: "a", taskId },
  }) as AttentionItem;

function build(input: Partial<Parameters<typeof buildTeamModel>[0]> = {}) {
  return buildTeamModel({
    roles: [],
    cronJobs: [],
    routines: [],
    devices: [],
    tasks: [],
    attention: [],
    workspaceNames: new Map([["ws", "Acme launch"]]),
    localLabel: "This Mac",
    now: NOW,
    ...input,
  });
}

describe("buildTeamModel", () => {
  it("lists your bots, and built-in agents only when they have work or check in", () => {
    const model = build({
      roles: [
        role("bot"),
        role("idle-system", { isSystem: true }),
        role("busy-system", { isSystem: true }),
        role("heartbeat", { isSystem: true, heartbeatEnabled: true, pulseEveryMinutes: 30 }),
        role("off", { isActive: false }),
      ],
      tasks: [task("t1", { assignedAgentRoleId: "busy-system" })],
    });
    expect(model.members.map((member) => [member.name, member.kindLabel])).toEqual([
      ["Role busy-system", "Agent"],
      ["Role bot", "Bot"],
      ["Role heartbeat", "Agent"],
    ]);
    const heartbeat = model.members.find((member) => member.name === "Role heartbeat")!;
    expect(heartbeat.facts).toContainEqual({ label: "Checks in", value: "Every 30 minutes" });
    const checkedIn = build({
      roles: [role("hb", { heartbeatEnabled: true, lastHeartbeatAt: NOW - HOUR })],
    }).members[0];
    expect(checkedIn.status).toMatch(/^Last checked in today /);
  });

  it("puts teammates waiting on you first and counts their decisions", () => {
    const model = build({
      roles: [role("ops"), role("quiet")],
      tasks: [
        task("t1", { assignedAgentRoleId: "ops", terminalStatus: "awaiting_approval" }),
        task("t2", { assignedAgentRoleId: "quiet", updatedAt: NOW }),
      ],
      attention: [approval("t1")],
    });
    const [first] = model.members;
    expect(first.name).toBe("Role ops");
    expect(first.state).toBe("needs");
    expect(first.status).toBe("Waiting on you · 1 decision");
    expect(first.recent[0]).toMatchObject({ taskId: "t1", statusLabel: "Needs you" });
  });

  it("describes a schedule, leaves automation-made jobs to their automation, and can pause it", () => {
    const model = build({
      cronJobs: [
        job("weekly", { accessProfileId: undefined, assignedAgentRoleId: "ops" }),
        job("compiled", { workflowRoutineId: "r1" }),
        job("paused", { enabled: false }),
      ],
      roles: [role("ops", { displayName: "Ops bot" })],
      routines: [
        {
          id: "r1",
          name: "Weekly report flow",
          enabled: true,
          workspaceId: "ws",
          triggers: [{ type: "schedule" }, { type: "mailbox_event" }],
        },
      ],
    });
    const names = model.members.map((member) => member.name);
    expect(names).not.toContain("Job compiled");
    const weekly = model.members.find((member) => member.name === "Job weekly")!;
    expect(weekly.facts).toEqual([
      { label: "Runs", value: "Every 15 minutes" },
      { label: "Project", value: "Acme launch" },
      { label: "May do alone", value: "Ask for approval" },
      { label: "Done by", value: "Ops bot" },
    ]);
    expect(weekly.schedule).toEqual({ cronJobId: "weekly", enabled: true });
    expect(weekly.open).toEqual({ type: "schedules" });
    const paused = model.members.find((member) => member.name === "Job paused")!;
    expect([paused.state, paused.status]).toEqual(["off", "Paused"]);
    const flow = model.members.find((member) => member.name === "Weekly report flow")!;
    expect(flow.status).toBe("Runs on a schedule, when mail arrives");
    expect(flow.open).toEqual({ type: "routine", routineId: "r1" });
  });

  it("shows this machine and remote devices with what runs and waits on each", () => {
    const model = build({
      devices: [
        { id: "local", name: "Local", role: "local", status: "local" },
        { id: "mini", name: "Mac mini", role: "remote", status: "disconnected" },
      ],
      tasks: [
        task("here", { status: "executing" }),
        task("there", { status: "executing", targetNodeId: "mini" }),
      ],
      attention: [approval("there", "mini")],
    });
    expect(model.devices).toEqual([
      {
        id: "local",
        name: "This Mac",
        local: true,
        online: true,
        statusLabel: "This device",
        running: 1,
        waiting: 0,
      },
      {
        id: "mini",
        name: "Mac mini",
        local: false,
        online: false,
        statusLabel: "Offline",
        running: 1,
        waiting: 1,
      },
    ]);
  });
});

describe("helpers", () => {
  it("describes schedules and makes initials", () => {
    expect(describeTeamSchedule({ kind: "every", everyMs: 3_600_000 })).toBe("Every hour");
    expect(describeTeamSchedule({ kind: "every", everyMs: 2 * 86_400_000 })).toBe("Every 2 days");
    expect(describeTeamSchedule({ kind: "cron", expr: "0 9 * * 1", tz: "UTC" })).toBe(
      "Cron 0 9 * * 1 (UTC)",
    );
    expect(teamInitials("Ops bot")).toBe("OB");
    expect(teamInitials("Weekly")).toBe("W");
  });
});
