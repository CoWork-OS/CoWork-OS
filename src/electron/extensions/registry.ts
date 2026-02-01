/**
 * Plugin Registry
 *
 * Central registry for managing loaded plugins.
 * Handles plugin lifecycle, configuration, and event dispatch.
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
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
} from './types';
import {
  discoverPlugins,
  loadPlugin,
  getPluginDataPath,
  isPluginCompatible,
} from './loader';
import { ChannelAdapter, ChannelConfig } from '../gateway/channels/types';

// Package version (will be replaced at build time or read from package.json)
const COWORK_VERSION = process.env.npm_package_version || '0.3.0';

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

  /** Event handlers by plugin */
  private pluginEventHandlers: Map<string, Map<string, Set<(data: unknown) => void>>> = new Map();

  /** Whether the registry has been initialized */
  private initialized = false;

  private constructor() {
    super();
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

    console.log('Initializing plugin registry...');

    // Discover plugins
    const discovered = await discoverPlugins(extensionDirs);
    console.log(`Discovered ${discovered.length} plugins`);

    // Load and register each plugin
    for (const { path: pluginPath, manifest } of discovered) {
      await this.loadAndRegister(pluginPath, manifest);
    }

    this.initialized = true;
    console.log(`Plugin registry initialized with ${this.plugins.size} plugins`);
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
      loadedPlugin.state = 'registered';

      this.emitPluginEvent('plugin:registered', pluginName);
      console.log(`Plugin ${pluginName} registered successfully`);
    } catch (error) {
      console.error(`Error registering plugin ${pluginName}:`, error);

      const loadedPlugin = this.plugins.get(pluginName);
      if (loadedPlugin) {
        loadedPlugin.state = 'error';
        loadedPlugin.error = error instanceof Error ? error : new Error(String(error));
      }

      this.emitPluginEvent('plugin:error', pluginName, { error });
    }
  }

  /**
   * Create the Plugin API for a specific plugin
   */
  private createPluginAPI(pluginName: string, loadedPlugin: LoadedPlugin): PluginAPI {
    const runtime: PluginRuntime = {
      version: COWORK_VERSION,
      platform: process.platform,
      appDataPath: app?.getPath?.('userData') || path.join(process.env.HOME || '', '.cowork'),
      pluginDataPath: getPluginDataPath(pluginName),
      isDev: process.env.NODE_ENV === 'development',
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
        this.emitPluginEvent('plugin:config-changed', pluginName, { config });
      },

      getSecureStorage: (): SecureStorage => {
        return this.createSecureStorage(pluginName);
      },

      log: (level: 'debug' | 'info' | 'warn' | 'error', message: string, ...args: unknown[]) => {
        const prefix = `[${pluginName}]`;
        switch (level) {
          case 'debug':
            console.debug(prefix, message, ...args);
            break;
          case 'info':
            console.log(prefix, message, ...args);
            break;
          case 'warn':
            console.warn(prefix, message, ...args);
            break;
          case 'error':
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
   * Create secure storage for a plugin
   */
  private createSecureStorage(pluginName: string): SecureStorage {
    // Use a simple file-based storage for now
    // In production, this should use the OS keychain
    const storagePath = path.join(getPluginDataPath(pluginName), '.secrets');

    const readSecrets = (): Record<string, string> => {
      if (!fs.existsSync(storagePath)) {
        return {};
      }
      try {
        return JSON.parse(fs.readFileSync(storagePath, 'utf-8'));
      } catch {
        return {};
      }
    };

    const writeSecrets = (secrets: Record<string, string>): void => {
      fs.writeFileSync(storagePath, JSON.stringify(secrets), { mode: 0o600 });
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
    const configPath = path.join(getPluginDataPath(pluginName), 'config.json');

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
      return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch {
      return {};
    }
  }

  /**
   * Save plugin configuration to disk
   */
  private async savePluginConfig(pluginName: string, config: Record<string, unknown>): Promise<void> {
    const configPath = path.join(getPluginDataPath(pluginName), 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
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
    return Array.from(this.plugins.values())
      .filter(p => p.manifest.type === type);
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

    if (plugin.state === 'active') {
      return;
    }

    plugin.state = 'active';
    this.emitPluginEvent('plugin:loaded', name);
  }

  /**
   * Disable a plugin
   */
  async disablePlugin(name: string): Promise<void> {
    const plugin = this.plugins.get(name);
    if (!plugin) {
      throw new Error(`Plugin not found: ${name}`);
    }

    if (plugin.state === 'disabled') {
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

    plugin.state = 'disabled';
    this.emitPluginEvent('plugin:unregistered', name);
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
    const entryPoint = path.join(pluginPath, plugin.manifest.main);
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
    this.emitPluginEvent('plugin:config-changed', name, { config });
  }

  /**
   * Shutdown the registry
   */
  async shutdown(): Promise<void> {
    console.log('Shutting down plugin registry...');

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
    this.initialized = false;

    console.log('Plugin registry shutdown complete');
  }
}

// Export singleton getter
export const getPluginRegistry = (): PluginRegistry => PluginRegistry.getInstance();
