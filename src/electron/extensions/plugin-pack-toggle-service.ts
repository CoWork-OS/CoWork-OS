import {
  isPackAllowed,
  isPackRequired,
  loadPoliciesStrict,
  type AdminPolicies,
} from "../admin/policies";
import { PluginRegistry } from "./registry";

export interface PluginPackToggleSkill {
  id: string;
  enabled?: boolean;
}

export interface PluginPackToggleTarget {
  manifest: {
    name: string;
    type: string;
    skills?: PluginPackToggleSkill[];
    skillDirectories?: PluginPackToggleSkill[];
  };
  state: string;
  securityReport?: { verdict?: string } | null;
}

export interface PluginPackToggleRegistry {
  initialize(): Promise<void>;
  getPlugin(name: string): PluginPackToggleTarget | undefined;
  getPackEnabled(name: string): boolean | undefined;
  setPackEnabled(name: string, enabled: boolean): void;
  restorePackEnabled(name: string, enabled: boolean | undefined): void;
  reloadPlugin(name: string): Promise<void>;
  disablePlugin(name: string): Promise<void>;
  enablePlugin(name: string): Promise<void>;
  setSkillEnabled(packName: string, skillId: string, enabled: boolean): Promise<void>;
}

export interface PluginPackTogglePolicies {
  loadPoliciesStrict: () => AdminPolicies | null;
  isPackAllowed: (packId: string, policies: AdminPolicies) => boolean;
  isPackRequired: (packId: string, policies: AdminPolicies) => boolean;
}

export interface PluginPackToggleResult {
  success: true;
  name: string;
  enabled: boolean;
}

export interface PluginPackSkillToggleResult {
  success: true;
  packName: string;
  skillId: string;
  enabled: boolean;
}

const defaultPolicies: PluginPackTogglePolicies = {
  loadPoliciesStrict,
  isPackAllowed,
  isPackRequired,
};

function isRuntimeEnabled(state: string): boolean {
  return state === "registered" || state === "active";
}

/**
 * Shared desired-state operations for installed packs and their registered skills.
 * Mutations for one pack share a queue so IPC and browser callers cannot interleave
 * persistence and runtime transitions for the same pack.
 */
export class PluginPackToggleService {
  private readonly mutationQueues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly registry: PluginPackToggleRegistry,
    private readonly policies: PluginPackTogglePolicies = defaultPolicies,
  ) {}

  setPackEnabled(name: string, enabled: boolean): Promise<PluginPackToggleResult> {
    if (typeof name !== "string" || !name.trim()) {
      return Promise.reject(new Error("Pack name is required"));
    }
    if (typeof enabled !== "boolean") {
      return Promise.reject(new Error("Pack enabled state must be a boolean"));
    }

    return this.serialize(name, async () => {
      await this.registry.initialize();
      const policies = this.requirePolicies("plugin pack state");
      this.assertPackAllowed(name, enabled, policies);

      const plugin = this.registry.getPlugin(name);
      if (!plugin || plugin.manifest.type !== "pack") {
        throw new Error(`Pack "${name}" not found`);
      }
      this.assertNotQuarantined(plugin, enabled);
      if (plugin.state === "loading") {
        throw new Error(`Pack "${name}" is still loading and cannot be changed`);
      }

      const currentlyEnabled = isRuntimeEnabled(plugin.state);
      const transitionNeeded = enabled ? !currentlyEnabled : plugin.state !== "disabled";
      const previousPersistedState = this.registry.getPackEnabled(name);
      const previousRuntimeState = plugin.state;
      this.registry.setPackEnabled(name, enabled);

      try {
        if (transitionNeeded) {
          if (enabled) {
            await this.registry.reloadPlugin(name);
          } else {
            await this.registry.disablePlugin(name);
          }
        }
        const transitioned = this.registry.getPlugin(name);
        if (enabled && (!transitioned || !isRuntimeEnabled(transitioned.state))) {
          throw new Error(`Pack "${name}" did not reach a registered runtime state`);
        }
        if (!enabled && (!transitioned || transitioned.state !== "disabled")) {
          throw new Error(`Pack "${name}" did not reach the disabled runtime state`);
        }
      } catch (error) {
        const rollbackErrors: string[] = [];
        try {
          this.registry.restorePackEnabled(name, previousPersistedState);
        } catch (rollbackError) {
          console.warn("[PluginPacks] Failed to roll back pack toggle state:", rollbackError);
          rollbackErrors.push("persisted state could not be restored");
        }
        try {
          await this.restoreRuntimeState(name, currentlyEnabled, previousRuntimeState);
        } catch (rollbackError) {
          console.warn("[PluginPacks] Failed to restore pack runtime state:", rollbackError);
          rollbackErrors.push("runtime registrations could not be restored");
          const degraded = this.registry.getPlugin(name);
          if (degraded) degraded.state = "error";
        }
        if (rollbackErrors.length > 0) {
          const transitionMessage =
            error instanceof Error ? error.message : "unknown transition error";
          throw new Error(
            `Pack "${name}" toggle failed (${transitionMessage}); rollback incomplete: ${rollbackErrors.join(", ")}.`,
          );
        }
        throw error;
      }

      return { success: true, name, enabled };
    });
  }

  setSkillEnabled(
    packName: string,
    skillId: string,
    enabled: boolean,
  ): Promise<PluginPackSkillToggleResult> {
    if (
      typeof packName !== "string" ||
      !packName.trim() ||
      typeof skillId !== "string" ||
      !skillId
    ) {
      return Promise.reject(new Error("Pack name and skill ID are required"));
    }
    if (typeof enabled !== "boolean") {
      return Promise.reject(new Error("Skill enabled state must be a boolean"));
    }

    return this.serialize(packName, async () => {
      await this.registry.initialize();
      const policies = this.requirePolicies("plugin skill state");
      const plugin = this.registry.getPlugin(packName);
      if (!plugin || plugin.manifest.type !== "pack") {
        throw new Error(`Pack "${packName}" not found`);
      }
      this.assertNotQuarantined(plugin, enabled);
      this.assertPackAllowed(packName, enabled, policies);

      const skill = [
        ...(plugin.manifest.skills || []),
        ...(plugin.manifest.skillDirectories || []),
      ].find((candidate) => candidate.id === skillId);
      if (!skill) {
        throw new Error(`Skill "${skillId}" not found in pack "${packName}"`);
      }

      const previousSkillState = skill.enabled;
      skill.enabled = enabled;
      try {
        await this.registry.setSkillEnabled(packName, skillId, enabled);
      } catch (error) {
        skill.enabled = previousSkillState;
        throw error;
      }
      return { success: true, packName, skillId, enabled };
    });
  }

  private requirePolicies(subject: string): AdminPolicies {
    const policies = this.policies.loadPoliciesStrict();
    if (!policies) {
      throw new Error(`Admin policies failed to load; refusing to change ${subject}`);
    }
    return policies;
  }

  private assertPackAllowed(name: string, enabled: boolean, policies: AdminPolicies): void {
    if (!this.policies.isPackAllowed(name, policies)) {
      throw new Error(`Pack "${name}" is blocked by admin policy`);
    }
    if (!enabled && this.policies.isPackRequired(name, policies)) {
      throw new Error(`Pack "${name}" is required by admin policy and cannot be disabled`);
    }
  }

  private assertNotQuarantined(plugin: PluginPackToggleTarget, enabled: boolean): void {
    if (enabled && plugin.securityReport?.verdict === "quarantined") {
      throw new Error(`Pack "${plugin.manifest.name}" is quarantined and cannot be enabled`);
    }
  }

  private async restoreRuntimeState(
    name: string,
    wasEnabled: boolean,
    previousRuntimeState: string,
  ): Promise<void> {
    if (!wasEnabled) {
      await this.registry.disablePlugin(name);
      const restored = this.registry.getPlugin(name);
      if (!restored || restored.state !== "disabled") {
        throw new Error(`Pack "${name}" did not return to the disabled state`);
      }
      return;
    }

    await this.registry.reloadPlugin(name);
    let restored = this.registry.getPlugin(name);
    if (!restored || !isRuntimeEnabled(restored.state)) {
      throw new Error(`Pack "${name}" did not return to an enabled state`);
    }
    if (previousRuntimeState === "active") {
      await this.registry.enablePlugin(name);
      restored = this.registry.getPlugin(name);
      if (!restored || restored.state !== "active") {
        throw new Error(`Pack "${name}" did not return to the active state`);
      }
    }
  }

  private serialize<T>(packName: string, mutation: () => Promise<T>): Promise<T> {
    const previous = this.mutationQueues.get(packName) || Promise.resolve();
    const current = previous.catch(() => undefined).then(mutation);
    this.mutationQueues.set(packName, current);
    return current.finally(() => {
      if (this.mutationQueues.get(packName) === current) {
        this.mutationQueues.delete(packName);
      }
    });
  }
}

const servicesByRegistry = new WeakMap<object, PluginPackToggleService>();

/** Return one shared service per registry for IPC and browser-host callers. */
export function getPluginPackToggleService(
  registry: PluginPackToggleRegistry = PluginRegistry.getInstance(),
): PluginPackToggleService {
  const key = registry as object;
  let service = servicesByRegistry.get(key);
  if (!service) {
    service = new PluginPackToggleService(registry);
    servicesByRegistry.set(key, service);
  }
  return service;
}
