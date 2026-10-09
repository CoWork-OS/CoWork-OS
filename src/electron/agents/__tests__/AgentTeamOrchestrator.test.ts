import { afterEach, describe, it, expect, vi } from "vitest";
import type {
  AgentTeam,
  AgentTeamItem,
  AgentTeamRun,
  LLMSettings,
  Task,
  UpdateAgentTeamItemRequest,
} from "../../../shared/types";
import { LLMProviderFactory } from "../../agent/llm/provider-factory";

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
    create: (req: Any) => AgentTeamItem;
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
          ...(updates.phase !== undefined ? { phase: updates.phase ?? undefined } : {}),
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
      create: (req) => {
        const created: AgentTeamItem = {
          id: req.id || `item-${Math.random().toString(16).slice(2)}`,
          teamRunId: req.teamRunId,
          parentItemId: req.parentItemId ?? undefined,
          title: req.title,
          description: req.description ?? undefined,
          ownerAgentRoleId: req.ownerAgentRoleId ?? undefined,
          sourceTaskId: req.sourceTaskId ?? undefined,
          status: req.status,
          resultSummary: req.resultSummary ?? undefined,
          sortOrder: req.sortOrder,
          createdAt: req.createdAt ?? Date.now(),
          updatedAt: req.updatedAt ?? Date.now(),
        };
        items.set(created.id, created);
        return created;
      },
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

function mockProfileRouting(
  profileRoutingEnabled: boolean,
  providerType: LLMSettings["providerType"] = "openai",
): void {
  const settings: LLMSettings = {
    providerType,
    modelKey: "gpt-4o-mini",
    openai: {
      model: "gpt-4o-mini",
      profileRoutingEnabled,
      strongModelKey: "gpt-5.4",
      cheapModelKey: "gpt-5.4-mini",
    },
  };
  vi.spyOn(LLMProviderFactory, "loadSettings").mockReturnValue(settings);
}

describe("AgentTeamOrchestrator", () => {
  it("spawns with team defaults and sets bypassQueue=false", async () => {
    mockProfileRouting(false);

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
    mockProfileRouting(false);

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
    mockProfileRouting(false);

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

    vi.spyOn((orch as Any).thoughtRepo, "listByRun").mockReturnValue([]);
    await (orch as Any).transitionToSynthesizePhase(run, team, rootTask, [item]);

    const call = createChildTask.mock.calls[0][0];
    expect(call.agentConfig.llmProfile).toBe("strong");
  });

  it("omits explicit team model override for collab subagents when profile routing is enabled", async () => {
    mockProfileRouting(true);

    const now = Date.now();

    const team: AgentTeam = {
      id: "team-4",
      workspaceId: "ws-4",
      name: "Team D",
      description: undefined,
      leadAgentRoleId: "role-lead-4",
      maxParallelAgents: 1,
      defaultModelPreference: "cheaper",
      defaultPersonality: "technical",
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };

    const run: AgentTeamRun = {
      id: "run-4",
      teamId: team.id,
      rootTaskId: "task-root-4",
      status: "running",
      startedAt: now,
      collaborativeMode: true,
    };

    const item: AgentTeamItem = {
      id: "item-4",
      teamRunId: run.id,
      parentItemId: undefined,
      title: "Implement feature",
      description: "Make the requested code change",
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
      title: "Root 4",
      prompt: "Implement the feature with collaborators",
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
      personalityId: "technical",
    });
    expect(call.agentConfig.modelKey).toBeUndefined();
  });

  it("includes lane-specific instructions for multitask collaborative subagents", async () => {
    mockProfileRouting(true);

    const now = Date.now();
    const team: AgentTeam = {
      id: "team-mt",
      workspaceId: "ws-mt",
      name: "Multitask Team",
      description: undefined,
      leadAgentRoleId: "role-lead-mt",
      maxParallelAgents: 2,
      defaultModelPreference: "same",
      defaultPersonality: "same",
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };
    const run: AgentTeamRun = {
      id: "run-mt",
      teamId: team.id,
      rootTaskId: "task-root-mt",
      status: "running",
      startedAt: now,
      collaborativeMode: true,
    };
    const item: AgentTeamItem = {
      id: "item-mt",
      teamRunId: run.id,
      parentItemId: undefined,
      title: "Verification",
      description: "Verify the flow and report regressions.",
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
      title: "Fix onboarding",
      prompt: "Fix the onboarding bugs",
      status: "executing",
      workspaceId: team.workspaceId,
      createdAt: now,
      updatedAt: now,
      agentType: "main",
      depth: 0,
      agentConfig: {
        collaborativeMode: true,
        multitaskMode: true,
        multitaskLaneCount: 2,
        multitaskAssignmentMode: "auto_split",
      },
    };

    const tasksById = new Map<string, Task>([[rootTask.id, rootTask]]);
    const createChildTask = vi.fn(async (params: Any) => {
      const child: Task = {
        id: "task-child-mt",
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
    expect(call.prompt).toContain("YOUR MULTITASK LANE:");
    expect(call.prompt).toContain("Verification");
    expect(call.prompt).toContain("Verify the flow and report regressions.");
    expect(call.prompt).toContain("Work only on this lane.");
  });

  it("keeps explicit team model override for collab subagents when profile routing is disabled", async () => {
    mockProfileRouting(false);

    const now = Date.now();

    const team: AgentTeam = {
      id: "team-5",
      workspaceId: "ws-5",
      name: "Team E",
      description: undefined,
      leadAgentRoleId: "role-lead-5",
      maxParallelAgents: 1,
      defaultModelPreference: "cheaper",
      defaultPersonality: "same",
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };

    const run: AgentTeamRun = {
      id: "run-5",
      teamId: team.id,
      rootTaskId: "task-root-5",
      status: "running",
      startedAt: now,
      collaborativeMode: true,
    };

    const item: AgentTeamItem = {
      id: "item-5",
      teamRunId: run.id,
      parentItemId: undefined,
      title: "Implement feature",
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
      title: "Root 5",
      prompt: "Implement the feature with collaborators",
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
    expect(call.agentConfig.llmProfile).toBe("cheap");
    expect(call.agentConfig.modelKey).toBe("haiku-4-5");
  });

  it("omits explicit team model override for synthesis when profile routing is enabled", async () => {
    mockProfileRouting(true);

    const now = Date.now();

    const team: AgentTeam = {
      id: "team-6",
      workspaceId: "ws-6",
      name: "Team F",
      description: undefined,
      leadAgentRoleId: "role-lead-6",
      maxParallelAgents: 1,
      defaultModelPreference: "cheaper",
      defaultPersonality: "technical",
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };

    const run: AgentTeamRun = {
      id: "run-6",
      teamId: team.id,
      rootTaskId: "task-root-6",
      status: "running",
      startedAt: now,
      collaborativeMode: true,
      phase: "dispatch",
    };

    const item: AgentTeamItem = {
      id: "item-6",
      teamRunId: run.id,
      parentItemId: undefined,
      title: "Implementation",
      description: "Completed",
      ownerAgentRoleId: undefined,
      sourceTaskId: "task-child-done",
      status: "done",
      resultSummary: "done",
      sortOrder: 1,
      createdAt: now,
      updatedAt: now,
    };

    const rootTask: Task = {
      id: run.rootTaskId,
      title: "Root 6",
      prompt: "Coordinate and summarize",
      status: "executing",
      workspaceId: team.workspaceId,
      createdAt: now,
      updatedAt: now,
      agentType: "main",
      depth: 0,
      agentConfig: {
        llmProfileHint: "strong",
      },
    };

    const completedChild: Task = {
      id: "task-child-done",
      title: "Implementation",
      prompt: "Done",
      status: "completed",
      workspaceId: team.workspaceId,
      createdAt: now,
      updatedAt: now,
      parentTaskId: rootTask.id,
      agentType: "sub",
      depth: 1,
    };

    const tasksById = new Map<string, Task>([
      [rootTask.id, rootTask],
      [completedChild.id, completedChild],
    ]);
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

    vi.spyOn((orch as Any).thoughtRepo, "listByRun").mockReturnValue([]);
    await (orch as Any).transitionToSynthesizePhase(run, team, rootTask, [item]);

    const call = createChildTask.mock.calls[0][0];
    expect(call.title).toBe("Synthesis");
    expect(call.agentConfig).toMatchObject({
      retainMemory: false,
      bypassQueue: true,
      conversationMode: "chat",
      qualityPasses: 1,
      llmProfile: "strong",
      personalityId: "technical",
    });
    expect(call.agentConfig.modelKey).toBeUndefined();
  });

  function makeSynthesisFixture(suffix: string) {
    mockProfileRouting(true);
    const now = Date.now();
    const team: AgentTeam = {
      id: `team-${suffix}`,
      workspaceId: `ws-${suffix}`,
      name: `Team ${suffix}`,
      description: undefined,
      leadAgentRoleId: `role-lead-${suffix}`,
      maxParallelAgents: 1,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };
    const run: AgentTeamRun = {
      id: `run-${suffix}`,
      teamId: team.id,
      rootTaskId: `task-root-${suffix}`,
      status: "running",
      startedAt: now,
      collaborativeMode: true,
      phase: "execute",
    };
    const item: AgentTeamItem = {
      id: `item-${suffix}`,
      teamRunId: run.id,
      parentItemId: undefined,
      title: "Analysis lane",
      description: "Completed",
      ownerAgentRoleId: undefined,
      sourceTaskId: `task-child-${suffix}`,
      status: "done",
      resultSummary: "done",
      sortOrder: 1,
      createdAt: now,
      updatedAt: now,
    };
    const rootTask: Task = {
      id: run.rootTaskId,
      title: `Root ${suffix}`,
      prompt: "Coordinate and summarize",
      status: "executing",
      workspaceId: team.workspaceId,
      createdAt: now,
      updatedAt: now,
      agentType: "main",
      depth: 0,
      agentConfig: { llmProfileHint: "strong" },
    };
    const completedChild: Task = {
      id: item.sourceTaskId!,
      title: item.title,
      prompt: "Done",
      status: "completed",
      workspaceId: team.workspaceId,
      createdAt: now,
      updatedAt: now,
      parentTaskId: rootTask.id,
      agentType: "sub",
      depth: 1,
    };
    const tasksById = new Map<string, Task>([
      [rootTask.id, rootTask],
      [completedChild.id, completedChild],
    ]);
    const createChildTask = vi.fn(async (params: Any) => {
      const child: Task = {
        id: `task-child-${Math.random().toString(16).slice(2)}`,
        title: params.title,
        prompt: params.prompt,
        status: "executing",
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
    return { team, run, item, rootTask, tasksById, createChildTask };
  }

  it("spawns the synthesis task directly when the graph engine drops the appended node", async () => {
    const { team, run, item, rootTask, tasksById, createChildTask } = makeSynthesisFixture("drop");
    const graphRun = { id: "graph-run-drop", status: "completed" };
    const laneNode = { id: "node-lane", teamRunId: run.id, teamItemId: item.id };
    const appendOrchestrationGraphNodes = vi.fn(async () => ({
      run: graphRun,
      nodes: [laneNode],
      edges: [],
    }));
    const completeRootTask = vi.fn();

    const repos = makeRepos({ team, run, items: [item] });
    const { AgentTeamOrchestrator } = await import("../AgentTeamOrchestrator");
    const orch = new AgentTeamOrchestrator(
      {
        getDatabase: () => ({}) as Any,
        getTaskById: async (taskId: string) => tasksById.get(taskId),
        createChildTask,
        cancelTask: async () => {},
        appendOrchestrationGraphNodes: appendOrchestrationGraphNodes as Any,
        findOrchestrationGraphByTeamRunId: (async () => ({
          run: graphRun,
          nodes: [laneNode],
          edges: [],
        })) as Any,
        completeRootTask,
      },
      repos,
    );
    vi.spyOn((orch as Any).thoughtRepo, "listByRun").mockReturnValue([]);

    await (orch as Any).transitionToSynthesizePhase(run, team, rootTask, [item]);

    expect(appendOrchestrationGraphNodes).toHaveBeenCalledTimes(1);
    expect(createChildTask).toHaveBeenCalledTimes(1);
    expect(createChildTask.mock.calls[0][0]).toMatchObject({
      title: "Synthesis",
      workerRole: "synthesizer",
      parentTaskId: rootTask.id,
    });
    const synthesisItem = repos.itemRepo.listByRun(run.id).find((i) => i.title === "Synthesis");
    expect(synthesisItem?.status).toBe("in_progress");
    expect(synthesisItem?.sourceTaskId).toBe((await createChildTask.mock.results[0].value).id);
    expect(completeRootTask).not.toHaveBeenCalled();
    for (const timer of (orch as Any).synthesisWatchdogTimers.values()) clearTimeout(timer);
  });

  it.each([
    ["full", "transitionToSynthesizePhase"],
    ["compact", "transitionToSynthesizePhaseCompact"],
  ])(
    "gives the %s synthesis the user's updates as superseding constraints",
    async (suffix, method) => {
      const { team, run, item, rootTask, tasksById, createChildTask } = makeSynthesisFixture(
        `updates-${suffix}`,
      );
      rootTask.prompt = "Plan a workshop for 40 people with a €250 cash budget.";
      const repos = makeRepos({ team, run, items: [item] });
      const { AgentTeamOrchestrator } = await import("../AgentTeamOrchestrator");
      const orch = new AgentTeamOrchestrator(
        {
          getDatabase: () => ({}) as Any,
          getTaskById: async (taskId: string) => tasksById.get(taskId),
          createChildTask,
          cancelTask: async () => {},
          listRootUserUpdates: () => ["Cap attendance at 20 people and the cash budget at €150."],
        },
        repos,
      );
      vi.spyOn((orch as Any).thoughtRepo, "listByRun").mockReturnValue([]);

      await (orch as Any)[method](run, team, rootTask, [item]);

      const prompt = String(createChildTask.mock.calls[0][0].prompt);
      expect(prompt).toContain("USER UPDATES");
      expect(prompt).toContain("SUPERSEDE");
      expect(prompt).toContain("1. Cap attendance at 20 people and the cash budget at €150.");
      expect(prompt.indexOf("USER UPDATES")).toBeGreaterThan(prompt.indexOf("40 people"));
      for (const timer of (orch as Any).synthesisWatchdogTimers.values()) clearTimeout(timer);
    },
  );

  it("marks synthesis blocked without spawning when the graph run was cancelled", async () => {
    const { team, run, item, rootTask, tasksById, createChildTask } =
      makeSynthesisFixture("cancelled");
    const graphRun = { id: "graph-run-cancelled", status: "cancelled" };
    const repos = makeRepos({ team, run, items: [item] });
    const { AgentTeamOrchestrator } = await import("../AgentTeamOrchestrator");
    const orch = new AgentTeamOrchestrator(
      {
        getDatabase: () => ({}) as Any,
        getTaskById: async (taskId: string) => tasksById.get(taskId),
        createChildTask,
        cancelTask: async () => {},
        appendOrchestrationGraphNodes: (async () => ({
          run: graphRun,
          nodes: [],
          edges: [],
        })) as Any,
        findOrchestrationGraphByTeamRunId: (async () => ({
          run: graphRun,
          nodes: [],
          edges: [],
        })) as Any,
      },
      repos,
    );
    vi.spyOn((orch as Any).thoughtRepo, "listByRun").mockReturnValue([]);

    await (orch as Any).transitionToSynthesizePhase(run, team, rootTask, [item]);

    expect(createChildTask).not.toHaveBeenCalled();
    const synthesisItem = repos.itemRepo.listByRun(run.id).find((i) => i.title === "Synthesis");
    expect(synthesisItem?.status).toBe("blocked");
    for (const timer of (orch as Any).synthesisWatchdogTimers.values()) clearTimeout(timer);
  });

  it("extends the synthesis watchdog while the synthesis task is still executing", async () => {
    const { team, run, item, rootTask, tasksById, createChildTask } =
      makeSynthesisFixture("watchdog");
    const completeRootTask = vi.fn();
    const repos = makeRepos({ team, run, items: [item] });
    const { AgentTeamOrchestrator } = await import("../AgentTeamOrchestrator");
    const orch = new AgentTeamOrchestrator(
      {
        getDatabase: () => ({}) as Any,
        getTaskById: async (taskId: string) => tasksById.get(taskId),
        createChildTask,
        cancelTask: async () => {},
        completeRootTask,
      },
      repos,
    );
    vi.spyOn((orch as Any).thoughtRepo, "listByRun").mockReturnValue([]);
    const schedule = vi.spyOn(orch as Any, "scheduleSynthesisWatchdog");

    await (orch as Any).transitionToSynthesizePhase(run, team, rootTask, [item]);
    const synthesisItem = repos.itemRepo.listByRun(run.id).find((i) => i.title === "Synthesis")!;
    expect(synthesisItem.status).toBe("in_progress");
    expect(tasksById.get(synthesisItem.sourceTaskId!)?.status).toBe("executing");
    for (const timer of (orch as Any).synthesisWatchdogTimers.values()) clearTimeout(timer);
    schedule.mockClear();

    // Still executing: the watchdog re-arms instead of closing the run.
    await (orch as Any).runSynthesisWatchdog(run.id, synthesisItem.id, rootTask.id, 0);
    expect(schedule).toHaveBeenCalledWith(run.id, rootTask.id, synthesisItem.id, 1);
    expect(repos.itemRepo.listByRun(run.id).find((i) => i.id === synthesisItem.id)?.status).toBe(
      "in_progress",
    );
    expect(repos.runRepo.findById(run.id)?.status).toBe("running");
    expect(completeRootTask).not.toHaveBeenCalled();
    for (const timer of (orch as Any).synthesisWatchdogTimers.values()) clearTimeout(timer);

    // Extension budget exhausted: close with the lane outputs.
    await (orch as Any).runSynthesisWatchdog(run.id, synthesisItem.id, rootTask.id, 3);
    expect(repos.itemRepo.listByRun(run.id).find((i) => i.id === synthesisItem.id)?.status).toBe(
      "blocked",
    );
    expect(repos.runRepo.findById(run.id)?.status).toBe("completed");
    expect(completeRootTask).toHaveBeenCalledWith(
      rootTask.id,
      "completed",
      expect.stringContaining("Synthesis timed out"),
    );
  });
  it("counts lanes that finished with warnings as needing review", async () => {
    const tasks = new Map<string, Any>([
      ["t1", { id: "t1", status: "completed", terminalStatus: "ok" }],
      ["t2", { id: "t2", status: "completed", terminalStatus: "partial_success" }],
    ]);
    const { AgentTeamOrchestrator } = await import("../AgentTeamOrchestrator");
    const orch = new AgentTeamOrchestrator(
      {
        getDatabase: () => ({}) as Any,
        getTaskById: async (taskId: string) => tasks.get(taskId),
        createChildTask: vi.fn(),
        cancelTask: async () => {},
      },
      makeRepos({ team: {} as Any, run: {} as Any, items: [] }),
    );
    const items = [
      { title: "Anansi", status: "done", sourceTaskId: "t1" },
      { title: "Synthesis", status: "done", sourceTaskId: "t2" },
    ];
    const needsReview = await (orch as Any).listItemsNeedingReview(items);
    expect(needsReview).toEqual(["Synthesis"]);
    expect((orch as Any).buildRunSummary(items, needsReview)).toBe(
      "Items: 1 done, 1 need review, 0 failed, 0 blocked (total: 2)",
    );
    expect((orch as Any).buildRunSummary(items)).toBe(
      "Items: 2 done, 0 failed, 0 blocked (total: 2)",
    );
  });

  describe("synthesis retry supersession", () => {
    const plan =
      "# Launch plan\n\n## Proposed schedule\n\n| Day | Session |\n|---|---|\n| Mon | 1 |";

    async function makeRetryHarness(suffix: string) {
      const fixture = makeSynthesisFixture(suffix);
      const { run, item, tasksById } = fixture;
      run.phase = "synthesize";
      const failedSynthesisTask: Task = {
        id: `task-synth-${suffix}`,
        title: "Synthesis",
        prompt: "Synthesize",
        status: "failed",
        error:
          "Task missing direct answer: the request asks for a decision or recommendation, but the final response does not state one.",
        resultSummary: plan,
        workspaceId: fixture.team.workspaceId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        parentTaskId: fixture.rootTask.id,
        agentType: "sub",
        depth: 1,
      };
      tasksById.set(failedSynthesisTask.id, failedSynthesisTask);
      const synthesisItem: AgentTeamItem = {
        id: `item-synth-${suffix}`,
        teamRunId: run.id,
        title: "Synthesis",
        sourceTaskId: failedSynthesisTask.id,
        status: "in_progress",
        sortOrder: 9999,
        createdAt: Date.now() - 1000,
        updatedAt: Date.now() - 1000,
      };
      const repos = makeRepos({ team: fixture.team, run, items: [item, synthesisItem] });
      const completeRootTask = vi.fn();
      const { AgentTeamOrchestrator } = await import("../AgentTeamOrchestrator");
      const orch = new AgentTeamOrchestrator(
        {
          getDatabase: () => ({}) as Any,
          getTaskById: async (taskId: string) => tasksById.get(taskId),
          createChildTask: fixture.createChildTask,
          cancelTask: async () => {},
          completeRootTask,
        },
        repos,
      );
      vi.spyOn((orch as Any).thoughtRepo, "listByRun").mockReturnValue([]);
      const finish = () => {
        for (const timer of (orch as Any).synthesisWatchdogTimers.values()) clearTimeout(timer);
      };
      return {
        ...fixture,
        repos,
        orch,
        completeRootTask,
        failedSynthesisTask,
        synthesisItem,
        finish,
      };
    }

    it("completes the parent when a failed synthesis is recovered by its retry", async () => {
      const h = await makeRetryHarness("recovered");

      await h.orch.onTaskTerminal(h.failedSynthesisTask.id);

      expect(h.createChildTask).toHaveBeenCalledTimes(1);
      const firstAttempt = h.repos.itemRepo
        .listByRun(h.run.id)
        .find((i) => i.id === h.synthesisItem.id);
      expect(firstAttempt?.title).toBe("Synthesis (failed)");
      expect(firstAttempt?.status).toBe("failed");
      expect(firstAttempt?.resultSummary).toContain("does not state one");
      expect(h.completeRootTask).not.toHaveBeenCalled();

      const retryTask = await h.createChildTask.mock.results[0].value;
      h.tasksById.set(retryTask.id, {
        ...retryTask,
        status: "completed",
        terminalStatus: "ok",
        resultSummary: plan,
      });
      await h.orch.onTaskTerminal(retryTask.id);

      expect(h.repos.runRepo.findById(h.run.id)?.status).toBe("completed");
      expect(h.completeRootTask).toHaveBeenCalledTimes(1);
      const [, status, summary] = h.completeRootTask.mock.calls[0];
      expect(status).toBe("completed");
      expect(summary.startsWith(plan)).toBe(true);
      expect(summary).toContain("Items: 2 done, 0 failed, 0 blocked (total: 2)");
      expect(summary).toContain("1 failed synthesis attempt was recovered by a successful retry.");
      // The failed attempt remains visible as history.
      const rows = h.repos.itemRepo.listByRun(h.run.id);
      expect(rows.map((row) => [row.title, row.status])).toEqual(
        expect.arrayContaining([
          ["Synthesis (failed)", "failed"],
          ["Synthesis", "done"],
        ]),
      );
      h.finish();
    });

    it("retries a synthesis whose failure was recorded before the retry started", async () => {
      const h = await makeRetryHarness("race");
      // The graph notification marked the attempt failed before the task-terminal hook ran.
      h.repos.itemRepo.update({ id: h.synthesisItem.id, status: "failed", resultSummary: plan });

      await h.orch.tickRun(h.run.id, "graph_node_notification");

      expect(h.createChildTask).toHaveBeenCalledTimes(1);
      expect(h.completeRootTask).not.toHaveBeenCalled();
      expect(h.repos.runRepo.findById(h.run.id)?.status).toBe("running");

      // The late task-terminal hook must not start a second retry.
      await h.orch.onTaskTerminal(h.failedSynthesisTask.id);
      expect(h.createChildTask).toHaveBeenCalledTimes(1);
      expect(h.completeRootTask).not.toHaveBeenCalled();
      h.finish();
    });

    it("fails the parent with the retry's reason when the retry also fails", async () => {
      const h = await makeRetryHarness("retry-failed");
      await h.orch.onTaskTerminal(h.failedSynthesisTask.id);
      const retryTask = await h.createChildTask.mock.results[0].value;
      h.tasksById.set(retryTask.id, {
        ...retryTask,
        status: "failed",
        error: "Provider request failed: quota exceeded",
      });

      await h.orch.onTaskTerminal(retryTask.id);

      expect(h.repos.runRepo.findById(h.run.id)?.status).toBe("failed");
      expect(h.completeRootTask).toHaveBeenCalledTimes(1);
      const [, status, summary, metadata] = h.completeRootTask.mock.calls[0];
      expect(status).toBe("failed");
      const reason =
        "Team run failed: 1 work item failed without recovery: Synthesis (Provider request failed: quota exceeded).";
      expect(metadata).toEqual({ failureReason: reason });
      expect(summary.startsWith(reason)).toBe(true);
      expect(summary).toContain("Items: 1 done, 1 failed, 0 blocked (total: 2)");
      expect(h.repos.runRepo.findById(h.run.id)?.error).toBe(reason);
      h.finish();
    });

    it("still fails the parent for an unrecovered lane failure and explains it", async () => {
      const h = await makeRetryHarness("lane-failed");
      h.tasksById.set(h.item.sourceTaskId!, {
        ...h.tasksById.get(h.item.sourceTaskId!)!,
        status: "failed",
        error: "Error: web_fetch was blocked by policy\nstack details",
        resultSummary: plan,
      });
      h.repos.itemRepo.update({ id: h.item.id, status: "failed", resultSummary: plan });
      h.tasksById.set(h.failedSynthesisTask.id, {
        ...h.failedSynthesisTask,
        status: "completed",
        error: undefined,
        resultSummary: plan,
      });

      await h.orch.onTaskTerminal(h.failedSynthesisTask.id);

      expect(h.createChildTask).not.toHaveBeenCalled();
      const [, status, summary, metadata] = h.completeRootTask.mock.calls[0];
      expect(status).toBe("failed");
      expect(metadata.failureReason).toBe(
        "Team run failed: 1 work item failed without recovery: Analysis lane (web_fetch was blocked by policy).",
      );
      expect(summary.startsWith(metadata.failureReason)).toBe(true);
      expect(summary).toContain(plan);
      h.finish();
    });
  });

  it("resolves synthesis attempts to one logical work item", async () => {
    const { resolveTeamItemAttempts } = await import("../AgentTeamOrchestrator");
    const lane = { title: "Lane", status: "done" as const, createdAt: 1 };
    const failedAttempt = { title: "Synthesis (failed)", status: "failed" as const, createdAt: 2 };
    const retryDone = { title: "Synthesis", status: "done" as const, createdAt: 3 };
    const recovered = resolveTeamItemAttempts([lane, failedAttempt, retryDone]);
    expect(recovered.effective).toEqual([lane, retryDone]);
    expect(recovered.recovered).toEqual([failedAttempt]);
    expect(recovered.synthesis).toBe(retryDone);

    const retryFailed = { title: "Synthesis", status: "failed" as const, createdAt: 3 };
    const unrecovered = resolveTeamItemAttempts([lane, failedAttempt, retryFailed]);
    expect(unrecovered.effective).toEqual([lane, retryFailed]);
    expect(unrecovered.recovered).toEqual([]);

    const single = resolveTeamItemAttempts([lane, { ...retryFailed }]);
    expect(single.effective).toHaveLength(2);
    expect(single.superseded).toEqual([]);
  });
});
