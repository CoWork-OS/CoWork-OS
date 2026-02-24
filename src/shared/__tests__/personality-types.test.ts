/**
 * Tests for personality types and helper functions
 */

import { describe, it, expect } from "vitest";
import {
  PersonalityId,
  PersonalityDefinition,
  PERSONALITY_DEFINITIONS,
  getPersonalityById,
} from "../types";

describe("PERSONALITY_DEFINITIONS", () => {
  it("should have exactly 7 personalities defined", () => {
    expect(PERSONALITY_DEFINITIONS).toHaveLength(7);
  });

  it("should include all expected personality ids", () => {
    const ids = PERSONALITY_DEFINITIONS.map((p) => p.id);

    expect(ids).toContain("professional");
    expect(ids).toContain("friendly");
    expect(ids).toContain("concise");
    expect(ids).toContain("creative");
    expect(ids).toContain("technical");
    expect(ids).toContain("casual");
    expect(ids).toContain("custom");
  });

  it("each personality should have required fields", () => {
    PERSONALITY_DEFINITIONS.forEach((personality) => {
      expect(personality.id).toBeDefined();
      expect(personality.name).toBeDefined();
      expect(personality.description).toBeDefined();
      expect(personality.icon).toBeDefined();
      expect(personality.traits).toBeDefined();
      expect(personality.promptTemplate).toBeDefined();
    });
  });

  it("built-in personalities should have non-empty prompt templates", () => {
    const builtIn = PERSONALITY_DEFINITIONS.filter((p) => p.id !== "custom");

    builtIn.forEach((personality) => {
      expect(personality.promptTemplate.length).toBeGreaterThan(0);
      expect(personality.promptTemplate).toContain("PERSONALITY & COMMUNICATION STYLE");
    });
  });

  it("custom personality should have empty prompt template", () => {
    const custom = PERSONALITY_DEFINITIONS.find((p) => p.id === "custom");

    expect(custom?.promptTemplate).toBe("");
  });

  it("each personality should have a unique id", () => {
    const ids = PERSONALITY_DEFINITIONS.map((p) => p.id);
    const uniqueIds = new Set(ids);

    expect(uniqueIds.size).toBe(ids.length);
  });

  it("each personality should have a unique name", () => {
    const names = PERSONALITY_DEFINITIONS.map((p) => p.name);
    const uniqueNames = new Set(names);

    expect(uniqueNames.size).toBe(names.length);
  });

  it("each personality should have a non-empty description", () => {
    PERSONALITY_DEFINITIONS.forEach((personality) => {
      expect(personality.description.length).toBeGreaterThan(10);
    });
  });

  it("each personality should have an icon identifier", () => {
    PERSONALITY_DEFINITIONS.forEach((personality) => {
      expect(personality.icon.length).toBeGreaterThanOrEqual(1);
    });
  });
});

describe("personality traits", () => {
  it("professional personality should have formal traits", () => {
    const professional = PERSONALITY_DEFINITIONS.find((p) => p.id === "professional");

    expect(professional?.traits).toContain("formal");
    expect(professional?.traits).toContain("precise");
  });

  it("friendly personality should have warm traits", () => {
    const friendly = PERSONALITY_DEFINITIONS.find((p) => p.id === "friendly");

    expect(friendly?.traits).toContain("warm");
    expect(friendly?.traits).toContain("supportive");
  });

  it("concise personality should have brief traits", () => {
    const concise = PERSONALITY_DEFINITIONS.find((p) => p.id === "concise");

    expect(concise?.traits).toContain("brief");
    expect(concise?.traits).toContain("direct");
  });

  it("creative personality should have imaginative traits", () => {
    const creative = PERSONALITY_DEFINITIONS.find((p) => p.id === "creative");

    expect(creative?.traits).toContain("imaginative");
    expect(creative?.traits).toContain("innovative");
  });

  it("technical personality should have detailed traits", () => {
    const technical = PERSONALITY_DEFINITIONS.find((p) => p.id === "technical");

    expect(technical?.traits).toContain("detailed");
    expect(technical?.traits).toContain("precise");
  });

  it("casual personality should have relaxed traits", () => {
    const casual = PERSONALITY_DEFINITIONS.find((p) => p.id === "casual");

    expect(casual?.traits).toContain("relaxed");
    expect(casual?.traits).toContain("informal");
  });

  it("custom personality should have no traits", () => {
    const custom = PERSONALITY_DEFINITIONS.find((p) => p.id === "custom");

    expect(custom?.traits).toEqual([]);
  });
});

describe("getPersonalityById", () => {
  it("should return the correct personality for valid id", () => {
    const professional = getPersonalityById("professional");

    expect(professional).toBeDefined();
    expect(professional?.id).toBe("professional");
    expect(professional?.name).toBe("Professional");
  });

  it("should return undefined for invalid id", () => {
    // @ts-expect-error - testing invalid value
    const invalid = getPersonalityById("invalid-id");

    expect(invalid).toBeUndefined();
  });

  it("should return correct personality for each valid id", () => {
    const validIds: PersonalityId[] = [
      "professional",
      "friendly",
      "concise",
      "creative",
      "technical",
      "casual",
      "custom",
    ];

    validIds.forEach((id) => {
      const personality = getPersonalityById(id);

      expect(personality).toBeDefined();
      expect(personality?.id).toBe(id);
    });
  });

  it("should return a personality with all required properties", () => {
    const personality = getPersonalityById("friendly");

    expect(personality).toHaveProperty("id");
    expect(personality).toHaveProperty("name");
    expect(personality).toHaveProperty("description");
    expect(personality).toHaveProperty("icon");
    expect(personality).toHaveProperty("traits");
    expect(personality).toHaveProperty("promptTemplate");
  });
});

describe("PersonalityId type", () => {
  it("should accept valid personality ids", () => {
    const ids: PersonalityId[] = [
      "professional",
      "friendly",
      "concise",
      "creative",
      "technical",
      "casual",
      "custom",
    ];

    // This test mainly ensures TypeScript compilation passes
    expect(ids).toHaveLength(7);
  });
});

describe("PersonalityDefinition interface", () => {
  it("should be compatible with PERSONALITY_DEFINITIONS items", () => {
    PERSONALITY_DEFINITIONS.forEach((def: PersonalityDefinition) => {
      expect(typeof def.id).toBe("string");
      expect(typeof def.name).toBe("string");
      expect(typeof def.description).toBe("string");
      expect(typeof def.icon).toBe("string");
      expect(Array.isArray(def.traits)).toBe(true);
      expect(typeof def.promptTemplate).toBe("string");
    });
  });
});

describe("prompt template content quality", () => {
  it("professional prompt should mention business context", () => {
    const professional = getPersonalityById("professional");

    expect(professional?.promptTemplate).toContain("business");
  });

  it("friendly prompt should mention encouragement", () => {
    const friendly = getPersonalityById("friendly");

    expect(friendly?.promptTemplate).toContain("encourag");
  });

  it("concise prompt should mention avoiding verbosity", () => {
    const concise = getPersonalityById("concise");

    expect(concise?.promptTemplate).toContain("Avoid");
  });

  it("creative prompt should mention innovation", () => {
    const creative = getPersonalityById("creative");

    expect(creative?.promptTemplate).toContain("innovat");
  });

  it("technical prompt should mention best practices", () => {
    const technical = getPersonalityById("technical");

    expect(technical?.promptTemplate).toContain("best practices");
  });

  it("casual prompt should mention informal language", () => {
    const casual = getPersonalityById("casual");

    expect(casual?.promptTemplate).toContain("informal");
  });

  it("all built-in prompts should be multi-line instructions", () => {
    const builtIn = PERSONALITY_DEFINITIONS.filter((p) => p.id !== "custom");

    builtIn.forEach((personality) => {
      const lineCount = personality.promptTemplate.split("\n").length;
      expect(lineCount).toBeGreaterThan(3);
    });
  });
});
