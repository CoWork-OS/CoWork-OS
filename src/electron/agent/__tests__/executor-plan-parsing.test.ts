import { beforeEach, describe, expect, it, vi } from "vitest";
import { TaskExecutor } from "../executor";

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue("/tmp"),
  },
}));

vi.mock("../custom-skill-loader", () => ({
  getCustomSkillLoader: () => ({
    getEnabledGuidelinesPrompt: () => "",
  }),
}));

vi.mock("../../settings/memory-features-manager", () => ({
  MemoryFeaturesManager: {
    loadSettings: vi.fn().mockReturnValue({ contextPackInjectionEnabled: false }),
  },
}));

vi.mock("../../settings/personality-manager", () => ({
  PersonalityManager: {
    getPersonalityPrompt: vi.fn().mockReturnValue(""),
    getPersonalityPromptById: vi.fn().mockReturnValue(""),
    getIdentityPrompt: vi.fn().mockReturnValue("You are Cowork."),
  },
}));

function createPlanExecutor(response: Any): Any {
  const executor = Object.create(TaskExecutor.prototype) as Any;
  executor.task = {
    id: "task-plan",
    title: "Build project",
    prompt: "Build something to win this competition and show in canvas.",
    createdAt: Date.now() - 1000,
  };
  executor.workspace = {
    id: "ws-1",
    path: "/tmp",
    isTemp: true,
    permissions: { read: true, write: true, delete: true, network: true, shell: true },
  };
  executor.daemon = { logEvent: vi.fn() };
  executor.modelId = "gpt-5.3-codex-spark";
  executor.provider = { type: "openai" };
  executor.cachedLlmSettings = {
    promptCaching: {
      mode: "off",
      ttl: "5m",
      strictStablePrefix: true,
      surfaceCoverage: {
        executor: true,
        followUps: true,
        chatMode: true,
        sideCalls: false,
      },
    },
  };
  executor.initialImages = [];
  executor.emitEvent = vi.fn();
  executor.stableSystemBlocks = [];
  executor.systemPromptBlocks = [];
  executor.currentPromptCacheContext = null;
  executor.promptSectionCache = new Map();

  executor.getRoleContextPrompt = vi.fn().mockReturnValue("");
  executor.getInfraContextPrompt = vi.fn().mockReturnValue("");
  executor.getEffectiveExecutionMode = vi.fn().mockReturnValue("execute");
  executor.getAvailableTools = vi.fn().mockReturnValue([]);
  executor.applyIntentFilter = vi.fn((tools: Any[]) => tools);
  executor.toolRegistry = {
    getToolDescriptions: vi.fn().mockReturnValue(""),
  };
  executor.budgetPromptSection = vi.fn((content: string) => ({
    content,
    budget: 100,
    label: "test",
    hard: false,
    priority: 1,
  }));
  executor.composePromptWithBudget = vi.fn().mockReturnValue("test-system-prompt");

  executor.checkBudgets = vi.fn();
  executor.updateTracking = vi.fn();
  executor.buildUserContent = vi.fn().mockResolvedValue("test-user-content");
  executor.resolveLLMMaxTokens = vi.fn().mockReturnValue(8192);
  executor.callLLMWithRetry = vi.fn().mockResolvedValue(response);
  executor.requiresVisualQARun = false;
  executor.refreshProviderIfSettingsChanged = vi.fn();
  executor.llmProfileUsed = "cheap";

  return executor;
}

describe("TaskExecutor plan parsing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes execution plan creation through the strong model profile when using profile routing", async () => {
    const response = {
      usage: { inputTokens: 1, outputTokens: 2 },
      content: [
        { type: "text", text: '{"description":"P","steps":[{"id":"1","description":"Do the thing"}]}' },
      ],
    };
    const executor = createPlanExecutor(response);
    await executor.createPlan();
    expect(executor.refreshProviderIfSettingsChanged).toHaveBeenCalledWith("strong");
  });

  it("does not force strong profile for execution plan when a task model override is set", async () => {
    const response = {
      usage: { inputTokens: 1, outputTokens: 2 },
      content: [{ type: "text", text: '{"description":"P","steps":[{"id":"1","description":"Do"}]}' }],
    };
    const executor = createPlanExecutor(response);
    executor.task.agentConfig = { modelKey: "gpt-5.4-mini" };
    await executor.createPlan();
    expect(executor.refreshProviderIfSettingsChanged).not.toHaveBeenCalled();
  });

  it("routes plan creation through the prompt-cache request path for Azure profile routing", async () => {
    const response = {
      usage: { inputTokens: 1, outputTokens: 2, cachedTokens: 0 },
      content: [{ type: "text", text: '{"description":"P","steps":[{"id":"1","description":"Do"}]}' }],
    };
    const executor = createPlanExecutor(response);
    executor.modelId = "gpt-5.4";
    executor.provider = { type: "azure" };
    executor.task.agentConfig = { taskIntent: "execution" };
    executor.cachedLlmSettings = {
      promptCaching: {
        mode: "auto",
        ttl: "5m",
        strictStablePrefix: true,
        surfaceCoverage: {
          executor: true,
          followUps: true,
          chatMode: true,
          sideCalls: false,
        },
      },
    };
    executor.getAvailableTools = vi.fn().mockReturnValue([
      {
        name: "write_file",
        description: "Write a file",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
          required: ["path", "content"],
        },
      },
    ]);
    executor.createMessageWithTimeout = vi.fn().mockResolvedValue(response);
    executor.callLLMWithRetry = vi.fn(async (requestFn: Any) => requestFn(0));

    await executor.createPlan();

    expect(executor.createMessageWithTimeout).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5.4",
        toolChoice: "none",
        tools: expect.arrayContaining([
          expect.objectContaining({
            name: "write_file",
          }),
        ]),
        systemBlocks: expect.any(Array),
        promptCache: expect.objectContaining({
          mode: "openai_key",
          cacheKey: expect.any(String),
        }),
      }),
      expect.any(Number),
      "Plan creation",
    );
  });

  it("parses step-header plans spread across multiple text blocks", async () => {
    const response = {
      usage: { inputTokens: 10, outputTokens: 20 },
      content: [
        { type: "text", text: "Step 1" },
        { type: "text", text: "Research the competition constraints and judging criteria." },
        { type: "text", text: "Step 2" },
        { type: "text", text: "Build and save a prototype in index.html." },
        { type: "text", text: "Step 3\nVerify: run through one complete flow and report findings." },
      ],
    };
    const executor = createPlanExecutor(response);

    await executor.createPlan();

    expect(executor.plan?.steps?.length).toBe(3);
    expect(executor.plan.steps[0].description).toContain("Research the competition constraints");
    expect(executor.plan.steps[1].description).toContain("Build and save a prototype");
    expect(executor.plan.steps[2].kind).toBe("verification");
  });

  it("parses JSON plans split across multiple text blocks", async () => {
    const response = {
      usage: { inputTokens: 10, outputTokens: 20 },
      content: [
        { type: "text", text: '{"description":"Execution plan","steps":[' },
        { type: "text", text: '{"id":"1","description":"Create app shell in canvas."},' },
        { type: "text", text: '{"id":"2","description":"Verify: test interaction flow end-to-end."}]}' },
      ],
    };
    const executor = createPlanExecutor(response);

    await executor.createPlan();

    expect(executor.plan?.steps?.length).toBe(2);
    expect(executor.plan.steps[0].description).toContain("Create app shell in canvas");
    expect(executor.plan.steps[1].kind).toBe("verification");
  });

  it("skips leading empty objects and malformed transcript noise before the real plan JSON", async () => {
    const response = {
      usage: { inputTokens: 10, outputTokens: 20 },
      content: [
        {
          type: "text",
          text:
            '{}【analysis to=skill_list code:\n{"description":"Compare the most recent OpenClaw changes against CoWork OS and identify a short list of feasible updates to adopt.","steps":[{"id":"1","description":"Inspect available project assistance capabilities.","status":"pending"}]}',
        },
      ],
    };
    const executor = createPlanExecutor(response);

    await executor.createPlan();

    expect(executor.plan?.description).toBe("Compare the most recent OpenClaw changes against CoWork OS and identify a short list of feasible updates to adopt.");
    expect(executor.plan?.steps?.[0]?.description).toBe("Inspect available project assistance capabilities.");
  });

  it("anchors subsequent relative file paths to detected scaffold root", async () => {
    const response = {
      usage: { inputTokens: 10, outputTokens: 20 },
      content: [
        {
          type: "text",
          text: JSON.stringify({
            description: "Execution plan",
            steps: [
              {
                id: "1",
                description:
                  "Create project scaffold under `./win95-ui/` with files: `index.html`, `styles/win95.css`, `scripts/main.js`.",
              },
              {
                id: "2",
                description:
                  "Implement core window manager in `scripts/window-manager.js` and wire launcher in `scripts/main.js`.",
              },
              {
                id: "3",
                description: "Add shell polish in `styles/win95.css`.",
              },
            ],
          }),
        },
      ],
    };
    const executor = createPlanExecutor(response);

    await executor.createPlan();

    expect(executor.plan?.steps?.[1]?.description).toContain("`win95-ui/scripts/window-manager.js`");
    expect(executor.plan?.steps?.[1]?.description).toContain("`win95-ui/scripts/main.js`");
    expect(executor.plan?.steps?.[2]?.description).toContain("`win95-ui/styles/win95.css`");
  });

  it("sanitizes raw tool-call markup from plan descriptions and steps", async () => {
    const response = {
      usage: { inputTokens: 10, outputTokens: 20 },
      content: [
        {
          type: "text",
          text: JSON.stringify({
            description: 'Execution plan [TOOL_CALL]{tool => "glob", args => {"pattern":"**/*community*pack*"}}[/TOOL_CALL]',
            steps: [
              {
                id: "1",
                description:
                  'I will analyze the workspace brief. [TOOL_CALL]{tool => "read_file", args => {"path":".cowork/workspace-example-community-packs.md"}}[/TOOL_CALL]',
              },
              {
                id: "2",
                description:
                  '[TOOL_CALL]{tool => "glob", args => {"pattern":"**/*community*pack*"}}[/TOOL_CALL]',
              },
            ],
          }),
        },
      ],
    };
    const executor = createPlanExecutor(response);

    await executor.createPlan();

    expect(executor.plan?.description).toBe("Execution plan");
    expect(executor.plan?.steps?.[0]?.description).toBe("I will analyze the workspace brief.");
    expect(executor.plan?.steps?.[1]?.description).toBe("Step 2");
  });

  it("appends a Playwright QA verification step for web-app shipping prompts", async () => {
    const response = {
      usage: { inputTokens: 10, outputTokens: 20 },
      content: [
        {
          type: "text",
          text: JSON.stringify({
            description: "Execution plan",
            steps: [
              { id: "1", description: "Inspect the workspace and determine whether to scaffold or reuse files." },
              { id: "2", description: "Implement the React todo app." },
              { id: "3", description: "Run tests and build the app." },
            ],
          }),
        },
      ],
    };
    const executor = createPlanExecutor(response);
    executor.task.title = "Build a simple todo app in React";
    executor.task.prompt = "Build a simple todo app in React, test it to catch any bugs before shipping.";
    executor.requiresVisualQARun = true;

    await executor.createPlan();

    expect(executor.plan?.steps?.some((step: Any) => /visual qa with playwright/i.test(step.description))).toBe(true);
    const qaStep = executor.plan.steps.find((step: Any) => /visual qa with playwright/i.test(step.description));
    expect(qaStep?.kind).toBe("verification");
  });

  it("does not append a Playwright QA step when the plan does not actually build a web app", async () => {
    const response = {
      usage: { inputTokens: 10, outputTokens: 20 },
      content: [
        {
          type: "text",
          text: JSON.stringify({
            description: "Execution plan",
            steps: [
              { id: "1", description: "Research examples of successful citizen portals and dashboards." },
              { id: "2", description: "Write the implementation brief in README.md." },
            ],
          }),
        },
      ],
    };
    const executor = createPlanExecutor(response);
    executor.task.title = "Design a portal concept";
    executor.task.prompt = "Design a portal concept and make sure it is ready to ship.";
    executor.requiresVisualQARun = true;

    await executor.createPlan();

    expect(executor.plan?.steps?.some((step: Any) => /visual qa with playwright/i.test(step.description))).toBe(
      false,
    );
  });
});
