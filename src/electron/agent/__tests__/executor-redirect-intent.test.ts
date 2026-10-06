import { describe, expect, it, vi } from "vitest";
import { TaskExecutor } from "../executor";

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue("/tmp"),
  },
}));

vi.mock("../custom-skill-loader", () => ({
  getCustomSkillLoader: () => ({
    getEnabledGuidelinesPrompt: () => "",
    rankModelInvocableSkillsForQuery: () => [],
  }),
}));

vi.mock("../../settings/personality-manager", () => ({
  PersonalityManager: {
    getPersonalityPrompt: vi.fn().mockReturnValue(""),
    getPersonalityPromptById: vi.fn().mockReturnValue(""),
    getIdentityPrompt: vi.fn().mockReturnValue(""),
  },
}));

/**
 * Tests for isRedirectIntent() and compactHistoryForRedirect().
 *
 * These cover the follow-up redirect detection logic that prevents the LLM
 * from anchoring on prior completed-task context when the user pivots to a
 * new direction.
 */
describe("TaskExecutor — isRedirectIntent", () => {
  const executor = Object.create(TaskExecutor.prototype) as Any;

  const isRedirect = (text: string): boolean =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (executor as any).isRedirectIntent(text);

  describe("Pattern 1 — ignore-and-pivot", () => {
    it("detects the canonical failure case", () => {
      expect(
        isRedirect(
          "ignore the openclaw related fixes for its codebase and focus on new features or enhancements",
        ),
      ).toBe(true);
    });

    it("detects 'ignore X and work on Y'", () => {
      expect(isRedirect("ignore the bug fixes and work on the dashboard instead")).toBe(true);
    });

    it("detects 'ignore X, do Y'", () => {
      expect(isRedirect("ignore the auth module, do the payment flow")).toBe(true);
    });

    it("detects 'ignore X and build Y'", () => {
      expect(isRedirect("ignore the refactoring tasks and build the new onboarding flow")).toBe(
        true,
      );
    });
  });

  describe("Pattern 2 — explicit pivot language", () => {
    it("detects 'pivot to X'", () => {
      expect(isRedirect("let's pivot to building the authentication flow")).toBe(true);
    });

    it("detects 'redirect to X'", () => {
      expect(isRedirect("redirect to working on the API endpoints")).toBe(true);
    });

    it("detects 'change direction'", () => {
      expect(isRedirect("change direction and focus on the payment module")).toBe(true);
    });

    it("detects 'change focus'", () => {
      expect(isRedirect("change focus to the frontend performance issues")).toBe(true);
    });

    it("detects 'change approach'", () => {
      expect(isRedirect("let's change approach and try a different architecture")).toBe(true);
    });

    it("detects 'new direction'", () => {
      expect(isRedirect("new direction: focus on the mobile app instead")).toBe(true);
    });
  });

  describe("Pattern 3 — contrast pivot", () => {
    it("detects 'instead of X, focus on Y'", () => {
      expect(isRedirect("instead of refactoring the old code, focus on writing new tests")).toBe(
        true,
      );
    });

    it("detects 'rather than X, build Y'", () => {
      expect(isRedirect("rather than fixing the existing bugs, build the new feature")).toBe(true);
    });

    it("detects 'instead of X, work on Y'", () => {
      expect(isRedirect("instead of the database migration, work on the UI redesign")).toBe(true);
    });
  });

  describe("Pattern 4 — negate-and-pivot", () => {
    it("detects 'forget that and focus on X'", () => {
      expect(isRedirect("forget that approach and instead focus on the API layer")).toBe(true);
    });

    it("detects 'don't do X, focus on Y'", () => {
      expect(isRedirect("don't fix the styling issues, focus on the backend logic instead")).toBe(
        true,
      );
    });

    it("detects 'skip X and work on Y'", () => {
      expect(isRedirect("skip the tests for now and work on the deployment script")).toBe(true);
    });

    it("detects 'drop X, concentrate on Y'", () => {
      expect(isRedirect("drop the OpenClaw integration, concentrate on the new features")).toBe(
        true,
      );
    });

    it("detects 'abandon X, focus instead'", () => {
      expect(isRedirect("abandon the current plan and focus instead on delivering the MVP")).toBe(
        true,
      );
    });
  });

  describe("Pattern 5 — scope narrowing", () => {
    it("detects 'focus only on Y'", () => {
      expect(isRedirect("focus only on the new features, not the old bugs")).toBe(true);
    });

    it("detects 'only focus on Y'", () => {
      expect(isRedirect("only focus on the critical path items")).toBe(true);
    });

    it("detects 'focus solely on Y'", () => {
      expect(isRedirect("focus solely on the performance improvements")).toBe(true);
    });

    it("detects 'focus exclusively on Y'", () => {
      expect(isRedirect("focus exclusively on the security fixes")).toBe(true);
    });
  });

  describe("non-redirect messages — should NOT be detected", () => {
    it("does not flag simple greetings", () => {
      expect(isRedirect("hello")).toBe(false);
      expect(isRedirect("thanks")).toBe(false);
      expect(isRedirect("good morning")).toBe(false);
    });

    it("does not flag plain execution tasks", () => {
      expect(isRedirect("build a REST API for user authentication")).toBe(false);
      expect(isRedirect("create a new React component for the dashboard")).toBe(false);
    });

    it("does not flag extend follow-ups", () => {
      expect(isRedirect("also check the auth module")).toBe(false);
      expect(isRedirect("what did you find in the logs?")).toBe(false);
      expect(isRedirect("can you also look at the payment service?")).toBe(false);
    });

    it("does not flag correction follow-ups", () => {
      expect(isRedirect("you used the wrong API, please use v2 instead")).toBe(false);
      expect(isRedirect("actually use the postgres database not sqlite")).toBe(false);
    });

    it("does not flag empty or whitespace input", () => {
      expect(isRedirect("")).toBe(false);
      expect(isRedirect("   ")).toBe(false);
    });
  });
});

describe("TaskExecutor — compactHistoryForRedirect", () => {
  it("replaces full conversation history with a user→assistant stub pair", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = { title: "Fix OpenClaw Bugs" };
    executor.conversationHistory = [
      { role: "user", content: [{ type: "text", text: "fix the bugs" }] },
      { role: "assistant", content: [{ type: "text", text: "Done, fixed 3 bugs." }] },
      { role: "user", content: [{ type: "text", text: "also check the logs" }] },
      { role: "assistant", content: [{ type: "text", text: "Logs look clean." }] },
    ];

    (executor as any).compactHistoryForRedirect();

    expect(executor.conversationHistory).toHaveLength(2);
  });

  it("stub starts with a user turn so providers requiring alternating roles are satisfied", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = { title: "Fix OpenClaw Bugs" };
    executor.conversationHistory = [];

    (executor as any).compactHistoryForRedirect();

    const [first, second] = executor.conversationHistory;
    // Must be user → assistant so appending the redirect message yields user,assistant,user
    expect(first.role).toBe("user");
    expect(second.role).toBe("assistant");
  });

  it("user stub references the task title", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = { title: "Fix OpenClaw Bugs" };
    executor.conversationHistory = [];

    (executor as any).compactHistoryForRedirect();

    const userText = executor.conversationHistory[0].content[0].text as string;
    expect(userText).toContain("Fix OpenClaw Bugs");
  });

  it("uses a generic label when task has no title", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = {};
    executor.conversationHistory = [
      { role: "user", content: [{ type: "text", text: "do something" }] },
    ];

    (executor as any).compactHistoryForRedirect();

    const userText = executor.conversationHistory[0].content[0].text as string;
    expect(userText).toContain("previous session");
  });

  it("both stub entries are valid LLMMessages with text content", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = { title: "Some Task" };
    executor.conversationHistory = [];

    (executor as any).compactHistoryForRedirect();

    for (const msg of executor.conversationHistory) {
      expect(Array.isArray(msg.content)).toBe(true);
      expect(msg.content[0].type).toBe("text");
      expect(typeof msg.content[0].text).toBe("string");
      expect(msg.content[0].text.length).toBeGreaterThan(0);
    }
  });

  it("appending a user redirect message after compaction yields valid user,assistant,user order", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = { title: "Old Task" };
    executor.conversationHistory = [];

    (executor as any).compactHistoryForRedirect();

    // Simulate what sendMessageLegacy does: append the redirect message
    executor.conversationHistory.push({
      role: "user",
      content: [{ type: "text", text: "ignore X, focus on Y instead" }],
    });

    const roles = executor.conversationHistory.map((m: Any) => m.role);
    expect(roles).toEqual(["user", "assistant", "user"]);
  });
});

describe("TaskExecutor — sendMessageLegacy redirect wiring", () => {
  it("sets redirectRequested=true for pivot messages and false for plain ones", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;

    // Use the public isRedirectIntent surface via direct call
    const check = (text: string) => (executor as any).isRedirectIntent(text);

    expect(check("ignore the openclaw fixes and focus on new features")).toBe(true);
    expect(check("pivot to the authentication module")).toBe(true);
    expect(check("instead of X, focus on Y")).toBe(true);
    expect(check("build a new dashboard")).toBe(false);
    expect(check("what did you find?")).toBe(false);
    expect(check("also check the API layer")).toBe(false);
  });

  it("compactHistoryForRedirect leaves history ready for the redirect message to be appended", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = { title: "Prior Task" };
    // Simulate a long prior session history
    executor.conversationHistory = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: [{ type: "text", text: `message ${i}` }],
    }));

    (executor as any).compactHistoryForRedirect();

    // History is compacted to just 2 stub entries — not 20
    expect(executor.conversationHistory).toHaveLength(2);
    // Last entry is assistant, ready for the user redirect message to follow
    expect(executor.conversationHistory[1].role).toBe("assistant");
  });
});

describe("TaskExecutor — redirect history reset vs steering", () => {
  const isHistoryReset = (text: string): boolean =>
    (Object.create(TaskExecutor.prototype) as Any).isHistoryResetRedirect(text);

  it.each([
    "Instead of a modal, build a dropdown",
    "Don't change the API; focus on the caching layer you just added",
    "Leave the backend as is and focus on the frontend validation",
    "Rather than a new file, do it inside utils.ts",
    "Focus only on the files you changed",
  ])("keeps the conversation for a refinement of the current work: %s", (message) => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    expect(executor.isRedirectIntent(message)).toBe(true);
    expect(isHistoryReset(message)).toBe(false);
  });

  it("resets the conversation only for an explicit pivot that does not refer back", () => {
    expect(isHistoryReset("Forget that. New task: write a poem about the sea")).toBe(true);
    expect(isHistoryReset("Start over and build it in Rust")).toBe(false);
  });

  it("keeps the prior result summary and changed files in the redirect stub", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = { id: "task-1", title: "Add settings modal" };
    executor.workspace = { path: "/workspace/project" };
    executor.conversationHistory = [
      { role: "user", content: [{ type: "text", text: "Add a settings modal" }] },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Added SettingsModal with a save button and wired it into the Header.",
          },
        ],
      },
    ];
    executor.fileOperationTracker = {
      getCreatedFiles: () => ["/workspace/project/src/SettingsModal.tsx"],
    };
    executor.daemon = {
      getTaskEvents: vi.fn(() => [
        { type: "file_modified", payload: { path: "/workspace/project/src/Header.tsx" } },
        { type: "file_created", payload: { path: "src/SettingsModal.tsx" } },
      ]),
    };

    executor.compactHistoryForRedirect();

    expect(executor.conversationHistory).toHaveLength(2);
    const stub = executor.conversationHistory[0].content[0].text as string;
    expect(stub).toContain("Add settings modal");
    expect(stub).toContain("Added SettingsModal with a save button");
    expect(stub).toContain("src/Header.tsx");
    expect(stub).toContain("src/SettingsModal.tsx");
    expect(stub.match(/src\/SettingsModal\.tsx/g)).toHaveLength(1);
  });

  it("keeps a redirect message that is already in the recovered transcript", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = { title: "Old Task" };
    const redirectTurn = {
      role: "user",
      content: [{ type: "text", text: "Forget that. New task: write a poem about the sea" }],
    };
    executor.conversationHistory = [
      { role: "user", content: [{ type: "text", text: "fix the bugs" }] },
      { role: "assistant", content: [{ type: "text", text: "Fixed 3 bugs." }] },
      redirectTurn,
    ];

    executor.compactHistoryForRedirect({ keepLatestUserTurn: true });

    expect(executor.conversationHistory.map((message: Any) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(executor.conversationHistory[2]).toBe(redirectTurn);
  });

  it("uses steering guidance instead of fresh-work guidance for refinements", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.redirectRequested = true;
    executor.redirectResetsHistory = false;

    const guidance = executor.buildFollowUpTurnGuidancePrompt(
      "Instead of a modal, build a dropdown",
    ) as string;

    expect(guidance).toContain("FOLLOW-UP TURN (CRITICAL):");
    expect(guidance).toContain("steering");
    expect(guidance).not.toContain("fresh work");
  });

  it("keeps fresh-work guidance for an explicit pivot", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.redirectRequested = true;
    executor.redirectResetsHistory = true;

    const guidance = executor.buildFollowUpTurnGuidancePrompt(
      "Forget that. New task: write a poem about the sea",
    ) as string;

    expect(guidance).toContain("TASK RE-SCOPE (CRITICAL):");
    expect(guidance).toContain("fresh work");
  });
});

describe("TaskExecutor — redirect follow-up wiring after a completed task", () => {
  const runCompletedTaskFollowUp = async (message: string) => {
    const redirectTurn = { role: "user", content: [{ type: "text", text: message }] };
    const task = {
      id: "redirect-wiring",
      status: "completed",
      title: "Add settings modal",
      prompt: "Add a settings modal",
      agentConfig: { executionMode: "execute", retainMemory: false },
    };
    let loopMessages: Any[] = [];
    let turnGuidance = "";
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = task;
    executor.workspace = {
      id: "workspace-1",
      path: "/tmp/workspace",
      permissions: { read: false, write: false, delete: false, network: false, shell: false },
    };
    executor.provider = { type: "openai" };
    executor.conversationHistory = [
      { role: "user", content: [{ type: "text", text: "Add a settings modal" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "Added SettingsModal.tsx and wired it into Header.tsx." }],
      },
      redirectTurn,
    ];
    executor.lastNonVerificationOutput = "Added SettingsModal.tsx and wired it into Header.tsx.";
    executor.daemon = {
      getTask: vi.fn(() => task),
      getTaskEvents: vi.fn(() => []),
      updateTaskStatus: vi.fn(),
    };
    executor.getSessionRuntime = () => ({
      setRecoveryRequestActive: vi.fn(),
      runFollowUpLoop: vi.fn(async ({ messages }: Any) => {
        loopMessages = messages.slice();
        messages.push({ role: "assistant", content: [{ type: "text", text: "Done." }] });
        return { messages, iterations: 1, emptyResponseCount: 0 };
      }),
    });
    executor.refreshProviderIfSettingsChanged = vi.fn();
    executor.ensureProviderFailoverSelectionsContext = vi.fn();
    executor.getPendingSkillParameterCollection = () => null;
    executor.handleGoalSlashFollowUp = () => ({ handled: false });
    executor.isRecoveryIntent = () => false;
    executor.isCapabilityUpgradeIntent = () => false;
    executor.isDebugMode = () => false;
    executor.preflightShellExecutionCheck = () => false;
    executor.isExplicitChatExecutionMode = () => false;
    executor.isKnownContextInformationalFollowUp = () => false;
    executor.getEffectiveExecutionMode = () => "execute";
    executor.getEffectiveTaskDomain = () => "code";
    executor.getEffectiveTaskPathRootPolicy = () => "none";
    executor.getLoopGuardrailForMode = () => ({});
    executor.followUpRequiresCommandExecution = () => false;
    executor.followUpRequiresCanvasAction = () => false;
    executor.loadExecutionPromptMemoryFeatures = () => ({ contextPackInjectionEnabled: false });
    executor.getRoleContextPrompt = () => "";
    executor.getInfraContextPrompt = () => "";
    executor.buildAdaptiveRecoveryTurnGuidance = async () => "";
    executor.buildIntegrationMentionGuidancePrompt = () => "";
    executor.buildExecutionSystemPrompt = async (params: Any) => {
      turnGuidance = params.turnGuidancePrompt;
      return {
        systemBlocks: [],
        droppedSections: [],
        truncatedSections: [],
        totalTokens: 0,
      };
    };
    executor.setPromptCacheContext = () => "system";
    executor.fileOperationTracker = { getKnowledgeSummary: () => "", getCreatedFiles: () => [] };
    executor.toolRegistry = { setCanvasSessionCutoff: vi.fn() };
    executor.toolCallDeduplicator = { reset: vi.fn() };
    executor.turnSuccessfulToolUsageCounts = new Map();
    executor.emitEvent = vi.fn();
    executor.updateConversationHistory = (messages: Any[]) => {
      executor.conversationHistory = messages;
    };
    executor.saveConversationSnapshot = vi.fn(() => true);
    executor.finalizeSuccessfulFollowUp = vi.fn();

    await (TaskExecutor as Any).prototype.sendMessageUnified.call(
      executor,
      message,
      undefined,
      undefined,
      {
        messageContext: { messageSource: "web", messageId: "redirect-wiring" },
        suppressUserMessageEvent: true,
        transcriptAlreadyContainsMessage: true,
      },
    );
    return { loopMessages, turnGuidance, redirectTurn };
  };

  const textOf = (message: Any): string =>
    (message?.content || []).map((block: Any) => block?.text || "").join("\n");

  it("keeps the full conversation and adds steering guidance for a refinement", async () => {
    const { loopMessages, turnGuidance, redirectTurn } = await runCompletedTaskFollowUp(
      "Instead of a modal, build a dropdown",
    );

    expect(loopMessages.map(textOf)).toEqual([
      "Add a settings modal",
      "Added SettingsModal.tsx and wired it into Header.tsx.",
      "Instead of a modal, build a dropdown",
    ]);
    expect(loopMessages[2]).toBe(redirectTurn);
    expect(turnGuidance).toContain("FOLLOW-UP TURN (CRITICAL):");
    expect(turnGuidance).toContain("steering the current work");
  });

  it("compacts to a summary stub and keeps the pivot message for an explicit pivot", async () => {
    const { loopMessages, turnGuidance, redirectTurn } = await runCompletedTaskFollowUp(
      "Forget that. New task: write a poem about the sea",
    );

    expect(loopMessages).toHaveLength(3);
    expect(textOf(loopMessages[0])).toContain("Prior session");
    expect(textOf(loopMessages[0])).toContain("Added SettingsModal.tsx");
    expect(loopMessages[2]).toBe(redirectTurn);
    expect(turnGuidance).toContain("TASK RE-SCOPE (CRITICAL):");
  });
});
