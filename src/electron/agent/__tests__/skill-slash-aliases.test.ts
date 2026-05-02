import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSkill: vi.fn(),
  getPluginsByType: vi.fn(),
  isPackAllowed: vi.fn(),
}));

vi.mock("../custom-skill-loader", () => ({
  getCustomSkillLoader: () => ({
    getSkill: mocks.getSkill,
  }),
}));

vi.mock("../../extensions/registry", () => ({
  PluginRegistry: {
    getInstance: () => ({
      getPluginsByType: mocks.getPluginsByType,
    }),
  },
}));

vi.mock("../../admin/policies", () => ({
  isPackAllowed: mocks.isPackAllowed,
}));

import { resolveSkillSlashAlias } from "../skill-slash-aliases";

describe("resolveSkillSlashAlias", () => {
  beforeEach(() => {
    mocks.getSkill.mockReset();
    mocks.getPluginsByType.mockReset();
    mocks.isPackAllowed.mockReset();
    mocks.isPackAllowed.mockReturnValue(true);
    mocks.getPluginsByType.mockReturnValue([]);
  });

  it("prefers plugin aliases over direct skill ids when tokens collide", () => {
    mocks.getSkill.mockImplementation((id: string) =>
      id === "review" || id === "strategy" ? { id, enabled: true } : undefined,
    );
    mocks.getPluginsByType.mockReturnValue([
      {
        state: "registered",
        manifest: {
          name: "shortcuts",
          slashCommands: [{ name: "review", skillId: "strategy" }],
          skills: [{ id: "strategy", enabled: true }],
        },
      },
    ]);

    expect(resolveSkillSlashAlias("/review")).toBe("strategy");
  });

  it("falls back to a direct skill when a colliding alias target is unavailable", () => {
    mocks.getSkill.mockImplementation((id: string) =>
      id === "review" ? { id, enabled: true } : undefined,
    );
    mocks.getPluginsByType.mockReturnValue([
      {
        state: "registered",
        manifest: {
          name: "shortcuts",
          slashCommands: [{ name: "review", skillId: "missing" }],
          skills: [{ id: "missing", enabled: true }],
        },
      },
    ]);

    expect(resolveSkillSlashAlias("review")).toBe("review");
  });

  it("ignores invalid slash command tokens", () => {
    mocks.getSkill.mockReturnValue({ id: "bad token", enabled: true });

    expect(resolveSkillSlashAlias("bad token")).toBeNull();
  });
});
