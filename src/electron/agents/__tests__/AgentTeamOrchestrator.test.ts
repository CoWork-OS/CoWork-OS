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

  it("keeps explicit model pinning for multi-llm analysis and judge synthesis", async () => {
    mockProfileRouting(true);

    const now = Date.now();

    const team: AgentTeam = {
      id: "team-7",
      workspaceId: "ws-7",
      name: "Team G",
      description: undefined,
      leadAgentRoleId: "role-lead-7",
      maxParallelAgents: 1,
      defaultModelPreference: "cheaper",
      defaultPersonality: "technical",
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };

    const analysisRun: AgentTeamRun = {
      id: "run-7a",
      teamId: team.id,
      rootTaskId: "task-root-7a",
      status: "running",
      startedAt: now,
      multiLlmMode: true,
    };

    const analysisItem: AgentTeamItem = {
      id: "item-7a",
      teamRunId: analysisRun.id,
      parentItemId: undefined,
      title: "Analysis lane",
      description: undefined,
      ownerAgentRoleId: undefined,
      sourceTaskId: undefined,
      status: "todo",
      resultSummary: undefined,
      sortOrder: 1,
      createdAt: now,
      updatedAt: now,
    };

    const analysisRootTask: Task = {
      id: analysisRun.rootTaskId,
      title: "Root 7a",
      prompt: "Run multi-llm analysis",
      status: "executing",
      workspaceId: team.workspaceId,
      createdAt: now,
      updatedAt: now,
      agentType: "main",
      depth: 0,
      agentConfig: {
        multiLlmConfig: {
          participants: [
            {
              providerType: "openai",
              modelKey: "gpt-5.4-mini",
              displayName: "OpenAI Cheap",
            },
          ],
          judgeProviderType: "openai",
          judgeModelKey: "gpt-5.4",
        } as Any,
      },
    };

    const analysisTasksById = new Map<string, Task>([[analysisRootTask.id, analysisRootTask]]);
    const createAnalysisChildTask = vi.fn(async (params: Any) => {
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
      analysisTasksById.set(child.id, child);
      return child;
    });

    const analysisRepos = makeRepos({ team, run: analysisRun, items: [analysisItem] });
    const { AgentTeamOrchestrator } = await import("../AgentTeamOrchestrator");
    const analysisOrch = new AgentTeamOrchestrator(
      {
        getDatabase: () => ({}) as Any,
        getTaskById: async (taskId: string) => analysisTasksById.get(taskId),
        createChildTask: createAnalysisChildTask,
        cancelTask: async () => {},
      },
      analysisRepos,
    );

    await analysisOrch.tickRun(analysisRun.id, "test");

    const analysisCall = createAnalysisChildTask.mock.calls[0][0];
    expect(analysisCall.agentConfig.providerType).toBe("openai");
    expect(analysisCall.agentConfig.modelKey).toBe("gpt-5.4-mini");
    expect(analysisCall.agentConfig.llmProfile).toBe("cheap");

    const synthesisRun: AgentTeamRun = {
      id: "run-7b",
      teamId: team.id,
      rootTaskId: "task-root-7b",
      status: "running",
      startedAt: now,
      collaborativeMode: true,
      multiLlmMode: true,
      phase: "dispatch",
    };

    const synthesisItem: AgentTeamItem = {
      id: "item-7b",
      teamRunId: synthesisRun.id,
      parentItemId: undefined,
      title: "Analysis lane",
      description: "Done",
      ownerAgentRoleId: undefined,
      sourceTaskId: "task-child-7b",
      status: "done",
      resultSummary: "done",
      sortOrder: 1,
      createdAt: now,
      updatedAt: now,
    };

    const synthesisRootTask: Task = {
      id: synthesisRun.rootTaskId,
      title: "Root 7b",
      prompt: "Synthesize multi-llm results",
      status: "executing",
      workspaceId: team.workspaceId,
      createdAt: now,
      updatedAt: now,
      agentType: "main",
      depth: 0,
      agentConfig: analysisRootTask.agentConfig,
    };

    const completedSynthesisInput: Task = {
      id: "task-child-7b",
      title: "Analysis lane",
      prompt: "Done",
      status: "completed",
      workspaceId: team.workspaceId,
      createdAt: now,
      updatedAt: now,
      parentTaskId: synthesisRootTask.id,
      agentType: "sub",
      depth: 1,
    };

    const synthesisTasksById = new Map<string, Task>([
      [synthesisRootTask.id, synthesisRootTask],
      [completedSynthesisInput.id, completedSynthesisInput],
    ]);
    const createSynthesisChildTask = vi.fn(async (params: Any) => {
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
      synthesisTasksById.set(child.id, child);
      return child;
    });

    const synthesisRepos = makeRepos({ team, run: synthesisRun, items: [synthesisItem] });
    const synthesisOrch = new AgentTeamOrchestrator(
      {
        getDatabase: () => ({}) as Any,
        getTaskById: async (taskId: string) => synthesisTasksById.get(taskId),
        createChildTask: createSynthesisChildTask,
        cancelTask: async () => {},
      },
      synthesisRepos,
    );

    vi.spyOn((synthesisOrch as Any).thoughtRepo, "listByRun").mockReturnValue([]);
    await (synthesisOrch as Any).transitionToSynthesizePhase(
      synthesisRun,
      team,
      synthesisRootTask,
      [synthesisItem],
    );

    const synthesisCall = createSynthesisChildTask.mock.calls[0][0];
    expect(synthesisCall.title).toBe("Synthesis");
    expect(synthesisCall.agentConfig.providerType).toBe("openai");
    expect(synthesisCall.agentConfig.modelKey).toBe("gpt-5.4");
    expect(synthesisCall.agentConfig.llmProfile).toBe("strong");
  });
});
