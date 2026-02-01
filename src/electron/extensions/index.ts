/**
 * CoWork Extension System
 *
 * Provides a plugin architecture for extending CoWork with:
 * - Channel adapters (messaging platforms)
 * - Tools (agent capabilities)
 * - Providers (LLM, search, etc.)
 * - Integrations (external services)
 *
 * Plugins are defined via cowork.plugin.json manifests and can be:
 * - Built-in (shipped with CoWork)
 * - User-installed (~/.cowork/extensions)
 * - Dynamically loaded at runtime
 */

export * from './types';
export * from './loader';
export * from './registry';
