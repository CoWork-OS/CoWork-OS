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
  }),
}));

vi.mock("../../settings/memory-features-manager", () => ({
  MemoryFeaturesManager: {
    loadSettings: vi.fn().mockReturnValue({ contextPackInjectionEnabled: false }),
  },
}));

// Production identity/personality prompts are a few thousand characters, which
// leaves the planning guidance roughly 13K characters of the system budget.
vi.mock("../../settings/personality-manager", () => ({
  PersonalityManager: {
    getPersonalityPrompt: vi.fn().mockReturnValue("Be warm and direct. ".repeat(45)),
    getPersonalityPromptById: vi.fn().mockReturnValue(""),
    getIdentityPrompt: vi.fn().mockReturnValue("You are CoWork. ".repeat(200)),
  },
}));

const TOOL_COUNT = 140;
const SKILL_COUNT = 20;

function buildCatalog() {
  const tools = Array.from({ length: TOOL_COUNT }, (_, index) => ({
    name: `catalog_tool_${index}`,
    description: `Does task number ${index}. `.repeat(12),
    input_schema: { type: "object" as const, properties: {} },
  }));
  const toolLines = tools.map(
    (tool) => `- ${tool.name}: ${tool.description.slice(0, 177).trim()}...`,
  );
  const skillLines = Array.from(
    { length: SKILL_COUNT },
    (_, index) => `- skill-${index}: Produces deliverable ${index} with a guided workflow.`,
  );
  const toolDescriptions = [
    `Available tools:\n${toolLines.join("\n")}`,
    `Skills Available Through The Skill Tool:\n${skillLines.join("\n")}`,
  ].join("\n\n");
  return { tools, toolDescriptions };
}

function createPlanExecutor(response: Any): Any {
  const { tools, toolDescriptions } = buildCatalog();
  const executor = Object.create(TaskExecutor.prototype) as Any;
  executor.task = {
    id: "task-plan",
    title: "Fix failing parseDate test",
    prompt: "Fix the failing parseDate test in src/utils/date.ts and run the test suite.",
    rawPrompt: "Fix the failing parseDate test in src/utils/date.ts and run the test suite.",
    createdAt: Date.now() - 1000,
  };
  executor.workspace = {
    id: "ws-1",
    path: "/tmp",
    isTemp: false,
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
      surfaceCoverage: { executor: true, followUps: true, chatMode: true, sideCalls: false },
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
  executor.getAvailableTools = vi.fn().mockReturnValue(tools);
  executor.applyIntentFilter = vi.fn((candidateTools: Any[]) => candidateTools);
  executor.toolRegistry = { getToolDescriptions: vi.fn().mockReturnValue(toolDescriptions) };
  executor.checkBudgets = vi.fn();
  executor.updateTracking = vi.fn();
  executor.buildUserContent = vi.fn().mockResolvedValue("test-user-content");
  executor.resolveLLMMaxTokens = vi.fn().mockReturnValue(8192);
  executor.createMessageWithTimeout = vi.fn().mockResolvedValue(response);
  executor.callLLMWithRetry = vi.fn(async (requestFn: Any) => requestFn(0));
  executor.requiresVisualQARun = false;
  executor.refreshProviderIfSettingsChanged = vi.fn();
  executor.llmProfileUsed = "cheap";
  return executor;
}

describe("planning prompt budget", () => {
  it("keeps the planning rules and JSON contract with a large tool and skill catalog", async () => {
    const response = {
      usage: { inputTokens: 1, outputTokens: 2 },
      content: [
        {
          type: "text",
          text: '{"description":"Fix","steps":[{"id":"1","description":"Fix the parser"}]}',
        },
      ],
    };
    const executor = createPlanExecutor(response);

    await executor.createPlan();

    const system = String(executor.createMessageWithTimeout.mock.calls[0][0].system);
    expect(system).toContain("PLANNING RULES:");
    expect(system).toContain("Include one final verification step");
    expect(system).toContain("Return ONLY a JSON object");
    expect(system).toContain('"steps": [');
    // Every tool stays visible to the planner, at least by name.
    expect(system).toContain("catalog_tool_0");
    expect(system).toContain(`catalog_tool_${TOOL_COUNT - 1}`);
    expect(system).toContain("skill-0");
  });
});
