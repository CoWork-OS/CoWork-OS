import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, Workspace } from "../../../shared/types";

const spies = vi.hoisted(() => ({
  core: {
    listCompanies: vi.fn(async () => [{ id: "company-1" }]),
    listGoals: vi.fn(async () => []),
    listProjects: vi.fn(async () => []),
    listIssues: vi.fn(async () => []),
    listIssueComments: vi.fn(async () => []),
    listRuns: vi.fn(async () => []),
    getRunEvents: vi.fn(async () => []),
  },
  intelligence: {
    getBrief: vi.fn(async () => ({ workspaceIds: ["workspace-1"] })),
    listItems: vi.fn(async () => []),
    getEvidence: vi.fn(async () => []),
    refresh: vi.fn(async () => ({ refreshed: true })),
  },
  activities: { list: vi.fn(async () => [{ id: "activity-1" }]) },
  tasks: {
    findById: vi.fn(async () => null as Task | null),
    moveToColumn: vi.fn(async () => undefined as Task | undefined),
    setPriority: vi.fn(async () => undefined as Task | undefined),
    setDueDate: vi.fn(async () => undefined as Task | undefined),
    setEstimate: vi.fn(async () => undefined as Task | undefined),
  },
  workspaces: {
    findAll: vi.fn(async () => [] as Workspace[]),
  },
  suggestions: {
    listActive: vi.fn(async () => []),
    generateAll: vi.fn(async () => undefined),
    dismiss: vi.fn(async () => true),
    snooze: vi.fn(async () => true),
    recordEditedAction: vi.fn(async () => true),
    actOn: vi.fn(async () => "Review this suggestion"),
  },
  queue: { getQueueStatus: vi.fn(() => ({ pending: 0 })) },
}));

vi.mock("../../../electron/database/repository-facades", () => ({
  TaskRepository: class {
    constructor() {
      Object.assign(this, spies.tasks);
    }
  },
  WorkspaceRepository: class {
    constructor() {
      Object.assign(this, spies.workspaces);
    }
  },
}));
vi.mock("../../../electron/activity/activity-repository-facades", () => ({
  ActivityRepository: class {
    constructor() {
      Object.assign(this, spies.activities);
    }
  },
}));
vi.mock("../../../electron/control-plane/ControlPlaneCoreService", () => ({
  ControlPlaneCoreService: class {
    constructor() {
      Object.assign(this, spies.core);
    }
  },
}));
vi.mock("../../../electron/mission-control/mission-control-repository-facades", () => ({
  MissionControlIntelligenceService: class {
    constructor() {
      Object.assign(this, spies.intelligence);
    }
  },
}));
vi.mock("../../../electron/agent/ProactiveSuggestionsService", () => ({
  ProactiveSuggestionsService: spies.suggestions,
}));

import { createBrowserPlanningDefinitions } from "../browser-planning-methods";

const readableWorkspace = makeWorkspace("workspace-1", true);
const readOnlyWorkspace = makeWorkspace("workspace-read-only", false);
const hiddenWorkspace = makeWorkspace("workspace-hidden", true);
const task = {
  id: "task-1",
  title: "Task",
  prompt: "Task prompt",
  status: "pending",
  workspaceId: readableWorkspace.id,
  createdAt: 1,
  updatedAt: 2,
} as Task;

function makeWorkspace(id: string, write: boolean, isTemp = false): Workspace {
  return {
    id,
    name: id,
    path: `/work/${id}`,
    createdAt: 1,
    isTemp,
    permissions: { read: true, write, delete: false, network: false, shell: false },
  };
}

function definitions(resolveWorkspace?: (id: string) => Promise<Workspace | null>) {
  return createBrowserPlanningDefinitions({
    db: {} as never,
    agentDaemon: { getQueueStatus: spies.queue.getQueueStatus } as never,
    resolveWorkspace:
      resolveWorkspace ??
      (async (id) => {
        if (id === readableWorkspace.id) return readableWorkspace;
        if (id === readOnlyWorkspace.id) return readOnlyWorkspace;
        return null;
      }),
  });
}

async function invoke(
  defs: ReturnType<typeof createBrowserPlanningDefinitions>,
  methodName: string,
  args: unknown[] = [],
) {
  const method = defs[methodName];
  if (!method) throw new Error(`Missing browser planning method: ${methodName}`);
  const validated = method.validate ? method.validate(args) : args;
  return method.handler(validated, {} as never);
}

describe("browser planning desktop methods", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spies.core.listCompanies.mockResolvedValue([{ id: "company-1" }]);
    spies.core.listIssues.mockResolvedValue([]);
    spies.activities.list.mockResolvedValue([{ id: "activity-1" }]);
    spies.tasks.findById.mockResolvedValue(task);
    spies.tasks.moveToColumn.mockResolvedValue(undefined);
    spies.tasks.setPriority.mockResolvedValue(undefined);
    spies.tasks.setDueDate.mockResolvedValue(undefined);
    spies.tasks.setEstimate.mockResolvedValue(undefined);
    spies.workspaces.findAll.mockResolvedValue([]);
    spies.suggestions.generateAll.mockResolvedValue(undefined);
    spies.suggestions.dismiss.mockResolvedValue(true);
    spies.suggestions.snooze.mockResolvedValue(true);
    spies.suggestions.recordEditedAction.mockResolvedValue(true);
    spies.suggestions.actOn.mockResolvedValue("Review this suggestion");
  });

  it("filters scoped activity reads and gates unscoped company reads on every readable workspace", async () => {
    const defs = definitions();
    await expect(
      invoke(defs, "listActivities", [{ workspaceId: readableWorkspace.id, limit: 25 }]),
    ).resolves.toEqual([{ id: "activity-1" }]);
    expect(spies.activities.list).toHaveBeenCalledWith({
      workspaceId: readableWorkspace.id,
      limit: 25,
    });

    await expect(
      invoke(defs, "listActivities", [{ workspaceId: hiddenWorkspace.id }]),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(spies.activities.list).toHaveBeenCalledTimes(1);

    spies.workspaces.findAll.mockResolvedValue([
      readableWorkspace,
      hiddenWorkspace,
      makeWorkspace("temporary", false, true),
    ]);
    const overview = definitions(async (id) =>
      id === readableWorkspace.id ? readableWorkspace : null,
    );
    await expect(invoke(overview, "listCompanies")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(spies.core.listCompanies).not.toHaveBeenCalled();

    spies.workspaces.findAll.mockResolvedValue([
      readableWorkspace,
      makeWorkspace("temporary", false, true),
    ]);
    await expect(invoke(overview, "listCompanies")).resolves.toEqual([{ id: "company-1" }]);
    expect(spies.core.listCompanies).toHaveBeenCalledTimes(1);
  });

  it("validates task mutations before dispatch and preserves explicit null clears", async () => {
    const defs = definitions();
    expect(defs.moveTaskToColumn.mutation).toBe(true);
    expect(defs.setTaskPriority.mutation).toBe(true);
    expect(defs.setTaskDueDate.mutation).toBe(true);
    expect(defs.setTaskEstimate.mutation).toBe(true);

    expect(() => defs.setTaskPriority.validate?.([task.id, -1])).toThrow();
    expect(() => defs.moveTaskToColumn.validate?.([task.id, "archived"])).toThrow();
    expect(spies.tasks.findById).not.toHaveBeenCalled();

    await invoke(defs, "setTaskPriority", [task.id, 4]);
    await invoke(defs, "setTaskDueDate", [task.id, null]);
    await invoke(defs, "setTaskEstimate", [task.id, null]);

    expect(spies.tasks.findById).toHaveBeenCalledTimes(3);
    expect(spies.tasks.setPriority).toHaveBeenCalledWith(task.id, 4);
    expect(spies.tasks.setDueDate).toHaveBeenCalledWith(task.id, null);
    expect(spies.tasks.setEstimate).toHaveBeenCalledWith(task.id, null);
  });

  it("requires workspace write permission before calling task mutation repositories", async () => {
    const defs = definitions();
    spies.tasks.findById.mockResolvedValue({ ...task, workspaceId: readOnlyWorkspace.id });

    await expect(invoke(defs, "setTaskPriority", [task.id, 2])).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(spies.tasks.setPriority).not.toHaveBeenCalled();
  });

  it("preflights all unique workspace permissions before refreshing any suggestions", async () => {
    const resolveWorkspace = vi.fn(async (id: string) =>
      id === readableWorkspace.id ? readableWorkspace : null,
    );
    const defs = definitions(resolveWorkspace);

    await expect(
      invoke(defs, "refreshSuggestionsForWorkspaces", [
        [readableWorkspace.id, hiddenWorkspace.id, readableWorkspace.id],
      ]),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(resolveWorkspace.mock.calls.map(([id]) => id)).toEqual([
      readableWorkspace.id,
      hiddenWorkspace.id,
    ]);
    expect(spies.suggestions.generateAll).not.toHaveBeenCalled();

    resolveWorkspace.mockImplementation(async (id) =>
      id === readableWorkspace.id ? readableWorkspace : makeWorkspace("workspace-2", true),
    );
    await expect(
      invoke(defs, "refreshSuggestionsForWorkspaces", [
        [readableWorkspace.id, "workspace-2", readableWorkspace.id],
      ]),
    ).resolves.toEqual({ success: true });
    expect(spies.suggestions.generateAll.mock.calls).toEqual([
      [readableWorkspace.id],
      ["workspace-2"],
    ]);
  });
});
