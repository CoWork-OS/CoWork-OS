import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminPolicies } from "../../admin/policies";
import {
  PluginPackToggleService,
  type PluginPackTogglePolicies,
  type PluginPackToggleRegistry,
  type PluginPackToggleTarget,
} from "../plugin-pack-toggle-service";

const packPolicies = (overrides: Partial<AdminPolicies["packs"]> = {}) =>
  ({
    packs: { allowed: [], blocked: [], required: [], ...overrides },
  }) as AdminPolicies;

function makeHarness(
  options: {
    state?: string;
    persistedPackState?: boolean;
    policies?: AdminPolicies | null;
    isAllowed?: boolean;
    isRequired?: boolean;
    skillEnabled?: boolean;
    securityVerdict?: string;
    setSkillEnabled?: (enabled: boolean) => void;
    reloadPlugin?: () => Promise<void>;
    disablePlugin?: () => Promise<void>;
    restorePackEnabled?: (enabled: boolean | undefined) => void;
  } = {},
) {
  const plugin: PluginPackToggleTarget = {
    manifest: {
      name: "pack-one",
      type: "pack",
      skills: [{ id: "skill-one", enabled: options.skillEnabled ?? true }],
      skillDirectories: [{ id: "skill-directory", enabled: true }],
    },
    state: options.state ?? "disabled",
    securityReport: options.securityVerdict ? { verdict: options.securityVerdict } : undefined,
  };
  const persistedPackState = new Map<string, boolean>();
  if (options.persistedPackState !== undefined) {
    persistedPackState.set("pack-one", options.persistedPackState);
  }
  const persistedSkillStates = new Map<string, boolean>();
  const calls: string[] = [];
  const registry: PluginPackToggleRegistry = {
    initialize: vi.fn(async () => {
      calls.push("initialize");
    }),
    getPlugin: vi.fn((name) => (name === "pack-one" ? plugin : undefined)),
    getPackEnabled: vi.fn((name) => persistedPackState.get(name)),
    setPackEnabled: vi.fn((name, enabled) => {
      calls.push(`persist-pack:${enabled}`);
      persistedPackState.set(name, enabled);
    }),
    restorePackEnabled: vi.fn((name, enabled) => {
      calls.push(`restore-pack:${enabled}`);
      options.restorePackEnabled?.(enabled);
      if (enabled === undefined) persistedPackState.delete(name);
      else persistedPackState.set(name, enabled);
    }),
    reloadPlugin: vi.fn(async () => {
      calls.push("reload");
      plugin.state = "loading";
      await options.reloadPlugin?.();
      plugin.state = "registered";
    }),
    disablePlugin: vi.fn(async () => {
      calls.push("disable");
      await options.disablePlugin?.();
      plugin.state = "disabled";
    }),
    enablePlugin: vi.fn(async () => {
      calls.push("enable-runtime");
      plugin.state = "active";
    }),
    setSkillEnabled: vi.fn(async (packName, skillId, enabled) => {
      calls.push(`persist-skill:${enabled}`);
      persistedSkillStates.set(`${packName}:${skillId}`, enabled);
      options.setSkillEnabled?.(enabled);
    }),
  };
  const policies: PluginPackTogglePolicies = {
    loadPoliciesStrict: vi.fn(() =>
      options.policies === undefined ? packPolicies() : options.policies,
    ),
    isPackAllowed: vi.fn(() => options.isAllowed ?? true),
    isPackRequired: vi.fn(() => options.isRequired ?? false),
  };
  return {
    service: new PluginPackToggleService(registry, policies),
    plugin,
    registry,
    policies,
    calls,
    persistedPackState,
    persistedSkillStates,
  };
}

describe("PluginPackToggleService", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses blocked packs and required-pack disable requests before mutation", async () => {
    const blocked = makeHarness({ isAllowed: false });
    await expect(blocked.service.setPackEnabled("pack-one", true)).rejects.toThrow(
      'Pack "pack-one" is blocked by admin policy',
    );
    expect(blocked.registry.setPackEnabled).not.toHaveBeenCalled();

    const required = makeHarness({ isRequired: true });
    await expect(required.service.setPackEnabled("pack-one", false)).rejects.toThrow(
      'Pack "pack-one" is required by admin policy and cannot be disabled',
    );
    await expect(required.service.setSkillEnabled("pack-one", "skill-one", false)).rejects.toThrow(
      'Pack "pack-one" is required by admin policy and cannot be disabled',
    );
    expect(required.registry.setPackEnabled).not.toHaveBeenCalled();
    expect(required.registry.setSkillEnabled).not.toHaveBeenCalled();
  });

  it("fails closed when strict admin policies are unavailable", async () => {
    const harness = makeHarness({ policies: null });
    await expect(harness.service.setPackEnabled("pack-one", true)).rejects.toThrow(
      "Admin policies failed to load; refusing to change plugin pack state",
    );
    expect(harness.registry.setPackEnabled).not.toHaveBeenCalled();
  });

  it("never enables a quarantined pack or one of its skills", async () => {
    const harness = makeHarness({ securityVerdict: "quarantined" });
    await expect(harness.service.setPackEnabled("pack-one", true)).rejects.toThrow(
      'Pack "pack-one" is quarantined and cannot be enabled',
    );
    await expect(harness.service.setSkillEnabled("pack-one", "skill-one", true)).rejects.toThrow(
      'Pack "pack-one" is quarantined and cannot be enabled',
    );
    expect(harness.registry.setPackEnabled).not.toHaveBeenCalled();
    expect(harness.registry.setSkillEnabled).not.toHaveBeenCalled();
  });

  it("still allows a quarantined pack to be disabled", async () => {
    const harness = makeHarness({ securityVerdict: "quarantined", state: "registered" });
    await expect(harness.service.setPackEnabled("pack-one", false)).resolves.toMatchObject({
      success: true,
      enabled: false,
    });
    expect(harness.plugin.state).toBe("disabled");
  });

  it("restores persisted and runtime pack state after a reload failure", async () => {
    const harness = makeHarness({
      state: "disabled",
      persistedPackState: false,
      reloadPlugin: async () => {
        throw new Error("reload failed");
      },
    });

    await expect(harness.service.setPackEnabled("pack-one", true)).rejects.toThrow("reload failed");

    expect(harness.registry.restorePackEnabled).toHaveBeenCalledWith("pack-one", false);
    expect(harness.persistedPackState.get("pack-one")).toBe(false);
    expect(harness.plugin.state).toBe("disabled");
  });

  it("reloads an errored pack to reach the requested enabled state", async () => {
    const harness = makeHarness({ state: "error" });
    await expect(harness.service.setPackEnabled("pack-one", true)).resolves.toMatchObject({
      success: true,
      name: "pack-one",
      enabled: true,
    });
    expect(harness.registry.reloadPlugin).toHaveBeenCalledOnce();
    expect(harness.plugin.state).toBe("registered");
  });

  it("restores runtime registrations after a failed disable before returning failure", async () => {
    const harness = makeHarness({
      state: "active",
      disablePlugin: async () => {
        throw new Error("disable failed");
      },
    });
    await expect(harness.service.setPackEnabled("pack-one", false)).rejects.toThrow(
      "disable failed",
    );
    expect(harness.persistedPackState.has("pack-one")).toBe(false);
    expect(harness.registry.reloadPlugin).toHaveBeenCalledOnce();
    expect(harness.registry.enablePlugin).toHaveBeenCalledOnce();
    expect(harness.plugin.state).toBe("active");
  });

  it("marks state as error and reports an incomplete rollback if runtime recovery fails", async () => {
    const harness = makeHarness({
      state: "registered",
      disablePlugin: async () => {
        throw new Error("disable failed");
      },
      reloadPlugin: async () => {
        throw new Error("recovery failed");
      },
    });
    await expect(harness.service.setPackEnabled("pack-one", false)).rejects.toThrow(
      "rollback incomplete: runtime registrations could not be restored",
    );
    expect(harness.plugin.state).toBe("error");
  });

  it("rejects a pack while it is transitioning through loading", async () => {
    const harness = makeHarness({ state: "loading" });
    await expect(harness.service.setPackEnabled("pack-one", true)).rejects.toThrow(
      'Pack "pack-one" is still loading and cannot be changed',
    );
    expect(harness.registry.setPackEnabled).not.toHaveBeenCalled();
  });

  it("rejects unknown packs and skills without persisting state", async () => {
    const harness = makeHarness();
    await expect(harness.service.setPackEnabled("missing-pack", true)).rejects.toThrow(
      'Pack "missing-pack" not found',
    );
    await expect(
      harness.service.setSkillEnabled("pack-one", "missing-skill", false),
    ).rejects.toThrow('Skill "missing-skill" not found in pack "pack-one"');
    expect(harness.registry.setPackEnabled).not.toHaveBeenCalled();
    expect(harness.registry.setSkillEnabled).not.toHaveBeenCalled();
  });

  it("applies requested desired state and avoids redundant runtime reloads", async () => {
    const pack = makeHarness({ state: "registered" });
    await expect(pack.service.setPackEnabled("pack-one", true)).resolves.toEqual({
      success: true,
      name: "pack-one",
      enabled: true,
    });
    expect(pack.persistedPackState.get("pack-one")).toBe(true);
    expect(pack.registry.reloadPlugin).not.toHaveBeenCalled();

    const skill = makeHarness({ skillEnabled: true });
    await expect(skill.service.setSkillEnabled("pack-one", "skill-one", false)).resolves.toEqual({
      success: true,
      packName: "pack-one",
      skillId: "skill-one",
      enabled: false,
    });
    expect(skill.plugin.manifest.skills?.[0].enabled).toBe(false);
    expect(skill.persistedSkillStates.get("pack-one:skill-one")).toBe(false);
  });

  it("preserves an active runtime state when enabling an already active pack", async () => {
    const harness = makeHarness({ state: "active" });
    await expect(harness.service.setPackEnabled("pack-one", true)).resolves.toEqual({
      success: true,
      name: "pack-one",
      enabled: true,
    });
    expect(harness.plugin.state).toBe("active");
    expect(harness.registry.reloadPlugin).not.toHaveBeenCalled();
    expect(harness.registry.enablePlugin).not.toHaveBeenCalled();
  });

  it("restores manifest skill state when skill persistence fails", async () => {
    const harness = makeHarness({
      skillEnabled: true,
      setSkillEnabled: () => {
        throw new Error("save failed");
      },
    });

    await expect(harness.service.setSkillEnabled("pack-one", "skill-one", false)).rejects.toThrow(
      "save failed",
    );
    expect(harness.plugin.manifest.skills?.[0].enabled).toBe(true);
  });

  it("serializes pack and skill writes for the same pack", async () => {
    let markReloadStarted!: () => void;
    let releaseReload!: () => void;
    const reloadStarted = new Promise<void>((resolve) => {
      markReloadStarted = resolve;
    });
    const reloadGate = new Promise<void>((resolve) => {
      releaseReload = resolve;
    });
    const harness = makeHarness({
      state: "disabled",
      reloadPlugin: async () => {
        markReloadStarted();
        await reloadGate;
      },
    });

    const enabling = harness.service.setPackEnabled("pack-one", true);
    await reloadStarted;
    const disablingSkill = harness.service.setSkillEnabled("pack-one", "skill-one", false);
    await Promise.resolve();
    expect(harness.plugin.manifest.skills?.[0].enabled).toBe(true);
    expect(harness.calls).not.toContain("persist-skill:false");

    releaseReload();
    await Promise.all([enabling, disablingSkill]);
    expect(harness.plugin.manifest.skills?.[0].enabled).toBe(false);
    expect(harness.calls.indexOf("persist-pack:true")).toBeLessThan(
      harness.calls.indexOf("persist-skill:false"),
    );
  });
});
