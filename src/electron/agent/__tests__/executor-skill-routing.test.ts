import { beforeEach, describe, expect, it, vi } from "vitest";

const rankModelInvocableSkillsForQuery = vi.fn();
const listSkills = vi.fn();

vi.mock("../custom-skill-loader", () => ({
  getCustomSkillLoader: () => ({
    rankModelInvocableSkillsForQuery,
    listSkills,
  }),
}));

import { TaskExecutor } from "../executor";

describe("TaskExecutor skill shortlist routing", () => {
  function createExecutor(prompt: string, taskOverrides: Any = {}) {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    const resolvedInvocations = new Map<string, Any>();

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
    executor.emitEvent = vi.fn();
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

    return executor as TaskExecutor & {
      emitEvent: ReturnType<typeof vi.fn>;
      getAvailableTools: ReturnType<typeof vi.fn>;
      toolRegistry: {
        executeTool: ReturnType<typeof vi.fn>;
        takeResolvedSkillInvocation: ReturnType<typeof vi.fn>;
      };
      __resolvedInvocations: Map<string, Any>;
    };
  }

  beforeEach(() => {
    rankModelInvocableSkillsForQuery.mockReset();
    listSkills.mockReset();
    listSkills.mockReturnValue([]);
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

    const handled = await (TaskExecutor as Any).prototype.maybeHandleHighConfidenceSkillRouting.call(
      executor,
    );

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

    const handled = await (TaskExecutor as Any).prototype.maybeHandleHighConfidenceSkillRouting.call(
      executor,
    );

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
});
