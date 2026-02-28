import { describe, it, expect, vi } from "vitest";
import type {
  AgentTeam,
  AgentTeamItem,
  AgentTeamRun,
  Task,
  UpdateAgentTeamItemRequest,
} from "../../../shared/types";

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
}));

// Avoid loading the native module in test environment.
vi.mock("better-sqlite3", () => ({
  default: class FakeDatabase {},
}));

function makeRepos(seed: { team: AgentTeam; run: AgentTeamRun; items: AgentTeamItem[] }): {
  teamRepo: { findById: (id: string) => AgentTeam | undefined };
  runRepo: {
    findById: (id: string) => AgentTeamRun | undefined;
    update: (id: string, updates: Any) => AgentTeamRun | undefined;
  };
  itemRepo: {
    listByRun: (runId: string) => AgentTeamItem[];
    listBySourceTaskId: (taskId: string) => AgentTeamItem[];
    update: (req: UpdateAgentTeamItemRequest) => AgentTeamItem | undefined;
  };
} {
  const teams = new Map<string, AgentTeam>([[seed.team.id, seed.team]]);
  const runs = new Map<string, AgentTeamRun>([[seed.run.id, seed.run]]);
  const items = new Map<string, AgentTeamItem>(seed.items.map((i) => [i.id, i]));

  return {
    teamRepo: {
      findById: (id) => teams.get(id),
    },
    runRepo: {
      findById: (id) => runs.get(id),
      update: (id, updates) => {
        const existing = runs.get(id);
        if (!existing) return undefined;
        const next: AgentTeamRun = {
          ...existing,
          ...(updates.status !== undefined ? { status: updates.status } : {}),
          ...(updates.error !== undefined ? { error: updates.error ?? undefined } : {}),
          ...(updates.summary !== undefined ? { summary: updates.summary ?? undefined } : {}),
          ...(updates.completedAt !== undefined
            ? { completedAt: updates.completedAt ?? undefined }
            : {}),
        };
        runs.set(id, next);
        return next;
      },
    },
    itemRepo: {
      listByRun: (runId) => Array.from(items.values()).filter((i) => i.teamRunId === runId),
      listBySourceTaskId: (taskId) =>
        Array.from(items.values()).filter((i) => i.sourceTaskId === taskId),
      update: (req) => {
        const existing = items.get(req.id);
        if (!existing) return undefined;
        const next: AgentTeamItem = {
          ...existing,
          ...(req.parentItemId !== undefined
            ? { parentItemId: (req.parentItemId as Any) ?? undefined }
            : {}),
          ...(req.title !== undefined ? { title: req.title } : {}),
          ...(req.description !== undefined
            ? { description: (req.description as Any) ?? undefined }
            : {}),
          ...(req.ownerAgentRoleId !== undefined
            ? { ownerAgentRoleId: (req.ownerAgentRoleId as Any) ?? undefined }
            : {}),
          ...(req.sourceTaskId !== undefined
            ? { sourceTaskId: (req.sourceTaskId as Any) ?? undefined }
            : {}),
          ...(req.status !== undefined ? { status: req.status as Any } : {}),
          ...(req.resultSummary !== undefined
            ? { resultSummary: (req.resultSummary as Any) ?? undefined }
            : {}),
          ...(req.sortOrder !== undefined ? { sortOrder: req.sortOrder as Any } : {}),
          updatedAt: Date.now(),
        };
        items.set(req.id, next);
        return next;
      },
    },
  };
}

describe("AgentTeamOrchestrator", () => {
  it("spawns with team defaults and sets bypassQueue=false", async () => {
    const now = Date.now();

    const team: AgentTeam = {
      id: "team-1",
      workspaceId: "ws-1",
      name: "Team A",
      description: undefined,
      leadAgentRoleId: "role-lead",
      maxParallelAgents: 2,
      defaultModelPreference: "cheaper",
      defaultPersonality: "technical",
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };

    const run: AgentTeamRun = {
      id: "run-1",
      teamId: team.id,
      rootTaskId: "task-root",
      status: "running",
      startedAt: now,
      completedAt: undefined,
      error: undefined,
      summary: undefined,
    };

    const item: AgentTeamItem = {
      id: "item-1",
      teamRunId: run.id,
      parentItemId: undefined,
      title: "Item 1",
      description: "Detail",
      ownerAgentRoleId: "role-owner",
      sourceTaskId: undefined,
      status: "todo",
      resultSummary: undefined,
      sortOrder: 1,
      createdAt: now,
      updatedAt: now,
    };

    const rootTask: Task = {
      id: run.rootTaskId,
      title: "Root",
      prompt: "Do the thing",
      status: "executing",
      workspaceId: team.workspaceId,
      createdAt: now,
      updatedAt: now,
      agentType: "main",
      depth: 0,
    };

    const tasksById = new Map<string, Task>([[rootTask.id, rootTask]]);

    const createChildTask = vi.fn(async (params: Any) => {
      const child: Task = {
        id: `task-child-${Math.random().toString(16).slice(2)}`,
        title: params.title,
        prompt: params.prompt,
        status: "pending",
        workspaceId: params.workspaceId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        parentTaskId: params.parentTaskId,
        agentType: params.agentType,
        agentConfig: params.agentConfig,
        depth: params.depth,
        assignedAgentRoleId: params.assignedAgentRoleId,
      };
      tasksById.set(child.id, child);
      return child;
    });

    const { teamRepo, runRepo, itemRepo } = makeRepos({ team, run, items: [item] });

    const { AgentTeamOrchestrator } = await import("../AgentTeamOrchestrator");
    const orch = new AgentTeamOrchestrator(
      {
        getDatabase: () => ({}) as Any,
        getTaskById: async (taskId: string) => tasksById.get(taskId),
        createChildTask,
        cancelTask: async () => {},
      },
      { teamRepo, runRepo, itemRepo },
    );

    await orch.tickRun(run.id, "test");

    expect(createChildTask).toHaveBeenCalledTimes(1);
    const call = createChildTask.mock.calls[0][0];
    expect(call.assignedAgentRoleId).toBe(item.ownerAgentRoleId);
    expect(call.agentConfig).toMatchObject({
      retainMemory: false,
      bypassQueue: false,
      llmProfile: "cheap",
      modelKey: "haiku-4-5",
      personalityId: "technical",
    });

    const updated = itemRepo.listByRun(run.id)[0];
    expect(updated.status).toBe("in_progress");
    expect(typeof updated.sourceTaskId).toBe("string");
    expect((updated.sourceTaskId || "").length).toBeGreaterThan(0);
  });

  it("does not override model/personality when defaults inherit", async () => {
    const now = Date.now();

    const team: AgentTeam = {
      id: "team-2",
      workspaceId: "ws-2",
      name: "Team B",
      description: undefined,
      leadAgentRoleId: "role-lead-2",
      maxParallelAgents: 1,
      defaultModelPreference: "same",
      defaultPersonality: "same",
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };

    const run: AgentTeamRun = {
      id: "run-2",
      teamId: team.id,
      rootTaskId: "task-root-2",
      status: "running",
      startedAt: now,
      completedAt: undefined,
      error: undefined,
      summary: undefined,
    };

    const item: AgentTeamItem = {
      id: "item-2",
      teamRunId: run.id,
      parentItemId: undefined,
      title: "Item",
      description: undefined,
      ownerAgentRoleId: undefined,
      sourceTaskId: undefined,
      status: "todo",
      resultSummary: undefined,
      sortOrder: 1,
      createdAt: now,
      updatedAt: now,
    };

    const rootTask: Task = {
      id: run.rootTaskId,
      title: "Root 2",
      prompt: "Do the other thing",
      status: "executing",
      workspaceId: team.workspaceId,
      createdAt: now,
      updatedAt: now,
      agentType: "main",
      depth: 0,
    };

    const tasksById = new Map<string, Task>([[rootTask.id, rootTask]]);

    const createChildTask = vi.fn(async (params: Any) => {
      const child: Task = {
        id: `task-child-${Math.random().toString(16).slice(2)}`,
        title: params.title,
        prompt: params.prompt,
        status: "pending",
        workspaceId: params.workspaceId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        parentTaskId: params.parentTaskId,
        agentType: params.agentType,
        agentConfig: params.agentConfig,
        depth: params.depth,
        assignedAgentRoleId: params.assignedAgentRoleId,
      };
      tasksById.set(child.id, child);
      return child;
    });

    const { teamRepo, runRepo, itemRepo } = makeRepos({ team, run, items: [item] });

    const { AgentTeamOrchestrator } = await import("../AgentTeamOrchestrator");
    const orch = new AgentTeamOrchestrator(
      {
        getDatabase: () => ({}) as Any,
        getTaskById: async (taskId: string) => tasksById.get(taskId),
        createChildTask,
        cancelTask: async () => {},
      },
      { teamRepo, runRepo, itemRepo },
    );

    await orch.tickRun(run.id, "test");

    const call = createChildTask.mock.calls[0][0];
    expect(call.agentConfig).toMatchObject({
      retainMemory: false,
      bypassQueue: false,
      llmProfile: "cheap",
    });
    expect(call.agentConfig.modelKey).toBeUndefined();
    expect(call.agentConfig.personalityId).toBeUndefined();
  });

  it("routes validator-style checklist items to strong profile", async () => {
    const now = Date.now();

    const team: AgentTeam = {
      id: "team-3",
      workspaceId: "ws-3",
      name: "Team C",
      description: undefined,
      leadAgentRoleId: "role-lead-3",
      maxParallelAgents: 1,
      defaultModelPreference: "same",
      defaultPersonality: "same",
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };

    const run: AgentTeamRun = {
      id: "run-3",
      teamId: team.id,
      rootTaskId: "task-root-3",
      status: "running",
      startedAt: now,
      completedAt: undefined,
      error: undefined,
      summary: undefined,
    };

    const item: AgentTeamItem = {
      id: "item-3",
      teamRunId: run.id,
      parentItemId: undefined,
      title: "Validation pass",
      description: "Verify quality and correctness",
      ownerAgentRoleId: undefined,
      sourceTaskId: undefined,
      status: "todo",
      resultSummary: undefined,
      sortOrder: 1,
      createdAt: now,
      updatedAt: now,
    };

    const rootTask: Task = {
      id: run.rootTaskId,
      title: "Root 3",
      prompt: "Ship the change",
      status: "executing",
      workspaceId: team.workspaceId,
      createdAt: now,
      updatedAt: now,
      agentType: "main",
      depth: 0,
    };

    const tasksById = new Map<string, Task>([[rootTask.id, rootTask]]);

    const createChildTask = vi.fn(async (params: Any) => {
      const child: Task = {
        id: `task-child-${Math.random().toString(16).slice(2)}`,
        title: params.title,
        prompt: params.prompt,
        status: "pending",
        workspaceId: params.workspaceId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        parentTaskId: params.parentTaskId,
        agentType: params.agentType,
        agentConfig: params.agentConfig,
        depth: params.depth,
        assignedAgentRoleId: params.assignedAgentRoleId,
      };
      tasksById.set(child.id, child);
      return child;
    });

    const { teamRepo, runRepo, itemRepo } = makeRepos({ team, run, items: [item] });
    const { AgentTeamOrchestrator } = await import("../AgentTeamOrchestrator");
    const orch = new AgentTeamOrchestrator(
      {
        getDatabase: () => ({}) as Any,
        getTaskById: async (taskId: string) => tasksById.get(taskId),
        createChildTask,
        cancelTask: async () => {},
      },
      { teamRepo, runRepo, itemRepo },
    );

    await orch.tickRun(run.id, "test");

    const call = createChildTask.mock.calls[0][0];
    expect(call.agentConfig.llmProfile).toBe("strong");
  });
});
