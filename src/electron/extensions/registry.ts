/**
 * Plugin Registry
 *
 * Central registry for managing loaded plugins.
 * Handles plugin lifecycle, configuration, and event dispatch.
 */

import { EventEmitter } from "events";
import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import {
  SecureSettingsRepository,
  type SettingsCategory,
} from "../database/SecureSettingsRepository";
import {
  Plugin,
  PluginManifest,
  LoadedPlugin,
  PluginState,
  PluginAPI,
  PluginRuntime,
  PluginEvent,
  PluginEventType,
  RegisterChannelOptions,
  RegisterToolOptions,
  SecureStorage,
  PluginType,
} from "./types";
import { createToolFromConnector, validateConnector } from "./declarative-connector-loader";
import { discoverPlugins, loadPlugin, getPluginDataPath, isPluginCompatible } from "./loader";
import { ChannelAdapter, ChannelConfig } from "../gateway/channels/types";
import { getUserDataDir } from "../utils/user-data-dir";
import { getSafeStorage } from "../utils/safe-storage";

// Package version (will be replaced at build time or read from package.json)
const COWORK_VERSION = process.env.npm_package_version || "0.3.0";

/**
 * Plugin Registry - Singleton manager for all plugins
 */
export class PluginRegistry extends EventEmitter {
  private static instance: PluginRegistry;

  /** Loaded plugins by name */
  private plugins: Map<string, LoadedPlugin> = new Map();

  /** Registered channel adapters by plugin name */
  private channelAdapters: Map<string, RegisterChannelOptions> = new Map();

  /** Registered tools by name */
  private tools: Map<string, RegisterToolOptions> = new Map();

  /** Plugin configurations */
  private configs: Map<string, Record<string, unknown>> = new Map();

  /** Track which plugin registered each skill ID (for conflict detection) */
  private skillOwnership: Map<string, string> = new Map();

  /** Event handlers by plugin */
  private pluginEventHandlers: Map<string, Map<string, Set<(data: unknown) => void>>> = new Map();

  /** Whether the registry has been initialized */
  private initialized = false;

  /** Persisted pack toggle states */
  private packStates: Map<string, boolean> = new Map();

  /** Persisted per-skill toggle states: Map<packName, Map<skillId, enabled>> */
  private skillStates: Map<string, Map<string, boolean>> = new Map();

  /** Path to the pack states file */
  private get packStatesPath(): string {
    return path.join(getUserDataDir(), "pack-states.json");
  }

  private constructor() {
    super();
    this.loadPackStates();
  }

  /**
   * Load persisted pack toggle states from disk
   */
  private loadPackStates(): void {
    try {
      if (fs.existsSync(this.packStatesPath)) {
        const data = JSON.parse(fs.readFileSync(this.packStatesPath, "utf-8"));
        if (data && typeof data === "object") {
          // Load pack states
          const packs = data.packs || data;
          for (const [name, enabled] of Object.entries(packs)) {
            if (typeof enabled === "boolean") {
              this.packStates.set(name, enabled);
            }
          }
          // Load skill states
          if (data.skills && typeof data.skills === "object") {
            for (const [packName, skills] of Object.entries(data.skills)) {
              if (skills && typeof skills === "object") {
                const skillMap = new Map<string, boolean>();
                for (const [skillId, enabled] of Object.entries(skills as Record<string, boolean>)) {
                  if (typeof enabled === "boolean") {
                    skillMap.set(skillId, enabled);
                  }
                }
                if (skillMap.size > 0) {
                  this.skillStates.set(packName, skillMap);
                }
              }
            }
          }
        }
      }
    } catch {
      // Corrupted file, start fresh
    }
  }

  /**
   * Save pack toggle states to disk
   */
  savePackStates(): void {
    try {
      const dir = path.dirname(this.packStatesPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const packs: Record<string, boolean> = {};
      for (const [name, enabled] of this.packStates) {
        packs[name] = enabled;
      }
      const skills: Record<string, Record<string, boolean>> = {};
      for (const [packName, skillMap] of this.skillStates) {
        const entries: Record<string, boolean> = {};
        for (const [skillId, enabled] of skillMap) {
          entries[skillId] = enabled;
        }
        if (Object.keys(entries).length > 0) {
          skills[packName] = entries;
        }
      }
      fs.writeFileSync(
        this.packStatesPath,
        JSON.stringify({ packs, skills }, null, 2),
        "utf-8",
      );
    } catch (error) {
      console.warn("[PluginRegistry] Failed to save pack states:", error);
    }
  }

  /**
   * Set and persist a pack's enabled state
   */
  setPackEnabled(name: string, enabled: boolean): void {
    this.packStates.set(name, enabled);
    this.savePackStates();
  }

  /**
   * Get the persisted enabled state for a pack (undefined if not set)
   */
  getPackEnabled(name: string): boolean | undefined {
    return this.packStates.get(name);
  }

  /**
   * Set and persist a skill's enabled state within a pack
   */
  setSkillEnabled(packName: string, skillId: string, enabled: boolean): void {
    if (!this.skillStates.has(packName)) {
      this.skillStates.set(packName, new Map());
    }
    this.skillStates.get(packName)!.set(skillId, enabled);
    this.savePackStates();
  }

  /**
   * Get the persisted enabled state for a skill (undefined if not set)
   */
  getSkillEnabled(packName: string, skillId: string): boolean | undefined {
    return this.skillStates.get(packName)?.get(skillId);
  }

  /** Remove persisted state for a pack (used when a pack is fully uninstalled). */
  purgePackState(name: string): void {
    this.packStates.delete(name);
    this.skillStates.delete(name);
    this.savePackStates();
  }

  /**
   * Get the singleton instance
   */
  static getInstance(): PluginRegistry {
    if (!PluginRegistry.instance) {
      PluginRegistry.instance = new PluginRegistry();
    }
    return PluginRegistry.instance;
  }

  /**
   * Initialize the registry and load all plugins
   */
  async initialize(extensionDirs?: string[]): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Discover plugins
    const discovered = await discoverPlugins(extensionDirs);

    // Load and register each plugin
    for (const { path: pluginPath, manifest } of discovered) {
      await this.loadAndRegister(pluginPath, manifest);
    }

    this.initialized = true;

    if (this.plugins.size > 0) {
      console.log(`[PluginRegistry] Initialized with ${this.plugins.size} plugins`);
    }
  }

  /**
   * Re-scan extension directories for new plugins that weren't present at startup.
   * Unlike initialize(), this can be called multiple times to discover newly-added plugins.
   */
  async discoverNewPlugins(extensionDirs?: string[]): Promise<void> {
    const discovered = await discoverPlugins(extensionDirs);
    let newCount = 0;
    for (const { path: pluginPath, manifest } of discovered) {
      if (!this.plugins.has(manifest.name)) {
        await this.loadAndRegister(pluginPath, manifest);
        newCount++;
      }
    }
    if (newCount > 0) {
      console.log(`Discovered ${newCount} new plugin(s)`);
    }
  }

  /**
   * Load and register a single plugin
   */
  private async loadAndRegister(pluginPath: string, manifest: PluginManifest): Promise<void> {
    const pluginName = manifest.name;

    // Check compatibility
    if (!isPluginCompatible(manifest, COWORK_VERSION)) {
      console.warn(`Plugin ${pluginName} requires CoWork ${manifest.coworkVersion}, skipping`);
      return;
    }

    // Check if already loaded
    if (this.plugins.has(pluginName)) {
      console.warn(`Plugin ${pluginName} already loaded, skipping`);
      return;
    }

    try {
      // Load the plugin
      const result = await loadPlugin(pluginPath);

      if (!result.success || !result.plugin) {
        console.error(`Failed to load plugin ${pluginName}:`, result.error);
        return;
      }

      const loadedPlugin = result.plugin;
      this.plugins.set(pluginName, loadedPlugin);

      // Load configuration
      const config = this.loadPluginConfig(pluginName);
      this.configs.set(pluginName, config);

      // Create plugin API
      const api = this.createPluginAPI(pluginName, loadedPlugin);

      // Register the plugin
      await loadedPlugin.instance.register(api);

      // Handle composite declarative content (skills, agentRoles, connectors)
      await this.registerDeclarativeContent(loadedPlugin.manifest, pluginName);

      // Apply persisted pack toggle state
      const savedState = this.packStates.get(pluginName);
      if (savedState === false) {
        loadedPlugin.state = "disabled";
      } else {
        loadedPlugin.state = "registered";
      }

      this.emitPluginEvent("plugin:registered", pluginName);
      console.log(`Plugin ${pluginName} registered successfully`);
    } catch (error) {
      console.error(`Error registering plugin ${pluginName}:`, error);

      const loadedPlugin = this.plugins.get(pluginName);
      if (loadedPlugin) {
        loadedPlugin.state = "error";
        loadedPlugin.error = error instanceof Error ? error : new Error(String(error));
      }

      this.emitPluginEvent("plugin:error", pluginName, { error });
    }
  }

  /**
   * Create the Plugin API for a specific plugin
   */
  private createPluginAPI(pluginName: string, loadedPlugin: LoadedPlugin): PluginAPI {
    const runtime: PluginRuntime = {
      version: COWORK_VERSION,
      platform: process.platform,
      appDataPath: app?.getPath?.("userData") || path.join(process.env.HOME || "", ".cowork"),
      pluginDataPath: getPluginDataPath(pluginName),
      isDev: process.env.NODE_ENV === "development",
    };

    return {
      runtime,

      registerChannel: (options: RegisterChannelOptions) => {
        this.channelAdapters.set(pluginName, options);
        console.log(`Channel adapter registered by plugin: ${pluginName}`);
      },

      registerTool: (options: RegisterToolOptions) => {
        const toolKey = `${pluginName}:${options.name}`;
        this.tools.set(toolKey, options);
        console.log(`Tool registered: ${toolKey}`);
      },

      getConfig: <T = Record<string, unknown>>(): T => {
        return (this.configs.get(pluginName) || {}) as T;
      },

      setConfig: async (config: Record<string, unknown>): Promise<void> => {
        this.configs.set(pluginName, config);
        await this.savePluginConfig(pluginName, config);
        this.emitPluginEvent("plugin:config-changed", pluginName, { config });
      },

      getSecureStorage: (): SecureStorage => {
        return this.createSecureStorage(pluginName);
      },

      log: (level: "debug" | "info" | "warn" | "error", message: string, ...args: unknown[]) => {
        const prefix = `[${pluginName}]`;
        switch (level) {
          case "debug":
            console.debug(prefix, message, ...args);
            break;
          case "info":
            console.log(prefix, message, ...args);
            break;
          case "warn":
            console.warn(prefix, message, ...args);
            break;
          case "error":
            console.error(prefix, message, ...args);
            break;
        }
      },

      emit: (event: string, data?: unknown) => {
        const handlers = this.pluginEventHandlers.get(pluginName)?.get(event);
        if (handlers) {
          for (const handler of handlers) {
            try {
              handler(data);
            } catch (e) {
              console.error(`Error in plugin event handler:`, e);
            }
          }
        }
      },

      on: (event: string, handler: (data: unknown) => void) => {
        if (!this.pluginEventHandlers.has(pluginName)) {
          this.pluginEventHandlers.set(pluginName, new Map());
        }
        const pluginHandlers = this.pluginEventHandlers.get(pluginName)!;
        if (!pluginHandlers.has(event)) {
          pluginHandlers.set(event, new Set());
        }
        pluginHandlers.get(event)!.add(handler);
      },

      off: (event: string, handler: (data: unknown) => void) => {
        this.pluginEventHandlers.get(pluginName)?.get(event)?.delete(handler);
      },
    };
  }

  /**
   * Register declarative content from a composite plugin manifest.
   * Handles inline skills, agent roles, and declarative connectors.
   */
  private async registerDeclarativeContent(
    manifest: PluginManifest,
    pluginName: string,
  ): Promise<void> {
    // 1. Register inline skills
    if (manifest.skills && manifest.skills.length > 0) {
      try {
        const { getCustomSkillLoader } = await import("../agent/custom-skill-loader");
        const loader = getCustomSkillLoader();
        for (const skill of manifest.skills) {
          // Check for duplicate skill ID conflicts
          const existingOwner = this.skillOwnership.get(skill.id);
          if (existingOwner && existingOwner !== pluginName) {
            console.warn(
              `[PluginRegistry] Skill ID conflict: "${skill.id}" is defined by both "${existingOwner}" and "${pluginName}". The later registration will overwrite the earlier one.`,
            );
          }
          this.skillOwnership.set(skill.id, pluginName);

          // Apply persisted per-skill toggle state
          const savedSkillState = this.skillStates.get(pluginName)?.get(skill.id);
          if (savedSkillState !== undefined) {
            skill.enabled = savedSkillState;
          }
          skill.source = "managed" as const;
          skill.metadata = {
            ...skill.metadata,
            pluginSource: pluginName,
          };
          if (typeof loader.registerPluginSkill === "function") {
            loader.registerPluginSkill(skill);
          }
        }
        console.log(
          `[PluginRegistry] Registered ${manifest.skills.length} skill(s) from ${pluginName}`,
        );
      } catch (error) {
        console.error(`[PluginRegistry] Failed to register skills from ${pluginName}:`, error);
      }
    }

    // 2. Register agent roles
    if (manifest.agentRoles && manifest.agentRoles.length > 0) {
      for (const role of manifest.agentRoles) {
        try {
          this.emit("plugin:register-role", { pluginName, role });
        } catch (error) {
          console.error(
            `[PluginRegistry] Failed to emit role registration from ${pluginName}:`,
            error,
          );
        }
      }
      console.log(
        `[PluginRegistry] Emitted ${manifest.agentRoles.length} role(s) from ${pluginName}`,
      );
    }

    // 3. Register declarative connectors as tools
    if (manifest.connectors && manifest.connectors.length > 0) {
      let registered = 0;
      for (const connector of manifest.connectors) {
        const validationError = validateConnector(connector);
        if (validationError) {
          console.warn(
            `[PluginRegistry] Skipping invalid connector ${connector.name} from ${pluginName}: ${validationError}`,
          );
          continue;
        }
        const toolOptions = createToolFromConnector(connector, pluginName);
        const toolKey = `${pluginName}:${toolOptions.name}`;
        this.tools.set(toolKey, toolOptions);
        registered++;
      }
      console.log(`[PluginRegistry] Registered ${registered} connector(s) from ${pluginName}`);
    }
  }

  /**
   * Create secure storage for a plugin
   */
  private createSecureStorage(pluginName: string): SecureStorage {
    const storagePath = path.join(getPluginDataPath(pluginName), ".secrets");
    const safeStorage = getSafeStorage();
    const repositoryCategory = `plugin:${pluginName}` as SettingsCategory;

    type PluginSecretsMap = Record<string, string>;

    const readFromRepository = (): PluginSecretsMap => {
      if (!SecureSettingsRepository.isInitialized()) {
        return {};
      }

      try {
        const repository = SecureSettingsRepository.getInstance();
        const raw = repository.load<PluginSecretsMap>(repositoryCategory);
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
          return {};
        }

        const secrets: PluginSecretsMap = {};
        for (const [key, value] of Object.entries(raw)) {
          if (typeof key === "string" && typeof value === "string") {
            secrets[key] = value;
          }
        }
        return secrets;
      } catch {
        return {};
      }
    };

    interface StoredSecretsPayload {
      v: 1;
      encrypted: boolean;
      data: string;
    }

    const parseSecretsMap = (value: unknown): Record<string, string> => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return {};
      }

      const next: Record<string, string> = {};
      for (const [key, entry] of Object.entries(value)) {
        if (typeof entry === "string") {
          next[key] = entry;
        }
      }
      return next;
    };

    const isRepositoryAvailable = (): boolean => {
      return SecureSettingsRepository.isInitialized();
    };

    const readSecrets = (): Record<string, string> => {
      if (isRepositoryAvailable()) {
        const repositorySecrets = readFromRepository();
        if (Object.keys(repositorySecrets).length > 0) {
          return repositorySecrets;
        }

        const migrated = readFromFile();
        if (Object.keys(migrated).length > 0) {
          // Best-effort migration from legacy file format.
          writeToRepository(migrated);
          return migrated;
        }
      }

      return readFromFile();
    };

    const readFromFile = (): Record<string, string> => {
      if (!fs.existsSync(storagePath)) {
        return {};
      }

      try {
        const raw = fs.readFileSync(storagePath, "utf-8");
        const parsed = JSON.parse(raw) as unknown;

        if (
          parsed &&
          typeof parsed === "object" &&
          !Array.isArray(parsed) &&
          (parsed as Record<string, unknown>).v === 1 &&
          typeof (parsed as Record<string, unknown>).encrypted === "boolean" &&
          typeof (parsed as Record<string, unknown>).data === "string"
        ) {
          const envelope = parsed as StoredSecretsPayload;
          const decoded = decodePayload(envelope.data, envelope.encrypted);
          if (!decoded) {
            return {};
          }

          const decodedPayload = JSON.parse(decoded) as unknown;
          return parseSecretsMap(decodedPayload);
        }

        // Backward-compatible fallback for older plaintext format.
        return parseSecretsMap(parsed);
      } catch {
        return {};
      }
    };

    const writeToRepository = (secrets: PluginSecretsMap): boolean => {
      try {
        const repository = SecureSettingsRepository.getInstance();
        repository.save(repositoryCategory, secrets);
        return true;
      } catch {
        return false;
      }
    };

    const decodePayload = (payload: string, encrypted: boolean): string | null => {
      if (!encrypted) {
        return payload;
      }

      if (!safeStorage) {
        return null;
      }

      try {
        return safeStorage.decryptString(Buffer.from(payload, "base64"));
      } catch {
        return null;
      }
    };

    const writeToFile = (secrets: Record<string, string>): void => {
      const raw = JSON.stringify(secrets);
      let encrypted = false;
      let data = raw;

      if (safeStorage) {
        try {
          data = safeStorage.encryptString(raw).toString("base64");
          encrypted = true;
        } catch {
          encrypted = false;
          data = raw;
        }
      }

      const dir = path.dirname(storagePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(
        storagePath,
        JSON.stringify({
          v: 1,
          encrypted,
          data,
        } as StoredSecretsPayload),
        { mode: 0o600 },
      );
    };

    const writeSecrets = (secrets: Record<string, string>): void => {
      if (isRepositoryAvailable()) {
        const persisted = writeToRepository(secrets);
        if (persisted) {
          return;
        }
      }
      writeToFile(secrets);
    };

    return {
      get: async (key: string): Promise<string | null> => {
        const secrets = readSecrets();
        return secrets[key] || null;
      },

      set: async (key: string, value: string): Promise<void> => {
        const secrets = readSecrets();
        secrets[key] = value;
        writeSecrets(secrets);
      },

      delete: async (key: string): Promise<void> => {
        const secrets = readSecrets();
        delete secrets[key];
        writeSecrets(secrets);
      },

      has: async (key: string): Promise<boolean> => {
        const secrets = readSecrets();
        return key in secrets;
      },
    };
  }

  /**
   * Load plugin configuration from disk
   */
  private loadPluginConfig(pluginName: string): Record<string, unknown> {
    const configPath = path.join(getPluginDataPath(pluginName), "config.json");

    if (!fs.existsSync(configPath)) {
      // Return default config from manifest
      const plugin = this.plugins.get(pluginName);
      if (plugin?.manifest.configSchema?.properties) {
        const defaults: Record<string, unknown> = {};
        for (const [key, prop] of Object.entries(plugin.manifest.configSchema.properties)) {
          if (prop.default !== undefined) {
            defaults[key] = prop.default;
          }
        }
        return defaults;
      }
      return {};
    }

    try {
      return JSON.parse(fs.readFileSync(configPath, "utf-8"));
    } catch {
      return {};
    }
  }

  /**
   * Save plugin configuration to disk
   */
  private async savePluginConfig(
    pluginName: string,
    config: Record<string, unknown>,
  ): Promise<void> {
    const configPath = path.join(getPluginDataPath(pluginName), "config.json");
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
  }

  /**
   * Emit a plugin event
   */
  private emitPluginEvent(type: PluginEventType, pluginName: string, data?: unknown): void {
    const event: PluginEvent = {
      type,
      pluginName,
      timestamp: new Date(),
      data,
    };
    this.emit(type, event);
  }

  // ============================================================================
  // Public API
  // ============================================================================

  /**
   * Get all loaded plugins
   */
  getPlugins(): LoadedPlugin[] {
    return Array.from(this.plugins.values());
  }

  /**
   * Get a plugin by name
   */
  getPlugin(name: string): LoadedPlugin | undefined {
    return this.plugins.get(name);
  }

  /**
   * Get plugins by type
   */
  getPluginsByType(type: PluginType): LoadedPlugin[] {
    return Array.from(this.plugins.values()).filter((p) => p.manifest.type === type);
  }

  /**
   * Check if a plugin is loaded
   */
  hasPlugin(name: string): boolean {
    return this.plugins.has(name);
  }

  /**
   * Get channel adapter factory for a plugin
   */
  getChannelAdapter(pluginName: string): RegisterChannelOptions | undefined {
    return this.channelAdapters.get(pluginName);
  }

  /**
   * Get all registered channel adapters
   */
  getChannelAdapters(): Map<string, RegisterChannelOptions> {
    return new Map(this.channelAdapters);
  }

  /**
   * Create a channel adapter instance from a plugin
   */
  createChannelAdapterFromPlugin(pluginName: string, config: ChannelConfig): ChannelAdapter | null {
    const adapterFactory = this.channelAdapters.get(pluginName);
    if (!adapterFactory) {
      return null;
    }

    return adapterFactory.createAdapter(config);
  }

  /**
   * Get all registered tools
   */
  getTools(): Map<string, RegisterToolOptions> {
    return new Map(this.tools);
  }

  /**
   * Get a specific tool
   */
  getTool(pluginName: string, toolName: string): RegisterToolOptions | undefined {
    return this.tools.get(`${pluginName}:${toolName}`);
  }

  /**
   * Enable a plugin
   */
  async enablePlugin(name: string): Promise<void> {
    const plugin = this.plugins.get(name);
    if (!plugin) {
      throw new Error(`Plugin not found: ${name}`);
    }

    if (plugin.state === "active") {
      return;
    }

    plugin.state = "active";
    this.emitPluginEvent("plugin:loaded", name);
  }

  /**
   * Disable a plugin
   */
  async disablePlugin(name: string): Promise<void> {
    const plugin = this.plugins.get(name);
    if (!plugin) {
      throw new Error(`Plugin not found: ${name}`);
    }

    if (plugin.state === "disabled") {
      return;
    }

    // Call unregister if available
    if (plugin.instance.unregister) {
      try {
        await plugin.instance.unregister();
      } catch (error) {
        console.error(`Error unregistering plugin ${name}:`, error);
      }
    }

    plugin.state = "disabled";
    this.emitPluginEvent("plugin:unregistered", name);
  }

  /**
   * Unload a plugin completely
   */
  async unloadPlugin(name: string): Promise<void> {
    await this.disablePlugin(name);

    // Remove from all registries
    this.plugins.delete(name);
    this.channelAdapters.delete(name);
    this.configs.delete(name);
    this.pluginEventHandlers.delete(name);

    // Remove tools for this plugin
    for (const key of this.tools.keys()) {
      if (key.startsWith(`${name}:`)) {
        this.tools.delete(key);
      }
    }

    // Remove skill ownership entries for this plugin
    for (const [skillId, owner] of this.skillOwnership) {
      if (owner === name) {
        this.skillOwnership.delete(skillId);
      }
    }
  }

  /**
   * Reload a plugin
   */
  async reloadPlugin(name: string): Promise<void> {
    const plugin = this.plugins.get(name);
    if (!plugin) {
      throw new Error(`Plugin not found: ${name}`);
    }

    const pluginPath = plugin.path;
    await this.unloadPlugin(name);

    // Clear require cache
    const entryPoint = path.join(pluginPath, plugin.manifest.main || "index.js");
    delete require.cache[require.resolve(entryPoint)];

    // Reload
    const result = await loadPlugin(pluginPath);
    if (result.success && result.plugin) {
      await this.loadAndRegister(pluginPath, result.plugin.manifest);
    }
  }

  /**
   * Get plugin configuration
   */
  getPluginConfig(name: string): Record<string, unknown> | undefined {
    return this.configs.get(name);
  }

  /**
   * Set plugin configuration
   */
  async setPluginConfig(name: string, config: Record<string, unknown>): Promise<void> {
    if (!this.plugins.has(name)) {
      throw new Error(`Plugin not found: ${name}`);
    }

    this.configs.set(name, config);
    await this.savePluginConfig(name, config);
    this.emitPluginEvent("plugin:config-changed", name, { config });
  }

  /**
   * Shutdown the registry
   */
  async shutdown(): Promise<void> {
    console.log("Shutting down plugin registry...");

    for (const [name, plugin] of this.plugins) {
      try {
        if (plugin.instance.unregister) {
          await plugin.instance.unregister();
        }
      } catch (error) {
        console.error(`Error unregistering plugin ${name}:`, error);
      }
    }

    this.plugins.clear();
    this.channelAdapters.clear();
    this.tools.clear();
    this.configs.clear();
    this.pluginEventHandlers.clear();
    this.skillOwnership.clear();
    this.initialized = false;

    console.log("Plugin registry shutdown complete");
  }
}

// Export singleton getter
export const getPluginRegistry = (): PluginRegistry => PluginRegistry.getInstance();
