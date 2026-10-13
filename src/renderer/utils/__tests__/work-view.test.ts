import { describe, expect, it } from "vitest";
import type { AttentionItem } from "../../../shared/attention";
import type { Task, Workspace } from "../../../shared/types";
import {
  DEFAULT_WORK_FILTERS,
  actorInitials,
  buildWorkModel,
  originFactLabel,
  workGroupSummary,
  type WorkFilters,
} from "../work-view";

const NOW = 1_800_000_000_000;
const MIN = 60_000;

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `Session ${id}`,
    prompt: "",
    status: "completed",
    workspaceId: "proj",
    createdAt: NOW - 10 * MIN,
    updatedAt: NOW - 5 * MIN,
    ...overrides,
  } as Task;
}

const workspaces = [
  { id: "proj", name: "Acme launch", path: "/Users/me/acme" } as Workspace,
  { id: "tmp", name: "Scratch", path: "/tmp/scratch", isTemp: true } as Workspace,
];
const context = { localLabel: "This Mac", agentNames: new Map([["role-ops", "Ops bot"]]) };

function build(tasks: Task[], filters: Partial<WorkFilters> = {}, attention: AttentionItem[] = []) {
  return buildWorkModel({
    tasks,
    workspaces,
    attention,
    context,
    filters: { ...DEFAULT_WORK_FILTERS, ...filters },
  });
}

describe("buildWorkModel", () => {
  it("names each session's status from the shared rules", () => {
    const model = build([
      task("waiting", { status: "paused", terminalStatus: "needs_user_action" }),
      task("running", { status: "executing" }),
      task("failed", { status: "failed" }),
      task("partial", { terminalStatus: "partial_success" }),
      task("done"),
    ]);
    const rows = model.groups[0].rows.map((row) => [row.title, row.status, row.statusLabel]);
    expect(rows).toEqual([
      ["Session waiting", "needs", "Response needed"],
      ["Session running", "running", "Running"],
      ["Session failed", "failed", "Failed"],
      ["Session partial", "done", "Partly done"],
      ["Session done", "done", "Done"],
    ]);
    expect(model.counts).toEqual({ all: 5, needs: 1, running: 1, done: 2, failed: 1 });
  });

  it("collapses repeated runs of the same work and leads with the one that needs you", () => {
    const model = build([
      task("a", { title: "Banner test", updatedAt: NOW - 1 * MIN }),
      task("b", { title: "banner  test", updatedAt: NOW - 3 * MIN, status: "failed" }),
      task("c", { title: "Banner test", updatedAt: NOW - 2 * MIN, status: "paused" }),
    ]);
    const [row] = model.groups[0].rows;
    expect(model.groups[0].rows).toHaveLength(1);
    expect(row.runs.map((run) => run.task.id)).toEqual(["a", "c", "b"]);
    expect(row.task.id).toBe("c");
    expect(row.status).toBe("needs");
    expect(row.at).toBe(NOW - 1 * MIN);
  });

  it("groups by project, newest first, with sessions outside a project last", () => {
    const model = build([
      task("scratch", { workspaceId: "tmp", updatedAt: NOW }),
      task("old", { updatedAt: NOW - 60 * MIN }),
    ]);
    expect(model.groups.map((group) => group.label)).toEqual(["Acme launch", "No project"]);
  });

  it("leaves out sub-agents, side chats and agent panel turns", () => {
    const model = build([
      task("child", { parentTaskId: "root" }),
      task("side", { source: "side_chat" }),
      task("panel", { source: "managed_agent_panel" }),
      task("root"),
    ]);
    expect(model.groups[0].rows.map((row) => row.task.id)).toEqual(["root"]);
  });

  it("takes the next decision from the queue and marks the session as needing you", () => {
    const decision = {
      id: "approval:a1",
      kind: "approval",
      state: "Approval needed",
      title: "Delete 14 build folders",
      createdAt: NOW,
      urgent: true,
      actor: { kind: "you", name: "You" },
      origin: { kind: "you", label: "" },
      place: { kind: "local", label: "" },
      taskId: "t1",
      ref: { type: "approval", approvalId: "a1", taskId: "t1" },
    } as AttentionItem;
    const [row] = build([task("t1", { status: "executing" })], {}, [decision]).groups[0].rows;
    expect(row.status).toBe("needs");
    expect(row.statusLabel).toBe("Approval needed");
    expect(row.decision?.title).toBe("Delete 14 build folders");
  });

  it("filters by status, search, origin and owner, counting before the status filter", () => {
    const tasks = [
      task("mine", { title: "Write the memo", status: "executing" }),
      task("cron", { title: "Weekly metrics", source: "cron", assignedAgentRoleId: "role-ops" }),
    ];
    const needsOnly = build(tasks, { status: "needs" });
    expect(needsOnly.groups).toEqual([]);
    expect(needsOnly.counts.all).toBe(2);

    expect(build(tasks, { query: "memo" }).groups[0].rows.map((row) => row.task.id)).toEqual([
      "mine",
    ]);
    expect(build(tasks, { origin: "schedule" }).groups[0].rows.map((row) => row.task.id)).toEqual([
      "cron",
    ]);
    const ops = build(tasks, { actor: "Ops bot" });
    expect(ops.groups[0].rows.map((row) => row.task.id)).toEqual(["cron"]);
    expect(ops.actors).toEqual(["You", "Ops bot"]);
  });
});

describe("helpers", () => {
  it("summarizes a group and makes avatar initials", () => {
    const group = build([
      task("w", { status: "paused", terminalStatus: "needs_user_action" }),
      task("r", { status: "executing" }),
    ]).groups[0];
    expect(workGroupSummary(group)).toBe("1 needs you · 1 running");
    expect(workGroupSummary(build([task("d")]).groups[0])).toBe("1 session");
    expect(actorInitials("Ops bot")).toBe("OB");
    expect(actorInitials("You")).toBe("Y");
    expect(originFactLabel({ kind: "schedule", label: "Started by a schedule" })).toBe(
      "A schedule",
    );
    expect(originFactLabel({ kind: "background", label: "Started by Heartbeat" })).toBe(
      "Heartbeat",
    );
  });
});
