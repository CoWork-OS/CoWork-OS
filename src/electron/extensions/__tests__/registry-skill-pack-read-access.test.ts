/**
 * The PluginRegistry is the only source of skill-pack read grants: it registers a pack root
 * when it loads directory-backed skills from it and revokes it when the pack is disabled.
 * Quarantined, disabled and inline-only packs never qualify.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CapabilitySecurityReport, CustomSkill } from "../../../shared/types";
import type { LoadedPlugin, PluginManifest } from "../types";

const mocks = vi.hoisted(() => ({
  discoverPlugins: vi.fn(),
  loadPlugin: vi.fn(),
  registerPluginSkill: vi.fn(),
  unregisterPluginSkills: vi.fn(),
  securePayload: undefined as { packs?: Record<string, boolean> } | undefined,
  userDataDir: "",
}));

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => mocks.userDataDir) },
}));

vi.mock("../loader", () => ({
  discoverPlugins: mocks.discoverPlugins,
  loadPlugin: mocks.loadPlugin,
  getPluginDataPath: (pluginName: string) => `/tmp/cowork-registry-test/${pluginName}`,
  isPluginCompatible: () => true,
}));

vi.mock("../../admin/policies", () => ({
  isPackAllowed: () => true,
  isPackRequired: () => false,
  loadPoliciesStrict: () => ({ packs: { allowed: [], blocked: [], required: [] } }),
}));

vi.mock("../../agent/custom-skill-loader", () => ({
  getCustomSkillLoader: () => ({
    registerPluginSkill: mocks.registerPluginSkill,
    unregisterPluginSkills: mocks.unregisterPluginSkills,
    setPluginSkillEnabled: vi.fn(),
  }),
}));

vi.mock("../../database/SecureSettingsRepository", () => ({
  SecureSettingsRepository: {
    isInitialized: () => mocks.securePayload !== undefined,
    getInstance: () => ({
      load: () => mocks.securePayload,
      save: () => true,
    }),
  },
}));

vi.mock("../../utils/user-data-dir", () => ({
  getUserDataDir: () => mocks.userDataDir,
}));

vi.mock("../pack-state-storage", () => ({
  writePackStateFile: vi.fn(),
}));

const cleanup: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}

function makeManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    name: "unity",
    displayName: "Unity",
    version: "1.0.0",
    description: "Unity agent skills",
    type: "pack",
    skillDirectories: [{ id: "unity:implement-in-app-purchases", path: "skills/iap" }],
    ...overrides,
  } as PluginManifest;
}

async function loadModules() {
  vi.resetModules();
  const { PluginRegistry } = await import("../registry");
  const access = await import("../../security/skill-pack-read-access");
  return { registry: PluginRegistry.getInstance(), access };
}

function registeredSkill(): CustomSkill {
  const call = mocks.registerPluginSkill.mock.calls.find(
    ([skill]) => (skill as CustomSkill).id === "unity:implement-in-app-purchases",
  );
  expect(call).toBeDefined();
  return call![0] as CustomSkill;
}

describe("PluginRegistry skill pack read grants", () => {
  let packRoot: string;
  let skillFile: string;

  function discover(manifest: PluginManifest, securityReport?: CapabilitySecurityReport): void {
    mocks.discoverPlugins.mockResolvedValue([{ path: packRoot, manifest, securityReport }]);
    mocks.loadPlugin.mockResolvedValue({
      success: true,
      plugin: {
        manifest,
        instance: { register: vi.fn(), unregister: vi.fn() },
        path: packRoot,
        state: "loaded",
        loadedAt: new Date(),
      } as LoadedPlugin,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.securePayload = undefined;
    mocks.userDataDir = tempDir("cowork-registry-grant-data-");
    packRoot = path.join(tempDir("cowork-registry-grant-ext-"), "unity");
    skillFile = path.join(packRoot, "skills", "iap", "SKILL.md");
    fs.mkdirSync(path.join(path.dirname(skillFile), "references"), { recursive: true });
    fs.writeFileSync(skillFile, "---\nname: iap\n---\nRead references/pre-check.md first.\n");
    fs.writeFileSync(path.join(path.dirname(skillFile), "references", "pre-check.md"), "# Pre\n");
    discover(makeManifest());
  });

  afterEach(() => {
    while (cleanup.length > 0) {
      const target = cleanup.pop();
      if (target) fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it("registers the pack root for the directory-backed skills it loaded", async () => {
    const { registry, access } = await loadModules();
    await registry.initialize();

    expect(access.getRegisteredSkillPackRoot("unity")).toBe(path.resolve(packRoot));
    const skill = registeredSkill();
    expect(skill.prompt).toContain("read-only");
    const grant = access.resolveSkillPackReadGrant(skill);
    expect(grant).toEqual({ pluginName: "unity", canonicalRoot: fs.realpathSync.native(packRoot) });
  });

  it("revokes the grant when the pack is disabled", async () => {
    const { registry, access } = await loadModules();
    await registry.initialize();
    const skill = registeredSkill();
    const grant = access.resolveSkillPackReadGrant(skill);
    expect(grant).not.toBeNull();

    await registry.disablePlugin("unity");

    expect(access.getRegisteredSkillPackRoot("unity")).toBeNull();
    expect(access.resolveSkillPackReadGrant(skill)).toBeNull();
    // A scope opened with the old grant reads nothing any more.
    expect(
      access.runWithSkillPackReadAccess([grant], () => access.getSkillPackReadRoots()),
    ).toEqual([]);
  });

  it("withholds the grant from a quarantined pack", async () => {
    discover(makeManifest(), {
      verdict: "quarantined",
      findings: [],
    } as unknown as CapabilitySecurityReport);
    const { registry, access } = await loadModules();
    await registry.initialize();

    expect(access.getRegisteredSkillPackRoot("unity")).toBeNull();
    expect(access.resolveSkillPackReadGrant(registeredSkill())).toBeNull();
  });

  it("registers nothing for a user-disabled pack", async () => {
    mocks.securePayload = { packs: { unity: false } };
    const { registry, access } = await loadModules();
    await registry.initialize();

    expect(registry.getPlugin("unity")?.state).toBe("disabled");
    expect(access.getRegisteredSkillPackRoot("unity")).toBeNull();
  });

  it("registers nothing for a pack with only inline skills", async () => {
    discover(
      makeManifest({
        skillDirectories: undefined,
        skills: [
          {
            id: "unity:inline",
            name: "Inline",
            description: "Inline",
            icon: "🧩",
            prompt: "Inline",
            enabled: true,
          },
        ],
      }),
    );
    const { registry, access } = await loadModules();
    await registry.initialize();

    expect(access.getRegisteredSkillPackRoot("unity")).toBeNull();
  });
});
