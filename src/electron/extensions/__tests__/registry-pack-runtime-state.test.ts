import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CustomSkill } from "../../../shared/types";
import type { LoadedPlugin, PluginManifest } from "../types";

const mocks = vi.hoisted(() => ({
  discoverPlugins: vi.fn(),
  loadPlugin: vi.fn(),
  isPackAllowed: vi.fn(),
  isPackRequired: vi.fn(),
  register: vi.fn(),
  unregister: vi.fn(),
  unregisterPluginSkills: vi.fn(),
  setPluginSkillEnabled: vi.fn(),
  secureInitialized: false,
  secureRefusesWrites: false,
  strictPolicies: undefined as any,
  securePayload: undefined as
    | { packs?: Record<string, boolean>; skills?: Record<string, Record<string, boolean>> }
    | undefined,
  userDataDir: "",
  writePackStateFile: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => mocks.userDataDir),
  },
}));

vi.mock("../loader", () => ({
  discoverPlugins: mocks.discoverPlugins,
  loadPlugin: mocks.loadPlugin,
  getPluginDataPath: (pluginName: string) => `/tmp/cowork-registry-test/${pluginName}`,
  isPluginCompatible: () => true,
}));

vi.mock("../../admin/policies", () => ({
  isPackAllowed: mocks.isPackAllowed,
  isPackRequired: mocks.isPackRequired,
  loadPoliciesStrict: () => mocks.strictPolicies,
}));

vi.mock("../../agent/custom-skill-loader", () => ({
  getCustomSkillLoader: () => ({
    registerPluginSkill: vi.fn(),
    unregisterPluginSkills: mocks.unregisterPluginSkills,
    setPluginSkillEnabled: mocks.setPluginSkillEnabled,
  }),
}));

vi.mock("../../database/SecureSettingsRepository", () => ({
  SecureSettingsRepository: {
    isInitialized: () => mocks.secureInitialized,
    getInstance: () => ({
      load: () => mocks.securePayload,
      save: (_category: string, payload: object) => {
        if (mocks.secureRefusesWrites) return false;
        mocks.securePayload = payload as typeof mocks.securePayload;
        return true;
      },
    }),
  },
}));

vi.mock("../../utils/user-data-dir", () => ({
  getUserDataDir: () => mocks.userDataDir,
}));

vi.mock("../pack-state-storage", () => ({
  writePackStateFile: mocks.writePackStateFile,
}));

function makeSkill(overrides: Partial<CustomSkill> = {}): CustomSkill {
  return {
    id: "smb-plan-payroll",
    name: "Plan Payroll",
    description: "Plan payroll",
    icon: "$",
    prompt: "Plan payroll",
    enabled: true,
    ...overrides,
  };
}

function makeManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    name: "smb-complete",
    displayName: "SMB Complete",
    version: "0.1.0",
    description: "Small business workflows",
    type: "pack",
    skills: [makeSkill()],
    ...overrides,
  };
}

function makeLoadedPlugin(manifest = makeManifest()): LoadedPlugin {
  return {
    manifest,
    instance: {
      register: mocks.register,
      unregister: mocks.unregister,
    },
    path: "/tmp/smb-complete",
    state: "loaded",
    loadedAt: new Date(),
  };
}

async function loadRegistry() {
  vi.resetModules();
  const { PluginRegistry } = await import("../registry");
  return PluginRegistry.getInstance();
}

describe("PluginRegistry pack runtime state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-registry-test-"));
    mocks.writePackStateFile.mockImplementation((filePath: string, contents: string) => {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, contents, "utf-8");
    });
    mocks.secureInitialized = false;
    mocks.secureRefusesWrites = false;
    mocks.strictPolicies = {
      version: 1,
      updatedAt: new Date().toISOString(),
      packs: { allowed: [], blocked: [], required: [] },
      connectors: { blocked: [] },
      agents: { maxHeartbeatFrequencySec: 60, maxConcurrentAgents: 10 },
      everydayAgent: {
        blocked: false,
        blockedBundles: [],
        forceReviewOnly: false,
        maxHeartbeatCadenceMinutes: 60,
        maxConcurrentBackgroundWork: 1,
        activeHours: { enabled: false, windows: [] },
      },
      runtime: {
        allowedPermissionModes: [],
        allowedSandboxTypes: ["macos", "docker"],
        requireSandboxForShell: false,
        allowUnsandboxedShell: false,
        network: {
          defaultAction: "allow",
          allowedDomains: [],
          blockedDomains: [],
          allowShellNetwork: false,
        },
        autoReview: { enabled: true },
        telemetry: { enabled: false },
      },
      general: {
        allowCustomPacks: true,
        allowGitInstall: true,
        allowUrlInstall: true,
      },
    };
    mocks.securePayload = undefined;
    mocks.isPackAllowed.mockReturnValue(true);
    mocks.isPackRequired.mockReturnValue(false);
    mocks.discoverPlugins.mockResolvedValue([
      { path: "/tmp/smb-complete", manifest: makeManifest(), securityReport: undefined },
    ]);
    mocks.loadPlugin.mockResolvedValue({
      success: true,
      plugin: makeLoadedPlugin(),
    });
  });

  afterEach(() => {
    fs.rmSync(mocks.userDataDir, { recursive: true, force: true });
  });

  it("does not register runtime content for admin-blocked packs", async () => {
    mocks.isPackAllowed.mockReturnValue(false);
    const registry = await loadRegistry();

    await registry.initialize();

    expect(mocks.register).not.toHaveBeenCalled();
    expect(registry.getPlugin("smb-complete")?.state).toBe("disabled");
  });

  it("does not load script entrypoints for admin-blocked packs", async () => {
    mocks.isPackAllowed.mockReturnValue(false);
    mocks.discoverPlugins.mockResolvedValue([
      {
        path: "/tmp/smb-complete",
        manifest: makeManifest({ main: "index.js" }),
        securityReport: undefined,
      },
    ]);
    const registry = await loadRegistry();

    await registry.initialize();

    expect(mocks.loadPlugin).not.toHaveBeenCalled();
    expect(registry.getPlugin("smb-complete")?.state).toBe("disabled");
  });

  it("does not load script entrypoints for user-disabled packs", async () => {
    mocks.secureInitialized = true;
    mocks.securePayload = { packs: { "smb-complete": false } };
    mocks.discoverPlugins.mockResolvedValue([
      {
        path: "/tmp/smb-complete",
        manifest: makeManifest({ main: "index.js" }),
        securityReport: undefined,
      },
    ]);
    const registry = await loadRegistry();

    await registry.initialize();

    expect(mocks.loadPlugin).not.toHaveBeenCalled();
    expect(registry.getPlugin("smb-complete")?.state).toBe("disabled");
  });

  it("does not load pack runtime code when policies fail to load", async () => {
    mocks.strictPolicies = null;
    mocks.discoverPlugins.mockResolvedValue([
      {
        path: "/tmp/smb-complete",
        manifest: makeManifest({ main: "index.js" }),
        securityReport: undefined,
      },
    ]);
    const registry = await loadRegistry();

    await registry.initialize();

    expect(mocks.loadPlugin).not.toHaveBeenCalled();
    expect(registry.getPlugin("smb-complete")?.state).toBe("disabled");
  });

  it("removes runtime registrations when a loaded pack becomes policy-blocked", async () => {
    const registry = await loadRegistry();
    await registry.initialize();
    expect(registry.getPlugin("smb-complete")?.state).toBe("registered");

    mocks.isPackAllowed.mockReturnValue(false);
    await registry.reconcilePackRuntimeState();

    expect(mocks.unregisterPluginSkills).toHaveBeenCalledWith("smb-complete");
    expect(registry.getPlugin("smb-complete")?.state).toBe("disabled");
  });

  it("synchronizes an individual skill toggle with the live plugin-skill loader", async () => {
    const registry = await loadRegistry();
    await registry.initialize();

    await registry.setSkillEnabled("smb-complete", "smb-plan-payroll", false);

    expect(mocks.setPluginSkillEnabled).toHaveBeenCalledWith(
      "smb-complete",
      "smb-plan-payroll",
      false,
    );
    expect(registry.getSkillEnabled("smb-complete", "smb-plan-payroll")).toBe(false);
    expect(registry.getPlugin("smb-complete")?.manifest.skills?.[0].enabled).toBe(true);
  });

  it("fails closed and rolls back in-memory states when legacy-file persistence fails", async () => {
    const registry = await loadRegistry();
    await registry.initialize();
    mocks.writePackStateFile.mockImplementation(() => {
      throw new Error("disk full");
    });

    expect(() => registry.setPackEnabled("smb-complete", false)).toThrow("disk full");
    expect(registry.getPackEnabled("smb-complete")).toBeUndefined();
    await expect(
      registry.setSkillEnabled("smb-complete", "smb-plan-payroll", false),
    ).rejects.toThrow("disk full");
    expect(registry.getSkillEnabled("smb-complete", "smb-plan-payroll")).toBeUndefined();
    expect(mocks.setPluginSkillEnabled).not.toHaveBeenCalled();
  });

  it("retains pack and live skill state when secure storage refuses a write", async () => {
    mocks.secureInitialized = true;
    const persisted = {
      packs: { "smb-complete": true },
      skills: { "smb-complete": { "smb-plan-payroll": true } },
    };
    mocks.securePayload = persisted;
    const registry = await loadRegistry();
    await registry.initialize();
    mocks.secureRefusesWrites = true;

    expect(() => registry.setPackEnabled("smb-complete", false)).toThrow("Secure storage refused");
    expect(registry.getPackEnabled("smb-complete")).toBe(true);
    await expect(
      registry.setSkillEnabled("smb-complete", "smb-plan-payroll", false),
    ).rejects.toThrow("Secure storage refused");
    expect(registry.getSkillEnabled("smb-complete", "smb-plan-payroll")).toBe(true);
    expect(mocks.setPluginSkillEnabled).not.toHaveBeenCalled();
    expect(mocks.writePackStateFile).not.toHaveBeenCalled();
    expect(mocks.securePayload).toEqual(persisted);
  });

  it("leaves runtime state unchanged when policy reconciliation cannot load policies", async () => {
    const registry = await loadRegistry();
    await registry.initialize();
    mocks.strictPolicies = null;

    await registry.reconcilePackRuntimeState();

    expect(mocks.unregisterPluginSkills).not.toHaveBeenCalled();
    expect(registry.getPlugin("smb-complete")?.state).toBe("registered");
  });

  it("cleans partial tool registrations when script registration throws", async () => {
    mocks.loadPlugin.mockResolvedValueOnce({
      success: true,
      plugin: {
        ...makeLoadedPlugin(),
        instance: {
          register: vi.fn(async (api: { registerTool: (tool: unknown) => void }) => {
            api.registerTool({
              name: "leaky-tool",
              description: "Should be removed after failure",
              inputSchema: {},
              handler: async () => ({}),
            });
            throw new Error("boom");
          }),
        },
      },
    });
    const registry = await loadRegistry();

    await registry.initialize();

    expect(registry.getPlugin("smb-complete")?.state).toBe("error");
    expect(registry.getTools().has("smb-complete:leaky-tool")).toBe(false);
  });

  it("applies saved skill toggles to disabled pack manifests", async () => {
    mocks.secureInitialized = true;
    mocks.securePayload = {
      packs: { "smb-complete": false },
      skills: { "smb-complete": { "smb-plan-payroll": false } },
    };
    const registry = await loadRegistry();

    await registry.initialize();

    const skill = registry.getPlugin("smb-complete")?.manifest.skills?.[0];
    expect(registry.getPlugin("smb-complete")?.state).toBe("disabled");
    expect(skill?.enabled).toBe(false);
    expect(mocks.register).not.toHaveBeenCalled();
  });

  it("throws on reload failure and keeps the pack visible but disabled", async () => {
    const registry = await loadRegistry();
    await registry.initialize();

    mocks.loadPlugin.mockResolvedValueOnce({
      success: false,
      error: "missing manifest",
    });

    await expect(registry.reloadPlugin("smb-complete")).rejects.toThrow(
      "Failed to reload plugin smb-complete",
    );
    expect(registry.getPlugin("smb-complete")?.state).toBe("disabled");
  });
});
