import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CustomSkill, PendingSkillParameterCollection } from "../../../shared/types";

const mockGetSkill = vi.fn();

vi.mock("../custom-skill-loader", () => ({
  getCustomSkillLoader: () => ({
    getSkill: mockGetSkill,
  }),
}));

import { TaskExecutor } from "../executor";

function createRuntimeState(initialPending: PendingSkillParameterCollection | null) {
  let pending = initialPending ? { ...initialPending } : null;
  let primaryHandled = false;
  return {
    getPendingSkillParameterCollection: vi.fn(() => (pending ? { ...pending } : null)),
    setPendingSkillParameterCollection: vi.fn((next: PendingSkillParameterCollection | null) => {
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
}

function createExecutorHarness(pending: PendingSkillParameterCollection): TaskExecutor & {
  emitEvent: ReturnType<typeof vi.fn>;
  appendConversationHistory: ReturnType<typeof vi.fn>;
  saveConversationSnapshot: ReturnType<typeof vi.fn>;
  executeSkillInvocation: ReturnType<typeof vi.fn>;
  daemon: { updateTask: ReturnType<typeof vi.fn> };
  __runtime: ReturnType<typeof createRuntimeState>;
} {
  const runtime = createRuntimeState(pending);
  const executor = Object.create(TaskExecutor.prototype) as Any;
  executor.task = {
    id: "task-pending-skill-1",
    title: "Run /decision-prep",
    prompt: "/decision-prep",
    rawPrompt: "/decision-prep",
    userPrompt: "/decision-prep",
    status: "paused",
    workspaceId: "workspace-1",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  executor.plan = undefined;
  executor.waitingForUserInput = true;
  executor.lastPauseReason = "skill_parameters";
  executor.lastAwaitingUserInputReasonCode = "skill_parameters";
  executor.emitEvent = vi.fn();
  executor.appendConversationHistory = vi.fn();
  executor.saveConversationSnapshot = vi.fn();
  executor.executeSkillInvocation = vi.fn().mockResolvedValue("applied");
  executor.daemon = {
    updateTask: vi.fn(),
  };
  executor.getSessionRuntime = vi.fn(() => runtime);
  executor.__runtime = runtime;
  return executor;
}

describe("TaskExecutor pending slash-skill parameter collection", () => {
  beforeEach(() => {
    mockGetSkill.mockReset();
  });

  it("accepts a required string answer and auto-applies the skill exactly once", async () => {
    const pending: PendingSkillParameterCollection = {
      skillId: "decision-prep",
      skillName: "Decision Prep",
      trigger: "slash",
      parameters: {
        num_options: "2-4",
      },
      requiredParameterNames: ["decision_topic"],
      currentParameterIndex: 0,
      startedAt: Date.now(),
    };
    mockGetSkill.mockReturnValue({
      id: "decision-prep",
      name: "Decision Prep",
      description: "Prepare a decision package.",
      icon: "⚖️",
      prompt: "Prepare {{decision_topic}}",
      parameters: [
        {
          name: "decision_topic",
          type: "string",
          description: "The decision to prepare for",
          required: true,
        },
      ],
    } satisfies CustomSkill);
    const executor = createExecutorHarness(pending);

    const result = await (TaskExecutor as Any).prototype.handlePendingSkillParameterReply.call(
      executor,
      "Migrate from REST to GraphQL",
    );

    expect(result).toBe("continue");
    expect(executor.executeSkillInvocation).toHaveBeenCalledTimes(1);
    expect(executor.executeSkillInvocation).toHaveBeenCalledWith(
      "decision-prep",
      '{"num_options":"2-4","decision_topic":"Migrate from REST to GraphQL"}',
      "/decision-prep",
      "slash",
    );
    expect(executor.__runtime.pending).toBeNull();
    expect(executor.emitEvent).toHaveBeenCalledWith(
      "skill_parameter_collection_finished",
      expect.objectContaining({
        status: "applied",
      }),
    );
  });

  it("reprompts when a required select answer is invalid", async () => {
    const pending: PendingSkillParameterCollection = {
      skillId: "explain-code",
      skillName: "Explain Code",
      trigger: "slash",
      parameters: {},
      requiredParameterNames: ["level"],
      currentParameterIndex: 0,
      startedAt: Date.now(),
    };
    mockGetSkill.mockReturnValue({
      id: "explain-code",
      name: "Explain Code",
      description: "Explain source code.",
      icon: "📖",
      prompt: "Explain {{level}}",
      parameters: [
        {
          name: "level",
          type: "select",
          description: "Explanation depth",
          required: true,
          options: ["beginner", "intermediate", "advanced"],
        },
      ],
    } satisfies CustomSkill);
    const executor = createExecutorHarness(pending);

    const result = await (TaskExecutor as Any).prototype.handlePendingSkillParameterReply.call(
      executor,
      "expert",
    );

    expect(result).toBe("paused");
    expect(executor.executeSkillInvocation).not.toHaveBeenCalled();
    expect(executor.__runtime.pending).toEqual(
      expect.objectContaining({
        currentParameterIndex: 0,
      }),
    );
    expect(executor.daemon.updateTask).toHaveBeenCalledWith(
      "task-pending-skill-1",
      expect.objectContaining({
        status: "paused",
        awaitingUserInputReasonCode: "skill_parameters",
      }),
    );
    expect(executor.emitEvent).toHaveBeenCalledWith(
      "assistant_message",
      expect.objectContaining({
        message: expect.stringContaining("beginner, intermediate, advanced"),
      }),
    );
  });
});
