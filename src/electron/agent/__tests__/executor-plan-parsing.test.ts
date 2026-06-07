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

  it("does not emit llm_error when plan creation is aborted by user cancellation", async () => {
    const executor = createPlanExecutor({
      usage: { inputTokens: 1, outputTokens: 2 },
      content: [],
    });
    executor.cancelled = true;
    executor.cancelReason = "user";
    executor.callLLMWithRetry = vi.fn().mockRejectedValue(new Error("Request cancelled"));

    await expect(executor.createPlan()).rejects.toThrow("Request cancelled");

    expect(executor.emitEvent).not.toHaveBeenCalledWith("llm_error", expect.anything());
  });

  it("uses a direct one-step plan for simple image generation prompts", async () => {
    const response = {
      usage: { inputTokens: 1, outputTokens: 2 },
      content: [
        { type: "text", text: '{"description":"P","steps":[{"id":"1","description":"Do the thing"}]}' },
      ],
    };
    const executor = createPlanExecutor(response);
    executor.task.title = "Create image";
    executor.task.prompt = "create an image of a snow leopard";
    executor.task.rawPrompt = "create an image of a snow leopard";

    await executor.createPlan();

    expect(executor.callLLMWithRetry).not.toHaveBeenCalled();
    expect(executor.plan.steps).toHaveLength(1);
    expect(executor.plan.steps[0].description).toBe(
      "Generate the requested image and share the resulting file.",
    );
  });

  it("uses a direct one-step plan for infographic image generation prompts", async () => {
    const executor = createPlanExecutor({
      usage: { inputTokens: 1, outputTokens: 2 },
      content: [
        { type: "text", text: '{"description":"P","steps":[{"id":"1","description":"Do the thing"}]}' },
      ],
    });
    executor.task.title = "Create infographic";
    executor.task.prompt = "create an infographic image explaining snow leopards";
    executor.task.rawPrompt = "create an infographic image explaining snow leopards";

    await executor.createPlan();

    expect(executor.callLLMWithRetry).not.toHaveBeenCalled();
    expect(executor.plan.steps).toHaveLength(1);
  });

  it("uses a direct one-step plan for simple Markdown file creation prompts", async () => {
    const executor = createPlanExecutor({
      usage: { inputTokens: 1, outputTokens: 2 },
      content: [
        { type: "text", text: '{"description":"P","steps":[{"id":"1","description":"Do the thing"}]}' },
      ],
    });
    executor.task.title = "Create sample files";
    executor.task.prompt = "create 2 sample md files";
    executor.task.rawPrompt = "create 2 sample md files";

    await executor.createPlan();

    expect(executor.callLLMWithRetry).not.toHaveBeenCalled();
    expect(executor.plan.steps).toHaveLength(1);
    expect(executor.plan.steps[0].description).toContain("sample-1.md");
    expect(executor.plan.steps[0].description).toContain("sample-2.md");

    const contract = executor.resolveStepExecutionContract(executor.plan.steps[0]);
    expect(Array.from(contract.requiredTools)).toContain("write_file");
  });

  it("keeps non-trivial file requests on the normal planning path", async () => {
    const response = {
      usage: { inputTokens: 1, outputTokens: 2 },
      content: [
        { type: "text", text: '{"description":"P","steps":[{"id":"1","description":"Do the thing"}]}' },
      ],
    };
    const executor = createPlanExecutor(response);
    executor.task.title = "Build app";
    executor.task.prompt = "create a web app and write README.md documentation";
    executor.task.rawPrompt = "create a web app and write README.md documentation";

    await executor.createPlan();

    expect(executor.callLLMWithRetry).toHaveBeenCalled();
    expect(executor.plan.steps[0].description).toBe("Do the thing");
  });

  it("adds a final XLSX workbook step when a spreadsheet plan only contains research steps", async () => {
    const response = {
      usage: { inputTokens: 1, outputTokens: 2 },
      content: [
        {
          type: "text",
          text: JSON.stringify({
            description: "Research OpenAI text models",
            steps: [
              { id: "1", description: "Define the model scope" },
              { id: "2", description: "Exclude image-only and deprecated models" },
            ],
          }),
        },
      ],
    };
    const executor = createPlanExecutor(response);
    const prompt = "create a spreadsheet of all OpenAI text models and exclude non-text models";
    executor.task.title = "OpenAI text model spreadsheet";
    executor.task.prompt = prompt;
    executor.task.rawPrompt = prompt;

    await executor.createPlan();

    expect(executor.plan.steps).toHaveLength(3);
    expect(executor.plan.steps[2].description).toContain(".xlsx");
    expect(executor.plan.steps[2].description).toContain("Excel workbook");
  });

  it("offers only generate_image tools for simple image generation prompts", () => {
    const executor = createPlanExecutor({
      usage: { inputTokens: 1, outputTokens: 2 },
      content: [],
    });
    executor.task.title = "Create infographic";
    executor.task.prompt = "create an infographic image explaining snow leopards";
    executor.task.rawPrompt = "create an infographic image explaining snow leopards";

    const scoped = executor.applyStepScopedToolPolicy([
      { name: "generate_image" },
      { name: "write_file" },
      { name: "web_search" },
      { name: "task_list_create" },
    ]);

    expect(scoped.map((tool: Any) => tool.name)).toEqual(["generate_image"]);
  });

  it("requires generate_image instead of write_file for terminal image generation contracts", () => {
    const executor = createPlanExecutor({
      usage: { inputTokens: 1, outputTokens: 2 },
      content: [],
    });
    executor.task.title = "Create image";
    executor.task.prompt = "create a similar image as a snow leopard";
    executor.task.rawPrompt = "create a similar image as a snow leopard";
    executor.plan = {
      description: "Create image",
      steps: [
        {
          id: "1",
          description: "Generate the requested image and share the resulting file.",
          status: "pending",
        },
      ],
    };

    const contract = executor.resolveStepExecutionContract(executor.plan.steps[0]);

    expect(Array.from(contract.requiredTools)).toContain("generate_image");
    expect(Array.from(contract.requiredTools)).not.toContain("write_file");
  });

  it("keeps dashboard UI polish prompts on code tools unless live verification is requested", () => {
    const executor = createPlanExecutor({
      usage: { inputTokens: 1, outputTokens: 2 },
      content: [],
    });
    const prompt =
      "Improve the dashboard UI. Keep the existing design system and make the buttons more consistent.";
    executor.task.title = "Improve dashboard UI";
    executor.task.prompt = prompt;
    executor.task.rawPrompt = prompt;
    executor.currentStepId = "1";
    executor.plan = {
      description: "Plan",
      steps: [
        {
          id: "1",
          description: "Update dashboard button variants and call sites.",
          status: "pending",
        },
      ],
    };
    executor.resolveStepExecutionContract = vi.fn().mockReturnValue({
      requiresMutation: true,
      requiredTools: new Set<string>(),
      requiredExtensions: [],
      requiresArtifactEvidence: false,
    });
    executor.isVerificationStepForCompletion = vi.fn().mockReturnValue(false);
    executor.getEffectiveTaskDomain = vi.fn().mockReturnValue("code");

    const scoped = executor
      .applyStepScopedToolPolicy([
        { name: "read_file" },
        { name: "edit_file" },
        { name: "write_file" },
        { name: "browser_navigate" },
        { name: "browser_screenshot" },
        { name: "open_application" },
        { name: "screenshot" },
        { name: "open_url" },
        { name: "run_command" },
      ])
      .map((tool: Any) => tool.name);

    expect(scoped).toEqual(["read_file", "edit_file", "write_file", "run_command"]);
  });

  it("allows browser tools for UI prompts that explicitly request browser verification", () => {
    const executor = createPlanExecutor({
      usage: { inputTokens: 1, outputTokens: 2 },
      content: [],
    });
    const prompt =
      "Improve the dashboard UI and verify in browser that the buttons look consistent.";
    executor.task.title = "Improve dashboard UI";
    executor.task.prompt = prompt;
    executor.task.rawPrompt = prompt;
    executor.currentStepId = "1";
    executor.plan = {
      description: "Plan",
      steps: [
        {
          id: "1",
          description: "Update dashboard button variants and verify in browser.",
          status: "pending",
        },
      ],
    };
    executor.resolveStepExecutionContract = vi.fn().mockReturnValue({
      requiresMutation: true,
      requiredTools: new Set<string>(),
      requiredExtensions: [],
      requiresArtifactEvidence: false,
    });
    executor.isVerificationStepForCompletion = vi.fn().mockReturnValue(false);
    executor.getEffectiveTaskDomain = vi.fn().mockReturnValue("code");

    const scoped = executor
      .applyStepScopedToolPolicy([{ name: "read_file" }, { name: "browser_navigate" }])
      .map((tool: Any) => tool.name);

    expect(scoped).toContain("browser_navigate");
  });

  it("blocks native and browser tools before use for code-first UI prompts", () => {
    const executor = createPlanExecutor({
      usage: { inputTokens: 1, outputTokens: 2 },
      content: [],
    });
    const prompt =
      "Improve the dashboard UI. Keep the existing design system and make the buttons more consistent.";
    executor.task.title = "Improve dashboard UI";
    executor.task.prompt = prompt;
    executor.task.rawPrompt = prompt;
    executor.currentStepId = "1";
    executor.plan = {
      description: "Plan",
      steps: [
        {
          id: "1",
          description: "Update dashboard button variants and call sites.",
          status: "pending",
        },
      ],
    };

    const result = executor.applyPreToolUsePolicyHook({
      toolName: "browser_navigate",
      input: { url: "http://localhost:5173" },
      stepMode: undefined,
    });

    expect(result.blockedResult?.error).toContain("Code-first UI task mode is active");
  });

  it("allows browser tools for web page design and troubleshooting prompts", () => {
    const executor = createPlanExecutor({
      usage: { inputTokens: 1, outputTokens: 2 },
      content: [],
    });
    const prompt =
      "Edit the React landing page, start the app, open it in the browser, and troubleshoot the hero layout.";
    executor.task.title = "Improve React landing page";
    executor.task.prompt = prompt;
    executor.task.rawPrompt = prompt;
    executor.currentStepId = "1";
    executor.plan = {
      description: "Plan",
      steps: [
        {
          id: "1",
          description: "Edit the React landing page and verify it in the browser.",
          status: "pending",
        },
      ],
    };

    const result = executor.applyPreToolUsePolicyHook({
      toolName: "browser_navigate",
      input: { url: "http://localhost:5173" },
      stepMode: undefined,
    });

    expect(result.blockedResult).toBeUndefined();
  });

  it("adds web page preview guidance for frontend page work", () => {
    const executor = createPlanExecutor({
      usage: { inputTokens: 1, outputTokens: 2 },
      content: [],
    });

    const guidance = executor.buildWebPagePreviewGuidancePrompt(
      "Design a React web page and troubleshoot it in the browser.",
    );

    expect(guidance).toContain("WEB PAGE PREVIEW GUIDANCE");
    expect(guidance).toContain("visible in-app browser");
    expect(guidance).toContain("browser_screenshot");
  });

  it("uses the simple image path for app avatar image prompts", async () => {
    const executor = createPlanExecutor({
      usage: { inputTokens: 1, outputTokens: 2 },
      content: [
        { type: "text", text: '{"description":"P","steps":[{"id":"1","description":"Do the thing"}]}' },
      ],
    });
    const prompt = "generate an image of a cool avatar of a snow leopard for cowork os app";
    executor.task.title = "Create avatar";
    executor.task.prompt = prompt;
    executor.task.rawPrompt = prompt;

    await executor.createPlan();

    expect(executor.callLLMWithRetry).not.toHaveBeenCalled();
    expect(executor.plan.steps).toHaveLength(1);
    expect(
      executor
        .applyStepScopedToolPolicy([
          { name: "generate_image" },
          { name: "write_file" },
          { name: "task_list_create" },
        ])
        .map((tool: Any) => tool.name),
    ).toEqual(["generate_image"]);
  });

  it("keeps the simple image path when task prompt includes strategy context", async () => {
    const executor = createPlanExecutor({
      usage: { inputTokens: 1, outputTokens: 2 },
      content: [
        { type: "text", text: '{"description":"P","steps":[{"id":"1","description":"Do the thing"}]}' },
      ],
    });
    const rawPrompt = 'generate an image of a cool avatar of a snow leopard for "cowork os" app';
    executor.task.title = "Create snow leopard avatar";
    executor.task.rawPrompt = undefined;
    executor.task.userPrompt = undefined;
    executor.task.prompt = `${rawPrompt}

[AGENT_STRATEGY_CONTEXT_V1]
image_generation_contract:
- For a simple text-to-image request, call generate_image once, share the generated output, and finish.
- Do not search files, use scratchpad, ask for art direction, or run analyze_image unless the user explicitly asks for those extra steps.
[/AGENT_STRATEGY_CONTEXT_V1]`;

    await executor.createPlan();

    expect(executor.callLLMWithRetry).not.toHaveBeenCalled();
    expect(executor.plan.steps).toHaveLength(1);
    expect(
      executor
        .applyStepScopedToolPolicy([
          { name: "generate_image" },
          { name: "analyze_image" },
          { name: "write_file" },
          { name: "web_search" },
        ])
        .map((tool: Any) => tool.name),
    ).toEqual(["generate_image"]);
  });

  it("does not use the direct image path for grounded infographic prompts", async () => {
    const executor = createPlanExecutor({
      usage: { inputTokens: 1, outputTokens: 2 },
      content: [
        {
          type: "text",
          text: '{"description":"P","steps":[{"id":"1","description":"Research CoWork OS context"},{"id":"2","description":"Generate the infographic image"}]}',
        },
      ],
    });
    const prompt = "create an infographic about cowork os";
    executor.task.title = "Create CoWork OS infographic";
    executor.task.prompt = prompt;
    executor.task.rawPrompt = prompt;

    await executor.createPlan();

    expect(executor.callLLMWithRetry).toHaveBeenCalled();
    expect(executor.plan.steps).toHaveLength(2);
    expect(
      executor
        .applyStepScopedToolPolicy([
          { name: "generate_image" },
          { name: "web_search" },
          { name: "read_file" },
          { name: "task_list_create" },
          { name: "analyze_image" },
        ])
        .map((tool: Any) => tool.name),
    ).toEqual(["generate_image", "web_search", "read_file"]);
  });

  it("rewrites broad personal-folder file discovery back to the selected workspace", async () => {
    const executor = createPlanExecutor({
      usage: { inputTokens: 1, outputTokens: 2 },
      content: [
        {
          type: "text",
          text: JSON.stringify({
            description: "Combine videos",
            steps: [
              { id: "1", description: "Locate the two source videos" },
              {
                id: "2",
                description:
                  "Search the current workspace and likely media folders such as Desktop, Downloads, and Movies for video files.",
              },
              { id: "3", description: "Create the combined video file" },
            ],
          }),
        },
      ],
    });
    const prompt =
      'can you combine two videos and save it as a new video named "Cowork OS Gmail"';
    executor.task.title = prompt;
    executor.task.prompt = prompt;
    executor.task.rawPrompt = prompt;

    await executor.createPlan();

    expect(executor.plan.steps[1].description).toBe(
      "Search the selected workspace for the required source files; ask for a path if they are not present there.",
    );
  });

  it("keeps explicit user-requested personal-folder discovery locations", async () => {
    const executor = createPlanExecutor({
      usage: { inputTokens: 1, outputTokens: 2 },
      content: [
        {
          type: "text",
          text: JSON.stringify({
            description: "Find videos",
            steps: [
              {
                id: "1",
                description: "Search Downloads and Movies for the source video files.",
              },
            ],
          }),
        },
      ],
    });
    const prompt = "Find the videos in Downloads and Movies, then combine them.";
    executor.task.title = prompt;
    executor.task.prompt = prompt;
    executor.task.rawPrompt = prompt;

    await executor.createPlan();

    expect(executor.plan.steps[0].description).toBe(
      "Search Downloads and Movies for the source video files.",
    );
  });

  it("drops non-action supported-format plan steps and requires an mp4 output for video saves", async () => {
    const executor = createPlanExecutor({
      usage: { inputTokens: 1, outputTokens: 2 },
      content: [
        {
          type: "text",
          text: JSON.stringify({
            description: "Combine videos",
            steps: [
              { id: "1", description: "Find the two source videos" },
              {
                id: "2",
                description: "Supported likely formats: `.mp4`, `.mov`, `.m4v`, `.webm`, `.avi`.",
              },
              { id: "3", description: "Inspect video durations" },
            ],
          }),
        },
      ],
    });
    const prompt =
      'can you combine two videos and save it as a new video named "Cowork OS Gmail"\n\n' +
      "the longer video should be the first and the other should come after it";
    executor.task.title = prompt;
    executor.task.prompt = prompt;
    executor.task.rawPrompt = prompt;

    await executor.createPlan();

    expect(executor.plan.steps.map((step: Any) => step.description)).not.toContain(
      "Supported likely formats: `.mp4`, `.mov`, `.m4v`, `.webm`, `.avi`.",
    );
    expect(executor.plan.steps.at(-1).description).toBe(
      "Create the final combined video file `Cowork OS Gmail.mp4` with the longer source video first.",
    );
  });

  it("does not classify gather-and-verify work steps as verification checkpoints", () => {
    const executor = createPlanExecutor({
      usage: { inputTokens: 1, outputTokens: 2 },
      content: [],
    });

    expect(executor.descriptionIndicatesVerification("Gather and verify core facts")).toBe(false);
    expect(executor.descriptionIndicatesVerification("Verify: generated image file exists")).toBe(
      true,
    );
  });

  it("uses compact step-count guidance for plan and advice tasks", () => {
    const executor = createPlanExecutor({
      usage: { inputTokens: 1, outputTokens: 2 },
      content: [],
    });
    executor.task.agentConfig = { executionMode: "plan", taskIntent: "advice" };
    executor.getEffectiveExecutionMode = vi.fn().mockReturnValue("plan");
    executor.getExecutionTaskPrompt = vi.fn().mockReturnValue("What are the tradeoffs?");

    expect(executor.getPlanningStepCountRule()).toContain("1-3 high-level steps");
  });

  it("keeps broader step-count guidance for deep workflows", () => {
    const executor = createPlanExecutor({
      usage: { inputTokens: 1, outputTokens: 2 },
      content: [],
    });
    executor.task.agentConfig = { deepWorkMode: true, taskIntent: "deep_work" };
    executor.getExecutionTaskPrompt = vi.fn().mockReturnValue("Run the full migration workflow.");

    expect(executor.getPlanningStepCountRule()).toContain("4-7 specific steps");
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

  it("uses numbered task prompt steps when a local model returns freeform planning prose", async () => {
    const response = {
      usage: { inputTokens: 10, outputTokens: 20 },
      content: [
        {
          type: "text",
          text: [
            "I'll research both repos, gather star history and growth events, and build the comparison dashboard for you.",
            "Let's get started.",
            "First, I'll locate the repositories and gather their core stats and growth history.",
            "searching for repositories...",
          ].join("\n"),
        },
      ],
    };
    const executor = createPlanExecutor(response);
    const prompt = [
      "Research and compare two GitHub repositories: Hermes Agent and OpenClaw.",
      "Step 1: Find their GitHub pages and collect current stats.",
      "Step 2: Get the full star history for both projects.",
      "Step 3: Search the web for key events that caused growth spikes.",
      "Step 4: Build a beautiful HTML dashboard and save it.",
    ].join("\n");
    executor.provider = { type: "ollama" };
    executor.modelId = "qwen3.6:35b";
    executor.task.prompt = prompt;
    executor.getExecutionTaskPrompt = vi.fn().mockReturnValue(prompt);
    executor.getContractPrompt = vi.fn().mockReturnValue(prompt);

    await executor.createPlan();

    const descriptions = executor.plan?.steps?.map((step: Any) => step.description) || [];
    expect(descriptions).toEqual(
      expect.arrayContaining([
        "Find their GitHub pages and collect current stats.",
        "Get the full star history for both projects.",
        "Search the web for key events that caused growth spikes.",
        "Build a beautiful HTML dashboard and save it.",
      ]),
    );
    expect(descriptions.join("\n")).not.toMatch(/searching for repositories|let'?s get started/i);
    expect(executor.emitEvent).toHaveBeenCalledWith(
      "log",
      expect.objectContaining({ metric: "plan_text_fallback_used_task_steps" }),
    );
  });

  it("limits local-model tool batches and defers same-turn writes after reads", () => {
    const executor = createPlanExecutor({ content: [] });
    executor.provider = { type: "ollama" };
    const calls = [
      { index: 0, toolUse: { id: "t1", name: "web_search", input: { query: "a" } } },
      {
        index: 1,
        toolUse: { id: "t2", name: "http_request", input: { url: "https://example.com/a" } },
      },
      { index: 2, toolUse: { id: "t3", name: "web_search", input: { query: "b" } } },
      {
        index: 3,
        toolUse: { id: "t4", name: "web_fetch", input: { url: "https://example.com/b" } },
      },
      { index: 4, toolUse: { id: "t5", name: "web_search", input: { query: "c" } } },
      { index: 5, toolUse: { id: "t6", name: "edit_file", input: { file_path: "out.html" } } },
    ];

    const limited = executor.limitLocalModelToolBatch(calls, "step", "s1");

    expect(limited.executableCalls.map((call: Any) => call.toolUse.id)).toEqual([
      "t1",
      "t2",
      "t3",
      "t4",
    ]);
    expect(limited.deferredToolResults).toHaveLength(2);
    expect(limited.deferredToolResults.every((result: Any) => result.is_error === false)).toBe(true);
    expect(JSON.parse(limited.deferredToolResults[0].content).reason).toBe("batch_limit");
    expect(JSON.parse(limited.deferredToolResults[1].content).reason).toBe(
      "mixed_read_write_batch",
    );
    expect(executor.emitEvent).toHaveBeenCalledWith(
      "log",
      expect.objectContaining({
        metric: "local_model_tool_batch_deferred",
        requested: 6,
        executed: 4,
        deferred: 2,
      }),
    );
  });

  it("clamps local-model web searches to five results", () => {
    const executor = createPlanExecutor({ content: [] });
    executor.provider = { type: "ollama" };
    const input = { query: "Hermes Agent", maxResults: 10 };

    executor.applyLocalModelNetworkInputLimits("web_search", input);

    expect(input.maxResults).toBe(5);
    expect(executor.emitEvent).toHaveBeenCalledWith(
      "log",
      expect.objectContaining({
        metric: "local_model_web_search_max_results_clamped",
        maxResults: 5,
      }),
    );
  });

  it("summarizes GitHub http_request repo payloads without keeping full JSON bodies", () => {
    const executor = createPlanExecutor({ content: [] });

    const summary = executor.summarizeToolResult(
      "http_request",
      {
        url: "https://api.github.com/repos/NousResearch/hermes-agent",
        status: 200,
        body: JSON.stringify({
          full_name: "NousResearch/hermes-agent",
          stargazers_count: 123,
          forks_count: 45,
          open_issues_count: 6,
          created_at: "2025-01-02T00:00:00Z",
          pushed_at: "2026-05-16T00:00:00Z",
          html_url: "https://github.com/NousResearch/hermes-agent",
        }),
      },
      { url: "https://api.github.com/repos/NousResearch/hermes-agent" },
    );

    expect(summary).toContain("repo=NousResearch/hermes-agent");
    expect(summary).toContain("stars=123");
    expect(summary).toContain("forks=45");
    expect(summary).toContain("created=2025-01-02T00:00:00Z");
    expect(summary).not.toContain("stargazers_count");
  });

  it("forces local-model analysis step finalization after enough successful evidence", () => {
    const executor = createPlanExecutor({ content: [] });
    executor.provider = { type: "ollama" };
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: "x".repeat(21_000),
            is_error: false,
          },
        ],
      },
    ];

    const shouldFinalize = executor.shouldForceLocalModelStepFinalization({
      iterationCount: 2,
      stepStartedAt: Date.now(),
      stepToolCallCount: 2,
      messages,
      stepContract: { mode: "analysis_only", requiresMutation: false },
      isVerificationStep: false,
      isSummaryStep: false,
      hadAnyToolSuccess: true,
    });

    expect(shouldFinalize).toBe(true);
  });

  it("keeps local-model mutation-required steps open for artifact creation", () => {
    const executor = createPlanExecutor({ content: [] });
    executor.provider = { type: "ollama" };

    const shouldFinalize = executor.shouldForceLocalModelStepFinalization({
      iterationCount: 8,
      stepStartedAt: Date.now() - 500_000,
      stepToolCallCount: 20,
      messages: [],
      stepContract: { mode: "mutation_required", requiresMutation: true },
      isVerificationStep: false,
      isSummaryStep: false,
      hadAnyToolSuccess: true,
    });

    expect(shouldFinalize).toBe(false);
  });

  it("does not force local-model finalization on low-evidence analysis loops", () => {
    const executor = createPlanExecutor({ content: [] });
    executor.provider = { type: "ollama" };

    const shouldFinalize = executor.shouldForceLocalModelStepFinalization({
      iterationCount: 4,
      stepStartedAt: Date.now() - 500_000,
      stepToolCallCount: 2,
      messages: [],
      stepContract: { mode: "analysis_only", requiresMutation: false },
      isVerificationStep: false,
      isSummaryStep: false,
      hadAnyToolSuccess: true,
    });

    expect(shouldFinalize).toBe(false);
  });

  it("keeps verification bullet checks attached to the same numbered step", async () => {
    const response = {
      usage: { inputTokens: 10, outputTokens: 20 },
      content: [
        {
          type: "text",
          text: [
            "1. Run the command `echo hello world`.",
            "2. Verify success by confirming:",
            "- output is exactly `hello world`",
            "- exit status is `0`",
            "3. Report the command result clearly.",
          ].join("\n"),
        },
      ],
    };
    const executor = createPlanExecutor(response);

    await executor.createPlan();

    expect(executor.plan?.steps?.length).toBe(3);
    expect(executor.plan?.steps?.[1]?.description).toContain("Verify success by confirming:");
    expect(executor.plan?.steps?.[1]?.description).toContain("output is exactly `hello world`");
    expect(executor.plan?.steps?.[1]?.description).toContain("exit status is `0`");
    expect(executor.plan?.steps?.[1]?.kind).toBe("verification");
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

  it("does not infer browser QA from Electron renderer Vite details alone", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;

    expect(
      executor.detectVisualQARequirement(
        "CoWork OS is an Electron app with a Vite renderer. Make sure the app works correctly.",
      ),
    ).toBe(false);
  });

  it("does not infer browser QA from build-status and KPI-dashboard checks", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;

    expect(
      executor.detectVisualQARequirement(
        "Check CI/CD pipeline health (last build status, any failures), review the KPI dashboard, and check for security advisories.",
      ),
    ).toBe(false);
  });

  it("still infers browser QA for explicit Vite web app shipping prompts", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;

    expect(
      executor.detectVisualQARequirement(
        "Build a Vite app for the customer dashboard and test it before shipping.",
      ),
    ).toBe(true);
  });

  it("sanitizes contradictory novelist franchise plans instead of reframing to original IP", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.workspace = { path: "/tmp/workspace" };
    executor.task = {
      id: "task-novelist",
      title: "Write a very interesting novel in Dune universe",
      prompt: "write a very interesting novel in Dune universe, use novelist skill",
      agentConfig: {},
    };
    executor.appliedSkills = [
      {
        skillId: "novelist",
        skillName: "Novelist",
        trigger: "slash",
        parameters: {
          canon_mode: "fanfiction",
          seed: "Write a very interesting novel in Dune universe.",
        },
        content: "novelist prompt",
        reason: "Applied via /novelist",
        appliedAt: Date.now(),
        contextDirectives: {
          artifactDirectories: [
            "/tmp/workspace/artifacts/skills/task-novelist/novelist",
            "/tmp/workspace/artifacts",
          ],
        },
      },
    ];
    executor.getContractPrompt = vi
      .fn()
      .mockReturnValue("write a very interesting novel in Dune universe, use novelist skill");
    executor.emitEvent = vi.fn();
    executor.getEffectiveTaskPathRootPolicy = vi.fn().mockReturnValue("disabled");
    executor.taskPinnedRootSource = "unset";
    executor.normalizeOverlappingPlanSteps = vi.fn((steps: Any[]) => steps);
    executor.normalizeWorkspaceAliasPathsInPlanSteps = vi.fn((steps: Any[]) => steps);
    executor.normalizeTaskPinnedRootPathsInPlanSteps = vi.fn((steps: Any[]) => steps);
    executor.ensureRequiredPlanSteps = vi.fn((plan: Any) => plan);
    executor.inferScaffoldRootFromPlanSteps = vi.fn().mockReturnValue(null);

    const sanitized = executor.sanitizePlan({
      description: "Build a legally distinct setting rather than using Dune canon.",
      steps: [
        {
          id: "1",
          description: "Reframe the project into an original universe.",
          kind: "primary",
          status: "pending",
        },
        {
          id: "2",
          description: "Write artifacts/world.md and artifacts/canon.md.",
          kind: "primary",
          status: "pending",
        },
      ],
    });

    expect(sanitized.description).toContain("Dune");
    expect(sanitized.description).not.toMatch(/legally distinct|original IP/i);
    expect(sanitized.steps[0].description).toContain("Dune universe");
    expect(sanitized.steps[0].description).not.toMatch(/original universe|legally distinct/i);
    expect(sanitized.steps[1].description).toContain("/tmp/workspace/artifacts/skills/task-novelist/novelist/world.md");
    expect(sanitized.steps[1].description).toContain("/tmp/workspace/artifacts/skills/task-novelist/novelist/canon.md");
  });

  it("forces strict step-intent alignment for novelist franchise runs", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = {
      id: "task-novelist",
      title: "Write a very interesting novel in Dune universe",
      prompt: "write a very interesting novel in Dune universe, use novelist skill",
      agentConfig: {},
    };
    executor.appliedSkills = [
      {
        skillId: "novelist",
        skillName: "Novelist",
        trigger: "slash",
        parameters: {
          canon_mode: "fanfiction",
          seed: "Write a very interesting novel in Dune universe.",
        },
        content: "novelist prompt",
        reason: "Applied via /novelist",
        appliedAt: Date.now(),
        contextDirectives: {
          artifactDirectories: ["/tmp/workspace/artifacts/skills/task-novelist/novelist"],
        },
      },
    ];
    executor.getContractPrompt = vi
      .fn()
      .mockReturnValue("write a very interesting novel in Dune universe, use novelist skill");

    expect(executor.getStepIntentAlignmentPolicy()).toBe("strict");
  });
});
