/**
 * Plugin Loader
 *
 * Discovers, validates, and loads plugins from cowork.plugin.json manifests.
 * Plugins can be loaded from:
 * - Built-in extensions directory
 * - User extensions directory (~/.cowork/extensions)
 * - Explicitly specified paths
 */

import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import {
  PluginManifest,
  Plugin,
  LoadedPlugin,
  PluginLoadResult,
  PluginDiscoveryResult,
  PluginState,
  PluginConfigSchema,
} from "./types";

/** Manifest filename */
const MANIFEST_FILENAME = "cowork.plugin.json";

/** Default extensions directories */
const getDefaultExtensionsDirs = (): string[] => {
  const dirs: string[] = [];

  // Built-in extensions (relative to app)
  const builtinDir = path.join(__dirname, "..", "extensions");
  if (fs.existsSync(builtinDir)) {
    dirs.push(builtinDir);
  }

  // Built-in plugin packs
  const isDev = process.env.NODE_ENV === "development";
  const pluginPacksDir = isDev
    ? path.join(process.cwd(), "resources", "plugin-packs")
    : path.join(process.resourcesPath || "", "plugin-packs");
  if (fs.existsSync(pluginPacksDir)) {
    dirs.push(pluginPacksDir);
  }

  // User extensions directory
  const userDataPath = app?.getPath?.("userData") || path.join(process.env.HOME || "", ".cowork");
  const userExtensionsDir = path.join(userDataPath, "extensions");
  if (fs.existsSync(userExtensionsDir)) {
    dirs.push(userExtensionsDir);
  }

  return dirs;
};

/**
 * Validate a plugin manifest
 */
export function validateManifest(manifest: unknown): manifest is PluginManifest {
  if (!manifest || typeof manifest !== "object") {
    return false;
  }

  const m = manifest as Record<string, unknown>;

  // Required fields
  if (typeof m.name !== "string" || !m.name) {
    throw new Error("Plugin manifest missing required field: name");
  }

  if (typeof m.displayName !== "string" || !m.displayName) {
    throw new Error("Plugin manifest missing required field: displayName");
  }

  if (typeof m.version !== "string" || !m.version) {
    throw new Error("Plugin manifest missing required field: version");
  }

  if (typeof m.description !== "string") {
    throw new Error("Plugin manifest missing required field: description");
  }

  if (
    typeof m.type !== "string" ||
    !["channel", "tool", "provider", "integration", "pack"].includes(m.type)
  ) {
    throw new Error(
      "Plugin manifest has invalid type. Must be: channel, tool, provider, integration, or pack",
    );
  }

  // main is required UNLESS declarative content is present
  const hasDeclarativeContent = !!(m.skills || m.agentRoles || m.connectors || m.slashCommands);
  if (!hasDeclarativeContent && (typeof m.main !== "string" || !m.main)) {
    throw new Error(
      "Plugin manifest missing required field: main (or provide declarative content: skills, agentRoles, connectors, slashCommands)",
    );
  }

  // Validate version format (semver-like)
  if (!/^\d+\.\d+\.\d+/.test(m.version)) {
    throw new Error("Plugin version must be valid semver (e.g., 1.0.0)");
  }

  // Validate config schema if present
  if (m.configSchema) {
    validateConfigSchema(m.configSchema as PluginConfigSchema);
  }

  return true;
}

/**
 * Validate configuration schema
 */
function validateConfigSchema(schema: PluginConfigSchema): void {
  if (schema.type !== "object") {
    throw new Error('Config schema type must be "object"');
  }

  if (!schema.properties || typeof schema.properties !== "object") {
    throw new Error("Config schema must have properties");
  }

  for (const [key, prop] of Object.entries(schema.properties)) {
    if (!prop.type) {
      throw new Error(`Config property "${key}" missing type`);
    }

    const validTypes = ["string", "number", "boolean", "array", "object"];
    if (!validTypes.includes(prop.type)) {
      throw new Error(`Config property "${key}" has invalid type: ${prop.type}`);
    }
  }
}

/**
 * Discover plugins in a directory
 */
export async function discoverPlugins(dirs?: string[]): Promise<PluginDiscoveryResult[]> {
  const searchDirs = dirs || getDefaultExtensionsDirs();
  const results: PluginDiscoveryResult[] = [];

  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) {
      continue;
    }

    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const pluginDir = path.join(dir, entry.name);
      const manifestPath = path.join(pluginDir, MANIFEST_FILENAME);

      if (!fs.existsSync(manifestPath)) {
        continue;
      }

      try {
        const manifestContent = fs.readFileSync(manifestPath, "utf-8");
        const manifest = JSON.parse(manifestContent);

        if (validateManifest(manifest)) {
          results.push({
            path: pluginDir,
            manifest,
          });
        }
      } catch (error) {
        console.warn(`Failed to load plugin manifest from ${manifestPath}:`, error);
      }
    }
  }

  return results;
}

/**
 * Load a plugin from its directory
 */
export async function loadPlugin(pluginPath: string): Promise<PluginLoadResult> {
  const manifestPath = path.join(pluginPath, MANIFEST_FILENAME);

  // Check manifest exists
  if (!fs.existsSync(manifestPath)) {
    return {
      success: false,
      error: new Error(`Plugin manifest not found: ${manifestPath}`),
    };
  }

  try {
    // Read and validate manifest
    const manifestContent = fs.readFileSync(manifestPath, "utf-8");
    const manifest = JSON.parse(manifestContent);

    if (!validateManifest(manifest)) {
      return {
        success: false,
        error: new Error("Invalid plugin manifest"),
      };
    }

    // Check platform compatibility
    if (manifest.platform?.os) {
      if (!manifest.platform.os.includes(process.platform)) {
        return {
          success: false,
          error: new Error(`Plugin does not support platform: ${process.platform}`),
        };
      }
    }

    // Declarative-only plugins (no main entry point)
    if (!manifest.main) {
      const declarativePlugin: Plugin = {
        manifest,
        register: async () => {
          // Registration of declarative content is handled by the registry
        },
      };

      const loadedPlugin: LoadedPlugin = {
        manifest,
        instance: declarativePlugin,
        path: pluginPath,
        state: "loaded",
        loadedAt: new Date(),
      };

      return { success: true, plugin: loadedPlugin };
    }

    // Resolve entry point
    const entryPoint = path.join(pluginPath, manifest.main);
    if (!fs.existsSync(entryPoint)) {
      return {
        success: false,
        error: new Error(`Plugin entry point not found: ${entryPoint}`),
      };
    }

    // Load the plugin module
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pluginModule = require(entryPoint);
    const plugin: Plugin = pluginModule.default || pluginModule;

    // Validate plugin interface
    if (typeof plugin.register !== "function") {
      return {
        success: false,
        error: new Error("Plugin must export a register function"),
      };
    }

    // Attach manifest to plugin
    plugin.manifest = manifest;

    const loadedPlugin: LoadedPlugin = {
      manifest,
      instance: plugin,
      path: pluginPath,
      state: "loaded",
      loadedAt: new Date(),
    };

    return {
      success: true,
      plugin: loadedPlugin,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/**
 * Create the user extensions directory if it doesn't exist
 */
export function ensureExtensionsDirectory(): string {
  const userDataPath = app?.getPath?.("userData") || path.join(process.env.HOME || "", ".cowork");
  const extensionsDir = path.join(userDataPath, "extensions");

  if (!fs.existsSync(extensionsDir)) {
    fs.mkdirSync(extensionsDir, { recursive: true });
  }

  return extensionsDir;
}

/**
 * Get the path to a plugin's data directory
 */
export function getPluginDataPath(pluginName: string): string {
  const userDataPath = app?.getPath?.("userData") || path.join(process.env.HOME || "", ".cowork");
  const pluginDataDir = path.join(userDataPath, "plugin-data", pluginName);

  if (!fs.existsSync(pluginDataDir)) {
    fs.mkdirSync(pluginDataDir, { recursive: true });
  }

  return pluginDataDir;
}

/**
 * Check if a plugin is compatible with current CoWork version
 */
export function isPluginCompatible(manifest: PluginManifest, coworkVersion: string): boolean {
  if (!manifest.coworkVersion) {
    return true; // No version constraint
  }

  // Minimum version check: current must be >= required.
  // We intentionally ignore pre-release/build metadata and compare just X.Y.Z.
  const parse = (version: string): [number, number, number] | null => {
    const match = version.trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
    if (!match) {
      return null;
    }
    return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
  };

  const required = parse(manifest.coworkVersion);
  if (!required) {
    return false;
  }

  const current = parse(coworkVersion);
  if (!current) {
    // If we cannot parse our own version, be permissive rather than breaking plugin loads.
    return true;
  }

  for (let i = 0; i < 3; i++) {
    if (current[i] > required[i]) return true;
    if (current[i] < required[i]) return false;
  }

  return true;
}

/**
 * Generate a template plugin manifest
 */
export function generateManifestTemplate(
  name: string,
  type: "channel" | "tool" | "provider" | "integration" = "channel",
): PluginManifest {
  return {
    name: name.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
    displayName: name,
    version: "1.0.0",
    description: `${name} plugin for CoWork`,
    type,
    main: "dist/index.js",
    configSchema: {
      type: "object",
      properties: {
        enabled: {
          type: "boolean",
          description: "Enable this plugin",
          default: true,
        },
      },
      required: [],
    },
    capabilities:
      type === "channel"
        ? {
            sendMessage: true,
            receiveMessage: true,
            attachments: false,
            reactions: false,
          }
        : undefined,
    keywords: [type, name.toLowerCase()],
  };
}

/**
 * Write a manifest template to a plugin directory
 */
export function writeManifestTemplate(pluginDir: string, manifest: PluginManifest): void {
  if (!fs.existsSync(pluginDir)) {
    fs.mkdirSync(pluginDir, { recursive: true });
  }

  const manifestPath = path.join(pluginDir, MANIFEST_FILENAME);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
}
