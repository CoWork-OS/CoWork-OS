/**
 * Tests for CustomSkillLoader
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import type { CustomSkill } from "../../../shared/types";
import * as path from "path";

// Track file system operations
let mockFiles: Map<string, string> = new Map();
let mockDirExists = true;
const getFilename = (p: string): string => path.basename(p);

// Mock electron app
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue("/mock/user/data"),
  },
}));

// Mock fs module - use a function to extract just the filename from any path
vi.mock("fs", () => ({
  default: {
    existsSync: vi.fn().mockImplementation((p: string) => {
      if (p.endsWith("skills")) return mockDirExists;
      // Check if any mock file ends with the same filename
      const filename = getFilename(p);
      for (const [key] of mockFiles) {
        if (key.endsWith(filename)) return true;
      }
      return false;
    }),
    readFileSync: vi.fn().mockImplementation((p: string) => {
      // Find mock file by filename
      const filename = getFilename(p);
      for (const [key, value] of mockFiles) {
        if (key.endsWith(filename)) return value;
      }
      throw new Error(`File not found: ${p}`);
    }),
    readdirSync: vi.fn().mockImplementation(() => {
      return Array.from(mockFiles.keys())
        .filter((k) => k.endsWith(".json"))
        .map((k) => getFilename(k));
    }),
  },
  existsSync: vi.fn().mockImplementation((p: string) => {
    if (p.endsWith("skills")) return mockDirExists;
    const filename = getFilename(p);
    for (const [key] of mockFiles) {
      if (key.endsWith(filename)) return true;
    }
    return false;
  }),
  readFileSync: vi.fn().mockImplementation((p: string) => {
    const filename = getFilename(p);
    for (const [key, value] of mockFiles) {
      if (key.endsWith(filename)) return value;
    }
    throw new Error(`File not found: ${p}`);
  }),
  readdirSync: vi.fn().mockImplementation(() => {
    return Array.from(mockFiles.keys())
      .filter((k) => k.endsWith(".json"))
      .map((k) => getFilename(k));
  }),
}));

// Import after mocking
import { CustomSkillLoader, getCustomSkillLoader } from "../custom-skill-loader";

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
    ...overrides,
  };
}

describe("CustomSkillLoader", () => {
  let loader: CustomSkillLoader;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFiles.clear();
    mockDirExists = true;
    // Create a fresh instance for each test
    loader = new CustomSkillLoader();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("getSkillsDirectory", () => {
    it("should return the skills directory path", () => {
      const dir = loader.getSkillsDirectory();
      expect(dir).toContain("skills");
    });
  });

  describe("validateSkill", () => {
    it("should validate a valid skill", async () => {
      const skill = createTestSkill();
      mockFiles.set("test-skill.json", JSON.stringify(skill));

      await loader.reloadSkills();
      const loaded = loader.getSkill("test-skill");

      expect(loaded).toBeDefined();
      expect(loaded?.id).toBe("test-skill");
    });

    it("should reject skill without id", async () => {
      const skill = createTestSkill({ id: "" });
      mockFiles.set("bad-skill.json", JSON.stringify(skill));

      await loader.reloadSkills();
      const loaded = loader.getSkill("");

      expect(loaded).toBeUndefined();
    });

    it("should reject skill without name", async () => {
      const skill = createTestSkill({ name: "" });
      mockFiles.set("no-name.json", JSON.stringify(skill));

      await loader.reloadSkills();
      expect(loader.listSkills()).toHaveLength(0);
    });

    it("should reject skill without description", async () => {
      const skill = createTestSkill({ description: "" });
      mockFiles.set("no-desc.json", JSON.stringify(skill));

      await loader.reloadSkills();
      expect(loader.listSkills()).toHaveLength(0);
    });

    it("should reject skill without prompt", async () => {
      const skill = createTestSkill({ prompt: "" });
      mockFiles.set("no-prompt.json", JSON.stringify(skill));

      await loader.reloadSkills();
      expect(loader.listSkills()).toHaveLength(0);
    });
  });

  describe("expandPrompt", () => {
    it("should replace placeholders with values", () => {
      const skill = createTestSkill();
      const result = loader.expandPrompt(skill, {
        param1: "value1",
        param2: "value2",
      });

      expect(result).toBe("This is a test prompt with value1 and value2");
    });

    it("should use default values when parameter not provided", () => {
      const skill = createTestSkill();
      const result = loader.expandPrompt(skill, {
        param1: "value1",
      });

      expect(result).toBe("This is a test prompt with value1 and default-value");
    });

    it("should remove unreplaced placeholders", () => {
      const skill = createTestSkill({
        prompt: "Test {{param1}} and {{unknown}}",
        parameters: [{ name: "param1", type: "string", description: "P1", required: true }],
      });
      const result = loader.expandPrompt(skill, { param1: "hello" });

      expect(result).toBe("Test hello and");
    });

    it("should handle skills with no parameters", () => {
      const skill = createTestSkill({
        prompt: "Simple prompt without placeholders",
        parameters: [],
      });
      const result = loader.expandPrompt(skill, {});

      expect(result).toBe("Simple prompt without placeholders");
    });

    it("should handle numeric values", () => {
      const skill = createTestSkill({
        prompt: "Count: {{count}}",
        parameters: [{ name: "count", type: "number", description: "A number", required: true }],
      });
      const result = loader.expandPrompt(skill, { count: 42 });

      expect(result).toBe("Count: 42");
    });

    it("should handle boolean values", () => {
      const skill = createTestSkill({
        prompt: "Enabled: {{enabled}}",
        parameters: [
          { name: "enabled", type: "boolean", description: "A boolean", required: true },
        ],
      });
      const result = loader.expandPrompt(skill, { enabled: true });

      expect(result).toBe("Enabled: true");
    });
  });

  describe("listSkills", () => {
    it("should return empty array when no skills", async () => {
      await loader.reloadSkills();
      expect(loader.listSkills()).toEqual([]);
    });

    it("should return all loaded skills", async () => {
      const skill1 = createTestSkill({ id: "skill-1", name: "Skill 1" });
      const skill2 = createTestSkill({ id: "skill-2", name: "Skill 2" });

      mockFiles.set("skill-1.json", JSON.stringify(skill1));
      mockFiles.set("skill-2.json", JSON.stringify(skill2));

      await loader.reloadSkills();
      const skills = loader.listSkills();

      expect(skills).toHaveLength(2);
    });

    it("should sort by priority first", async () => {
      const skill1 = createTestSkill({ id: "skill-1", name: "Skill 1", priority: 10 });
      const skill2 = createTestSkill({ id: "skill-2", name: "Skill 2", priority: 5 });

      mockFiles.set("skill-1.json", JSON.stringify(skill1));
      mockFiles.set("skill-2.json", JSON.stringify(skill2));

      await loader.reloadSkills();
      const skills = loader.listSkills();

      expect(skills[0].id).toBe("skill-2"); // Lower priority number = first
      expect(skills[1].id).toBe("skill-1");
    });

    it("should sort by category when priority is equal", async () => {
      const skill1 = createTestSkill({ id: "skill-1", name: "Skill 1", category: "Zebra" });
      const skill2 = createTestSkill({ id: "skill-2", name: "Skill 2", category: "Alpha" });

      mockFiles.set("skill-1.json", JSON.stringify(skill1));
      mockFiles.set("skill-2.json", JSON.stringify(skill2));

      await loader.reloadSkills();
      const skills = loader.listSkills();

      expect(skills[0].id).toBe("skill-2"); // Alpha before Zebra
      expect(skills[1].id).toBe("skill-1");
    });

    it("should sort by name when category and priority are equal", async () => {
      const skill1 = createTestSkill({ id: "skill-1", name: "Zebra", category: "Testing" });
      const skill2 = createTestSkill({ id: "skill-2", name: "Alpha", category: "Testing" });

      mockFiles.set("skill-1.json", JSON.stringify(skill1));
      mockFiles.set("skill-2.json", JSON.stringify(skill2));

      await loader.reloadSkills();
      const skills = loader.listSkills();

      expect(skills[0].id).toBe("skill-2"); // Alpha before Zebra
      expect(skills[1].id).toBe("skill-1");
    });
  });

  describe("listTaskSkills", () => {
    it("should exclude guideline skills", async () => {
      const taskSkill = createTestSkill({ id: "task-skill", type: undefined });
      const guidelineSkill = createTestSkill({ id: "guideline-skill", type: "guideline" });

      mockFiles.set("task-skill.json", JSON.stringify(taskSkill));
      mockFiles.set("guideline-skill.json", JSON.stringify(guidelineSkill));

      await loader.reloadSkills();
      const taskSkills = loader.listTaskSkills();

      expect(taskSkills).toHaveLength(1);
      expect(taskSkills[0].id).toBe("task-skill");
    });
  });

  describe("listGuidelineSkills", () => {
    it("should only return guideline skills", async () => {
      const taskSkill = createTestSkill({ id: "task-skill", type: undefined });
      const guidelineSkill = createTestSkill({ id: "guideline-skill", type: "guideline" });

      mockFiles.set("task-skill.json", JSON.stringify(taskSkill));
      mockFiles.set("guideline-skill.json", JSON.stringify(guidelineSkill));

      await loader.reloadSkills();
      const guidelineSkills = loader.listGuidelineSkills();

      expect(guidelineSkills).toHaveLength(1);
      expect(guidelineSkills[0].id).toBe("guideline-skill");
    });
  });

  describe("getEnabledGuidelinesPrompt", () => {
    it("should return empty string when no guidelines", async () => {
      const taskSkill = createTestSkill({ id: "task-skill" });
      mockFiles.set("task-skill.json", JSON.stringify(taskSkill));

      await loader.reloadSkills();
      const prompt = loader.getEnabledGuidelinesPrompt();

      expect(prompt).toBe("");
    });

    it("should combine enabled guideline prompts", async () => {
      const guideline1 = createTestSkill({
        id: "guideline-1",
        type: "guideline",
        prompt: "Guideline 1 content",
        enabled: true,
      });
      const guideline2 = createTestSkill({
        id: "guideline-2",
        type: "guideline",
        prompt: "Guideline 2 content",
        enabled: true,
      });

      mockFiles.set("guideline-1.json", JSON.stringify(guideline1));
      mockFiles.set("guideline-2.json", JSON.stringify(guideline2));

      await loader.reloadSkills();
      const prompt = loader.getEnabledGuidelinesPrompt();

      expect(prompt).toContain("Guideline 1 content");
      expect(prompt).toContain("Guideline 2 content");
    });

    it("should exclude disabled guidelines", async () => {
      const enabledGuideline = createTestSkill({
        id: "enabled-guideline",
        type: "guideline",
        prompt: "Enabled content",
        enabled: true,
      });
      const disabledGuideline = createTestSkill({
        id: "disabled-guideline",
        type: "guideline",
        prompt: "Disabled content",
        enabled: false,
      });

      mockFiles.set("enabled-guideline.json", JSON.stringify(enabledGuideline));
      mockFiles.set("disabled-guideline.json", JSON.stringify(disabledGuideline));

      await loader.reloadSkills();
      const prompt = loader.getEnabledGuidelinesPrompt();

      expect(prompt).toContain("Enabled content");
      expect(prompt).not.toContain("Disabled content");
    });
  });

  describe("getSkill", () => {
    it("should return undefined for non-existent skill", async () => {
      await loader.reloadSkills();
      const skill = loader.getSkill("non-existent");
      expect(skill).toBeUndefined();
    });

    it("should return the skill by id", async () => {
      const testSkill = createTestSkill({ id: "my-skill" });
      mockFiles.set("my-skill.json", JSON.stringify(testSkill));

      await loader.reloadSkills();
      const skill = loader.getSkill("my-skill");

      expect(skill).toBeDefined();
      expect(skill?.id).toBe("my-skill");
    });
  });

  describe("reloadSkills", () => {
    it("should clear existing skills before loading", async () => {
      const skill1 = createTestSkill({ id: "skill-1" });
      mockFiles.set("skill-1.json", JSON.stringify(skill1));
      await loader.reloadSkills();

      expect(loader.listSkills()).toHaveLength(1);

      // Clear files and reload
      mockFiles.clear();
      await loader.reloadSkills();

      expect(loader.listSkills()).toHaveLength(0);
    });

    it("should handle malformed JSON gracefully", async () => {
      mockFiles.set("bad.json", "not valid json");
      mockFiles.set("good.json", JSON.stringify(createTestSkill({ id: "good" })));

      await loader.reloadSkills();

      // Should still load the valid skill
      expect(loader.listSkills()).toHaveLength(1);
      expect(loader.getSkill("good")).toBeDefined();
    });

    it("should return empty array when directory does not exist", async () => {
      mockDirExists = false;
      const skills = await loader.reloadSkills();
      expect(skills).toEqual([]);
    });
  });

  describe("initialize", () => {
    it("should only initialize once", async () => {
      const skill = createTestSkill({ id: "init-skill" });
      mockFiles.set("init-skill.json", JSON.stringify(skill));

      await loader.initialize();
      expect(loader.listSkills()).toHaveLength(1);

      // Clear files - should not affect loaded skills since already initialized
      mockFiles.clear();
      await loader.initialize();
      expect(loader.listSkills()).toHaveLength(1);
    });
  });
});

describe("listModelInvocableSkills", () => {
  let loader: CustomSkillLoader;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFiles.clear();
    mockDirExists = true;
    loader = new CustomSkillLoader();
  });

  it("should return empty array when no skills", async () => {
    await loader.reloadSkills();
    expect(loader.listModelInvocableSkills()).toEqual([]);
  });

  it("should exclude guideline skills", async () => {
    const taskSkill = createTestSkill({ id: "task-skill", type: "task" });
    const guidelineSkill = createTestSkill({ id: "guideline-skill", type: "guideline" });

    mockFiles.set("task-skill.json", JSON.stringify(taskSkill));
    mockFiles.set("guideline-skill.json", JSON.stringify(guidelineSkill));

    await loader.reloadSkills();
    const invocableSkills = loader.listModelInvocableSkills();

    expect(invocableSkills).toHaveLength(1);
    expect(invocableSkills[0].id).toBe("task-skill");
  });

  it("should exclude disabled skills", async () => {
    const enabledSkill = createTestSkill({ id: "enabled-skill", enabled: true });
    const disabledSkill = createTestSkill({ id: "disabled-skill", enabled: false });

    mockFiles.set("enabled-skill.json", JSON.stringify(enabledSkill));
    mockFiles.set("disabled-skill.json", JSON.stringify(disabledSkill));

    await loader.reloadSkills();
    const invocableSkills = loader.listModelInvocableSkills();

    expect(invocableSkills).toHaveLength(1);
    expect(invocableSkills[0].id).toBe("enabled-skill");
  });

  it("should exclude skills with disableModelInvocation set", async () => {
    const invocableSkill = createTestSkill({ id: "invocable-skill" });
    const nonInvocableSkill = createTestSkill({
      id: "non-invocable-skill",
      invocation: { disableModelInvocation: true },
    });

    mockFiles.set("invocable-skill.json", JSON.stringify(invocableSkill));
    mockFiles.set("non-invocable-skill.json", JSON.stringify(nonInvocableSkill));

    await loader.reloadSkills();
    const invocableSkills = loader.listModelInvocableSkills();

    expect(invocableSkills).toHaveLength(1);
    expect(invocableSkills[0].id).toBe("invocable-skill");
  });

  it("should include skills with disableModelInvocation false", async () => {
    const skill = createTestSkill({
      id: "explicit-invocable",
      invocation: { disableModelInvocation: false },
    });

    mockFiles.set("explicit-invocable.json", JSON.stringify(skill));

    await loader.reloadSkills();
    const invocableSkills = loader.listModelInvocableSkills();

    expect(invocableSkills).toHaveLength(1);
    expect(invocableSkills[0].id).toBe("explicit-invocable");
  });

  it("should include skills without invocation policy", async () => {
    const skill = createTestSkill({ id: "no-policy-skill" });
    // Ensure no invocation property
    delete (skill as Any).invocation;

    mockFiles.set("no-policy-skill.json", JSON.stringify(skill));

    await loader.reloadSkills();
    const invocableSkills = loader.listModelInvocableSkills();

    expect(invocableSkills).toHaveLength(1);
    expect(invocableSkills[0].id).toBe("no-policy-skill");
  });

  it("should filter out skills requiring unavailable tools", async () => {
    const shellDependentSkill = createTestSkill({
      id: "shell-dependent",
      requires: { tools: ["run_command"] } as Any,
    });
    const safeSkill = createTestSkill({ id: "safe-skill" });

    mockFiles.set("shell-dependent.json", JSON.stringify(shellDependentSkill));
    mockFiles.set("safe-skill.json", JSON.stringify(safeSkill));

    await loader.reloadSkills();
    const invocableSkills = loader.listModelInvocableSkills({
      availableToolNames: new Set(["read_file", "web_fetch"]),
    });

    expect(invocableSkills).toHaveLength(1);
    expect(invocableSkills[0].id).toBe("safe-skill");
  });

  it("should filter out binary-dependent skills when run_command is unavailable", async () => {
    const binarySkill = createTestSkill({
      id: "binary-skill",
      requires: { bins: ["summarize"] },
    });
    const safeSkill = createTestSkill({ id: "safe-skill" });

    mockFiles.set("binary-skill.json", JSON.stringify(binarySkill));
    mockFiles.set("safe-skill.json", JSON.stringify(safeSkill));

    await loader.reloadSkills();
    const invocableSkills = loader.listModelInvocableSkills({
      availableToolNames: new Set(["read_file", "web_fetch"]),
    });

    expect(invocableSkills).toHaveLength(1);
    expect(invocableSkills[0].id).toBe("safe-skill");
  });
});

describe("getSkillDescriptionsForModel", () => {
  let loader: CustomSkillLoader;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFiles.clear();
    mockDirExists = true;
    loader = new CustomSkillLoader();
  });

  it("should return empty string when no skills", async () => {
    await loader.reloadSkills();
    expect(loader.getSkillDescriptionsForModel()).toBe("");
  });

  it("should format skills by category", async () => {
    const devSkill = createTestSkill({
      id: "git-commit",
      name: "Git Commit",
      description: "Create a commit",
      category: "Development",
    });
    const writingSkill = createTestSkill({
      id: "translate",
      name: "Translate",
      description: "Translate content",
      category: "Writing",
    });

    mockFiles.set("git-commit.json", JSON.stringify(devSkill));
    mockFiles.set("translate.json", JSON.stringify(writingSkill));

    await loader.reloadSkills();
    const descriptions = loader.getSkillDescriptionsForModel();

    expect(descriptions).toContain("Development:");
    expect(descriptions).toContain("Writing:");
    expect(descriptions).toContain("git-commit: Create a commit");
    expect(descriptions).toContain("translate: Translate content");
  });

  it("should use General category for skills without category", async () => {
    const skill = createTestSkill({
      id: "no-category",
      description: "A skill without category",
    });
    delete (skill as Any).category;

    mockFiles.set("no-category.json", JSON.stringify(skill));

    await loader.reloadSkills();
    const descriptions = loader.getSkillDescriptionsForModel();

    expect(descriptions).toContain("General:");
    expect(descriptions).toContain("no-category: A skill without category");
  });

  it("should include parameter info with required markers", async () => {
    const skill = createTestSkill({
      id: "parameterized-skill",
      description: "A skill with params",
      category: "Testing",
      parameters: [
        { name: "path", type: "string", description: "File path", required: true },
        { name: "language", type: "select", description: "Target language", required: false },
      ],
    });

    mockFiles.set("parameterized-skill.json", JSON.stringify(skill));

    await loader.reloadSkills();
    const descriptions = loader.getSkillDescriptionsForModel();

    expect(descriptions).toContain(
      "parameterized-skill: A skill with params (params: path*, language)",
    );
  });

  it("should not include param info for skills without parameters", async () => {
    const skill = createTestSkill({
      id: "no-params",
      description: "A skill without params",
      category: "Testing",
      parameters: [],
    });

    mockFiles.set("no-params.json", JSON.stringify(skill));

    await loader.reloadSkills();
    const descriptions = loader.getSkillDescriptionsForModel();

    expect(descriptions).toContain("no-params: A skill without params");
    expect(descriptions).not.toContain("(params:");
  });

  it("should exclude guideline skills from descriptions", async () => {
    const taskSkill = createTestSkill({
      id: "task-skill",
      description: "A task skill",
      category: "Testing",
    });
    const guidelineSkill = createTestSkill({
      id: "guideline-skill",
      description: "A guideline skill",
      category: "Testing",
      type: "guideline",
    });

    mockFiles.set("task-skill.json", JSON.stringify(taskSkill));
    mockFiles.set("guideline-skill.json", JSON.stringify(guidelineSkill));

    await loader.reloadSkills();
    const descriptions = loader.getSkillDescriptionsForModel();

    expect(descriptions).toContain("task-skill");
    expect(descriptions).not.toContain("guideline-skill");
  });

  it("should exclude disabled skills from descriptions", async () => {
    const enabledSkill = createTestSkill({
      id: "enabled-skill",
      description: "An enabled skill",
      category: "Testing",
      enabled: true,
    });
    const disabledSkill = createTestSkill({
      id: "disabled-skill",
      description: "A disabled skill",
      category: "Testing",
      enabled: false,
    });

    mockFiles.set("enabled-skill.json", JSON.stringify(enabledSkill));
    mockFiles.set("disabled-skill.json", JSON.stringify(disabledSkill));

    await loader.reloadSkills();
    const descriptions = loader.getSkillDescriptionsForModel();

    expect(descriptions).toContain("enabled-skill");
    expect(descriptions).not.toContain("disabled-skill");
  });
});

describe("getCustomSkillLoader", () => {
  it("should return singleton instance", () => {
    const instance1 = getCustomSkillLoader();
    const instance2 = getCustomSkillLoader();

    expect(instance1).toBe(instance2);
  });
});
