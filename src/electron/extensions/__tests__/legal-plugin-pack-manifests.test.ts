import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue("/mock/user/data"),
  },
}));

import { validateManifest } from "../loader";

const ROOT = path.resolve(process.cwd(), "resources", "plugin-packs");

function readPack(name: string) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, name, "cowork.plugin.json"), "utf8"));
}

describe("Claude for Legal plugin packs", () => {
  it("validates representative generated Legal pack manifests", () => {
    for (const packName of ["commercial-legal", "privacy-legal", "cocounsel-legal"]) {
      const manifest = readPack(packName);

      expect(validateManifest(manifest)).toBe(true);
      expect(manifest.category).toBe("Legal");
      expect(manifest.license).toBe("Apache-2.0");
      expect(manifest.homepage).toContain("anthropics/claude-for-legal");
      expect(
        manifest.skills.some((skill: { id: string }) => skill.id.endsWith("legal-guardrails")),
      ).toBe(true);
      expect(
        manifest.slashCommands.every((command: { name: string }) => !command.name.includes(":")),
      ).toBe(true);
    }
  });

  it("preserves a converted slash command and upstream metadata", () => {
    const manifest = readPack("commercial-legal");
    const reviewCommand = manifest.slashCommands.find(
      (command: { name: string }) => command.name === "commercial-legal-review",
    );
    const reviewSkill = manifest.skills.find(
      (skill: { id: string }) => skill.id === "commercial-legal-review",
    );

    expect(reviewCommand).toEqual({
      name: "commercial-legal-review",
      description: reviewSkill.description,
      skillId: "commercial-legal-review",
    });
    expect(reviewSkill.metadata.upstream.ref).toBe("993f6619fc2f321cfdd65daa6919ad6cd2c56d92");
    expect(reviewSkill.metadata.upstream.sourcePath).toBe(
      "commercial-legal/skills/review/SKILL.md",
    );
  });
});
