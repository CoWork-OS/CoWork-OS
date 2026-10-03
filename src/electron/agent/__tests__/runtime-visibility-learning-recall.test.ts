import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeVisibilityService } from "../RuntimeVisibilityService";
import { MemoryService } from "../../memory/MemoryService";
import { KnowledgeGraphService } from "../../knowledge-graph/KnowledgeGraphService";
import { ChronicleObservationRepository } from "../../chronicle";
import { DurableContextService } from "../../memory/DurableContextService";

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

  function mockSources(): { searchWorkspaceMarkdown: ReturnType<typeof vi.spyOn> } {
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
    return { searchWorkspaceMarkdown };
  }

  const deps = {
    taskRepo: {
      findByCreatedAtRange: async () => [
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
      list: async () => [
        {
          id: "activity-1",
          taskId: "task-1",
          title: "Alpha activity",
          description: "alpha activity note",
          createdAt: 100,
          activityType: "info",
          actorType: "system",
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
    expect(searchWorkspaceMarkdown).toHaveBeenCalledWith(
      "workspace-1",
      "/workspace/.cowork",
      "alpha rollout",
      expect.any(Number),
    );
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
});
