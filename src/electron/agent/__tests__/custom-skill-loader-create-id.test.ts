/**
 * Creating a skill from Settings: the form sends no id, so the loader names the file.
 * Uses real temporary folders so the loader's directory reads run unmocked.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomSkill } from "../../../shared/types";

vi.mock("electron", () => ({
  app: { getPath: vi.fn().mockReturnValue(os.tmpdir()), isPackaged: false },
}));

vi.mock("../../extensions/registry", () => ({
  PluginRegistry: { getInstance: () => ({ getPluginsByType: () => [] }) },
}));

vi.mock("../skill-registry", () => ({
  getSkillRegistry: () => ({
    listManagedSkills: () => [],
    verifyManagedSkillIntegrity: async () => null,
    getImportSecurityReport: () => null,
    inspectExternalSkill: async () => null,
  }),
}));

import { CustomSkillLoader, skillIdFromName } from "../custom-skill-loader";

const formSkill = (name: string, id = ""): Omit<CustomSkill, "filePath" | "source"> => ({
  id,
  name,
  description: `${name} description`,
  icon: "⚡",
  category: "Writing",
  prompt: "Write release notes for {{version}}.",
  parameters: [],
  enabled: true,
});

describe("CustomSkillLoader.createSkill ids", () => {
  let root: string;
  let managedDir: string;
  let loader: CustomSkillLoader;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-create-id-"));
    const bundledDir = path.join(root, "bundled");
    managedDir = path.join(root, "managed");
    fs.mkdirSync(bundledDir, { recursive: true });
    fs.mkdirSync(managedDir, { recursive: true });
    loader = new CustomSkillLoader({ bundledSkillsDir: bundledDir, managedSkillsDir: managedDir });
    await loader.initialize();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("names a skill without an id after its name, and loads it", async () => {
    const created = await loader.createSkill(formSkill("Release notes"));

    expect(created.id).toBe("release-notes");
    expect(created.filePath).toBe(path.join(managedDir, "release-notes.json"));
    expect(fs.existsSync(path.join(managedDir, ".json"))).toBe(false);
    expect(loader.getSkill("release-notes")?.name).toBe("Release notes");
  });

  it("gives a second skill with the same name its own file", async () => {
    await loader.createSkill(formSkill("Release notes"));
    const second = await loader.createSkill(formSkill("Release notes"));

    expect(second.id).toBe("release-notes-2");
    expect(loader.getSkill("release-notes")).toBeDefined();
    expect(loader.getSkill("release-notes-2")).toBeDefined();
  });

  it("refuses an id that is not a plain file name", async () => {
    await expect(loader.createSkill(formSkill("Escape", "../../escape"))).rejects.toThrow(
      /letters, numbers/,
    );
    expect(fs.existsSync(path.join(root, "escape.json"))).toBe(false);
  });

  it("keeps a valid id it is given", async () => {
    const created = await loader.createSkill(formSkill("Anything", "my-skill_v2"));
    expect(created.id).toBe("my-skill_v2");
  });
});

describe("skillIdFromName", () => {
  it("makes a lowercase dashed id and falls back for names without letters or digits", () => {
    expect(skillIdFromName("  Release Notes (v2)! ")).toBe("release-notes-v2");
    expect(skillIdFromName("Café résumé")).toBe("cafe-resume");
    expect(skillIdFromName("⚡⚡")).toBe("skill");
  });
});
