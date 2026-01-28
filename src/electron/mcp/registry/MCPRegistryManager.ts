/**
 * MCPRegistryManager - Manages discovery and installation of MCP servers from a registry
 *
 * Provides functionality to:
 * - Fetch the MCP server registry
 * - Search for servers by name, tags, or category
 * - Install servers from the registry
 * - Check for updates to installed servers
 */

import { v4 as uuidv4 } from 'uuid';
import { exec } from 'child_process';
import { promisify } from 'util';
import {
  MCPRegistry,
  MCPRegistryEntry,
  MCPRegistrySearchOptions,
  MCPServerConfig,
  MCPUpdateInfo,
} from '../types';
import { MCPSettingsManager } from '../settings';

const execAsync = promisify(exec);

// Cache duration in milliseconds (15 minutes)
const REGISTRY_CACHE_DURATION = 15 * 60 * 1000;

// Built-in registry of common MCP servers
// This is used as a fallback when the remote registry is unavailable
// Package versions verified against npm registry as of 2026-01
const BUILTIN_REGISTRY: MCPRegistry = {
  version: '1.1.0',
  lastUpdated: new Date().toISOString(),
  servers: [
    {
      id: 'filesystem',
      name: 'Filesystem',
      description: 'Provides secure file system access with configurable root directories',
      version: '2026.1.14',
      author: 'Anthropic',
      homepage: 'https://modelcontextprotocol.io',
      repository: 'https://github.com/modelcontextprotocol/servers',
      license: 'MIT',
      installMethod: 'npm',
      installCommand: 'npx',
      packageName: '@modelcontextprotocol/server-filesystem',
      transport: 'stdio',
      defaultCommand: 'npx',
      defaultArgs: ['-y', '@modelcontextprotocol/server-filesystem'],
      tools: [
        { name: 'read_file', description: 'Read complete file contents' },
        { name: 'read_multiple_files', description: 'Read multiple files at once' },
        { name: 'write_file', description: 'Write content to file' },
        { name: 'edit_file', description: 'Edit file with line-based operations' },
        { name: 'create_directory', description: 'Create a new directory' },
        { name: 'list_directory', description: 'List directory contents' },
        { name: 'directory_tree', description: 'Get recursive directory tree' },
        { name: 'move_file', description: 'Move or rename files and directories' },
        { name: 'search_files', description: 'Search for files matching pattern' },
        { name: 'get_file_info', description: 'Get file metadata' },
      ],
      tags: ['filesystem', 'files', 'official'],
      category: 'filesystem',
      verified: true,
      featured: true,
    },
    {
      id: 'github',
      name: 'GitHub',
      description: 'Provides GitHub API integration for repository management. Requires GITHUB_PERSONAL_ACCESS_TOKEN.',
      version: '2025.4.8',
      author: 'Anthropic',
      homepage: 'https://modelcontextprotocol.io',
      repository: 'https://github.com/modelcontextprotocol/servers',
      license: 'MIT',
      installMethod: 'npm',
      installCommand: 'npx',
      packageName: '@modelcontextprotocol/server-github',
      transport: 'stdio',
      defaultCommand: 'npx',
      defaultArgs: ['-y', '@modelcontextprotocol/server-github'],
      defaultEnv: {
        GITHUB_PERSONAL_ACCESS_TOKEN: '',
      },
      tools: [
        { name: 'create_or_update_file', description: 'Create or update a file in a repository' },
        { name: 'search_repositories', description: 'Search GitHub repositories' },
        { name: 'create_repository', description: 'Create a new repository' },
        { name: 'get_file_contents', description: 'Get contents of a file in a repository' },
        { name: 'push_files', description: 'Push multiple files to a repository' },
        { name: 'create_issue', description: 'Create a new issue' },
        { name: 'create_pull_request', description: 'Create a pull request' },
        { name: 'fork_repository', description: 'Fork a repository' },
        { name: 'create_branch', description: 'Create a new branch' },
      ],
      tags: ['github', 'git', 'version-control', 'official'],
      category: 'development',
      verified: true,
      featured: true,
    },
    {
      id: 'puppeteer',
      name: 'Puppeteer',
      description: 'Browser automation and web scraping using Puppeteer',
      version: '2025.5.12',
      author: 'Anthropic',
      homepage: 'https://modelcontextprotocol.io',
      repository: 'https://github.com/modelcontextprotocol/servers',
      license: 'MIT',
      installMethod: 'npm',
      installCommand: 'npx',
      packageName: '@modelcontextprotocol/server-puppeteer',
      transport: 'stdio',
      defaultCommand: 'npx',
      defaultArgs: ['-y', '@modelcontextprotocol/server-puppeteer'],
      tools: [
        { name: 'puppeteer_navigate', description: 'Navigate to a URL' },
        { name: 'puppeteer_screenshot', description: 'Take a screenshot of the page' },
        { name: 'puppeteer_click', description: 'Click an element on the page' },
        { name: 'puppeteer_fill', description: 'Fill out an input field' },
        { name: 'puppeteer_select', description: 'Select an option from a dropdown' },
        { name: 'puppeteer_hover', description: 'Hover over an element' },
        { name: 'puppeteer_evaluate', description: 'Execute JavaScript in the page' },
      ],
      tags: ['browser', 'automation', 'web', 'official'],
      category: 'automation',
      verified: true,
    },
    {
      id: 'memory',
      name: 'Memory',
      description: 'Knowledge graph-based persistent memory system',
      version: '2026.1.26',
      author: 'Anthropic',
      homepage: 'https://modelcontextprotocol.io',
      repository: 'https://github.com/modelcontextprotocol/servers',
      license: 'MIT',
      installMethod: 'npm',
      installCommand: 'npx',
      packageName: '@modelcontextprotocol/server-memory',
      transport: 'stdio',
      defaultCommand: 'npx',
      defaultArgs: ['-y', '@modelcontextprotocol/server-memory'],
      tools: [
        { name: 'create_entities', description: 'Create new entities in the knowledge graph' },
        { name: 'create_relations', description: 'Create relations between entities' },
        { name: 'add_observations', description: 'Add observations to entities' },
        { name: 'delete_entities', description: 'Delete entities from the graph' },
        { name: 'delete_observations', description: 'Delete observations from entities' },
        { name: 'delete_relations', description: 'Delete relations between entities' },
        { name: 'read_graph', description: 'Read the entire knowledge graph' },
        { name: 'search_nodes', description: 'Search for nodes in the graph' },
        { name: 'open_nodes', description: 'Open specific nodes by name' },
      ],
      tags: ['memory', 'knowledge-graph', 'persistence', 'official'],
      category: 'memory',
      verified: true,
    },
    {
      id: 'postgres',
      name: 'PostgreSQL',
      description: 'PostgreSQL database read-only queries. Requires POSTGRES_CONNECTION_STRING.',
      version: '0.6.2',
      author: 'Anthropic',
      homepage: 'https://modelcontextprotocol.io',
      repository: 'https://github.com/modelcontextprotocol/servers',
      license: 'MIT',
      installMethod: 'npm',
      installCommand: 'npx',
      packageName: '@modelcontextprotocol/server-postgres',
      transport: 'stdio',
      defaultCommand: 'npx',
      defaultArgs: ['-y', '@modelcontextprotocol/server-postgres'],
      defaultEnv: {
        POSTGRES_CONNECTION_STRING: '',
      },
      tools: [
        { name: 'query', description: 'Execute a read-only SQL query' },
      ],
      tags: ['database', 'postgres', 'sql', 'official'],
      category: 'database',
      verified: true,
    },
    {
      id: 'sequential-thinking',
      name: 'Sequential Thinking',
      description: 'MCP server for sequential thinking and problem solving',
      version: '2025.12.18',
      author: 'Anthropic',
      homepage: 'https://modelcontextprotocol.io',
      repository: 'https://github.com/modelcontextprotocol/servers',
      license: 'MIT',
      installMethod: 'npm',
      installCommand: 'npx',
      packageName: '@modelcontextprotocol/server-sequential-thinking',
      transport: 'stdio',
      defaultCommand: 'npx',
      defaultArgs: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
      tools: [
        { name: 'sequentialthinking', description: 'Sequential thinking and problem solving' },
      ],
      tags: ['thinking', 'reasoning', 'official'],
      category: 'reasoning',
      verified: true,
    },
    {
      id: 'everything',
      name: 'Everything (Demo)',
      description: 'MCP server that exercises all features of the MCP protocol. Useful for testing.',
      version: '2026.1.26',
      author: 'Anthropic',
      homepage: 'https://modelcontextprotocol.io',
      repository: 'https://github.com/modelcontextprotocol/servers',
      license: 'MIT',
      installMethod: 'npm',
      installCommand: 'npx',
      packageName: '@modelcontextprotocol/server-everything',
      transport: 'stdio',
      defaultCommand: 'npx',
      defaultArgs: ['-y', '@modelcontextprotocol/server-everything'],
      tools: [
        { name: 'echo', description: 'Echo back the input' },
        { name: 'add', description: 'Add two numbers' },
        { name: 'longRunningOperation', description: 'Test long-running operations' },
        { name: 'sampleLLM', description: 'Sample from an LLM' },
        { name: 'getTinyImage', description: 'Get a tiny test image' },
      ],
      tags: ['demo', 'testing', 'official'],
      category: 'testing',
      verified: true,
    },
  ],
};

export class MCPRegistryManager {
  private static registryCache: MCPRegistry | null = null;
  private static cacheTimestamp: number = 0;

  /**
   * Fetch the MCP server registry
   */
  static async fetchRegistry(forceRefresh: boolean = false): Promise<MCPRegistry> {
    // Check cache
    if (!forceRefresh && this.registryCache && Date.now() - this.cacheTimestamp < REGISTRY_CACHE_DURATION) {
      return this.registryCache;
    }

    const settings = MCPSettingsManager.loadSettings();

    if (!settings.registryEnabled) {
      console.log('[MCPRegistryManager] Registry disabled, using built-in registry');
      return BUILTIN_REGISTRY;
    }

    try {
      console.log(`[MCPRegistryManager] Fetching registry from ${settings.registryUrl}`);

      const response = await fetch(settings.registryUrl, {
        headers: {
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(10000), // 10 second timeout
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const registry = await response.json() as MCPRegistry;

      // Validate registry structure
      if (!registry.version || !Array.isArray(registry.servers)) {
        throw new Error('Invalid registry format');
      }

      // Update cache
      this.registryCache = registry;
      this.cacheTimestamp = Date.now();

      console.log(`[MCPRegistryManager] Fetched ${registry.servers.length} servers from registry`);
      return registry;
    } catch (error: any) {
      // Only log on first failure or after cache expires
      if (!this.registryCache) {
        console.warn('[MCPRegistryManager] Failed to fetch registry, using built-in:', error.message);
      }
      // Cache the built-in registry to prevent repeated fetch attempts
      this.registryCache = BUILTIN_REGISTRY;
      this.cacheTimestamp = Date.now();
      return BUILTIN_REGISTRY;
    }
  }

  /**
   * Search for servers in the registry
   */
  static async searchServers(options: MCPRegistrySearchOptions = {}): Promise<MCPRegistryEntry[]> {
    const registry = await this.fetchRegistry();
    let results = [...registry.servers];

    // Filter by query (search name and description)
    if (options.query) {
      const query = options.query.toLowerCase();
      results = results.filter(
        (server) =>
          server.name.toLowerCase().includes(query) ||
          server.description.toLowerCase().includes(query) ||
          server.tags.some((tag) => tag.toLowerCase().includes(query))
      );
    }

    // Filter by tags
    if (options.tags && options.tags.length > 0) {
      const tags = options.tags.map((t) => t.toLowerCase());
      results = results.filter((server) =>
        tags.some((tag) => server.tags.some((t) => t.toLowerCase() === tag))
      );
    }

    // Filter by category
    if (options.category) {
      const category = options.category.toLowerCase();
      results = results.filter(
        (server) => server.category?.toLowerCase() === category
      );
    }

    // Filter by verified status
    if (options.verified !== undefined) {
      results = results.filter((server) => server.verified === options.verified);
    }

    // Apply pagination
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 50;
    results = results.slice(offset, offset + limit);

    return results;
  }

  /**
   * Get a specific server from the registry by ID
   */
  static async getServer(serverId: string): Promise<MCPRegistryEntry | null> {
    const registry = await this.fetchRegistry();
    return registry.servers.find((s) => s.id === serverId) || null;
  }

  /**
   * Verify that an npm package exists on the registry
   */
  static async verifyNpmPackage(packageName: string): Promise<{ exists: boolean; version?: string; error?: string }> {
    try {
      console.log(`[MCPRegistryManager] Verifying npm package: ${packageName}`);
      const { stdout } = await execAsync(`npm view ${packageName} version`, {
        timeout: 15000, // 15 second timeout
      });
      const version = stdout.trim();
      console.log(`[MCPRegistryManager] Package ${packageName} exists, version: ${version}`);
      return { exists: true, version };
    } catch (error: any) {
      // Check if it's a 404 (package not found)
      if (error.message?.includes('404') || error.message?.includes('not found') || error.stderr?.includes('404')) {
        console.warn(`[MCPRegistryManager] Package ${packageName} not found on npm`);
        return { exists: false, error: `Package "${packageName}" not found on npm registry` };
      }
      // Other errors (network, timeout, etc.)
      console.warn(`[MCPRegistryManager] Error verifying package ${packageName}:`, error.message);
      return { exists: false, error: `Failed to verify package: ${error.message}` };
    }
  }

  /**
   * Install a server from the registry
   */
  static async installServer(entryId: string, extraArgs?: string[]): Promise<MCPServerConfig> {
    const entry = await this.getServer(entryId);
    if (!entry) {
      throw new Error(`Server ${entryId} not found in registry`);
    }

    console.log(`[MCPRegistryManager] Installing server: ${entry.name}`);

    // Check if already installed
    const settings = MCPSettingsManager.loadSettings();
    const existingIndex = settings.servers.findIndex(
      (s) => s.name === entry.name || (entry.packageName && s.command?.includes(entry.packageName))
    );

    if (existingIndex !== -1) {
      throw new Error(`Server ${entry.name} is already installed`);
    }

    // Verify the npm package exists before installing
    if (entry.packageName && entry.installMethod === 'npm') {
      const verification = await this.verifyNpmPackage(entry.packageName);
      if (!verification.exists) {
        throw new Error(verification.error || `Package "${entry.packageName}" is not available`);
      }
      // Update version to the actual npm version if available
      if (verification.version) {
        entry.version = verification.version;
      }
    }

    // Create server config from registry entry
    const config: MCPServerConfig = {
      id: uuidv4(),
      name: entry.name,
      description: entry.description,
      enabled: true,
      transport: entry.transport,
      command: entry.defaultCommand || entry.installCommand,
      args: [...(entry.defaultArgs || []), ...(extraArgs || [])],
      env: entry.defaultEnv,
      version: entry.version,
      author: entry.author,
      homepage: entry.homepage,
      repository: entry.repository,
      license: entry.license,
      installedAt: Date.now(),
    };

    // Add to settings
    MCPSettingsManager.addServer(config);

    console.log(`[MCPRegistryManager] Installed server: ${entry.name}`);
    return config;
  }

  /**
   * Uninstall a server (remove from settings)
   */
  static async uninstallServer(serverId: string): Promise<void> {
    console.log(`[MCPRegistryManager] Uninstalling server: ${serverId}`);
    MCPSettingsManager.removeServer(serverId);
    console.log(`[MCPRegistryManager] Uninstalled server: ${serverId}`);
  }

  /**
   * Check for updates to installed servers
   */
  static async checkForUpdates(): Promise<MCPUpdateInfo[]> {
    const registry = await this.fetchRegistry(true);
    const settings = MCPSettingsManager.loadSettings();
    const updates: MCPUpdateInfo[] = [];

    for (const installed of settings.servers) {
      // Try to match installed server with registry entry
      const entry = registry.servers.find(
        (e) =>
          e.name === installed.name ||
          (e.packageName && installed.command?.includes(e.packageName))
      );

      if (entry && installed.version && entry.version !== installed.version) {
        // Compare versions
        if (this.isNewerVersion(entry.version, installed.version)) {
          updates.push({
            serverId: installed.id,
            currentVersion: installed.version,
            latestVersion: entry.version,
            registryEntry: entry,
          });
        }
      }
    }

    return updates;
  }

  /**
   * Update an installed server to the latest version
   */
  static async updateServer(serverId: string): Promise<MCPServerConfig> {
    const settings = MCPSettingsManager.loadSettings();
    const installed = settings.servers.find((s) => s.id === serverId);

    if (!installed) {
      throw new Error(`Server ${serverId} not found`);
    }

    const registry = await this.fetchRegistry(true);
    const entry = registry.servers.find(
      (e) =>
        e.name === installed.name ||
        (e.packageName && installed.command?.includes(e.packageName))
    );

    if (!entry) {
      throw new Error(`Server ${installed.name} not found in registry`);
    }

    // Update the server config
    const updatedConfig: Partial<MCPServerConfig> = {
      version: entry.version,
      command: entry.defaultCommand || entry.installCommand,
      args: entry.defaultArgs,
    };

    const result = MCPSettingsManager.updateServer(serverId, updatedConfig);
    if (!result) {
      throw new Error(`Failed to update server ${serverId}`);
    }
    return result;
  }

  /**
   * Get available categories from the registry
   */
  static async getCategories(): Promise<string[]> {
    const registry = await this.fetchRegistry();
    const categories = new Set<string>();

    for (const server of registry.servers) {
      if (server.category) {
        categories.add(server.category);
      }
    }

    return Array.from(categories).sort();
  }

  /**
   * Get all unique tags from the registry
   */
  static async getTags(): Promise<string[]> {
    const registry = await this.fetchRegistry();
    const tags = new Set<string>();

    for (const server of registry.servers) {
      for (const tag of server.tags) {
        tags.add(tag);
      }
    }

    return Array.from(tags).sort();
  }

  /**
   * Clear the registry cache
   */
  static clearCache(): void {
    this.registryCache = null;
    this.cacheTimestamp = 0;
  }

  /**
   * Check if version A is newer than version B
   */
  private static isNewerVersion(versionA: string, versionB: string): boolean {
    const partsA = versionA.replace(/^v/, '').split('.').map(Number);
    const partsB = versionB.replace(/^v/, '').split('.').map(Number);

    for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
      const a = partsA[i] || 0;
      const b = partsB[i] || 0;

      if (a > b) return true;
      if (a < b) return false;
    }

    return false;
  }
}
