/**
 * Tests for the Skill and set_user_name tool functionality in ToolRegistry
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import type { CustomSkill } from "../../../../shared/types";
import * as path from "path";

// Mock settings storage for personality manager
let mockPersonalitySettings: Any = {};

// Mock personality manager
vi.mock("../../../settings/personality-manager", () => ({
  PersonalityManager: {
    loadSettings: vi.fn().mockImplementation(() => mockPersonalitySettings),
    saveSettings: vi.fn().mockImplementation((settings: Any) => {
      mockPersonalitySettings = { ...mockPersonalitySettings, ...settings };
    }),
    setUserName: vi.fn().mockImplementation((name: string) => {
      mockPersonalitySettings.relationship = {
        ...mockPersonalitySettings.relationship,
        userName: name,
      };
    }),
    getUserName: vi.fn().mockImplementation(() => mockPersonalitySettings.relationship?.userName),
    getAgentName: vi.fn().mockReturnValue("CoWork"),
    setActivePersona: vi.fn().mockImplementation((personaId: string) => {
      mockPersonalitySettings.activePersona = personaId;
    }),
    setResponseStyle: vi.fn().mockImplementation((style: Any) => {
      mockPersonalitySettings.responseStyle = {
        ...mockPersonalitySettings.responseStyle,
        ...style,
      };
    }),
    setQuirks: vi.fn().mockImplementation((quirks: Any) => {
      mockPersonalitySettings.quirks = {
        ...mockPersonalitySettings.quirks,
        ...quirks,
      };
    }),
    clearCache: vi.fn(),
  },
}));

// Mock skills storage
let mockSkills: Map<string, CustomSkill> = new Map();

function toRuntimeDescriptor(skill: CustomSkill) {
  return {
    name: skill.id,
    description: skill.description,
    whenToUse: skill.metadata?.routing?.useWhen || skill.description,
    allowedTools: Array.isArray((skill.requires as Any)?.tools)
      ? ((skill.requires as Any).tools as string[])
      : undefined,
    disableModelInvocation: skill.invocation?.disableModelInvocation === true,
    userInvocable: skill.invocation?.userInvocable !== false,
    skill,
  };
}

function matchesSkillRoutingQuery(skill: CustomSkill, query: string): boolean {
  const normalizedQuery = String(query || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/(^|\n)\s*>\s.*$/gm, " ")
    .replace(/["“”'‘’][^"“”'‘’]{1,160}["“”'‘’]/g, " ")
    .toLowerCase()
    .replace(/[-_\s]+/g, " ")
    .trim();

  if (skill.id === "codex-cli") {
    if (!normalizedQuery) return false;

    const activationCue =
      /\b(?:use|run|call|invoke|activate|apply|launch|start|enable|turn on|work on|help with|help me with)\b/;
    const skillCue = /\bskill\b/;
    if (!activationCue.test(normalizedQuery) && !skillCue.test(normalizedQuery)) {
      return false;
    }

    const targets = [skill.id, skill.name]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => value.toLowerCase().replace(/[-_\s]+/g, " ").trim());

    return targets.some((target) => {
      const escaped = target
        .split(" ")
        .filter(Boolean)
        .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("\\s+");

      return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "i").test(normalizedQuery);
    });
  }

  const explicitMatch = [skill.id, skill.name]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.toLowerCase().replace(/[-_\s]+/g, " ").trim())
    .some((target) => {
      const escaped = target
        .split(" ")
        .filter(Boolean)
        .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("\\s+");

      return (
        /\b(?:use|run|call|invoke|activate|apply|launch|start|enable|turn on|work on|help with|help me with)\b/.test(
          normalizedQuery,
        ) || /\bskill\b/.test(normalizedQuery)
      ) && new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "i").test(normalizedQuery);
    });
  if (explicitMatch) return true;

  const routing = skill.metadata?.routing;
  const hasRoutingMetadata =
    Boolean(routing?.useWhen) ||
    Boolean(routing?.dontUseWhen) ||
    Boolean(routing?.outputs) ||
    Boolean(routing?.successCriteria) ||
    (Array.isArray(routing?.expectedArtifacts) && routing.expectedArtifacts.length > 0) ||
    (Array.isArray(routing?.keywords) && routing.keywords.length > 0) ||
    (Array.isArray(routing?.examples?.positive) && routing.examples.positive.length > 0) ||
    (Array.isArray(routing?.examples?.negative) && routing.examples.negative.length > 0);
  if (!hasRoutingMetadata) return false;

  const keywords = routing?.keywords;
  if (!Array.isArray(keywords) || keywords.length === 0) return true;

  if (!normalizedQuery) return false;

  return keywords.some((keyword) => {
    if (typeof keyword !== "string") return false;
    const normalizedKeyword = keyword
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
    if (!normalizedKeyword) return false;

    const escaped = normalizedKeyword
      .split(" ")
      .filter(Boolean)
      .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("\\s+");

    return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "i").test(normalizedQuery);
  });
}

// Mock the custom skill loader
vi.mock("../../custom-skill-loader", () => ({
  getCustomSkillLoader: vi.fn().mockImplementation(() => ({
    getSkill: vi.fn().mockImplementation((id: string) => mockSkills.get(id)),
    listModelInvocableSkills: vi.fn().mockImplementation(() => Array.from(mockSkills.values())),
    listRuntimeSkillDescriptors: vi
      .fn()
      .mockImplementation(() => Array.from(mockSkills.values()).map((skill) => toRuntimeDescriptor(skill))),
    getRuntimeSkillDescriptor: vi.fn().mockImplementation((skill: CustomSkill) => toRuntimeDescriptor(skill)),
    getSkillStatusEntry: vi.fn().mockResolvedValue(null),
    matchesSkillRoutingQuery: vi
      .fn()
      .mockImplementation((skill: CustomSkill, query: string) => matchesSkillRoutingQuery(skill, query)),
    expandPrompt: vi.fn().mockImplementation((
      skill: CustomSkill,
      params: Record<string, Any>,
      context: { artifactDir?: string; workspaceArtifactDir?: string } = {},
    ) => {
      let prompt = skill.prompt;
      const fileDir = skill.filePath ? path.dirname(skill.filePath) : "/mock/resources/skills";
      const scopedBaseDir = skill.filePath ? path.join(fileDir, skill.id) : fileDir;
      prompt = prompt.replace(/\{baseDir\}/g, scopedBaseDir);
      if (context.artifactDir) {
        prompt = prompt.replace(/\{artifactDir\}/g, context.artifactDir);
      }
      if (context.workspaceArtifactDir) {
        prompt = prompt.replace(/\{workspaceArtifactDir\}/g, context.workspaceArtifactDir);
      }
      if (skill.parameters) {
        for (const param of skill.parameters) {
          const value = params[param.name] ?? param.default ?? "";
          const placeholder = new RegExp(`\\{\\{${param.name}\\}\\}`, "g");
          prompt = prompt.replace(placeholder, String(value));
        }
      }
      return prompt.replace(/\{\{[^}]+\}\}/g, "").trim();
    }),
    getSkillDescriptionsForModel: vi.fn().mockReturnValue(""),
  })),
}));

// Mock electron
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue("/mock/user/data"),
  },
}));

// Mock fs
vi.mock("fs", () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(true),
    readFileSync: vi.fn().mockReturnValue("{}"),
    readdirSync: vi.fn().mockReturnValue([]),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  },
  existsSync: vi.fn().mockReturnValue(true),
  readFileSync: vi.fn().mockReturnValue("{}"),
  readdirSync: vi.fn().mockReturnValue([]),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock("fs/promises", () => ({
  default: {
    writeFile: vi.fn(),
  },
  writeFile: vi.fn(),
}));

// Mock other dependencies
vi.mock("../../daemon", () => ({
  AgentDaemon: vi.fn().mockImplementation(() => ({
    logEvent: vi.fn(),
    registerArtifact: vi.fn(),
  })),
}));

vi.mock("../../../mcp/client/MCPClientManager", () => ({
  MCPClientManager: {
    getInstance: vi.fn().mockImplementation(() => {
      throw new Error("MCP not initialized");
    }),
  },
}));

vi.mock("../../../mcp/settings", () => ({
  MCPSettingsManager: {
    initialize: vi.fn(),
    loadSettings: vi.fn().mockReturnValue({ toolNamePrefix: "mcp_" }),
    updateServer: vi.fn().mockReturnValue({}),
  },
}));

vi.mock("../../../mcp/registry/MCPRegistryManager", () => ({
  MCPRegistryManager: {
    installServer: vi.fn(),
  },
}));

vi.mock("../../../hooks/settings", () => ({
  HooksSettingsManager: {
    initialize: vi.fn(),
    loadSettings: vi.fn().mockReturnValue({
      enabled: false,
      token: "",
      path: "/hooks",
      maxBodyBytes: 256 * 1024,
      presets: [],
      mappings: [],
    }),
    enableHooks: vi.fn().mockReturnValue({
      enabled: true,
      token: "token",
      path: "/hooks",
      maxBodyBytes: 256 * 1024,
      presets: [],
      mappings: [],
    }),
    updateConfig: vi.fn().mockImplementation((cfg: Any) => cfg),
  },
}));

vi.mock("../../../security/policy-manager", () => ({
  isToolAllowedQuick: vi.fn().mockReturnValue(true),
}));

vi.mock("../builtin-settings", () => ({
  BuiltinToolsSettingsManager: {
    loadSettings: vi.fn().mockReturnValue({}),
    isToolEnabled: vi.fn().mockReturnValue(true),
    getToolCategory: vi.fn().mockReturnValue("skills"),
    getToolPriority: vi.fn().mockReturnValue("normal"),
    getCodexRuntimeMode: vi.fn().mockReturnValue("native"),
  },
}));

vi.mock("../../search", () => ({
  SearchProviderFactory: {
    isAnyProviderConfigured: vi.fn().mockReturnValue(false),
    getAvailableProviders: vi.fn().mockReturnValue([]),
  },
}));

// Mock MentionTools to avoid DatabaseManager dependency
vi.mock("../mention-tools", () => {
  return {
    MentionTools: class MockMentionTools {
      getTools() {
        return [];
      }
      static getToolDefinitions() {
        return [];
      }
    },
  };
});

// Import after mocking
import { ToolRegistry } from "../registry";
import { BuiltinToolsSettingsManager } from "../builtin-settings";
import type { Workspace } from "../../../../shared/types";

// Helper to create a test skill
function createTestSkill(overrides: Partial<CustomSkill> = {}): CustomSkill {
  return {
    id: "test-skill",
    name: "Test Skill",
    description: "A test skill for unit testing",
    icon: "🧪",
    category: "Testing",
    prompt: "This is a test prompt with {{param1}} and {{param2}}",
    parameters: [
      { name: "param1", type: "string", description: "First param", required: true },
      {
        name: "param2",
        type: "string",
        description: "Second param",
        required: false,
        default: "default-value",
      },
    ],
    enabled: true,
    metadata: {
      routing: {
        useWhen: "Use when testing skill application behavior.",
      },
    },
    ...overrides,
  };
}

// Create mock workspace and daemon
function createMockWorkspace(): Workspace {
  return {
    id: "test-workspace",
    name: "Test Workspace",
    path: "/mock/workspace",
    permissions: {
      read: true,
      write: true,
      shell: false,
      network: true,
    },
    model: "claude-sonnet-4-20250514",
    createdAt: new Date().toISOString(),
  };
}

describe("Skill tool", () => {
  let registry: ToolRegistry;
  let mockDaemon: Any;
  let mockWorkspace: Workspace;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSkills.clear();
    mockPersonalitySettings = {};

    mockWorkspace = createMockWorkspace();
    mockDaemon = {
      logEvent: vi.fn(),
      registerArtifact: vi.fn(),
      getTaskById: vi.fn().mockResolvedValue({
        id: "test-task-123",
        title: "Generic task",
        prompt: "Generic prompt",
        rawPrompt: "Generic prompt",
        userPrompt: "Generic prompt",
      }),
    };

    registry = new ToolRegistry(mockWorkspace, mockDaemon, "test-task-123");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function takeResolvedSkill(result: Any) {
    expect(result.skill_invocation_id).toBeDefined();
    return registry.takeResolvedSkillInvocation(result.skill_invocation_id);
  }

  describe("tool definition", () => {
    it("should expose Skill and remove legacy model-facing skill tools", () => {
      const tools = registry.getTools();
      const skillTool = tools.find((t) => t.name === "Skill");

      expect(skillTool).toBeDefined();
      expect(skillTool?.description).toContain("Invoke a skill");
      expect(tools.find((t) => t.name === "use_skill")).toBeUndefined();
      expect(tools.find((t) => t.name === "skill_list")).toBeUndefined();
      expect(tools.find((t) => t.name === "skill_get")).toBeUndefined();
    });

    it("should have correct input schema", () => {
      const tools = registry.getTools();
      const skillTool = tools.find((t) => t.name === "Skill");

      expect(skillTool?.input_schema.properties.skill).toBeDefined();
      expect(skillTool?.input_schema.properties.args).toBeDefined();
      expect(skillTool?.input_schema.required).toContain("skill");
    });
  });

  describe("skill execution", () => {
    it("should return error for non-existent skill", async () => {
      const result = await registry.executeTool("Skill", {
        skill: "non-existent",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
      expect(result.available_skills).toBeDefined();
    });

    it("should execute a valid skill and store hidden invocation context", async () => {
      const skill = createTestSkill({ id: "my-skill" });
      mockSkills.set("my-skill", skill);

      const result = await registry.executeTool("Skill", {
        skill: "my-skill",
        args: "value1",
      });
      const resolved = takeResolvedSkill(result);

      expect(result.success).toBe(true);
      expect(result.skill).toBe("my-skill");
      expect(result.message).toContain("Loaded skill");
      expect(result.application_summary).toContain("hidden context");
      expect(resolved).toEqual(
        expect.objectContaining({
          skillId: "my-skill",
          args: "value1",
          content: "This is a test prompt with value1 and default-value",
          trigger: "model",
        }),
      );
    });

    it("should parse JSON args for multi-parameter skills", async () => {
      const skill = createTestSkill({
        id: "parameterized-skill",
        prompt: "Process {{path}} to {{language}}",
        parameters: [
          { name: "path", type: "string", description: "File path", required: true },
          { name: "language", type: "string", description: "Target language", required: true },
        ],
      });
      mockSkills.set("parameterized-skill", skill);

      const result = await registry.executeTool("Skill", {
        skill: "parameterized-skill",
        args: JSON.stringify({ path: "test.txt", language: "Spanish" }),
      });
      const resolved = takeResolvedSkill(result);

      expect(result.success).toBe(true);
      expect(resolved?.content).toBe("Process test.txt to Spanish");
      expect(resolved?.parameters).toEqual({ path: "test.txt", language: "Spanish" });
    });

    it("should use default values for optional parameters", async () => {
      const skill = createTestSkill({
        id: "default-params-skill",
        prompt: "Hello {{name}} with {{greeting}}",
        parameters: [
          { name: "name", type: "string", description: "Name", required: true },
          {
            name: "greeting",
            type: "string",
            description: "Greeting",
            required: false,
            default: "Good day",
          },
        ],
      });
      mockSkills.set("default-params-skill", skill);

      const result = await registry.executeTool("Skill", {
        skill: "default-params-skill",
        args: "World",
      });
      const resolved = takeResolvedSkill(result);

      expect(result.success).toBe(true);
      expect(resolved?.content).toBe("Hello World with Good day");
    });

    it("should return error for missing required parameters", async () => {
      const skill = createTestSkill({
        id: "required-params-skill",
        parameters: [
          { name: "required_param", type: "string", description: "Required", required: true },
        ],
      });
      mockSkills.set("required-params-skill", skill);

      const result = await registry.executeTool("Skill", {
        skill: "required-params-skill",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Missing required parameters");
      expect(result.error).toContain("required_param");
    });

    it("should reject skills with disableModelInvocation", async () => {
      const skill = createTestSkill({
        id: "manual-only-skill",
        invocation: { disableModelInvocation: true },
      });
      mockSkills.set("manual-only-skill", skill);

      const result = await registry.executeTool("Skill", {
        skill: "manual-only-skill",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("cannot be invoked automatically");
    });

    it("should reject automatic invocation for skills without routing metadata", async () => {
      const skill = createTestSkill({
        id: "manual-routing-skill",
        metadata: undefined,
      });
      mockSkills.set("manual-routing-skill", skill);

      const result = await registry.executeTool("Skill", {
        skill: "manual-routing-skill",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("not available for this task");
    });

    it("should allow manual slash invocation for a model-disabled skill", async () => {
      const skill = createTestSkill({
        id: "manual-only-skill",
        invocation: { disableModelInvocation: true },
      });
      mockSkills.set("manual-only-skill", skill);

      const result = await registry.executeTool("Skill", {
        skill: "manual-only-skill",
        args: "value1",
        trigger: "slash",
      });
      const resolved = takeResolvedSkill(result);

      expect(result.success).toBe(true);
      expect(resolved).toEqual(
        expect.objectContaining({
          skillId: "manual-only-skill",
          args: "value1",
          trigger: "slash",
        }),
      );
    });

    it("should log skill invocation event", async () => {
      const skill = createTestSkill({ id: "logged-skill" });
      mockSkills.set("logged-skill", skill);

      await registry.executeTool("Skill", {
        skill: "logged-skill",
        args: "test",
      });

      expect(mockDaemon.logEvent).toHaveBeenCalledWith(
        "test-task-123",
        "log",
        expect.objectContaining({
          message: expect.stringContaining("Using skill"),
          skillId: "logged-skill",
        }),
      );
    });

    it("should handle skills without parameters", async () => {
      const skill = createTestSkill({
        id: "no-params-skill",
        prompt: "A simple prompt without parameters",
        parameters: [],
      });
      mockSkills.set("no-params-skill", skill);

      const result = await registry.executeTool("Skill", {
        skill: "no-params-skill",
      });
      const resolved = takeResolvedSkill(result);

      expect(result.success).toBe(true);
      expect(resolved?.content).toBe("A simple prompt without parameters");
    });

    it("should resolve {baseDir} and {artifactDir} placeholders in expanded prompt", async () => {
      const skill = createTestSkill({
        id: "script-skill",
        filePath: "/mock/resources/skills/script-skill.json",
        prompt:
          "Run {baseDir}/scripts/run.sh > {artifactDir}/result.txt and sync into {workspaceArtifactDir}/result.txt",
        parameters: [],
      });
      mockSkills.set("script-skill", skill);

      const result = await registry.executeTool("Skill", {
        skill: "script-skill",
      });
      const resolved = takeResolvedSkill(result);

      expect(result.success).toBe(true);
      expect(resolved?.content).toContain(
        "/mock/resources/skills/script-skill/scripts/run.sh",
      );
      expect(resolved?.content).toContain(
        "/mock/workspace/artifacts/skills/test-task-123/script-skill/result.txt",
      );
      expect(resolved?.content).toContain("/mock/workspace/artifacts/result.txt");
      expect(resolved?.contextDirectives).toEqual(
        expect.objectContaining({
          artifactDirectories: expect.any(Array),
        }),
      );
    });

    it("should return skill metadata in response", async () => {
      const skill = createTestSkill({
        id: "metadata-skill",
        name: "Metadata Test Skill",
        description: "A skill with metadata",
      });
      mockSkills.set("metadata-skill", skill);

      const result = await registry.executeTool("Skill", {
        skill: "metadata-skill",
        args: "test",
      });

      expect(result.skill_name).toBe("Metadata Test Skill");
    });

    it("should reject skill when required tool is unavailable", async () => {
      const skill = createTestSkill({
        id: "cli-skill",
        requires: { tools: ["run_command"] } as Any,
      });
      mockSkills.set("cli-skill", skill);

      const result = await registry.executeTool("Skill", {
        skill: "cli-skill",
        args: "test",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("not currently executable");
      expect(result.reason).toContain("run_command");
      expect(result.missing_tools).toContain("run_command");
    });

    it("should reject codex-cli unless the task explicitly invokes the skill", async () => {
      const skill = createTestSkill({
        id: "codex-cli",
        name: "Codex CLI Agent",
        parameters: [],
        metadata: {
          routing: {
            keywords: ["codex"],
          },
        },
      });
      mockSkills.set("codex-cli", skill);
      mockDaemon.getTaskById.mockResolvedValue({
        id: "test-task-123",
        title: "Review this repo",
        prompt: "Run a generic agent on this issue",
      });

      const result = await registry.executeTool("Skill", {
        skill: "codex-cli",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("not available for this task");
      expect(result.reason).toContain("auto-routable");
    });

    it("should allow codex-cli when the task explicitly invokes the skill", async () => {
      const skill = createTestSkill({
        id: "codex-cli",
        name: "Codex CLI Agent",
        prompt: "Use codex for this task",
        parameters: [],
        metadata: {
          routing: {
            keywords: ["codex"],
          },
        },
      });
      mockSkills.set("codex-cli", skill);
      mockDaemon.getTaskById.mockResolvedValue({
        id: "test-task-123",
        title: "Use the Codex CLI Agent skill",
        prompt: "Use the Codex CLI Agent skill to review this change",
      });

      const result = await registry.executeTool("Skill", {
        skill: "codex-cli",
      });
      const resolved = takeResolvedSkill(result);

      expect(result.success).toBe(true);
      expect(result.skill).toBe("codex-cli");
      expect(resolved?.content).toContain("codex");
      expect(resolved).toEqual(
        expect.objectContaining({
          skillId: "codex-cli",
          trigger: "model",
        }),
      );
    });

    it("should expand codex-cli into an acpx-backed child task when the setting prefers acpx", async () => {
      const runtimeSpy = vi
        .spyOn(BuiltinToolsSettingsManager, "getCodexRuntimeMode")
        .mockReturnValue("acpx");
      const skill = createTestSkill({
        id: "codex-cli",
        name: "Codex CLI Agent",
        prompt: "legacy prompt should be bypassed",
        parameters: [],
        metadata: {
          routing: {
            keywords: ["codex"],
          },
        },
      });
      mockSkills.set("codex-cli", skill);
      mockDaemon.getTaskById.mockResolvedValue({
        id: "test-task-123",
        title: "Use the Codex CLI Agent skill for review",
        prompt:
          'Use the Codex CLI Agent skill to review the current workspace changes by spawning a child agent titled "Codex review" and have it inspect the diff.',
      });

      try {
        const result = await registry.executeTool("Skill", {
          skill: "codex-cli",
        });
        const resolved = takeResolvedSkill(result);

        expect(result.success).toBe(true);
        expect(resolved?.content).toContain("spawn_agent");
        expect(resolved?.content).toContain('`runtime`: `"acpx"`');
        expect(resolved?.content).toContain('`runtime_agent`: `"codex"`');
        expect(resolved?.content).toContain("review the current workspace changes and inspect the diff.");
        expect(resolved?.content).not.toContain("legacy prompt should be bypassed");
        expect(resolved?.content).not.toContain("Phase 0");
        expect(resolved?.content).not.toContain("Read `{baseDir}/SKILL.md`");
      } finally {
        runtimeSpy.mockRestore();
      }
    });

    it("should expand codex-cli into a native child task when the setting prefers native", async () => {
      const runtimeSpy = vi
        .spyOn(BuiltinToolsSettingsManager, "getCodexRuntimeMode")
        .mockReturnValue("native");
      const skill = createTestSkill({
        id: "codex-cli",
        name: "Codex CLI Agent",
        prompt: "legacy prompt should be bypassed",
        parameters: [],
        metadata: {
          routing: {
            keywords: ["codex"],
          },
        },
      });
      mockSkills.set("codex-cli", skill);
      mockDaemon.getTaskById.mockResolvedValue({
        id: "test-task-123",
        title: "Use the Codex CLI Agent skill to fix the failing test",
        prompt: "Use the Codex CLI Agent skill to fix the failing test in the current workspace",
      });

      try {
        const result = await registry.executeTool("Skill", {
          skill: "codex-cli",
        });
        const resolved = takeResolvedSkill(result);

        expect(result.success).toBe(true);
        expect(resolved?.content).toContain("spawn_agent");
        expect(resolved?.content).toContain("Omit `runtime` so the child uses the native Codex CLI path.");
        expect(resolved?.content).not.toContain('`runtime`: `"acpx"`');
        expect(resolved?.content).toContain("fix the failing test in the current workspace.");
      } finally {
        runtimeSpy.mockRestore();
      }
    });
  });

  describe("error handling", () => {
    it("should list available skills when skill not found", async () => {
      const skill1 = createTestSkill({ id: "skill-1" });
      const skill2 = createTestSkill({ id: "skill-2" });
      mockSkills.set("skill-1", skill1);
      mockSkills.set("skill-2", skill2);

      const result = await registry.executeTool("Skill", {
        skill: "unknown-skill",
      });

      expect(result.success).toBe(false);
      expect(result.available_skills).toContain("skill-1");
      expect(result.available_skills).toContain("skill-2");
    });

    it("should provide parameter info when required params missing", async () => {
      const skill = createTestSkill({
        id: "info-skill",
        parameters: [
          { name: "file", type: "string", description: "File to process", required: true },
          {
            name: "format",
            type: "select",
            description: "Output format",
            required: false,
            options: ["json", "xml"],
          },
        ],
      });
      mockSkills.set("info-skill", skill);

      const result = await registry.executeTool("Skill", {
        skill: "info-skill",
      });

      expect(result.success).toBe(false);
      expect(result.parameters).toBeDefined();
      expect(result.parameters).toHaveLength(2);
      expect(result.parameters[0].name).toBe("file");
      expect(result.parameters[0].required).toBe(true);
    });
  });
});

describe("set_user_name tool", () => {
  let registry: ToolRegistry;
  let mockDaemon: Any;
  let mockWorkspace: Workspace;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPersonalitySettings = {};

    mockWorkspace = createMockWorkspace();
    mockDaemon = {
      logEvent: vi.fn(),
      registerArtifact: vi.fn(),
    };

    registry = new ToolRegistry(mockWorkspace, mockDaemon, "test-task-123");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("tool definition", () => {
    it("should include set_user_name in available tools", () => {
      const tools = registry.getTools();
      const setUserNameTool = tools.find((t) => t.name === "set_user_name");

      expect(setUserNameTool).toBeDefined();
      expect(setUserNameTool?.description).toContain("user's name");
    });

    it("should have correct input schema", () => {
      const tools = registry.getTools();
      const setUserNameTool = tools.find((t) => t.name === "set_user_name");

      expect(setUserNameTool?.input_schema.properties.name).toBeDefined();
      expect(setUserNameTool?.input_schema.required).toContain("name");
    });

    it("should always be enabled regardless of builtin settings", () => {
      // The tool should be in the filtered tools list
      const tools = registry.getTools();
      const setUserNameTool = tools.find((t) => t.name === "set_user_name");
      expect(setUserNameTool).toBeDefined();
    });
  });

  describe("user name storage", () => {
    it("should store user name successfully", async () => {
      const { PersonalityManager } = await import("../../../settings/personality-manager");

      const result = await registry.executeTool("set_user_name", {
        name: "Alice",
      });

      expect(result.success).toBe(true);
      expect(result.name).toBe("Alice");
      expect(result.message).toContain("Alice");
      expect(PersonalityManager.setUserName).toHaveBeenCalledWith("Alice");
    });

    it("should include agent name in response message", async () => {
      const result = await registry.executeTool("set_user_name", {
        name: "Bob",
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain("Bob");
      expect(result.message).toContain("CoWork");
    });

    it("should trim whitespace from name", async () => {
      const { PersonalityManager } = await import("../../../settings/personality-manager");

      const result = await registry.executeTool("set_user_name", {
        name: "  Charlie  ",
      });

      expect(result.success).toBe(true);
      expect(result.name).toBe("Charlie");
      expect(PersonalityManager.setUserName).toHaveBeenCalledWith("Charlie");
    });

    it("should reject empty name", async () => {
      await expect(registry.executeTool("set_user_name", { name: "" })).rejects.toThrow(
        "Name cannot be empty",
      );
    });

    it("should reject whitespace-only name", async () => {
      await expect(registry.executeTool("set_user_name", { name: "   " })).rejects.toThrow(
        "Name cannot be empty",
      );
    });

    it("should reject very long names", async () => {
      const longName = "A".repeat(101);
      await expect(registry.executeTool("set_user_name", { name: longName })).rejects.toThrow(
        "Name is too long",
      );
    });

    it("should accept names up to 100 characters", async () => {
      const maxName = "A".repeat(100);
      const result = await registry.executeTool("set_user_name", {
        name: maxName,
      });

      expect(result.success).toBe(true);
      expect(result.name).toBe(maxName);
    });
  });

  describe("response format", () => {
    it("should return success status", async () => {
      const result = await registry.executeTool("set_user_name", {
        name: "Diana",
      });

      expect(result).toHaveProperty("success", true);
      expect(result).toHaveProperty("name", "Diana");
      expect(result).toHaveProperty("message");
    });

    it("should include friendly greeting in message", async () => {
      const result = await registry.executeTool("set_user_name", {
        name: "Eve",
      });

      expect(result.message).toContain("Nice to meet you");
      expect(result.message).toContain("remember");
    });
  });
});

describe("set_persona tool", () => {
  let registry: ToolRegistry;
  let mockDaemon: Any;
  let mockWorkspace: Workspace;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPersonalitySettings = {};

    mockWorkspace = createMockWorkspace();
    mockDaemon = {
      logEvent: vi.fn(),
      registerArtifact: vi.fn(),
    };

    registry = new ToolRegistry(mockWorkspace, mockDaemon, "test-task-123");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("tool definition", () => {
    it("should include set_persona in available tools", () => {
      const tools = registry.getTools();
      const setPersonaTool = tools.find((t) => t.name === "set_persona");

      expect(setPersonaTool).toBeDefined();
      expect(setPersonaTool?.description).toContain("persona");
    });

    it("should have correct input schema with all persona options", () => {
      const tools = registry.getTools();
      const setPersonaTool = tools.find((t) => t.name === "set_persona");

      expect(setPersonaTool?.input_schema.properties.persona).toBeDefined();
      expect(setPersonaTool?.input_schema.properties.persona.enum).toContain("jarvis");
      expect(setPersonaTool?.input_schema.properties.persona.enum).toContain("friday");
      expect(setPersonaTool?.input_schema.properties.persona.enum).toContain("none");
      expect(setPersonaTool?.input_schema.required).toContain("persona");
    });

    it("should always be enabled regardless of builtin settings", () => {
      const tools = registry.getTools();
      const setPersonaTool = tools.find((t) => t.name === "set_persona");
      expect(setPersonaTool).toBeDefined();
    });
  });

  describe("persona selection", () => {
    it("should set jarvis persona successfully", async () => {
      const { PersonalityManager } = await import("../../../settings/personality-manager");

      const result = await registry.executeTool("set_persona", {
        persona: "jarvis",
      });

      expect(result.success).toBe(true);
      expect(result.persona).toBe("jarvis");
      expect(result.name).toBe("Jarvis");
      expect(PersonalityManager.setActivePersona).toHaveBeenCalledWith("jarvis");
    });

    it("should set friday persona successfully", async () => {
      const result = await registry.executeTool("set_persona", {
        persona: "friday",
      });

      expect(result.success).toBe(true);
      expect(result.persona).toBe("friday");
      expect(result.name).toBe("Friday");
    });

    it("should set pirate persona successfully", async () => {
      const result = await registry.executeTool("set_persona", {
        persona: "pirate",
      });

      expect(result.success).toBe(true);
      expect(result.persona).toBe("pirate");
      expect(result.name).toBe("Pirate");
    });

    it("should clear persona with none", async () => {
      const result = await registry.executeTool("set_persona", {
        persona: "none",
      });

      expect(result.success).toBe(true);
      expect(result.persona).toBe("none");
      expect(result.message).toContain("cleared");
    });

    it("should reject invalid persona", async () => {
      await expect(
        registry.executeTool("set_persona", { persona: "invalid-persona" }),
      ).rejects.toThrow("Invalid persona");
    });

    it("should include valid personas in error message", async () => {
      try {
        await registry.executeTool("set_persona", { persona: "unknown" });
      } catch (error: Any) {
        expect(error.message).toContain("jarvis");
        expect(error.message).toContain("friday");
        expect(error.message).toContain("none");
      }
    });
  });

  describe("response format", () => {
    it("should return success status and persona details", async () => {
      const result = await registry.executeTool("set_persona", {
        persona: "hal",
      });

      expect(result).toHaveProperty("success", true);
      expect(result).toHaveProperty("persona", "hal");
      expect(result).toHaveProperty("name");
      expect(result).toHaveProperty("description");
      expect(result).toHaveProperty("message");
    });

    it("should include informative message for active persona", async () => {
      const result = await registry.executeTool("set_persona", {
        persona: "sensei",
      });

      expect(result.message).toContain("Sensei");
      expect(result.message).toContain("character style");
    });

    it("should include different message for none persona", async () => {
      const result = await registry.executeTool("set_persona", {
        persona: "none",
      });

      expect(result.message).toContain("cleared");
      expect(result.message).not.toContain("character style");
    });
  });
});

describe("set_response_style tool", () => {
  let registry: ToolRegistry;
  let mockDaemon: Any;
  let mockWorkspace: Workspace;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPersonalitySettings = {};

    mockWorkspace = createMockWorkspace();
    mockDaemon = {
      logEvent: vi.fn(),
      registerArtifact: vi.fn(),
    };

    registry = new ToolRegistry(mockWorkspace, mockDaemon, "test-task-123");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("tool definition", () => {
    it("should include set_response_style in available tools", () => {
      const tools = registry.getTools();
      const tool = tools.find((t) => t.name === "set_response_style");

      expect(tool).toBeDefined();
      expect(tool?.description).toContain("response");
    });

    it("should have all style options in schema", () => {
      const tools = registry.getTools();
      const tool = tools.find((t) => t.name === "set_response_style");

      expect(tool?.input_schema.properties.emoji_usage).toBeDefined();
      expect(tool?.input_schema.properties.response_length).toBeDefined();
      expect(tool?.input_schema.properties.code_comments).toBeDefined();
      expect(tool?.input_schema.properties.explanation_depth).toBeDefined();
    });
  });

  describe("style changes", () => {
    it("should set emoji usage", async () => {
      const { PersonalityManager } = await import("../../../settings/personality-manager");

      const result = await registry.executeTool("set_response_style", {
        emoji_usage: "expressive",
      });

      expect(result.success).toBe(true);
      expect(result.changes).toContain("emoji usage: expressive");
      expect(PersonalityManager.setResponseStyle).toHaveBeenCalledWith({
        emojiUsage: "expressive",
      });
    });

    it("should set response length", async () => {
      const result = await registry.executeTool("set_response_style", {
        response_length: "terse",
      });

      expect(result.success).toBe(true);
      expect(result.changes).toContain("response length: terse");
    });

    it("should set code comments style", async () => {
      const result = await registry.executeTool("set_response_style", {
        code_comments: "verbose",
      });

      expect(result.success).toBe(true);
      expect(result.changes).toContain("code comments: verbose");
    });

    it("should set explanation depth", async () => {
      const result = await registry.executeTool("set_response_style", {
        explanation_depth: "teaching",
      });

      expect(result.success).toBe(true);
      expect(result.changes).toContain("explanation depth: teaching");
    });

    it("should set multiple styles at once", async () => {
      const result = await registry.executeTool("set_response_style", {
        emoji_usage: "none",
        response_length: "detailed",
      });

      expect(result.success).toBe(true);
      expect(result.changes).toHaveLength(2);
    });

    it("should reject invalid emoji usage", async () => {
      await expect(
        registry.executeTool("set_response_style", { emoji_usage: "invalid" }),
      ).rejects.toThrow("Invalid emoji_usage");
    });

    it("should reject invalid response length", async () => {
      await expect(
        registry.executeTool("set_response_style", { response_length: "invalid" }),
      ).rejects.toThrow("Invalid response_length");
    });

    it("should reject empty input", async () => {
      await expect(registry.executeTool("set_response_style", {})).rejects.toThrow(
        "No valid style options",
      );
    });
  });
});

describe("set_quirks tool", () => {
  let registry: ToolRegistry;
  let mockDaemon: Any;
  let mockWorkspace: Workspace;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPersonalitySettings = {};

    mockWorkspace = createMockWorkspace();
    mockDaemon = {
      logEvent: vi.fn(),
      registerArtifact: vi.fn(),
    };

    registry = new ToolRegistry(mockWorkspace, mockDaemon, "test-task-123");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("tool definition", () => {
    it("should include set_quirks in available tools", () => {
      const tools = registry.getTools();
      const tool = tools.find((t) => t.name === "set_quirks");

      expect(tool).toBeDefined();
      expect(tool?.description).toContain("quirks");
    });

    it("should have all quirk options in schema", () => {
      const tools = registry.getTools();
      const tool = tools.find((t) => t.name === "set_quirks");

      expect(tool?.input_schema.properties.catchphrase).toBeDefined();
      expect(tool?.input_schema.properties.sign_off).toBeDefined();
      expect(tool?.input_schema.properties.analogy_domain).toBeDefined();
    });
  });

  describe("quirk changes", () => {
    it("should set catchphrase", async () => {
      const { PersonalityManager } = await import("../../../settings/personality-manager");

      const result = await registry.executeTool("set_quirks", {
        catchphrase: "At your service!",
      });

      expect(result.success).toBe(true);
      expect(result.changes).toContain('catchphrase: "At your service!"');
      expect(PersonalityManager.setQuirks).toHaveBeenCalledWith({
        catchphrase: "At your service!",
      });
    });

    it("should set sign-off", async () => {
      const result = await registry.executeTool("set_quirks", {
        sign_off: "Happy coding!",
      });

      expect(result.success).toBe(true);
      expect(result.changes).toContain('sign-off: "Happy coding!"');
    });

    it("should set analogy domain", async () => {
      const result = await registry.executeTool("set_quirks", {
        analogy_domain: "space",
      });

      expect(result.success).toBe(true);
      expect(result.changes).toContain("analogy domain: space");
    });

    it("should clear catchphrase with empty string", async () => {
      const result = await registry.executeTool("set_quirks", {
        catchphrase: "",
      });

      expect(result.success).toBe(true);
      expect(result.changes).toContain("catchphrase cleared");
    });

    it("should clear analogy domain with none", async () => {
      const result = await registry.executeTool("set_quirks", {
        analogy_domain: "none",
      });

      expect(result.success).toBe(true);
      expect(result.changes).toContain("analogy domain cleared");
    });

    it("should set multiple quirks at once", async () => {
      const result = await registry.executeTool("set_quirks", {
        catchphrase: "Hello!",
        sign_off: "Goodbye!",
      });

      expect(result.success).toBe(true);
      expect(result.changes).toHaveLength(2);
    });

    it("should reject invalid analogy domain", async () => {
      await expect(
        registry.executeTool("set_quirks", { analogy_domain: "invalid" }),
      ).rejects.toThrow("Invalid analogy_domain");
    });

    it("should reject empty input", async () => {
      await expect(registry.executeTool("set_quirks", {})).rejects.toThrow("No quirk options");
    });
  });
});
