import { beforeEach, describe, expect, it, vi } from "vitest";

const rankModelInvocableSkillsForQuery = vi.fn();
const listSkills = vi.fn();
const getSkill = vi.fn();

vi.mock("../custom-skill-loader", () => ({
  getCustomSkillLoader: () => ({
    rankModelInvocableSkillsForQuery,
    listSkills,
    getSkill,
  }),
}));

import { TaskExecutor } from "../executor";

describe("TaskExecutor skill shortlist routing", () => {
  function createExecutor(prompt: string, taskOverrides: Any = {}) {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    const resolvedInvocations = new Map<string, Any>();
    let pending: Any = null;
    let primaryHandled = false;
    const runtime = {
      getPendingSkillParameterCollection: vi.fn(() => (pending ? { ...pending } : null)),
      setPendingSkillParameterCollection: vi.fn((next: Any) => {
        pending = next ? { ...next } : null;
        return pending ? { ...pending } : null;
      }),
      markPrimarySlashCommandHandled: vi.fn(() => {
        primaryHandled = true;
      }),
      hasHandledPrimarySlashCommand: vi.fn(() => primaryHandled),
      get pending() {
        return pending;
      },
    };

    executor.task = {
      id: "task-skill-route-1",
      title: "Routing test",
      prompt,
      rawPrompt: taskOverrides.rawPrompt ?? prompt,
      userPrompt: taskOverrides.userPrompt ?? prompt,
      createdAt: Date.now() - 1000,
      ...taskOverrides,
    };
    executor.appliedSkills = [];
    executor.taskContextNotes = [];
    executor.workspace = {
      id: "workspace-1",
      name: "Workspace",
      path: "/tmp/workspace",
      createdAt: Date.now() - 1000,
      permissions: {
        read: true,
        write: true,
        delete: false,
        shell: true,
        network: false,
        unrestrictedFileAccess: false,
      },
      isTemp: false,
    };
    executor.emitEvent = vi.fn();
    executor.appendConversationHistory = vi.fn();
    executor.saveConversationSnapshot = vi.fn();
    executor.daemon = {
      updateTask: vi.fn(),
    };
    executor.getSessionRuntime = vi.fn(() => runtime);
    executor.getAvailableTools = vi.fn(() => [{ name: "Skill" }]);
    executor.toolRegistry = {
      executeTool: vi.fn(async (_name: string, _input: Any) => {
        throw new Error("Unexpected tool execution");
      }),
      takeResolvedSkillInvocation: vi.fn((invocationId: string) => {
        const resolved = resolvedInvocations.get(invocationId) || null;
        resolvedInvocations.delete(invocationId);
        return resolved;
      }),
    };
    executor.__resolvedInvocations = resolvedInvocations;
    executor.__runtime = runtime;

    return executor as TaskExecutor & {
      emitEvent: ReturnType<typeof vi.fn>;
      appendConversationHistory: ReturnType<typeof vi.fn>;
      saveConversationSnapshot: ReturnType<typeof vi.fn>;
      daemon: {
        updateTask: ReturnType<typeof vi.fn>;
      };
      getSessionRuntime: ReturnType<typeof vi.fn>;
      getAvailableTools: ReturnType<typeof vi.fn>;
      toolRegistry: {
        executeTool: ReturnType<typeof vi.fn>;
        takeResolvedSkillInvocation: ReturnType<typeof vi.fn>;
      };
      __resolvedInvocations: Map<string, Any>;
      __runtime: typeof runtime;
    };
  }

  beforeEach(() => {
    rankModelInvocableSkillsForQuery.mockReset();
    listSkills.mockReset();
    getSkill.mockReset();
    listSkills.mockReturnValue([]);
    getSkill.mockReturnValue(undefined);
  });

  it("ranks candidate skills for planning but does not auto-apply them", async () => {
    rankModelInvocableSkillsForQuery.mockReturnValue([
      {
        skill: {
          id: "codex-cli",
          name: "Codex CLI Agent",
          description: "Review a PR with Codex CLI.",
          metadata: { routing: { useWhen: "Use when a coding task needs Codex." } },
        },
        score: 0.93,
      },
      {
        skill: {
          id: "code-review",
          name: "Code Review",
          description: "Review a code change.",
          metadata: { routing: { useWhen: "Use when reviewing code." } },
        },
        score: 0.61,
      },
    ]);

    const prompt = "We need to review PR #55 on cowork os repo. Spin up Codex to review it.";
    const executor = createExecutor(prompt);

    const handled = await (
      TaskExecutor as Any
    ).prototype.maybeHandleHighConfidenceSkillRouting.call(executor);

    expect(handled).toBe(false);
    expect(executor.toolRegistry.executeTool).not.toHaveBeenCalled();
    expect(executor.task.prompt).toBe(prompt);
    expect(executor.emitEvent).toHaveBeenCalledWith(
      "skill_candidates_ranked",
      expect.objectContaining({
        candidates: expect.arrayContaining([
          expect.objectContaining({
            skillId: "codex-cli",
            score: 0.93,
          }),
        ]),
      }),
    );
  });

  it("does not let quoted pasted text hijack the task into a skill", async () => {
    rankModelInvocableSkillsForQuery.mockReturnValue([
      {
        skill: {
          id: "frontend",
          name: "Frontend",
          description: "Implement frontend work.",
          metadata: { routing: { useWhen: "Use for UI implementation tasks." } },
        },
        score: 0.21,
      },
    ]);

    const prompt = [
      "Summarize Karpathy's post and extract the repo names he mentioned.",
      "",
      'Pasted text: I use Obsidian as the IDE "frontend" for most notes.',
    ].join("\n");
    const executor = createExecutor(prompt);

    const handled = await (
      TaskExecutor as Any
    ).prototype.maybeHandleHighConfidenceSkillRouting.call(executor);

    expect(handled).toBe(false);
    expect(executor.toolRegistry.executeTool).not.toHaveBeenCalled();
    expect(executor.task.prompt).toBe(prompt);
    expect(executor.emitEvent).toHaveBeenCalledWith(
      "skill_candidates_ranked",
      expect.objectContaining({
        candidates: expect.any(Array),
      }),
    );
  });

  it("auto-applies explicitly requested skills from plain-English step text", async () => {
    listSkills.mockReturnValue([
      {
        id: "novelist",
        name: "Novelist",
        description: "Write a novel end-to-end.",
        enabled: true,
      },
    ]);

    const executor = createExecutor("Write a novel from this brief.");
    executor.currentStepId = "step-3";
    executor.toolRegistry.executeTool.mockImplementation(async (name: string, input: Any) => {
      expect(name).toBe("Skill");
      expect(input).toEqual({
        skill: "novelist",
        args: "",
        trigger: "explicit_hint",
      });
      const invocationId = "skill-invocation-1";
      executor.__resolvedInvocations.set(invocationId, {
        skillId: "novelist",
        skillName: "Novelist",
        trigger: "explicit_hint",
        args: "",
        parameters: {},
        content: "Expanded novelist instructions",
        reason: "Applied as additive skill context while preserving the original task.",
        appliedAt: Date.now(),
      });
      return {
        success: true,
        skill: "novelist",
        skill_name: "Novelist",
        skill_invocation_id: invocationId,
        message: "Loaded skill 'Novelist' for this task.",
      };
    });

    const handled = await (
      TaskExecutor as Any
    ).prototype.maybeAutoApplyExplicitSkillInvocation.call(
      executor,
      "Apply the 'novelist' skill to draft and package the novel from the approved brief.",
      "step",
      "the skill requested by step",
    );

    expect(handled).toBe(true);
    expect(executor.appliedSkills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          skillId: "novelist",
          trigger: "explicit_hint",
          content: "Expanded novelist instructions",
        }),
      ]),
    );
    expect(executor.taskContextNotes).toEqual(
      expect.arrayContaining([
        expect.stringContaining("The explicitly requested skill 'novelist' is already active"),
      ]),
    );
  });

  it("auto-applies explicitly requested skills from the task prompt before planning", async () => {
    listSkills.mockReturnValue([
      {
        id: "novelist",
        name: "Novelist",
        description: "Write a novel end-to-end.",
        enabled: true,
      },
    ]);

    const prompt =
      "Use the novelist skill to develop, draft, revise, and package a novel from the approved brief.";
    const executor = createExecutor(prompt);
    executor.toolRegistry.executeTool.mockImplementation(async (name: string, input: Any) => {
      expect(name).toBe("Skill");
      expect(input).toEqual({
        skill: "novelist",
        args: "",
        trigger: "explicit_hint",
      });
      const invocationId = "skill-invocation-task";
      executor.__resolvedInvocations.set(invocationId, {
        skillId: "novelist",
        skillName: "Novelist",
        trigger: "explicit_hint",
        args: "",
        parameters: {},
        content: "Expanded novelist instructions",
        reason: "Applied as additive skill context while preserving the original task.",
        appliedAt: Date.now(),
      });
      return {
        success: true,
        skill: "novelist",
        skill_name: "Novelist",
        skill_invocation_id: invocationId,
        message: "Loaded skill 'Novelist' for this task.",
      };
    });

    const handled = await (
      TaskExecutor as Any
    ).prototype.maybeAutoApplyExplicitSkillInvocation.call(
      executor,
      executor.task.prompt,
      "task",
      "the explicitly requested task skill",
    );

    expect(handled).toBe(true);
    expect(executor.appliedSkills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          skillId: "novelist",
          trigger: "explicit_hint",
        }),
      ]),
    );
  });

  it("auto-applies explicitly requested hyphenated skill ids from the task prompt", async () => {
    listSkills.mockReturnValue([
      {
        id: "imagegen-frontend-web",
        name: "Imagegen Frontend Web",
        description: "Generate frontend website section reference images.",
        enabled: true,
      },
    ]);

    const prompt =
      "Use imagegen-frontend-web skill and with that skill generate images for a website.";
    const executor = createExecutor(prompt);
    executor.toolRegistry.executeTool.mockImplementation(async (name: string, input: Any) => {
      expect(name).toBe("Skill");
      expect(input).toEqual({
        skill: "imagegen-frontend-web",
        args: "",
        trigger: "explicit_hint",
      });
      const invocationId = "skill-invocation-imagegen";
      executor.__resolvedInvocations.set(invocationId, {
        skillId: "imagegen-frontend-web",
        skillName: "Imagegen Frontend Web",
        trigger: "explicit_hint",
        args: "",
        parameters: {},
        content: "Expanded imagegen frontend web instructions",
        reason: "Applied as additive skill context while preserving the original task.",
        appliedAt: Date.now(),
      });
      return {
        success: true,
        skill: "imagegen-frontend-web",
        skill_name: "Imagegen Frontend Web",
        skill_invocation_id: invocationId,
        message: "Loaded skill 'Imagegen Frontend Web' for this task.",
      };
    });

    const handled = await (
      TaskExecutor as Any
    ).prototype.maybeAutoApplyExplicitSkillInvocation.call(
      executor,
      executor.task.prompt,
      "task",
      "the explicitly requested task skill",
    );

    expect(handled).toBe(true);
    expect(executor.appliedSkills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          skillId: "imagegen-frontend-web",
          skillName: "Imagegen Frontend Web",
          trigger: "explicit_hint",
          content: "Expanded imagegen frontend web instructions",
        }),
      ]),
    );
  });

  it("blocks code review skill invocation in a temporary workspace", async () => {
    const executor = createExecutor("/review all uncommitted fixes");
    executor.workspace = {
      ...executor.workspace,
      id: "__temp_workspace__",
      name: "Temporary Workspace",
      isTemp: true,
    };

    await expect(
      (TaskExecutor as Any).prototype.executeSkillInvocation.call(
        executor,
        "code-reviewer",
        "all uncommitted fixes",
        "/review",
        "slash",
      ),
    ).rejects.toThrow("requires a regular workspace");

    expect(executor.toolRegistry.executeTool).not.toHaveBeenCalled();
  });

  it("deterministically routes natural research-vault prompts into llm-wiki", async () => {
    listSkills.mockReturnValue([
      {
        id: "llm-wiki",
        name: "LLM Wiki",
        description: "Build and maintain a persistent research vault.",
        enabled: true,
        parameters: [
          { name: "objective", type: "string", required: false, default: "" },
          { name: "mode", type: "string", required: false, default: "auto" },
          { name: "path", type: "string", required: false, default: "research/wiki" },
          { name: "obsidian", type: "string", required: false, default: "auto" },
        ],
      },
    ]);

    const prompt = "Build a persistent Obsidian-friendly research vault for agent memory systems.";
    const executor = createExecutor(prompt);
    executor.toolRegistry.executeTool.mockImplementation(async (name: string, input: Any) => {
      expect(name).toBe("Skill");
      expect(input).toEqual({
        skill: "llm-wiki",
        args: '"agent memory systems" --obsidian on',
        trigger: "explicit_hint",
      });
      const invocationId = "skill-invocation-llm-wiki";
      executor.__resolvedInvocations.set(invocationId, {
        skillId: "llm-wiki",
        skillName: "LLM Wiki",
        trigger: "explicit_hint",
        args: '"agent memory systems" --obsidian on',
        parameters: {
          objective: "agent memory systems",
          obsidian: "on",
        },
        content: "Expanded llm-wiki instructions",
        reason: "Applied as additive skill context while preserving the original task.",
        appliedAt: Date.now(),
      });
      return {
        success: true,
        skill: "llm-wiki",
        skill_name: "LLM Wiki",
        skill_invocation_id: invocationId,
        message: "Loaded skill 'LLM Wiki' for this task.",
      };
    });

    const handled = await (TaskExecutor as Any).prototype.maybeHandleNaturalLlmWikiPrompt.call(
      executor,
    );

    expect(handled).toBe(true);
    expect(executor.appliedSkills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          skillId: "llm-wiki",
          trigger: "explicit_hint",
          parameters: expect.objectContaining({
            objective: "agent memory systems",
            obsidian: "on",
          }),
        }),
      ]),
    );
  });

  it("routes starter-style research-vault prompts even before the user supplies a topic", async () => {
    listSkills.mockReturnValue([
      {
        id: "llm-wiki",
        name: "LLM Wiki",
        description: "Build and maintain a persistent research vault.",
        enabled: true,
        parameters: [
          { name: "objective", type: "string", required: false, default: "" },
          { name: "mode", type: "string", required: false, default: "auto" },
          { name: "path", type: "string", required: false, default: "research/wiki" },
          { name: "obsidian", type: "string", required: false, default: "auto" },
        ],
      },
    ]);
    getSkill.mockReturnValue({
      id: "llm-wiki",
      name: "LLM Wiki",
      description: "Build and maintain a persistent research vault.",
      parameters: [
        {
          name: "objective",
          type: "string",
          description: "The topic, question, or research objective for the wiki run",
          required: false,
        },
      ],
    });

    const prompt =
      "Build a persistent Obsidian-friendly research vault in this workspace. If I have not given the topic yet, ask me for it first.";
    const executor = createExecutor(prompt);

    const handled = await (TaskExecutor as Any).prototype.maybeHandleNaturalLlmWikiPrompt.call(
      executor,
    );

    expect(handled).toBe(true);
    expect(executor.toolRegistry.executeTool).not.toHaveBeenCalled();
    expect(executor.appliedSkills).toEqual([]);
    expect(executor.__runtime.pending).toEqual(
      expect.objectContaining({
        skillId: "llm-wiki",
        skillName: "LLM Wiki",
        trigger: "explicit_hint",
        parameters: {
          obsidian: "on",
        },
        requiredParameterNames: ["objective"],
        currentParameterIndex: 0,
      }),
    );
    expect(executor.daemon.updateTask).toHaveBeenCalledWith(
      "task-skill-route-1",
      expect.objectContaining({
        status: "paused",
        awaitingUserInputReasonCode: "skill_parameters",
      }),
    );
    expect(executor.emitEvent).toHaveBeenCalledWith(
      "assistant_message",
      expect.objectContaining({
        message: expect.stringContaining("Reply with objective"),
      }),
    );
  });

  it("does not auto-apply a skill from planner tool transcript text embedded in a step", async () => {
    listSkills.mockReturnValue([
      {
        id: "twitter",
        name: "Twitter / X Writer",
        description: "Write optimized X content.",
        enabled: true,
      },
    ]);

    const executor = createExecutor("Research AI agent trends.");
    executor.currentStepId = "step-1";

    const handled = await (
      TaskExecutor as Any
    ).prototype.maybeAutoApplyExplicitSkillInvocation.call(
      executor,
      [
        "I'll create an execution plan for researching daily AI agent trends across Reddit, X, and tech news sources.",
        "<minimax:tool_call>",
        "task_list_create",
        'goal: "Complete Daily AI Agent Trends Research"',
        '{ ActiveForm: "Searching X/Twitter for AI agent trends" }',
      ].join("\n"),
      "step",
      "the skill requested by step",
    );

    expect(handled).toBe(false);
    expect(executor.toolRegistry.executeTool).not.toHaveBeenCalled();
    expect(executor.appliedSkills).toEqual([]);
  });

  it("does not auto-apply a skill from unrelated activation and skill words inside pasted content", async () => {
    listSkills.mockReturnValue([
      {
        id: "learn",
        name: "Learn",
        description: "Record a durable insight.",
        enabled: true,
        parameters: [{ name: "what", type: "string", required: true }],
      },
    ]);

    const executor = createExecutor("Summarize this article.");

    const handled = await (
      TaskExecutor as Any
    ).prototype.maybeAutoApplyExplicitSkillInvocation.call(
      executor,
      [
        "I need 3-4 diagrams to be added to this article in related places, write me text to image prompts for each so that I can create them one by one.",
        "",
        "You can swap providers, change models, or run local models.",
        "A lot of agent systems learn only from success stories.",
      ].join("\n"),
      "task",
      "the explicitly requested task skill",
    );

    expect(handled).toBe(false);
    expect(executor.toolRegistry.executeTool).not.toHaveBeenCalled();
    expect(executor.appliedSkills).toEqual([]);
  });

  it("does not auto-apply explicit skills that require mandatory parameters", async () => {
    listSkills.mockReturnValue([
      {
        id: "learn",
        name: "Learn",
        description: "Record a durable insight.",
        enabled: true,
        parameters: [{ name: "what", type: "string", required: true }],
      },
    ]);

    const executor = createExecutor("Use the learn skill for this request.");

    const handled = await (
      TaskExecutor as Any
    ).prototype.maybeAutoApplyExplicitSkillInvocation.call(
      executor,
      executor.task.prompt,
      "task",
      "the explicitly requested task skill",
    );

    expect(handled).toBe(false);
    expect(executor.toolRegistry.executeTool).not.toHaveBeenCalled();
    expect(executor.appliedSkills).toEqual([]);
  });
});
