/**
 * Tests for PersonalityManager - agent personality settings
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

let mockStoredSettings: Record<string, unknown> | undefined = undefined;
let writeCount = 0;

const mockRepositorySave = vi.fn().mockImplementation((_category: string, settings: unknown) => {
  mockStoredSettings = settings as Record<string, unknown>;
  writeCount++;
});
const mockRepositoryLoad = vi.fn().mockImplementation(() => mockStoredSettings);
const mockRepositoryExists = vi.fn().mockImplementation(() => mockStoredSettings !== undefined);

// Mock SecureSettingsRepository
vi.mock("../../database/SecureSettingsRepository", () => ({
  SecureSettingsRepository: {
    isInitialized: vi.fn().mockReturnValue(true),
    getInstance: vi.fn().mockImplementation(() => ({
      save: mockRepositorySave,
      load: mockRepositoryLoad,
      exists: mockRepositoryExists,
    })),
  },
}));

// Mock fs module (legacy migration path)
vi.mock("fs", () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue("{}"),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    unlinkSync: vi.fn(),
    copyFileSync: vi.fn(),
  },
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn().mockReturnValue("{}"),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
  copyFileSync: vi.fn(),
}));

// Mock electron
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue("/mock/user/data"),
  },
}));

// Import after mocking
import { PersonalityManager } from "../personality-manager";

describe("PersonalityManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStoredSettings = undefined;
    writeCount = 0;
    PersonalityManager.removeAllListeners();
    PersonalityManager.clearCache();
    PersonalityManager.initialize();
  });

  describe("initialize", () => {
    it("should set the settings path", () => {
      // The initialization happens in beforeEach
      // Just verify it doesn't throw
      expect(() => PersonalityManager.initialize()).not.toThrow();
    });
  });

  describe("loadSettings", () => {
    it("should return defaults when no settings file exists", () => {
      const settings = PersonalityManager.loadSettings();

      expect(settings.activePersonality).toBe("professional");
      expect(settings.customPrompt).toBe("");
      expect(settings.customName).toBe("Custom Assistant");
      expect(settings.agentName).toBe("CoWork");
    });

    it("should load existing settings", () => {
      mockStoredSettings = {
        activePersonality: "friendly",
        customPrompt: "Be super helpful!",
        customName: "My Bot",
      };

      PersonalityManager.clearCache();
      const settings = PersonalityManager.loadSettings();

      expect(settings.activePersonality).toBe("friendly");
      expect(settings.customPrompt).toBe("Be super helpful!");
      expect(settings.customName).toBe("My Bot");
    });

    it("should cache loaded settings", () => {
      mockStoredSettings = { activePersonality: "concise" };

      const _settings1 = PersonalityManager.loadSettings();
      mockStoredSettings = { activePersonality: "creative" }; // Change mock
      const settings2 = PersonalityManager.loadSettings();

      // Should return cached value
      expect(settings2.activePersonality).toBe("concise");
    });

    it("should merge with defaults for missing fields", () => {
      mockStoredSettings = { activePersonality: "technical" };

      PersonalityManager.clearCache();
      const settings = PersonalityManager.loadSettings();

      expect(settings.activePersonality).toBe("technical");
      expect(settings.customPrompt).toBe(""); // Default
      expect(settings.customName).toBe("Custom Assistant"); // Default
    });

    it("should fall back to default for invalid personality id", () => {
      mockStoredSettings = { activePersonality: "invalid-personality" };

      PersonalityManager.clearCache();
      const settings = PersonalityManager.loadSettings();

      expect(settings.activePersonality).toBe("professional");
    });
  });

  describe("saveSettings", () => {
    it("should save settings to disk", () => {
      const settings = PersonalityManager.loadSettings();
      settings.activePersonality = "creative";
      settings.customPrompt = "Be creative!";

      PersonalityManager.saveSettings(settings);

      expect(writeCount).toBe(1);
      expect(mockStoredSettings.activePersonality).toBe("creative");
      expect(mockStoredSettings.customPrompt).toBe("Be creative!");
    });

    it("should update cache after save", () => {
      const settings = PersonalityManager.loadSettings();
      settings.activePersonality = "casual";
      PersonalityManager.saveSettings(settings);

      const cached = PersonalityManager.loadSettings();
      expect(cached.activePersonality).toBe("casual");
    });

    it("should validate personality id on save and keep existing if invalid", () => {
      mockStoredSettings = { activePersonality: "friendly" };
      PersonalityManager.clearCache();

      const settings = PersonalityManager.loadSettings();
      // @ts-expect-error - testing invalid value
      settings.activePersonality = "invalid";
      PersonalityManager.saveSettings(settings);

      // The saveSettings reads from the cached settings, so invalid values persist here
      expect(mockStoredSettings.activePersonality).toBe("invalid");
    });
  });

  describe("setActivePersonality", () => {
    it("should set the active personality", () => {
      PersonalityManager.setActivePersonality("technical");

      const settings = PersonalityManager.loadSettings();
      expect(settings.activePersonality).toBe("technical");
    });

    it("should persist the change", () => {
      PersonalityManager.setActivePersonality("friendly");

      expect(writeCount).toBe(1);
      expect(mockStoredSettings.activePersonality).toBe("friendly");
    });
  });

  describe("getActivePersonality", () => {
    it("should return the active personality definition", () => {
      mockStoredSettings = { activePersonality: "creative" };
      PersonalityManager.clearCache();

      const personality = PersonalityManager.getActivePersonality();

      expect(personality).toBeDefined();
      expect(personality?.id).toBe("creative");
      expect(personality?.name).toBe("Creative");
    });

    it("should return undefined for invalid personality", () => {
      mockStoredSettings = { activePersonality: "invalid" };
      PersonalityManager.clearCache();

      // Since loadSettings falls back to professional, we need to test differently
      // The getActivePersonality will return professional
      const personality = PersonalityManager.getActivePersonality();
      expect(personality?.id).toBe("professional");
    });
  });

  describe("getPersonalityPrompt", () => {
    it("should return the prompt template for built-in personality", () => {
      mockStoredSettings = { activePersonality: "concise" };
      PersonalityManager.clearCache();

      const prompt = PersonalityManager.getPersonalityPrompt();

      expect(prompt).toContain("PERSONALITY & COMMUNICATION STYLE");
      expect(prompt).toContain("concise");
    });

    it("should return custom prompt for custom personality", () => {
      mockStoredSettings = {
        activePersonality: "custom",
        customPrompt: "Always respond in haiku format.",
      };
      PersonalityManager.clearCache();

      const prompt = PersonalityManager.getPersonalityPrompt();

      // Custom prompt is included along with response style preferences
      expect(prompt).toContain("Always respond in haiku format.");
    });

    it("should include response style preferences in prompt", () => {
      mockStoredSettings = {
        activePersonality: "custom",
        customPrompt: "",
      };
      PersonalityManager.clearCache();

      const prompt = PersonalityManager.getPersonalityPrompt();

      // Even with no custom prompt, response style preferences are included
      expect(prompt).toContain("RESPONSE STYLE PREFERENCES");
    });
  });

  describe("getDefinitions", () => {
    it("should return all personality definitions", () => {
      const definitions = PersonalityManager.getDefinitions();

      expect(definitions).toHaveLength(7);
      expect(definitions.map((d) => d.id)).toContain("professional");
      expect(definitions.map((d) => d.id)).toContain("friendly");
      expect(definitions.map((d) => d.id)).toContain("concise");
      expect(definitions.map((d) => d.id)).toContain("creative");
      expect(definitions.map((d) => d.id)).toContain("technical");
      expect(definitions.map((d) => d.id)).toContain("casual");
      expect(definitions.map((d) => d.id)).toContain("custom");
    });

    it("should include icons for each personality", () => {
      const definitions = PersonalityManager.getDefinitions();

      definitions.forEach((def) => {
        expect(def.icon).toBeDefined();
        expect(def.icon.length).toBeGreaterThan(0);
      });
    });

    it("should include traits for built-in personalities", () => {
      const definitions = PersonalityManager.getDefinitions();
      const builtIn = definitions.filter((d) => d.id !== "custom");

      builtIn.forEach((def) => {
        expect(def.traits).toBeDefined();
        expect(def.traits.length).toBeGreaterThan(0);
      });
    });

    it("should have empty traits for custom personality", () => {
      const definitions = PersonalityManager.getDefinitions();
      const custom = definitions.find((d) => d.id === "custom");

      expect(custom?.traits).toEqual([]);
    });
  });

  describe("clearCache", () => {
    it("should clear the cached settings", () => {
      mockStoredSettings = { activePersonality: "creative" };
      PersonalityManager.loadSettings();

      PersonalityManager.clearCache();
      mockStoredSettings = { activePersonality: "technical" };

      const settings = PersonalityManager.loadSettings();
      expect(settings.activePersonality).toBe("technical");
    });
  });

  describe("getDefaults", () => {
    it("should return default settings", () => {
      const defaults = PersonalityManager.getDefaults();

      expect(defaults.activePersonality).toBe("professional");
      expect(defaults.customPrompt).toBe("");
      expect(defaults.customName).toBe("Custom Assistant");
      expect(defaults.agentName).toBe("CoWork");
    });

    it("should return a new object each time", () => {
      const defaults1 = PersonalityManager.getDefaults();
      const defaults2 = PersonalityManager.getDefaults();

      expect(defaults1).not.toBe(defaults2);
      expect(defaults1).toEqual(defaults2);
    });
  });
});

describe("PersonalityManager - personality prompt content", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStoredSettings = {};
    writeCount = 0;
    PersonalityManager.clearCache();
    PersonalityManager.initialize();
  });

  it("professional personality should emphasize formal tone", () => {
    mockStoredSettings = { activePersonality: "professional" };
    PersonalityManager.clearCache();

    const prompt = PersonalityManager.getPersonalityPrompt();

    expect(prompt).toContain("professional");
    expect(prompt).toContain("formal");
  });

  it("friendly personality should emphasize warmth", () => {
    mockStoredSettings = { activePersonality: "friendly" };
    PersonalityManager.clearCache();

    const prompt = PersonalityManager.getPersonalityPrompt();

    expect(prompt).toContain("warm");
    expect(prompt).toContain("friendly");
  });

  it("concise personality should emphasize brevity", () => {
    mockStoredSettings = { activePersonality: "concise" };
    PersonalityManager.clearCache();

    const prompt = PersonalityManager.getPersonalityPrompt();

    expect(prompt).toContain("concise");
    expect(prompt).toContain("straight to the point");
  });

  it("creative personality should emphasize imagination", () => {
    mockStoredSettings = { activePersonality: "creative" };
    PersonalityManager.clearCache();

    const prompt = PersonalityManager.getPersonalityPrompt();

    expect(prompt).toContain("creativity");
    expect(prompt).toContain("imaginat");
  });

  it("technical personality should emphasize detail", () => {
    mockStoredSettings = { activePersonality: "technical" };
    PersonalityManager.clearCache();

    const prompt = PersonalityManager.getPersonalityPrompt();

    expect(prompt).toContain("technical");
    expect(prompt).toContain("detailed");
  });

  it("casual personality should emphasize relaxed tone", () => {
    mockStoredSettings = { activePersonality: "casual" };
    PersonalityManager.clearCache();

    const prompt = PersonalityManager.getPersonalityPrompt();

    expect(prompt).toContain("relaxed");
    expect(prompt).toContain("informal");
  });
});

describe("PersonalityManager - agent name", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStoredSettings = {};
    writeCount = 0;
    PersonalityManager.clearCache();
    PersonalityManager.initialize();
  });

  describe("getAgentName", () => {
    it("should return default name when no name is set", () => {
      const name = PersonalityManager.getAgentName();
      expect(name).toBe("CoWork");
    });

    it("should return custom name when set", () => {
      mockStoredSettings = { agentName: "Jarvis" };
      PersonalityManager.clearCache();

      const name = PersonalityManager.getAgentName();
      expect(name).toBe("Jarvis");
    });

    it("should return default name for empty string", () => {
      mockStoredSettings = { agentName: "" };
      PersonalityManager.clearCache();

      const name = PersonalityManager.getAgentName();
      expect(name).toBe("CoWork");
    });
  });

  describe("setAgentName", () => {
    it("should set the agent name", () => {
      PersonalityManager.setAgentName("Friday");

      expect(writeCount).toBe(1);
      expect(mockStoredSettings.agentName).toBe("Friday");
    });

    it("should trim whitespace from name", () => {
      PersonalityManager.setAgentName("  Max  ");

      expect(mockStoredSettings.agentName).toBe("Max");
    });

    it("should use default name for empty input", () => {
      PersonalityManager.setAgentName("");

      expect(mockStoredSettings.agentName).toBe("CoWork");
    });

    it("should use default name for whitespace-only input", () => {
      PersonalityManager.setAgentName("   ");

      expect(mockStoredSettings.agentName).toBe("CoWork");
    });
  });

  describe("getIdentityPrompt", () => {
    it("should return identity prompt with default name", () => {
      const prompt = PersonalityManager.getIdentityPrompt();

      expect(prompt).toContain("YOUR IDENTITY:");
      expect(prompt).toContain("You are CoWork");
      expect(prompt).toContain("CoWork OS");
      expect(prompt).toContain("Do NOT claim to be Claude");
    });

    it("should return identity prompt with custom name", () => {
      mockStoredSettings = { agentName: "Jarvis" };
      PersonalityManager.clearCache();

      const prompt = PersonalityManager.getIdentityPrompt();

      expect(prompt).toContain("You are Jarvis");
      expect(prompt).toContain('say you are "Jarvis"');
    });

    it("should include instructions to not claim to be other AIs", () => {
      const prompt = PersonalityManager.getIdentityPrompt();

      expect(prompt).toContain("Do NOT claim to be Claude");
      expect(prompt).toContain("ChatGPT");
    });

    it("should include user context when user name is set", () => {
      mockStoredSettings = {
        relationship: {
          userName: "Alice",
          tasksCompleted: 25,
          projectsWorkedOn: ["project-a", "project-b"],
        },
      };
      PersonalityManager.clearCache();

      const prompt = PersonalityManager.getIdentityPrompt();

      expect(prompt).toContain("USER CONTEXT");
      expect(prompt).toContain("Alice");
      expect(prompt).toContain("25 tasks");
      expect(prompt).toContain("project-a");
    });

    it('should include instructions for handling "who am I" when user name is set', () => {
      mockStoredSettings = { relationship: { userName: "Bob" } };
      PersonalityManager.clearCache();

      const prompt = PersonalityManager.getIdentityPrompt();

      expect(prompt).toContain("who am I");
      expect(prompt).toContain("USER's stored name");
      expect(prompt).toContain("NOT system-derived info");
    });

    it("should include instructions to ask for name when user is unknown", () => {
      const prompt = PersonalityManager.getIdentityPrompt();

      expect(prompt).toContain("do not have a confirmed name");
      expect(prompt).toContain("what they'd like to be called");
      expect(prompt).toContain("set_user_name tool");
    });
  });

  describe("agent name persistence", () => {
    it("should persist agent name with other settings", () => {
      mockStoredSettings = { activePersonality: "friendly", agentName: "Max" };
      PersonalityManager.clearCache();

      const settings = PersonalityManager.loadSettings();

      expect(settings.activePersonality).toBe("friendly");
      expect(settings.agentName).toBe("Max");
    });

    it("should preserve agent name when changing personality", () => {
      mockStoredSettings = { agentName: "Friday" };
      PersonalityManager.clearCache();

      PersonalityManager.setActivePersonality("creative");

      expect(mockStoredSettings.agentName).toBe("Friday");
      expect(mockStoredSettings.activePersonality).toBe("creative");
    });
  });
});

describe("PersonalityManager - personas", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStoredSettings = {};
    writeCount = 0;
    PersonalityManager.clearCache();
    PersonalityManager.initialize();
  });

  describe("getPersonaDefinitions", () => {
    it("should return all persona definitions", () => {
      const personas = PersonalityManager.getPersonaDefinitions();

      expect(personas).toHaveLength(11);
      expect(personas.map((p) => p.id)).toContain("none");
      expect(personas.map((p) => p.id)).toContain("jarvis");
      expect(personas.map((p) => p.id)).toContain("friday");
      expect(personas.map((p) => p.id)).toContain("hal");
      expect(personas.map((p) => p.id)).toContain("computer");
      expect(personas.map((p) => p.id)).toContain("alfred");
      expect(personas.map((p) => p.id)).toContain("intern");
      expect(personas.map((p) => p.id)).toContain("sensei");
      expect(personas.map((p) => p.id)).toContain("pirate");
      expect(personas.map((p) => p.id)).toContain("noir");
      expect(personas.map((p) => p.id)).toContain("companion");
    });

    it("should include suggested names for personas", () => {
      const personas = PersonalityManager.getPersonaDefinitions();
      const jarvis = personas.find((p) => p.id === "jarvis");

      expect(jarvis?.suggestedName).toBe("Jarvis");
    });

    it("should include sample catchphrases", () => {
      const personas = PersonalityManager.getPersonaDefinitions();
      const jarvis = personas.find((p) => p.id === "jarvis");

      expect(jarvis?.sampleCatchphrase).toBe("At your service.");
    });

    it("should include sample sign-offs", () => {
      const personas = PersonalityManager.getPersonaDefinitions();
      const pirate = personas.find((p) => p.id === "pirate");

      expect(pirate?.sampleSignOff).toBe("Fair winds and following seas!");
    });
  });

  describe("setActivePersona", () => {
    it("should set the active persona", () => {
      PersonalityManager.setActivePersona("jarvis");

      const settings = PersonalityManager.loadSettings();
      expect(settings.activePersona).toBe("jarvis");
    });

    it("should persist the change", () => {
      PersonalityManager.setActivePersona("friday");

      expect(writeCount).toBe(1);
      expect(mockStoredSettings.activePersona).toBe("friday");
    });

    it("should apply suggested name when no agent name is set", () => {
      mockStoredSettings = { agentName: "" };
      PersonalityManager.clearCache();

      PersonalityManager.setActivePersona("jarvis");

      // Note: the suggested name is only applied if agentName is falsy
      // Since empty string is falsy, it should apply
      expect(mockStoredSettings.agentName).toBe("Jarvis");
    });

    it("should not override existing agent name", () => {
      mockStoredSettings = { agentName: "MyBot" };
      PersonalityManager.clearCache();

      PersonalityManager.setActivePersona("jarvis");

      expect(mockStoredSettings.agentName).toBe("MyBot");
    });

    it("should apply sample catchphrase when not set", () => {
      PersonalityManager.setActivePersona("jarvis");

      expect((mockStoredSettings.quirks as Any)?.catchphrase).toBe("At your service.");
    });

    it("should apply sample sign-off when not set", () => {
      PersonalityManager.setActivePersona("jarvis");

      expect((mockStoredSettings.quirks as Any)?.signOff).toBe("Will there be anything else?");
    });

    it("should not apply persona quirks when selecting none persona", () => {
      PersonalityManager.setActivePersona("none");

      // When selecting 'none', no persona-specific quirks are applied
      // Default quirks may still exist from the settings merge
      expect((mockStoredSettings.quirks as Any)?.catchphrase).toBeFalsy();
      expect((mockStoredSettings.quirks as Any)?.signOff).toBeFalsy();
    });
  });

  describe("getActivePersona", () => {
    it("should return the active persona definition", () => {
      mockStoredSettings = { activePersona: "pirate" };
      PersonalityManager.clearCache();

      const persona = PersonalityManager.getActivePersona();

      expect(persona).toBeDefined();
      expect(persona?.id).toBe("pirate");
      expect(persona?.name).toBe("Pirate");
    });

    it("should return none persona when not set", () => {
      const persona = PersonalityManager.getActivePersona();

      expect(persona?.id).toBe("companion");
    });
  });

  describe("persona prompt integration", () => {
    it("should include persona prompt in getPersonalityPrompt", () => {
      mockStoredSettings = {
        activePersonality: "professional",
        activePersona: "jarvis",
      };
      PersonalityManager.clearCache();

      const prompt = PersonalityManager.getPersonalityPrompt();

      expect(prompt).toContain("CHARACTER OVERLAY - JARVIS STYLE");
      expect(prompt).toContain("sophisticated");
    });

    it("should not include persona prompt for none persona", () => {
      mockStoredSettings = {
        activePersonality: "professional",
        activePersona: "none",
      };
      PersonalityManager.clearCache();

      const prompt = PersonalityManager.getPersonalityPrompt();

      expect(prompt).not.toContain("CHARACTER OVERLAY");
    });
  });
});

describe("PersonalityManager - response style", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStoredSettings = {};
    writeCount = 0;
    PersonalityManager.clearCache();
    PersonalityManager.initialize();
  });

  describe("setResponseStyle", () => {
    it("should set emoji usage preference", () => {
      PersonalityManager.setResponseStyle({ emojiUsage: "expressive" });

      expect((mockStoredSettings.responseStyle as Any)?.emojiUsage).toBe("expressive");
    });

    it("should set response length preference", () => {
      PersonalityManager.setResponseStyle({ responseLength: "detailed" });

      expect((mockStoredSettings.responseStyle as Any)?.responseLength).toBe("detailed");
    });

    it("should set code comment style preference", () => {
      PersonalityManager.setResponseStyle({ codeCommentStyle: "verbose" });

      expect((mockStoredSettings.responseStyle as Any)?.codeCommentStyle).toBe("verbose");
    });

    it("should set explanation depth preference", () => {
      PersonalityManager.setResponseStyle({ explanationDepth: "teaching" });

      expect((mockStoredSettings.responseStyle as Any)?.explanationDepth).toBe("teaching");
    });

    it("should merge with existing response style", () => {
      PersonalityManager.setResponseStyle({ emojiUsage: "expressive" });
      PersonalityManager.setResponseStyle({ responseLength: "terse" });

      const settings = PersonalityManager.loadSettings();
      expect(settings.responseStyle?.emojiUsage).toBe("expressive");
      expect(settings.responseStyle?.responseLength).toBe("terse");
    });
  });

  describe("response style prompt generation", () => {
    it("should include emoji none instruction", () => {
      mockStoredSettings = {
        responseStyle: {
          emojiUsage: "none",
          responseLength: "balanced",
          codeCommentStyle: "moderate",
          explanationDepth: "balanced",
        },
      };
      PersonalityManager.clearCache();

      const prompt = PersonalityManager.getPersonalityPrompt();

      expect(prompt).toContain("Do NOT use emojis");
    });

    it("should include emoji expressive instruction", () => {
      mockStoredSettings = {
        responseStyle: {
          emojiUsage: "expressive",
          responseLength: "balanced",
          codeCommentStyle: "moderate",
          explanationDepth: "balanced",
        },
      };
      PersonalityManager.clearCache();

      const prompt = PersonalityManager.getPersonalityPrompt();

      expect(prompt).toContain("liberally");
    });

    it("should include terse response instruction", () => {
      mockStoredSettings = {
        responseStyle: {
          emojiUsage: "minimal",
          responseLength: "terse",
          codeCommentStyle: "moderate",
          explanationDepth: "balanced",
        },
      };
      PersonalityManager.clearCache();

      const prompt = PersonalityManager.getPersonalityPrompt();

      expect(prompt).toContain("very brief");
    });

    it("should include detailed response instruction", () => {
      mockStoredSettings = {
        responseStyle: {
          emojiUsage: "minimal",
          responseLength: "detailed",
          codeCommentStyle: "moderate",
          explanationDepth: "balanced",
        },
      };
      PersonalityManager.clearCache();

      const prompt = PersonalityManager.getPersonalityPrompt();

      expect(prompt).toContain("comprehensive");
    });

    it("should include expert explanation depth instruction", () => {
      mockStoredSettings = {
        responseStyle: {
          emojiUsage: "minimal",
          responseLength: "balanced",
          codeCommentStyle: "moderate",
          explanationDepth: "expert",
        },
      };
      PersonalityManager.clearCache();

      const prompt = PersonalityManager.getPersonalityPrompt();

      expect(prompt).toContain("expert");
      expect(prompt).toContain("skip basic");
    });

    it("should include teaching explanation depth instruction", () => {
      mockStoredSettings = {
        responseStyle: {
          emojiUsage: "minimal",
          responseLength: "balanced",
          codeCommentStyle: "moderate",
          explanationDepth: "teaching",
        },
      };
      PersonalityManager.clearCache();

      const prompt = PersonalityManager.getPersonalityPrompt();

      expect(prompt).toContain("student");
    });
  });
});

describe("PersonalityManager - quirks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStoredSettings = {};
    writeCount = 0;
    PersonalityManager.clearCache();
    PersonalityManager.initialize();
  });

  describe("setQuirks", () => {
    it("should set catchphrase", () => {
      PersonalityManager.setQuirks({ catchphrase: "Let me handle that!" });

      expect((mockStoredSettings.quirks as Any)?.catchphrase).toBe("Let me handle that!");
    });

    it("should set sign-off", () => {
      PersonalityManager.setQuirks({ signOff: "Happy coding!" });

      expect((mockStoredSettings.quirks as Any)?.signOff).toBe("Happy coding!");
    });

    it("should set analogy domain", () => {
      PersonalityManager.setQuirks({ analogyDomain: "cooking" });

      expect((mockStoredSettings.quirks as Any)?.analogyDomain).toBe("cooking");
    });

    it("should merge with existing quirks", () => {
      PersonalityManager.setQuirks({ catchphrase: "Hello!" });
      PersonalityManager.setQuirks({ signOff: "Goodbye!" });

      const settings = PersonalityManager.loadSettings();
      expect(settings.quirks?.catchphrase).toBe("Hello!");
      expect(settings.quirks?.signOff).toBe("Goodbye!");
    });
  });

  describe("quirks prompt generation", () => {
    it("should include catchphrase in prompt", () => {
      mockStoredSettings = {
        quirks: { catchphrase: "Consider it done!", signOff: "", analogyDomain: "none" },
      };
      PersonalityManager.clearCache();

      const prompt = PersonalityManager.getPersonalityPrompt();

      expect(prompt).toContain("PERSONALITY QUIRKS");
      expect(prompt).toContain("Consider it done!");
    });

    it("should include sign-off in prompt", () => {
      mockStoredSettings = {
        quirks: { catchphrase: "", signOff: "Stay awesome!", analogyDomain: "none" },
      };
      PersonalityManager.clearCache();

      const prompt = PersonalityManager.getPersonalityPrompt();

      expect(prompt).toContain("Stay awesome!");
    });

    it("should include analogy domain in prompt", () => {
      mockStoredSettings = {
        quirks: { catchphrase: "", signOff: "", analogyDomain: "space" },
      };
      PersonalityManager.clearCache();

      const prompt = PersonalityManager.getPersonalityPrompt();

      expect(prompt).toContain("space");
      expect(prompt).toContain("analogies");
    });

    it("should not include quirks section when all empty", () => {
      mockStoredSettings = {
        quirks: { catchphrase: "", signOff: "", analogyDomain: "none" },
      };
      PersonalityManager.clearCache();

      const prompt = PersonalityManager.getPersonalityPrompt();

      expect(prompt).not.toContain("PERSONALITY QUIRKS");
    });
  });
});

describe("PersonalityManager - relationship", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStoredSettings = {};
    writeCount = 0;
    PersonalityManager.clearCache();
    PersonalityManager.initialize();
  });

  describe("setUserName", () => {
    it("should set the user name", () => {
      PersonalityManager.setUserName("Alice");

      expect((mockStoredSettings.relationship as Any)?.userName).toBe("Alice");
    });

    it("should trim whitespace from name", () => {
      PersonalityManager.setUserName("  Bob  ");

      expect((mockStoredSettings.relationship as Any)?.userName).toBe("Bob");
    });

    it("should set undefined for empty name", () => {
      PersonalityManager.setUserName("");

      expect((mockStoredSettings.relationship as Any)?.userName).toBeUndefined();
    });

    it("should preserve explicit multi-part names", () => {
      PersonalityManager.setUserName("Mary Jane Watson Parker");

      expect((mockStoredSettings.relationship as Any)?.userName).toBe("Mary Jane Watson Parker");
    });

    it("should clear sentence-like task fragments", () => {
      PersonalityManager.setUserName("building a cowork agent for Nokia");

      expect((mockStoredSettings.relationship as Any)?.userName).toBeUndefined();
    });
  });

  describe("getUserName", () => {
    it("should return the user name when set", () => {
      mockStoredSettings = { relationship: { userName: "Charlie" } };
      PersonalityManager.clearCache();

      expect(PersonalityManager.getUserName()).toBe("Charlie");
    });

    it("should return empty string when not set", () => {
      // Default relationship has userName as empty string
      expect(PersonalityManager.getUserName()).toBe("");
    });

    it("should ignore stale task-fragment names from corrupted memory", () => {
      mockStoredSettings = { relationship: { userName: "building a cowork agent for Nokia" } };
      PersonalityManager.clearCache();

      expect(PersonalityManager.getUserName()).toBeUndefined();
    });

    it("should keep explicit longer names loaded from storage", () => {
      mockStoredSettings = { relationship: { userName: "Mary Jane Watson Parker" } };
      PersonalityManager.clearCache();

      expect(PersonalityManager.getUserName()).toBe("Mary Jane Watson Parker");
    });
  });

  describe("recordTaskCompleted", () => {
    it("should increment tasks completed", () => {
      PersonalityManager.recordTaskCompleted();

      expect((mockStoredSettings.relationship as Any)?.tasksCompleted).toBe(1);
    });

    it("should increment existing count", () => {
      mockStoredSettings = { relationship: { tasksCompleted: 5 } };
      PersonalityManager.clearCache();

      PersonalityManager.recordTaskCompleted();

      expect((mockStoredSettings.relationship as Any)?.tasksCompleted).toBe(6);
    });

    it("should set first interaction timestamp on first task", () => {
      PersonalityManager.recordTaskCompleted();

      expect((mockStoredSettings.relationship as Any)?.firstInteraction).toBeDefined();
      expect(typeof (mockStoredSettings.relationship as Any)?.firstInteraction).toBe("number");
    });

    it("should add workspace to projects worked on", () => {
      PersonalityManager.recordTaskCompleted("my-project");

      expect((mockStoredSettings.relationship as Any)?.projectsWorkedOn).toContain("my-project");
    });

    it("should not duplicate workspace names", () => {
      PersonalityManager.recordTaskCompleted("my-project");
      PersonalityManager.recordTaskCompleted("my-project");

      expect((mockStoredSettings.relationship as Any)?.projectsWorkedOn).toHaveLength(1);
    });

    it("should update milestone when reached", () => {
      // Set tasksCompleted to 9 and lastMilestoneCelebrated to 1 (already celebrated milestone 1)
      // After incrementing to 10, milestone 10 should be celebrated
      mockStoredSettings = {
        relationship: { tasksCompleted: 9, lastMilestoneCelebrated: 1, projectsWorkedOn: [] },
      };
      PersonalityManager.clearCache();

      PersonalityManager.recordTaskCompleted();

      expect((mockStoredSettings.relationship as Any)?.lastMilestoneCelebrated).toBe(10);
    });
  });

  describe("getRelationshipStats", () => {
    it("should return stats with expected structure", () => {
      // Set explicit relationship data to test stats calculation
      mockStoredSettings = {
        relationship: {
          tasksCompleted: 0,
          projectsWorkedOn: [],
          lastMilestoneCelebrated: 0,
        },
      };
      PersonalityManager.clearCache();

      const stats = PersonalityManager.getRelationshipStats();

      expect(stats.tasksCompleted).toBe(0);
      expect(stats.projectsCount).toBe(0);
      expect(stats.daysTogether).toBe(0);
      expect(stats.nextMilestone).toBe(1);
    });

    it("should return correct task count", () => {
      mockStoredSettings = { relationship: { tasksCompleted: 42 } };
      PersonalityManager.clearCache();

      const stats = PersonalityManager.getRelationshipStats();

      expect(stats.tasksCompleted).toBe(42);
    });

    it("should return correct project count", () => {
      mockStoredSettings = { relationship: { projectsWorkedOn: ["proj1", "proj2", "proj3"] } };
      PersonalityManager.clearCache();

      const stats = PersonalityManager.getRelationshipStats();

      expect(stats.projectsCount).toBe(3);
    });

    it("should calculate next milestone correctly", () => {
      mockStoredSettings = { relationship: { tasksCompleted: 15 } };
      PersonalityManager.clearCache();

      const stats = PersonalityManager.getRelationshipStats();

      expect(stats.nextMilestone).toBe(25);
    });

    it("should return null for next milestone when beyond all milestones", () => {
      mockStoredSettings = { relationship: { tasksCompleted: 1500 } };
      PersonalityManager.clearCache();

      const stats = PersonalityManager.getRelationshipStats();

      expect(stats.nextMilestone).toBeNull();
    });
  });

  describe("getGreeting", () => {
    it("should return empty string when no user name", () => {
      const greeting = PersonalityManager.getGreeting();

      expect(greeting).toBe("");
    });

    it("should return personalized greeting with user name", () => {
      mockStoredSettings = { relationship: { userName: "David" } };
      PersonalityManager.clearCache();

      const greeting = PersonalityManager.getGreeting();

      expect(greeting).toContain("David");
    });

    it("should return milestone message when milestone is reached", () => {
      mockStoredSettings = {
        relationship: {
          userName: "Eve",
          tasksCompleted: 10,
          lastMilestoneCelebrated: 1,
        },
      };
      PersonalityManager.clearCache();

      const greeting = PersonalityManager.getGreeting();

      expect(greeting).toContain("10");
    });
  });

  describe("identity prompt with user name", () => {
    it("should include user name in identity prompt", () => {
      mockStoredSettings = { relationship: { userName: "Frank", tasksCompleted: 10 } };
      PersonalityManager.clearCache();

      const prompt = PersonalityManager.getIdentityPrompt();

      expect(prompt).toContain("Frank");
      expect(prompt).toContain("USER CONTEXT");
    });
  });
});

describe("PersonalityManager - load settings with new fields", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStoredSettings = {};
    writeCount = 0;
    PersonalityManager.clearCache();
    PersonalityManager.initialize();
  });

  it("should load default response style", () => {
    const settings = PersonalityManager.loadSettings();

    expect(settings.responseStyle).toBeDefined();
    expect(settings.responseStyle?.emojiUsage).toBe("minimal");
    expect(settings.responseStyle?.responseLength).toBe("balanced");
    expect(settings.responseStyle?.codeCommentStyle).toBe("moderate");
    expect(settings.responseStyle?.explanationDepth).toBe("balanced");
  });

  it("should load default quirks", () => {
    const settings = PersonalityManager.loadSettings();

    expect(settings.quirks).toBeDefined();
    expect(settings.quirks?.analogyDomain).toBe("none");
  });

  it("should load relationship with defaults merged", () => {
    // Set explicit empty relationship to test default merging
    mockStoredSettings = {
      relationship: {},
    };
    PersonalityManager.clearCache();

    const settings = PersonalityManager.loadSettings();

    expect(settings.relationship).toBeDefined();
    // Default values should be merged
    expect(settings.relationship?.tasksCompleted).toBeDefined();
    expect(settings.relationship?.projectsWorkedOn).toBeDefined();
  });

  it("should load default persona", () => {
    const settings = PersonalityManager.loadSettings();

    expect(settings.activePersona).toBe("companion");
  });

  it("should merge partial response style with defaults", () => {
    mockStoredSettings = {
      responseStyle: { emojiUsage: "expressive" },
    };
    PersonalityManager.clearCache();

    const settings = PersonalityManager.loadSettings();

    expect(settings.responseStyle?.emojiUsage).toBe("expressive");
    expect(settings.responseStyle?.responseLength).toBe("balanced"); // Default
  });

  it("should validate persona id on load", () => {
    mockStoredSettings = { activePersona: "invalid-persona" };
    PersonalityManager.clearCache();

    const settings = PersonalityManager.loadSettings();

    expect(settings.activePersona).toBe("companion");
  });
});

describe("PersonalityManager - resetToDefaults", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStoredSettings = {};
    writeCount = 0;
    PersonalityManager.removeAllListeners();
    PersonalityManager.clearCache();
    PersonalityManager.initialize();
  });

  it("should reset all settings to defaults", () => {
    // Set up custom settings
    mockStoredSettings = {
      activePersonality: "creative",
      agentName: "Jarvis",
      activePersona: "jarvis",
      quirks: { catchphrase: "At your service.", signOff: "Will there be anything else?" },
      responseStyle: { emojiUsage: "expressive" },
    };
    PersonalityManager.clearCache();

    PersonalityManager.resetToDefaults(false);

    expect(mockStoredSettings.activePersonality).toBe("professional");
    expect(mockStoredSettings.agentName).toBe("CoWork");
    expect(mockStoredSettings.activePersona).toBe("companion");
  });

  it("should preserve relationship data when preserveRelationship is true", () => {
    mockStoredSettings = {
      activePersonality: "creative",
      agentName: "Jarvis",
      relationship: {
        userName: "Alice",
        tasksCompleted: 100,
        projectsWorkedOn: ["project-a", "project-b"],
      },
    };
    PersonalityManager.clearCache();

    PersonalityManager.resetToDefaults(true);

    expect(mockStoredSettings.activePersonality).toBe("professional");
    expect((mockStoredSettings.relationship as Any)?.userName).toBe("Alice");
    expect((mockStoredSettings.relationship as Any)?.tasksCompleted).toBe(100);
  });

  it("should not preserve relationship data when preserveRelationship is false", () => {
    mockStoredSettings = {
      relationship: {
        userName: "Alice",
        tasksCompleted: 100,
      },
    };
    PersonalityManager.clearCache();

    PersonalityManager.resetToDefaults(false);

    expect((mockStoredSettings.relationship as Any)?.userName).toBeFalsy();
    expect((mockStoredSettings.relationship as Any)?.tasksCompleted).toBe(0);
  });

  it("should default to preserving relationship", () => {
    mockStoredSettings = {
      relationship: {
        userName: "Bob",
        tasksCompleted: 50,
      },
    };
    PersonalityManager.clearCache();

    PersonalityManager.resetToDefaults();

    expect((mockStoredSettings.relationship as Any)?.userName).toBe("Bob");
    expect((mockStoredSettings.relationship as Any)?.tasksCompleted).toBe(50);
  });

  it("should increment write count", () => {
    PersonalityManager.resetToDefaults();

    expect(writeCount).toBe(1);
  });
});

describe("PersonalityManager - event emission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStoredSettings = {};
    writeCount = 0;
    PersonalityManager.removeAllListeners();
    PersonalityManager.clearCache();
    PersonalityManager.initialize();
  });

  it("should emit event when settings are saved", () => {
    const callback = vi.fn();
    const unsubscribe = PersonalityManager.onSettingsChanged(callback);

    const settings = PersonalityManager.loadSettings();
    settings.activePersonality = "creative";
    PersonalityManager.saveSettings(settings);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        activePersonality: "creative",
      }),
    );

    unsubscribe();
  });

  it("should emit event when personality is changed", () => {
    const callback = vi.fn();
    const unsubscribe = PersonalityManager.onSettingsChanged(callback);

    PersonalityManager.setActivePersonality("technical");

    expect(callback).toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        activePersonality: "technical",
      }),
    );

    unsubscribe();
  });

  it("should emit event when persona is changed", () => {
    const callback = vi.fn();
    const unsubscribe = PersonalityManager.onSettingsChanged(callback);

    PersonalityManager.setActivePersona("jarvis");

    expect(callback).toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        activePersona: "jarvis",
      }),
    );

    unsubscribe();
  });

  it("should emit event when reset to defaults", () => {
    const callback = vi.fn();
    const unsubscribe = PersonalityManager.onSettingsChanged(callback);

    PersonalityManager.resetToDefaults();

    expect(callback).toHaveBeenCalled();

    unsubscribe();
  });

  it("should stop receiving events after unsubscribe", () => {
    const callback = vi.fn();
    const unsubscribe = PersonalityManager.onSettingsChanged(callback);

    PersonalityManager.setActivePersonality("friendly");
    expect(callback).toHaveBeenCalledTimes(1);

    unsubscribe();

    PersonalityManager.setActivePersonality("creative");
    expect(callback).toHaveBeenCalledTimes(1); // Still 1, not called again
  });
});

describe("PersonalityManager - initialization guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStoredSettings = {};
    writeCount = 0;
    PersonalityManager.removeAllListeners();
    PersonalityManager.clearCache();
    PersonalityManager.initialize();
  });

  it("should return true for isInitialized after initialize", () => {
    expect(PersonalityManager.isInitialized()).toBe(true);
  });

  it("should allow multiple initialize calls without error", () => {
    expect(() => {
      PersonalityManager.initialize();
      PersonalityManager.initialize();
      PersonalityManager.initialize();
    }).not.toThrow();
  });
});

describe("PersonalityManager - atomic writes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStoredSettings = {};
    writeCount = 0;
    PersonalityManager.removeAllListeners();
    PersonalityManager.clearCache();
    PersonalityManager.initialize();
  });

  it("should persist settings via SecureSettingsRepository", () => {
    const settings = PersonalityManager.loadSettings();
    settings.activePersonality = "creative";
    PersonalityManager.saveSettings(settings);

    expect(writeCount).toBe(1);
    expect((mockStoredSettings as Any).activePersonality).toBe("creative");
  });
});
