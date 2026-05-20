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

  it("resolves flat Claude for Legal pack aliases", () => {
    mocks.getSkill.mockImplementation((id: string) =>
      id === "commercial-legal-review" ? { id, enabled: true } : undefined,
    );
    mocks.getPluginsByType.mockReturnValue([
      {
        state: "registered",
        manifest: {
          name: "commercial-legal-pack",
          slashCommands: [
            {
              name: "commercial-legal-review",
              skillId: "commercial-legal-review",
            },
          ],
          skills: [{ id: "commercial-legal-review", enabled: true }],
        },
      },
    ]);

    expect(resolveSkillSlashAlias("/commercial-legal-review")).toBe("commercial-legal-review");
  });

  it("falls back to a direct skill when a colliding alias target is unavailable", () => {
    mocks.getSkill.mockImplementation((id: string) =>
      id === "fallback" ? { id, enabled: true } : undefined,
    );
    mocks.getPluginsByType.mockReturnValue([
      {
        state: "registered",
        manifest: {
          name: "shortcuts",
          slashCommands: [{ name: "fallback", skillId: "missing" }],
          skills: [{ id: "missing", enabled: true }],
        },
      },
    ]);

    expect(resolveSkillSlashAlias("fallback")).toBe("fallback");
  });

  it("does not fall back /review to the bundled code-reviewer skill", () => {
    mocks.getSkill.mockImplementation((id: string) =>
      id === "code-reviewer" ? { id, enabled: true } : undefined,
    );

    expect(resolveSkillSlashAlias("/review")).toBeNull();
  });

  it("does not fall back /review to a generic direct review skill", () => {
    mocks.getSkill.mockImplementation((id: string) =>
      id === "review" ? { id, enabled: true } : undefined,
    );

    expect(resolveSkillSlashAlias("/review")).toBeNull();
  });

  it("ignores aliases from disabled packs", () => {
    mocks.getSkill.mockImplementation((id: string) =>
      id === "plan-payroll" ? { id, enabled: true } : undefined,
    );
    mocks.getPluginsByType.mockReturnValue([
      {
        state: "disabled",
        manifest: {
          name: "smb-complete",
          slashCommands: [{ name: "plan-payroll", skillId: "smb-plan-payroll" }],
          skills: [{ id: "smb-plan-payroll", enabled: true }],
        },
      },
    ]);

    expect(resolveSkillSlashAlias("/plan-payroll")).toBe("plan-payroll");
  });

  it("ignores invalid slash command tokens", () => {
    mocks.getSkill.mockReturnValue({ id: "bad token", enabled: true });

    expect(resolveSkillSlashAlias("bad token")).toBeNull();
  });
});
