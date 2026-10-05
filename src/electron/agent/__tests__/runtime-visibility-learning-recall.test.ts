import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeVisibilityService } from "../RuntimeVisibilityService";
import { MemoryService } from "../../memory/MemoryService";
import { KnowledgeGraphService } from "../../knowledge-graph/KnowledgeGraphService";
import { ChronicleObservationRepository } from "../../chronicle";
import { DurableContextService } from "../../memory/DurableContextService";
import { MemoryRecallService } from "../../memory/MemoryRecall";
import { SupermemoryService } from "../../memory/SupermemoryService";

describe("RuntimeVisibilityService learning + recall", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds a full learning progression in the expected order", () => {
    const now = Date.now();
    const progress = RuntimeVisibilityService.buildLearningProgress({
      task: {
        id: "task-1",
        workspaceId: "workspace-1",
        title: "Ship the feature",
        status: "completed",
        prompt: "Ship the feature",
      } as Any,
      outcome: "pending_review",
      summary: "Cowork captured the outcome and promoted a skill proposal.",
      memoryCaptured: true,
      playbookReinforced: true,
      skillProposal: {
        proposalId: "proposal-1",
        proposalStatus: "pending",
        reason: "The pattern has repeated enough times.",
      },
      evidenceRefs: [
        {
          evidenceId: "ev-1",
          sourceType: "file",
          sourceUrlOrPath: "/tmp/result.md",
          capturedAt: now,
        },
      ],
      nextAction: "Review the skill proposal",
    });

    expect(progress.taskId).toBe("task-1");
    expect(progress.summary).toContain("captured");
    expect(progress.steps.map((step) => step.stage)).toEqual([
      "screen_context_used",
      "memory_captured",
      "playbook_reinforced",
      "skill_proposed",
      "skill_reviewed",
    ]);
    expect(progress.steps[0]?.status).toBe("skipped");
    expect(progress.steps[1]?.status).toBe("done");
    expect(progress.steps[2]?.status).toBe("done");
    expect(progress.steps[3]?.status).toBe("pending");
    expect(progress.steps[4]?.status).toBe("pending");
  });

  function mockSources(): {
    searchWorkspaceMarkdown: ReturnType<typeof vi.spyOn>;
    recall: ReturnType<typeof vi.fn>;
  } {
    const recall = vi.fn(async (request: { lanes?: string[] }) => ({
      lanes: request.lanes ?? [],
      laneErrors: {},
      missing: [],
      hits: request.lanes?.includes("external")
        ? [
            {
              lane: "external",
              ref: "external:sm-1",
              title: "Alpha in Supermemory",
              snippet: "alpha rollout remote note",
              score: 0.5,
              laneRanks: { external: 1 },
              source: "document",
              createdAt: 100,
              relevance: 1,
            },
          ]
        : [
            {
              lane: "memory",
              ref: "memory:item-1",
              title: "Alpha rollout is staged",
              snippet: "Alpha rollout is staged by region",
              score: 0.9,
              laneRanks: { memory: 1 },
              source: "user_stated",
              kind: "project_fact",
              createdAt: 100,
              relevance: 1,
            },
          ],
    }));
    vi.spyOn(MemoryRecallService, "getDefault").mockReturnValue({
      recall,
    } as unknown as MemoryRecallService);
    vi.spyOn(SupermemoryService, "isConfigured").mockReturnValue(true);
    vi.spyOn(MemoryService, "searchForBriefingAsync").mockResolvedValue([
      {
        id: "memory-1",
        workspaceId: "workspace-1",
        taskId: "task-1",
        type: "note",
        // FTS/hybrid hit without the literal query phrase: must not be filtered out.
        snippet: "alpha rollout memory note",
        createdAt: 100,
        relevanceScore: 0.8,
      } as Any,
    ]);
    const searchWorkspaceMarkdown = vi
      .spyOn(MemoryService, "searchWorkspaceMarkdown")
      .mockResolvedValue([
        {
          id: "note-1",
          path: "/workspace/.cowork/notes.md",
          type: "workspace_note",
          snippet: "alpha workspace note",
          createdAt: 100,
          relevanceScore: 0.75,
        } as Any,
      ]);
    vi.spyOn(KnowledgeGraphService, "search").mockResolvedValue([
      {
        entity: {
          id: "kg-1",
          name: "Alpha entity",
          description: "alpha knowledge graph node",
          updatedAt: 100,
          entityTypeName: "Concept",
          confidence: 0.8,
        },
        score: 0.7,
      } as Any,
    ]);
    vi.spyOn(ChronicleObservationRepository, "searchSync").mockReturnValue([
      {
        id: "chronicle-1",
        workspaceId: "workspace-1",
        taskId: "task-1",
        query: "alpha",
        observationId: "obs-1",
        capturedAt: 100,
        promotedAt: 110,
        displayId: "1",
        appName: "VS Code",
        windowTitle: "alpha.ts",
        imagePath: "/workspace/.cowork/chronicle/assets/alpha.png",
        localTextSnippet: "alpha screen context",
        confidence: 0.77,
        usedFallback: false,
        width: 100,
        height: 100,
        destinationHints: ["repo_file"],
      },
      {
        id: "chronicle-unrelated",
        workspaceId: "workspace-1",
        capturedAt: 200,
        appName: "Mail",
        windowTitle: "Inbox",
        localTextSnippet: "nothing relevant",
        confidence: 0.9,
      },
    ] as Any);
    vi.spyOn(DurableContextService, "searchConversation").mockResolvedValue([
      {
        id: "dce_1",
        kind: "event",
        workspaceId: "workspace-1",
        taskId: "task-1",
        type: "assistant_message",
        role: "assistant",
        timestamp: 100,
        snippet: "alpha message",
        eventId: "event-1",
        score: 0.02,
      },
      {
        id: "dce_2",
        kind: "event",
        workspaceId: "workspace-1",
        taskId: "task-1",
        type: "tool_result",
        role: "tool",
        timestamp: 100,
        snippet: "run_command alpha build passed",
        eventId: "event-3",
        score: 0.01,
      },
    ]);
    return { searchWorkspaceMarkdown, recall };
  }

  const deps = {
    taskRepo: {
      searchByTerms: async () => [
        {
          id: "task-1",
          workspaceId: "workspace-1",
          title: "Alpha task",
          prompt: "alpha prompt",
          resultSummary: "alpha result",
          status: "completed",
          createdAt: 100,
          updatedAt: 100,
        },
        {
          id: "task-other",
          workspaceId: "workspace-2",
          title: "Alpha task elsewhere",
          prompt: "alpha prompt",
          status: "completed",
          createdAt: 100,
          updatedAt: 100,
        },
      ],
    } as Any,
    eventRepo: {
      findByTaskIds: () => [
        {
          id: "event-2",
          taskId: "task-1",
          type: "file_created",
          payload: { path: "/workspace/alpha.ts", message: "alpha file" },
          timestamp: 100,
        },
      ],
    } as Any,
    activityRepo: {
      search: async () => [
        {
          id: "activity-1",
          taskId: "task-1",
          title: "Alpha activity",
          description: "alpha activity note",
          createdAt: 100,
          activityType: "info",
          actorType: "system",
          workspaceId: "workspace-1",
        },
      ],
    } as Any,
    workspaceRepo: { findById: () => ({ path: "/workspace" }) } as Any,
  };

  it("fuses every lane by reciprocal rank without discarding FTS hits", async () => {
    const { searchWorkspaceMarkdown } = mockSources();
    const searchForPromptRecall = vi.spyOn(MemoryService, "searchForPromptRecall");
    const search = vi.spyOn(MemoryService, "search");

    const response = await RuntimeVisibilityService.collectUnifiedRecall(deps, {
      workspaceId: "workspace-1",
      workspacePath: "/workspace",
      query: "alpha rollout",
      limit: 20,
    });

    const sources = response.results.map((result) => result.sourceType);
    // Memory items come from the engine's recall; Supermemory needs network access.
    expect(response.results.some((result) => result.objectId === "memory:item-1")).toBe(true);
    expect(sources).not.toContain("supermemory");
    expect(sources).toEqual(
      expect.arrayContaining([
        "task",
        "message",
        "conversation",
        "file",
        "memory",
        "workspace_note",
        "screen_context",
        "knowledge_graph",
      ]),
    );
    // Ranks are fused positions, strictly ordered within the response.
    for (let index = 1; index < response.results.length; index += 1) {
      expect(response.results[index - 1]!.rank).toBeGreaterThanOrEqual(
        response.results[index]!.rank,
      );
    }
    expect(response.results[0]?.rank).toBeLessThanOrEqual(1);
    // The memory hit lacks the phrase "alpha rollout" but is an FTS hit: kept.
    expect(response.results.some((result) => result.objectId === "memory-1")).toBe(true);
    // Unrelated screen context and other workspaces' tasks are not.
    expect(response.results.some((result) => result.objectId === "chronicle-unrelated")).toBe(
      false,
    );
    expect(response.results.some((result) => result.objectId === "task-other")).toBe(false);
    // Browsing records no memory references, and notes come from the `.cowork` kit.
    expect(searchForPromptRecall).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
    // Notes are read through a read guard (no background index sync from a browse),
    // which refuses anything outside the kit.
    expect(searchWorkspaceMarkdown).toHaveBeenCalledWith(
      "workspace-1",
      "/workspace/.cowork",
      "alpha rollout",
      expect.any(Number),
      expect.any(Function),
    );
    const guard = searchWorkspaceMarkdown.mock.calls[0]![4] as (candidate: string) => boolean;
    expect(guard("/workspace/.cowork/notes.md")).toBe(true);
    expect(guard("/workspace/.cowork/../secrets.md")).toBe(false);
    expect(guard("/etc/passwd")).toBe(false);
    expect(DurableContextService.searchConversation).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "workspace-1" }),
    );
  });

  it("filters by source type and returns nothing without a workspace", async () => {
    mockSources();
    const messagesOnly = await RuntimeVisibilityService.collectUnifiedRecall(deps, {
      workspaceId: "workspace-1",
      workspacePath: "/workspace",
      query: "alpha",
      sourceTypes: ["message"],
    });
    expect(new Set(messagesOnly.results.map((result) => result.sourceType))).toEqual(
      new Set(["message"]),
    );
    expect(messagesOnly.results.map((result) => result.snippet)).toEqual(
      expect.arrayContaining(["alpha message", "Alpha activity alpha activity note"]),
    );

    const noWorkspace = await RuntimeVisibilityService.collectUnifiedRecall(deps, {
      query: "alpha",
    });
    expect(noWorkspace.results).toEqual([]);
  });

  it("searches every task and activity of the workspace, not a recent window", async () => {
    mockSources();
    const old = Date.now() - 400 * 24 * 60 * 60 * 1000;
    const searchByTerms = vi.fn(async () => [
      {
        id: "task-old",
        workspaceId: "workspace-1",
        title: "Postgres migration plan",
        prompt: "plan the postgres 16 migration",
        status: "completed",
        createdAt: old,
        updatedAt: old,
      },
    ]);
    const search = vi.fn(async () => [
      {
        id: "activity-old",
        workspaceId: "workspace-1",
        title: "Postgres migration finished",
        description: "",
        createdAt: old,
        activityType: "info",
        actorType: "system",
      },
    ]);
    const response = await RuntimeVisibilityService.collectUnifiedRecall(
      {
        ...deps,
        taskRepo: { searchByTerms } as Any,
        activityRepo: { search } as Any,
      },
      {
        workspaceId: "workspace-1",
        workspacePath: "/workspace",
        query: "postgres migration",
        sourceTypes: ["task", "message"],
      },
    );
    expect(searchByTerms).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        terms: ["postgres", "migration"],
        minMatched: 1,
      }),
    );
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "workspace-1", terms: ["postgres", "migration"] }),
    );
    expect(response.results.map((result) => result.objectId)).toEqual(
      expect.arrayContaining(["task-old", "activity-old"]),
    );
  });

  it("adds a Supermemory lane only when connected and the workspace allows network access", async () => {
    const { recall } = mockSources();
    const workspace = {
      id: "workspace-1",
      name: "Alpha",
      path: "/workspace",
      permissions: { read: true, write: true, delete: false, network: true, shell: false },
    };
    const response = await RuntimeVisibilityService.collectUnifiedRecall(deps, {
      workspaceId: "workspace-1",
      workspace: workspace as Any,
      query: "alpha rollout",
      sourceTypes: ["supermemory"],
    });
    expect(response.results.map((result) => result.sourceType)).toEqual(["supermemory"]);
    expect(recall).toHaveBeenCalledWith(
      expect.objectContaining({
        lanes: ["external"],
        policy: expect.objectContaining({ allowExternal: true, workspaceName: "Alpha" }),
      }),
    );

    recall.mockClear();
    const offline = await RuntimeVisibilityService.collectUnifiedRecall(deps, {
      workspaceId: "workspace-1",
      workspace: { ...workspace, permissions: { ...workspace.permissions, network: false } } as Any,
      query: "alpha rollout",
      sourceTypes: ["supermemory"],
    });
    expect(offline.results).toEqual([]);
    expect(recall).not.toHaveBeenCalled();
  });
});
