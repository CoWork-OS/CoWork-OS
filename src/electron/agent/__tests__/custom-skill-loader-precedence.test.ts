/**
 * Skill precedence: stale managed copies of bundled skills, and per-task workspace skills.
 * Uses real temporary folders so the loader's directory reads run unmocked.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CapabilitySecurityReport, CustomSkill } from "../../../shared/types";

const mocks = vi.hoisted(() => ({
  lineage: { version: 1, skills: {} as Record<string, string[]> },
  importReports: new Map<string, unknown>(),
}));

vi.mock("electron", () => ({
  app: { getPath: vi.fn().mockReturnValue(os.tmpdir()), isPackaged: false },
}));

vi.mock("../bundled-skill-lineage.json", () => ({ default: mocks.lineage }));

vi.mock("../../extensions/registry", () => ({
  PluginRegistry: { getInstance: () => ({ getPluginsByType: () => [] }) },
}));

vi.mock("../skill-registry", () => ({
  getSkillRegistry: () => ({
    listManagedSkills: () => [],
    verifyManagedSkillIntegrity: async () => null,
    getImportSecurityReport: ({ bundleId }: { bundleId: string }) =>
      mocks.importReports.get(bundleId) ?? null,
    inspectExternalSkill: async () => null,
  }),
}));

import { CustomSkillLoader } from "../custom-skill-loader";
import { computeSkillManifestDigest } from "../skill-lineage";
import { resolveSkillSlashAlias } from "../skill-slash-aliases";

function skill(id: string, overrides: Partial<CustomSkill> = {}): CustomSkill {
  return {
    id,
    name: `Skill ${id}`,
    description: `Description of ${id}`,
    icon: "🧪",
    category: "Testing",
    prompt: `Current bundled prompt for ${id}.`,
    parameters: [],
    enabled: true,
    ...overrides,
  };
}

function writeSkill(dir: string, manifest: object & { id: string }): string {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${manifest.id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(manifest, null, 2), "utf-8");
  return filePath;
}

describe("CustomSkillLoader precedence", () => {
  let root: string;
  let bundledDir: string;
  let managedDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-precedence-"));
    bundledDir = path.join(root, "bundled");
    managedDir = path.join(root, "managed");
    fs.mkdirSync(bundledDir, { recursive: true });
    fs.mkdirSync(managedDir, { recursive: true });
    for (const id of Object.keys(mocks.lineage.skills)) delete mocks.lineage.skills[id];
    mocks.importReports.clear();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function loadSkills(): Promise<CustomSkillLoader> {
    const loader = new CustomSkillLoader({
      bundledSkillsDir: bundledDir,
      managedSkillsDir: managedDir,
    });
    await loader.initialize();
    return loader;
  }

  describe("managed copies of bundled skills", () => {
    it("uses the bundled skill when the managed copy is an older shipped version", async () => {
      writeSkill(bundledDir, skill("security-audit"));
      // What an older app version wrote into the managed folder: the February manifest,
      // with the app-added filePath key and no metadata.
      const februaryManifest = {
        ...skill("security-audit", { prompt: "February prompt." }),
        filePath: path.join(managedDir, "security-audit.json"),
      };
      const copyPath = writeSkill(managedDir, februaryManifest);
      mocks.lineage.skills["security-audit"] = [computeSkillManifestDigest(februaryManifest)];

      const loader = await loadSkills();

      const active = loader.getSkill("security-audit");
      expect(active?.source).toBe("bundled");
      expect(active?.prompt).toBe("Current bundled prompt for security-audit.");
      expect(loader.getShadowedSkillCopies()).toEqual([
        {
          id: "security-audit",
          name: "Skill security-audit",
          filePath: copyPath,
          source: "managed",
          reason: "stale_bundled_copy",
          activeSource: "bundled",
        },
      ]);
      const status = await loader.getSkillStatus();
      expect(status.shadowedSkills?.map((entry) => entry.reason)).toEqual(["stale_bundled_copy"]);
      expect(status.skills.find((entry) => entry.id === "security-audit")?.source).toBe("bundled");
      // The copy file is left in place; nothing in the user's profile is rewritten.
      expect(fs.existsSync(copyPath)).toBe(true);
    });

    it("treats a managed copy identical to the current bundled skill as a snapshot", async () => {
      writeSkill(bundledDir, skill("code-review"));
      writeSkill(managedDir, { ...skill("code-review"), source: "managed" });

      const loader = await loadSkills();

      expect(loader.getSkill("code-review")?.source).toBe("bundled");
      expect(loader.getShadowedSkillCopies()[0]?.reason).toBe("stale_bundled_copy");
    });

    it("keeps the copy's off switch when it sets the copy aside", async () => {
      writeSkill(bundledDir, skill("code-review"));
      writeSkill(managedDir, { ...skill("code-review"), enabled: false });

      const loader = await loadSkills();

      const active = loader.getSkill("code-review");
      expect(active?.source).toBe("bundled");
      expect(active?.enabled).toBe(false);
    });

    it("keeps a user-edited managed copy overriding the bundled skill", async () => {
      writeSkill(bundledDir, skill("code-review"));
      writeSkill(managedDir, skill("code-review", { prompt: "My own review checklist." }));

      const loader = await loadSkills();

      const active = loader.getSkill("code-review");
      expect(active?.source).toBe("managed");
      expect(active?.prompt).toBe("My own review checklist.");
      expect(loader.getShadowedSkillCopies()).toEqual([
        expect.objectContaining({
          id: "code-review",
          source: "bundled",
          reason: "overridden_by_managed",
          activeSource: "managed",
        }),
      ]);
    });

    it("keeps a matching managed copy that has its own companion folder", async () => {
      writeSkill(bundledDir, skill("code-review"));
      writeSkill(managedDir, skill("code-review"));
      fs.mkdirSync(path.join(managedDir, "code-review", "scripts"), { recursive: true });

      const loader = await loadSkills();

      expect(loader.getSkill("code-review")?.source).toBe("managed");
    });

    it("keeps managed skills that have no bundled counterpart", async () => {
      writeSkill(bundledDir, skill("code-review"));
      writeSkill(managedDir, skill("my-installed-skill"));

      const loader = await loadSkills();

      expect(loader.getSkill("my-installed-skill")?.source).toBe("managed");
      expect(loader.getShadowedSkillCopies()).toEqual([]);
    });

    it("does not attach the set-aside copy's security report to the bundled skill", async () => {
      writeSkill(bundledDir, skill("code-review"));
      writeSkill(managedDir, skill("code-review"));
      mocks.importReports.set("code-review", {
        bundleKind: "skill",
        bundleId: "code-review",
        verdict: "warning",
        summary: "copy report",
      } as Partial<CapabilitySecurityReport>);

      const loader = await loadSkills();

      const entry = await loader.getSkillStatusEntry("code-review");
      expect(entry?.source).toBe("bundled");
      expect(entry?.securityReport).toBeUndefined();
    });
  });

  describe("workspace skills per task", () => {
    let workspaceA: string;
    let workspaceB: string;

    beforeEach(() => {
      workspaceA = path.join(root, "workspace-a");
      workspaceB = path.join(root, "workspace-b");
      fs.mkdirSync(workspaceA, { recursive: true });
      fs.mkdirSync(workspaceB, { recursive: true });
    });

    it("loads a workspace's skills only into that workspace's view", async () => {
      writeSkill(bundledDir, skill("code-review"));
      writeSkill(path.join(workspaceA, "skills"), skill("team-release-notes"));
      const loader = await loadSkills();

      const viewA = loader.forWorkspace(workspaceA);
      const viewB = loader.forWorkspace(workspaceB);

      expect(viewA.getSkill("team-release-notes")?.source).toBe("workspace");
      expect(viewA.listSkills().map((entry) => entry.id)).toContain("team-release-notes");
      expect(viewA.getWorkspaceSkillsDir()).toBe(path.join(workspaceA, "skills"));
      expect(viewB.getSkill("team-release-notes")).toBeUndefined();
      expect(loader.getSkill("team-release-notes")).toBeUndefined();
      expect(loader.getWorkspaceSkillsDir()).toBeNull();
      // Shared skills stay visible in every view.
      expect(viewB.getSkill("code-review")?.source).toBe("bundled");
    });

    it("lets a workspace skill override bundled and managed skills in its view", async () => {
      writeSkill(bundledDir, skill("code-review"));
      writeSkill(managedDir, skill("code-review", { prompt: "Managed checklist." }));
      writeSkill(
        path.join(workspaceA, "skills"),
        skill("code-review", { prompt: "Workspace checklist." }),
      );
      const loader = await loadSkills();

      expect(loader.forWorkspace(workspaceA).getSkill("code-review")?.prompt).toBe(
        "Workspace checklist.",
      );
      expect(loader.forWorkspace(workspaceB).getSkill("code-review")?.prompt).toBe(
        "Managed checklist.",
      );
    });

    it("applies workspace guideline skills only to tasks in that workspace", async () => {
      writeSkill(
        path.join(workspaceA, "skills"),
        skill("house-style", { type: "guideline", prompt: "Use British spelling." }),
      );
      const loader = await loadSkills();

      expect(loader.forWorkspace(workspaceA).getEnabledGuidelinesPrompt()).toContain(
        "British spelling",
      );
      expect(loader.forWorkspace(workspaceB).getEnabledGuidelinesPrompt()).not.toContain(
        "British spelling",
      );
    });

    it("picks up a workspace skill saved after the view was created", async () => {
      const loader = await loadSkills();
      const view = loader.forWorkspace(workspaceA);
      expect(view.getSkill("late-skill")).toBeUndefined();

      writeSkill(path.join(workspaceA, "skills"), skill("late-skill"));

      expect(view.getSkill("late-skill")?.source).toBe("workspace");
    });

    it("saves workspace skills through the view without switching the shared loader", async () => {
      const loader = await loadSkills();
      const view = loader.forWorkspace(workspaceA);

      const created = await view.createWorkspaceSkill(skill("approved-proposal"));

      expect(created.filePath).toBe(path.join(workspaceA, "skills", "approved-proposal.json"));
      expect(fs.existsSync(created.filePath!)).toBe(true);
      expect(view.getSkill("approved-proposal")?.source).toBe("workspace");
      expect(loader.getSkill("approved-proposal")).toBeUndefined();
      expect(loader.forWorkspace(workspaceB).getSkill("approved-proposal")).toBeUndefined();
    });

    it("sees shared reloads and plugin skills through an existing view", async () => {
      const loader = await loadSkills();
      const view = loader.forWorkspace(workspaceA);
      expect(view.getSkill("added-later")).toBeUndefined();

      writeSkill(managedDir, skill("added-later"));
      await loader.reloadSkills();
      loader.registerPluginSkill(skill("plugin-skill", { metadata: { pluginSource: "pack" } }));

      expect(view.getSkill("added-later")?.source).toBe("managed");
      expect(view.getSkill("plugin-skill")).toBeDefined();
    });

    it("resolves {baseDir} to the workspace skill's own folder", async () => {
      const skillsDir = path.join(workspaceA, "skills");
      writeSkill(
        skillsDir,
        skill("deploy-check", { prompt: "Read {baseDir}/SKILL.md, then run the checks." }),
      );
      fs.mkdirSync(path.join(skillsDir, "deploy-check"), { recursive: true });
      fs.writeFileSync(path.join(skillsDir, "deploy-check", "SKILL.md"), "# Deploy check\n");
      const loader = await loadSkills();
      const view = loader.forWorkspace(workspaceA);

      const workspaceSkill = view.getSkill("deploy-check")!;
      expect(view.expandPrompt(workspaceSkill, {})).toBe(
        `Read ${path.join(skillsDir, "deploy-check")}/SKILL.md, then run the checks.`,
      );
    });

    it("reuses one view per workspace folder", async () => {
      const loader = await loadSkills();

      expect(loader.forWorkspace(workspaceA)).toBe(loader.forWorkspace(`${workspaceA}/`));
      expect(loader.forWorkspace(workspaceA)).not.toBe(loader.forWorkspace(workspaceB));
      expect(() => loader.forWorkspace(workspaceA).setWorkspaceSkillsDir(workspaceB)).toThrow();
    });

    it("resolves slash commands to the workspace's own skills", async () => {
      writeSkill(path.join(workspaceA, "skills"), skill("ship-notes"));
      const loader = await loadSkills();

      expect(resolveSkillSlashAlias("ship-notes", loader.forWorkspace(workspaceA))).toBe(
        "ship-notes",
      );
      expect(resolveSkillSlashAlias("ship-notes", loader.forWorkspace(workspaceB))).toBeNull();
    });

    it("returns the shared loader when no workspace path is given", async () => {
      const loader = await loadSkills();

      expect(loader.forWorkspace(undefined)).toBe(loader);
      expect(loader.forWorkspace("")).toBe(loader);
      expect(loader.forWorkspace(workspaceA).forWorkspace(null)).toBe(loader);
    });
  });
});
