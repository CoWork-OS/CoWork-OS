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
  executor.initialImages = [];
  executor.emitEvent = vi.fn();

  executor.getRoleContextPrompt = vi.fn().mockReturnValue("");
  executor.getInfraContextPrompt = vi.fn().mockReturnValue("");
  executor.getEffectiveExecutionMode = vi.fn().mockReturnValue("execute");
  executor.getAvailableTools = vi.fn().mockReturnValue([]);
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

  return executor;
}

describe("TaskExecutor plan parsing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
