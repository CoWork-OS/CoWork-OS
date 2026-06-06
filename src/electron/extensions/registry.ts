/**
 * Plugin Registry
 *
 * Central registry for managing loaded plugins.
 * Handles plugin lifecycle, configuration, and event dispatch.
 */

import { EventEmitter } from "events";
import * as fs from "fs";
import * as path from "path";
import {
  SecureSettingsRepository,
  type SettingsCategory,
} from "../database/SecureSettingsRepository";
import {
  Plugin as _Plugin,
  PluginManifest,
  LoadedPlugin,
  PluginState as _PluginState,
  PluginAPI,
  PluginRuntime,
  PluginEvent,
  PluginEventType,
  RegisterChannelOptions,
  RegisterToolOptions,
  SecureStorage,
  PluginType,
  SkillDirectoryDefinition,
} from "./types";
import { createToolFromConnector, validateConnector } from "./declarative-connector-loader";
import { discoverPlugins, loadPlugin, getPluginDataPath, isPluginCompatible } from "./loader";
import { ChannelAdapter, ChannelConfig } from "../gateway/channels/types";
import { getUserDataDir } from "../utils/user-data-dir";
import { getSafeStorage } from "../utils/safe-storage";
import { createLogger } from "../utils/logger";
import { isPackAllowed, isPackRequired, loadPoliciesStrict } from "../admin/policies";
import type { CustomSkill } from "../../shared/types";

// Package version (will be replaced at build time or read from package.json)
const COWORK_VERSION = process.env.npm_package_version || "0.3.0";
const logger = createLogger("PluginRegistry");

interface PersistedPackStates {
  updatedAt?: number;
  packs?: Record<string, boolean>;
  skills?: Record<string, Record<string, boolean>>;
}

function parseSkillMarkdownFrontmatter(markdown: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  if (!markdown.startsWith("---\n")) {
    return { frontmatter: {}, body: markdown };
  }
  const end = markdown.indexOf("\n---", 4);
  if (end === -1) {
    return { frontmatter: {}, body: markdown };
  }
  const rawFrontmatter = markdown.slice(4, end).trim();
  const body = markdown.slice(end + 4).replace(/^\s*\n/, "");
  const frontmatter: Record<string, string> = {};
  for (const line of rawFrontmatter.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    frontmatter[key] = value;
  }
  return { frontmatter, body };
}

function titleFromSkillId(id: string): string {
  const tail = id.split(":").pop() || id;
  return tail
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

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
  private initializationPromise: Promise<void> | null = null;

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
   * Load persisted pack toggle states from secure settings, with legacy disk fallback.
   */
  private loadPackStates(): void {
    const applyPersistedState = (data: PersistedPackStates | Record<string, boolean>): void => {
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        return;
      }

      const maybePayload = data as PersistedPackStates;
      const packs = maybePayload.packs || (data as Record<string, boolean>);
      for (const [name, enabled] of Object.entries(packs)) {
        if (typeof enabled === "boolean") {
          this.packStates.set(name, enabled);
        }
      }

      if (maybePayload.skills && typeof maybePayload.skills === "object") {
        for (const [packName, skills] of Object.entries(maybePayload.skills)) {
          if (!skills || typeof skills !== "object" || Array.isArray(skills)) continue;
          const skillMap = new Map<string, boolean>();
          for (const [skillId, enabled] of Object.entries(skills)) {
            if (typeof enabled === "boolean") {
              skillMap.set(skillId, enabled);
            }
          }
          if (skillMap.size > 0) {
            this.skillStates.set(packName, skillMap);
          }
        }
      }
    };

    if (SecureSettingsRepository.isInitialized()) {
      try {
        const repository = SecureSettingsRepository.getInstance();
        const stored = repository.load<PersistedPackStates>("plugin-packs");
        if (stored) {
          applyPersistedState(stored);
          return;
        }
      } catch (error) {
        logger.warn("Failed to load pack states from secure settings:", error);
      }
    }

    try {
      if (fs.existsSync(this.packStatesPath)) {
        const data = JSON.parse(fs.readFileSync(this.packStatesPath, "utf-8")) as
          | PersistedPackStates
          | Record<string, boolean>;
        applyPersistedState(data);
        if (SecureSettingsRepository.isInitialized()) {
          this.savePackStates();
        }
      }
    } catch {
      // Corrupted file, start fresh
    }
  }

  /**
   * Save pack toggle states to secure settings, with legacy disk fallback for early startup/tests.
   */
  savePackStates(): void {
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
    const payload: PersistedPackStates = { updatedAt: Date.now(), packs, skills };

    if (SecureSettingsRepository.isInitialized()) {
      try {
        SecureSettingsRepository.getInstance().save("plugin-packs", payload);
        return;
      } catch (error) {
        logger.warn("Failed to save pack states to secure settings:", error);
        throw error;
      }
    }

    try {
      const dir = path.dirname(this.packStatesPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.packStatesPath, JSON.stringify(payload, null, 2), "utf-8");
    } catch (error) {
      logger.warn("Failed to save pack states:", error);
    }
  }

  /**
   * Set and persist a pack's enabled state
   */
  setPackEnabled(name: string, enabled: boolean): void {
    const hadPreviousState = this.packStates.has(name);
    const previousState = this.packStates.get(name);
    this.packStates.set(name, enabled);
    try {
      this.savePackStates();
    } catch (error) {
      if (hadPreviousState && previousState !== undefined) {
        this.packStates.set(name, previousState);
      } else {
        this.packStates.delete(name);
      }
      throw error;
    }
  }

  /**
   * Restore a pack's persisted enabled state after a failed runtime transition.
   */
  restorePackEnabled(name: string, enabled: boolean | undefined): void {
    if (enabled === undefined) {
      this.packStates.delete(name);
    } else {
      this.packStates.set(name, enabled);
    }
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
    const hadSkillMap = this.skillStates.has(packName);
    const skillMap = this.skillStates.get(packName);
    const hadPreviousState = skillMap?.has(skillId) ?? false;
    const previousState = skillMap?.get(skillId);

    if (!skillMap) {
      this.skillStates.set(packName, new Map());
    }
    this.skillStates.get(packName)!.set(skillId, enabled);
    try {
      this.savePackStates();
    } catch (error) {
      if (!hadSkillMap) {
        this.skillStates.delete(packName);
      } else if (hadPreviousState && previousState !== undefined) {
        this.skillStates.get(packName)!.set(skillId, previousState);
      } else {
        this.skillStates.get(packName)!.delete(skillId);
      }
      throw error;
    }
  }

  /**
   * Get the persisted enabled state for a skill (undefined if not set)
   */
  getSkillEnabled(packName: string, skillId: string): boolean | undefined {
    return this.skillStates.get(packName)?.get(skillId);
  }

  /**
   * Apply persisted per-skill states to the manifest before it is sent to UI or registered.
   */
  private applyPersistedSkillStates(manifest: PluginManifest, pluginName: string): void {
    const savedSkillStates = this.skillStates.get(pluginName);
    if (!savedSkillStates) {
      return;
    }
    for (const skill of manifest.skills || []) {
      const savedSkillState = savedSkillStates.get(skill.id);
      if (savedSkillState !== undefined) {
        skill.enabled = savedSkillState;
      }
    }
    for (const skill of manifest.skillDirectories || []) {
      const savedSkillState = savedSkillStates.get(skill.id);
      if (savedSkillState !== undefined) {
        skill.enabled = savedSkillState;
      }
    }
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
    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    this.initializationPromise = (async () => {
      // Discover plugins
      const discovered = await discoverPlugins(extensionDirs);

      // Load and register each plugin
      for (const { path: pluginPath, manifest, securityReport } of discovered) {
        await this.loadAndRegister(pluginPath, manifest, securityReport || undefined);
      }

      this.initialized = true;

      if (this.plugins.size > 0) {
        logger.info(`Initialized with ${this.plugins.size} plugins`);
      }
    })().finally(() => {
      this.initializationPromise = null;
    });

    return this.initializationPromise;
  }

  /**
   * Re-scan extension directories for new plugins that weren't present at startup.
   * Unlike initialize(), this can be called multiple times to discover newly-added plugins.
   */
  async discoverNewPlugins(extensionDirs?: string[]): Promise<void> {
    const discovered = await discoverPlugins(extensionDirs);
    let newCount = 0;
    for (const { path: pluginPath, manifest, securityReport } of discovered) {
      if (!this.plugins.has(manifest.name)) {
        await this.loadAndRegister(pluginPath, manifest, securityReport || undefined);
        newCount++;
      }
    }
    if (newCount > 0) {
      logger.info(`Discovered ${newCount} new plugin(s)`);
    }
  }

  /**
   * Load and register a single plugin
   */
  private async loadAndRegister(
    pluginPath: string,
    manifest: PluginManifest,
    securityReport?: import("../../shared/types").CapabilitySecurityReport,
  ): Promise<void> {
    const pluginName = manifest.name;

    // Check compatibility
    if (!isPluginCompatible(manifest, COWORK_VERSION)) {
      logger.warn(`Plugin ${pluginName} requires CoWork ${manifest.coworkVersion}, skipping`);
      return;
    }

    // Check if already loaded
    if (this.plugins.has(pluginName)) {
      logger.warn(`Plugin ${pluginName} already loaded, skipping`);
      return;
    }

    const isPack = manifest.type === "pack";
    const policies = isPack ? loadPoliciesStrict() : null;
    const savedState = this.packStates.get(pluginName);
    const blockedByPolicy = isPack && (!policies || !isPackAllowed(pluginName, policies));
    const requiredByPolicy = isPack && !!policies && isPackRequired(pluginName, policies);
    const shouldStartDisabled =
      isPack && (blockedByPolicy || (savedState === false && !requiredByPolicy));

    if (shouldStartDisabled) {
      this.applyPersistedSkillStates(manifest, pluginName);
      const loadedPlugin: LoadedPlugin = {
        manifest,
        instance: {
          manifest,
          register: async () => {
            // Disabled packs do not execute plugin entrypoints.
          },
          unregister: async () => {
            // No runtime state was registered for disabled packs.
          },
        },
        path: pluginPath,
        state: "disabled",
        loadedAt: new Date(),
        securityReport,
      };
      this.plugins.set(pluginName, loadedPlugin);
      const config = this.loadPluginConfig(pluginName);
      this.configs.set(pluginName, config);
      this.emitPluginEvent("plugin:registered", pluginName);
      logger.debug(`Plugin ${pluginName} loaded disabled without executing runtime code`);
      return;
    }

    try {
      // Load the plugin
      const result = await loadPlugin(pluginPath);

      if (!result.success || !result.plugin) {
        logger.error(`Failed to load plugin ${pluginName}:`, result.error);
        return;
      }

      const loadedPlugin = result.plugin;
      if (securityReport) {
        loadedPlugin.securityReport = securityReport;
      }

      this.applyPersistedSkillStates(loadedPlugin.manifest, pluginName);
      this.plugins.set(pluginName, loadedPlugin);

      // Load configuration
      const config = this.loadPluginConfig(pluginName);
      this.configs.set(pluginName, config);

      if (!shouldStartDisabled) {
        // Create plugin API
        const api = this.createPluginAPI(pluginName, loadedPlugin);

        // Register the plugin
        await loadedPlugin.instance.register(api);

        // Handle composite declarative content (skills, agentRoles, connectors)
        await this.registerDeclarativeContent(loadedPlugin.manifest, pluginName, loadedPlugin.path);
      }

      loadedPlugin.state = shouldStartDisabled ? "disabled" : "registered";

      this.emitPluginEvent("plugin:registered", pluginName);
      logger.debug(`Plugin ${pluginName} registered successfully`);
    } catch (error) {
      logger.error(`Error registering plugin ${pluginName}:`, error);
      await this.removePluginRuntimeRegistrations(pluginName);

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
  private createPluginAPI(pluginName: string, _loadedPlugin: LoadedPlugin): PluginAPI {
    const runtime: PluginRuntime = {
      version: COWORK_VERSION,
      platform: process.platform,
      appDataPath: getUserDataDir(),
      pluginDataPath: getPluginDataPath(pluginName),
      isDev: process.env.NODE_ENV === "development",
    };

    return {
      runtime,

      registerChannel: (options: RegisterChannelOptions) => {
        this.channelAdapters.set(pluginName, options);
        logger.debug(`Channel adapter registered by plugin: ${pluginName}`);
      },

      registerTool: (options: RegisterToolOptions) => {
        const toolKey = `${pluginName}:${options.name}`;
        this.tools.set(toolKey, options);
        logger.debug(`Tool registered: ${toolKey}`);
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
              logger.error("Error in plugin event handler:", e);
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

  private buildDirectoryBackedSkill(
    definition: SkillDirectoryDefinition,
    pluginName: string,
    pluginPath: string,
  ): CustomSkill | null {
    const relativeDir = typeof definition.path === "string" ? definition.path.trim() : "";
    if (!definition.id || !relativeDir || path.isAbsolute(relativeDir)) {
      logger.warn(`Skipping invalid skill directory definition from ${pluginName}: ${definition.id}`);
      return null;
    }
    if (relativeDir.split(/[\\/]+/).includes("..")) {
      logger.warn(`Skipping skill directory path with parent traversal from ${pluginName}: ${relativeDir}`);
      return null;
    }

    const pluginRoot = path.resolve(pluginPath);
    const skillDir = path.resolve(pluginRoot, relativeDir);
    if (skillDir !== pluginRoot && !skillDir.startsWith(pluginRoot + path.sep)) {
      logger.warn(`Skipping skill directory outside plugin root from ${pluginName}: ${relativeDir}`);
      return null;
    }

    const skillPath = path.join(skillDir, "SKILL.md");
    if (!fs.existsSync(skillPath)) {
      logger.warn(`Skipping directory-backed skill without SKILL.md: ${skillPath}`);
      return null;
    }

    let markdown: string;
    try {
      markdown = fs.readFileSync(skillPath, "utf-8");
    } catch (error) {
      logger.warn(`Failed to read directory-backed skill ${skillPath}`, error);
      return null;
    }

    const { frontmatter, body } = parseSkillMarkdownFrontmatter(markdown);
    const name = definition.name || frontmatter.name || titleFromSkillId(definition.id);
    const description =
      definition.description ||
      frontmatter.description ||
      `Directory-backed skill from ${path.relative(pluginRoot, skillPath)}`;
    const prompt = [
      `Use the directory-backed CoWork plugin skill \`${definition.id}\`.`,
      "",
      `Plugin root: ${pluginRoot}`,
      `Skill directory: ${skillDir}`,
      `Skill instruction file: ${skillPath}`,
      "",
      "Read and follow the skill instructions below. When they reference relative paths such as ../../references, scripts/, or assets/, resolve them relative to the skill instruction file or plugin root as written. Preserve required artifact contracts, report validation steps, and phase boundaries.",
      "",
      body.trim(),
    ].join("\n");

    return {
      id: definition.id,
      name,
      description,
      icon: definition.icon || "🧩",
      category: definition.category || "Plugin",
      prompt,
      parameters: [],
      enabled: definition.enabled !== false,
      filePath: skillPath,
      source: "managed",
      metadata: {
        version: "1.0.0",
        pluginSource: pluginName,
        routing: {
          useWhen: description,
          outputs: "Task-specific result plus any artifacts required by the directory-backed skill.",
          successCriteria:
            "Follow the directory-backed skill instructions and satisfy its required artifact and validation contract.",
        },
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
    pluginPath: string,
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
            logger.warn(
              `Skill ID conflict: "${skill.id}" is defined by both "${existingOwner}" and "${pluginName}". The later registration will overwrite the earlier one.`,
            );
          }
          this.skillOwnership.set(skill.id, pluginName);

          skill.source = "managed" as const;
          skill.metadata = {
            ...skill.metadata,
            pluginSource: pluginName,
          };
          if (typeof loader.registerPluginSkill === "function") {
            loader.registerPluginSkill(skill);
          }
        }
        logger.debug(`Registered ${manifest.skills.length} skill(s) from ${pluginName}`);
      } catch (error) {
        logger.error(`Failed to register skills from ${pluginName}:`, error);
      }
    }

    // 1b. Register directory-backed skills.
    if (manifest.skillDirectories && manifest.skillDirectories.length > 0) {
      try {
        const { getCustomSkillLoader } = await import("../agent/custom-skill-loader");
        const loader = getCustomSkillLoader();
        let registered = 0;
        for (const skillDirectory of manifest.skillDirectories) {
          const skill = this.buildDirectoryBackedSkill(skillDirectory, pluginName, pluginPath);
          if (!skill) continue;

          const existingOwner = this.skillOwnership.get(skill.id);
          if (existingOwner && existingOwner !== pluginName) {
            logger.warn(
              `Skill ID conflict: "${skill.id}" is defined by both "${existingOwner}" and "${pluginName}". The later registration will overwrite the earlier one.`,
            );
          }
          this.skillOwnership.set(skill.id, pluginName);

          if (typeof loader.registerPluginSkill === "function") {
            loader.registerPluginSkill(skill);
            registered++;
          }
        }
        logger.debug(`Registered ${registered} directory-backed skill(s) from ${pluginName}`);
      } catch (error) {
        logger.error(`Failed to register directory-backed skills from ${pluginName}:`, error);
      }
    }

    // 2. Register agent roles
    if (manifest.agentRoles && manifest.agentRoles.length > 0) {
      for (const role of manifest.agentRoles) {
        try {
          this.emit("plugin:register-role", { pluginName, role });
        } catch (error) {
          logger.error(`Failed to emit role registration from ${pluginName}:`, error);
        }
      }
      logger.debug(`Emitted ${manifest.agentRoles.length} role(s) from ${pluginName}`);
    }

    // 3. Register declarative connectors as tools
    if (manifest.connectors && manifest.connectors.length > 0) {
      let registered = 0;
      for (const connector of manifest.connectors) {
        const validationError = validateConnector(connector);
        if (validationError) {
          logger.warn(
            `Skipping invalid connector ${connector.name} from ${pluginName}: ${validationError}`,
          );
          continue;
        }
        const toolOptions = createToolFromConnector(connector, pluginName);
        const toolKey = `${pluginName}:${toolOptions.name}`;
        this.tools.set(toolKey, toolOptions);
        registered++;
      }
      logger.debug(`Registered ${registered} connector(s) from ${pluginName}`);
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

  /**
   * Remove runtime registrations owned by a plugin without deleting the loaded manifest.
   */
  private async removePluginRuntimeRegistrations(pluginName: string): Promise<void> {
    try {
      const { getCustomSkillLoader } = await import("../agent/custom-skill-loader");
      getCustomSkillLoader().unregisterPluginSkills(pluginName);
    } catch (error) {
      logger.warn(`Failed to unregister plugin skills for ${pluginName}:`, error);
    }

    this.channelAdapters.delete(pluginName);
    this.pluginEventHandlers.delete(pluginName);

    for (const key of Array.from(this.tools.keys())) {
      if (key.startsWith(`${pluginName}:`)) {
        this.tools.delete(key);
      }
    }

    for (const [skillId, owner] of Array.from(this.skillOwnership.entries())) {
      if (owner === pluginName) {
        this.skillOwnership.delete(skillId);
      }
    }
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
   * Reconcile loaded pack runtime state after admin policy or persisted state changes.
   */
  async reconcilePackRuntimeState(): Promise<void> {
    const policies = loadPoliciesStrict();
    if (!policies) {
      logger.warn("Skipping plugin pack runtime reconciliation because policies failed to load");
      return;
    }
    for (const plugin of this.getPluginsByType("pack")) {
      const pluginName = plugin.manifest.name;
      const allowed = isPackAllowed(pluginName, policies);
      const required = isPackRequired(pluginName, policies);
      const savedState = this.packStates.get(pluginName);

      if (!allowed) {
        await this.disablePlugin(pluginName);
        continue;
      }

      if (plugin.state === "disabled") {
        if (required || savedState !== false) {
          await this.reloadPlugin(pluginName);
        }
        continue;
      }

      if (!required && savedState === false) {
        await this.disablePlugin(pluginName);
      }
    }
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
      await this.removePluginRuntimeRegistrations(name);
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

    await this.removePluginRuntimeRegistrations(name);

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
    this.configs.delete(name);
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
    const securityReport = plugin.securityReport;
    const previousPlugin = plugin;
    await this.unloadPlugin(name);

    // Clear require cache for script-based plugins.
    // Declarative plugins have no main entry point.
    if (plugin.manifest.main) {
      const entryPoint = path.join(pluginPath, plugin.manifest.main);
      try {
        delete require.cache[require.resolve(entryPoint)];
      } catch {
        // If resolution fails, continue with a fresh load attempt.
      }
    }

    // Reload
    const result = await loadPlugin(pluginPath);
    if (!result.success || !result.plugin) {
      previousPlugin.state = "disabled";
      this.plugins.set(name, previousPlugin);
      throw new Error(`Failed to reload plugin ${name}: ${result.error || "unknown error"}`);
    }

    await this.loadAndRegister(pluginPath, result.plugin.manifest, securityReport);
    const reloaded = this.plugins.get(name);
    if (!reloaded || reloaded.state === "error") {
      previousPlugin.state = "disabled";
      this.plugins.set(name, previousPlugin);
      throw new Error(`Failed to reload plugin ${name}`);
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
