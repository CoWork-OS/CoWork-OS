import { describe, expect, it } from "vitest";
import type { CustomSkill } from "../../../shared/types";
import { buildMessageSlashOptions, resolveSlashSelectedIndex } from "../message-slash-options";

function skill(overrides: Partial<CustomSkill>): CustomSkill {
  return {
    id: "base",
    name: "Base",
    description: "Base skill",
    icon: "B",
    prompt: "Do the thing",
    enabled: true,
    ...overrides,
  } as CustomSkill;
}

describe("buildMessageSlashOptions", () => {
  it("orders app commands before onboarding, plugin aliases, and direct skills", () => {
    const options = buildMessageSlashOptions({
      query: "",
      includeOnboarding: true,
      customSkills: [
        skill({ id: "strategy", name: "Strategy", icon: "S" }),
        skill({ id: "direct-skill", name: "Direct Skill", icon: "D" }),
      ],
      pluginSlashCommands: [
        { name: "plan-doc", description: "Plan a doc", skillId: "strategy" },
      ],
      limit: 20,
    });

    expect(options.slice(0, 3).map((option) => option.commandName)).toEqual([
      "schedule",
      "clear",
      "plan",
    ]);
    expect(options.findIndex((option) => option.commandName === "onboard")).toBeGreaterThan(0);
    expect(options.findIndex((option) => option.commandName === "plan-doc")).toBeGreaterThan(
      options.findIndex((option) => option.commandName === "onboard"),
    );
    expect(options.at(-1)?.commandName).toBe("direct-skill");
  });

  it("filters across app commands, plugin aliases, skill names, and descriptions", () => {
    const options = buildMessageSlashOptions({
      query: "rename",
      includeOnboarding: false,
      customSkills: [
        skill({ id: "batch-rename", name: "Batch Rename", description: "Rename files" }),
        skill({ id: "unrelated", name: "Unrelated", description: "Other task" }),
      ],
      pluginSlashCommands: [
        { name: "smart-files", description: "Rename and organize files", skillId: "batch-rename" },
      ],
      limit: 20,
    });

    expect(options.map((option) => option.commandName)).toEqual([
      "smart-files",
      "batch-rename",
    ]);
  });

  it("hides a direct skill when a plugin alias owns the same visible token", () => {
    const options = buildMessageSlashOptions({
      query: "alias review",
      includeOnboarding: false,
      customSkills: [
        skill({ id: "review", name: "Review", description: "Direct review" }),
        skill({ id: "strategy", name: "Strategy", description: "Alias target" }),
      ],
      pluginSlashCommands: [
        { name: "review", description: "Alias review", skillId: "strategy" },
      ],
      limit: 20,
    });

    expect(options.map((option) => option.id)).toEqual(["alias-review"]);
    expect(options[0]).toMatchObject({
      kind: "skill",
      commandName: "review",
      name: "review",
      description: "Alias review",
    });
  });

  it("marks required and optional skill parameter behavior separately", () => {
    const [required, optional, none] = buildMessageSlashOptions({
      query: "",
      includeOnboarding: false,
      customSkills: [
        skill({
          id: "required-skill",
          parameters: [{ name: "topic", type: "string", description: "Topic", required: true }],
        }),
        skill({
          id: "optional-skill",
          parameters: [{ name: "input", type: "string", description: "Input", required: false }],
        }),
        skill({ id: "plain-skill", parameters: [] }),
      ],
      pluginSlashCommands: [],
      limit: 20,
    }).filter((option) => option.kind === "skill");

    expect(required).toMatchObject({ commandName: "required-skill", hasRequiredParams: true });
    expect(optional).toMatchObject({
      commandName: "optional-skill",
      hasRequiredParams: false,
      hasOptionalParams: true,
    });
    expect(none).toMatchObject({
      commandName: "plain-skill",
      hasRequiredParams: false,
      hasOptionalParams: false,
    });
  });

  it("omits invalid alias tokens from the picker", () => {
    const options = buildMessageSlashOptions({
      query: "",
      includeOnboarding: false,
      customSkills: [skill({ id: "target", name: "Target" })],
      pluginSlashCommands: [
        { name: "bad token", description: "Invalid", skillId: "target" },
        { name: "good-token", description: "Valid", skillId: "target" },
      ],
      limit: 20,
    });

    expect(options.some((option) => option.commandName === "bad token")).toBe(false);
    expect(options.some((option) => option.commandName === "good-token")).toBe(true);
  });

  it("clamps keyboard selection to the available slash options", () => {
    expect(resolveSlashSelectedIndex(0, 4)).toBe(0);
    expect(resolveSlashSelectedIndex(3, -1)).toBe(0);
    expect(resolveSlashSelectedIndex(3, 1)).toBe(1);
    expect(resolveSlashSelectedIndex(3, 9)).toBe(2);
  });
});
