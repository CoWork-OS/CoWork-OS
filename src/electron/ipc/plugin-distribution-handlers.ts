/**
 * Plugin Pack Distribution IPC Handlers
 *
 * Handles scaffolding, installation (git/URL), uninstallation,
 * and remote registry queries for plugin packs.
 */

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/types";
import { scaffoldPluginPack, getAvailableCategories } from "../extensions/scaffold";
import { installFromGit, installFromUrl, uninstallPack } from "../extensions/pack-installer";
import { getPackRegistry } from "../extensions/pack-registry";
import { PluginRegistry } from "../extensions/registry";
import { loadPolicies } from "../admin/policies";

/**
 * Set up Plugin Pack Distribution IPC handlers
 */
export function setupPluginDistributionHandlers(): void {
  // Scaffold a new plugin pack
  ipcMain.handle(
    IPC_CHANNELS.PLUGIN_PACK_SCAFFOLD,
    async (
      _,
      options: {
        name: string;
        displayName: string;
        description?: string;
        category?: string;
        icon?: string;
        author?: string;
        personaTemplateId?: string;
      },
    ) => {
      if (!options?.name || !options?.displayName) {
        return { success: false, error: "Pack name and displayName are required" };
      }

      // Policy enforcement
      const policies = loadPolicies();
      if (!policies.general.allowCustomPacks) {
        return { success: false, error: "Custom plugin packs are disabled by admin policy" };
      }

      const result = await scaffoldPluginPack({
        name: options.name,
        displayName: options.displayName,
        description: options.description,
        category: options.category,
        icon: options.icon,
        author: options.author,
        personaTemplateId: options.personaTemplateId,
        includeExampleSkill: true,
        includeExampleAgent: true,
      });

      // If successful, trigger discovery to pick up the new pack
      if (result.success) {
        try {
          const registry = PluginRegistry.getInstance();
          await registry.discoverNewPlugins();
        } catch (error) {
          console.warn("[PluginDistribution] Failed to discover new plugins after scaffold:", error);
        }
      }

      return result;
    },
  );

  // Install from git repository
  ipcMain.handle(IPC_CHANNELS.PLUGIN_PACK_INSTALL_GIT, async (_, gitUrl: string) => {
    if (!gitUrl || typeof gitUrl !== "string") {
      return { success: false, error: "Git URL is required" };
    }

    // Policy enforcement
    const gitPolicies = loadPolicies();
    if (!gitPolicies.general.allowGitInstall) {
      return { success: false, error: "Git-based plugin installation is disabled by admin policy" };
    }

    const result = await installFromGit(gitUrl);

    // If successful, trigger discovery to register the new pack
    if (result.success) {
      try {
        const registry = PluginRegistry.getInstance();
        await registry.discoverNewPlugins();
      } catch (error) {
        console.warn("[PluginDistribution] Failed to discover new plugins after git install:", error);
      }
    }

    return result;
  });

  // Install from URL (manifest download)
  ipcMain.handle(IPC_CHANNELS.PLUGIN_PACK_INSTALL_URL, async (_, url: string) => {
    if (!url || typeof url !== "string") {
      return { success: false, error: "URL is required" };
    }

    // Policy enforcement
    const urlPolicies = loadPolicies();
    if (!urlPolicies.general.allowUrlInstall) {
      return { success: false, error: "URL-based plugin installation is disabled by admin policy" };
    }

    const result = await installFromUrl(url);

    // If successful, trigger discovery to register the new pack
    if (result.success) {
      try {
        const registry = PluginRegistry.getInstance();
        await registry.discoverNewPlugins();
      } catch (error) {
        console.warn("[PluginDistribution] Failed to discover new plugins after URL install:", error);
      }
    }

    return result;
  });

  // Uninstall a user-installed pack
  ipcMain.handle(IPC_CHANNELS.PLUGIN_PACK_UNINSTALL, async (_, packName: string) => {
    if (!packName || typeof packName !== "string") {
      return { success: false, error: "Pack name is required" };
    }

    const result = await uninstallPack(packName);

    // If successful, unload from registry
    if (result.success) {
      try {
        const registry = PluginRegistry.getInstance();
        const canonicalPackName = result.packName || packName;
        try {
          await registry.unloadPlugin(canonicalPackName);
        } finally {
          registry.purgePackState(canonicalPackName);
        }
      } catch (error) {
        console.warn("[PluginDistribution] Failed to unload plugin after uninstall:", error);
      }
    }

    return result;
  });

  // Search remote pack registry
  ipcMain.handle(
    IPC_CHANNELS.PLUGIN_PACK_REGISTRY_SEARCH,
    async (_, query: string, options?: { page?: number; pageSize?: number; category?: string }) => {
      const packRegistry = getPackRegistry();
      return packRegistry.search(query || "", options);
    },
  );

  // Get pack details from remote registry
  ipcMain.handle(IPC_CHANNELS.PLUGIN_PACK_REGISTRY_DETAILS, async (_, packId: string) => {
    if (!packId || typeof packId !== "string") {
      return null;
    }
    const packRegistry = getPackRegistry();
    return packRegistry.getPackDetails(packId);
  });

  // Get available categories from remote registry
  ipcMain.handle(IPC_CHANNELS.PLUGIN_PACK_REGISTRY_CATEGORIES, async () => {
    const packRegistry = getPackRegistry();
    return packRegistry.getCategories();
  });

  // Check for pack updates against remote registry
  ipcMain.handle(IPC_CHANNELS.PLUGIN_PACK_CHECK_UPDATES, async () => {
    const pluginRegistry = PluginRegistry.getInstance();
    const packs = pluginRegistry.getPluginsByType("pack");
    const installedPacks = packs.map((p) => ({
      name: p.manifest.name,
      version: p.manifest.version,
    }));
    const packRegistry = getPackRegistry();
    return packRegistry.checkUpdates(installedPacks);
  });
}
