/**
 * Plugin Pack Registry
 *
 * Remote registry for discovering and installing plugin packs.
 * Mirrors the SkillRegistry pattern with static catalog and REST API modes.
 */

/** Default registry URL — overridable via PLUGIN_PACK_REGISTRY env var */
const DEFAULT_REGISTRY_URL =
  process.env.PLUGIN_PACK_REGISTRY ||
  "https://raw.githubusercontent.com/CoWork-OS/CoWork-OS/main/registry";

const FETCH_TIMEOUT_MS = 15_000;

/** Cache TTL for the static catalog (5 minutes) */
const CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;

/** Regex for valid pack IDs */
const VALID_PACK_ID = /^[a-z0-9_-]+$/;

export interface PackRegistryEntry {
  id: string;
  name: string;
  displayName: string;
  description: string;
  version: string;
  author: string;
  icon?: string;
  category?: string;
  tags?: string[];
  downloadUrl?: string;
  gitUrl?: string;
  skillCount?: number;
  agentCount?: number;
  downloads?: number;
  rating?: number;
  updatedAt?: string;
}

export interface PackSearchResult {
  query: string;
  total: number;
  page: number;
  pageSize: number;
  results: PackRegistryEntry[];
}

export interface PackRegistryConfig {
  registryUrl?: string;
}

/**
 * Validate and sanitize a pack ID
 */
function sanitizePackId(packId: string): string | null {
  if (!packId || typeof packId !== "string") return null;

  const normalized = packId.trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > 128) return null;
  if (normalized.includes("..") || normalized.includes("/") || normalized.includes("\\"))
    return null;
  if (!VALID_PACK_ID.test(normalized)) return null;

  return normalized;
}

export class PackRegistry {
  private registryUrl: string;
  private catalogCache: { entries: PackRegistryEntry[]; fetchedAt: number } | null = null;

  constructor(config?: PackRegistryConfig) {
    this.registryUrl = config?.registryUrl || DEFAULT_REGISTRY_URL;
  }

  private async fetchWithTimeout(url: string): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      return await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Detect whether the registry URL points to a static catalog
   */
  private isStaticCatalog(): boolean {
    const url = this.registryUrl.toLowerCase();
    return (
      url.includes("raw.githubusercontent.com") ||
      url.includes("github.io") ||
      url.endsWith("/registry") ||
      url.endsWith("/registry/")
    );
  }

  /**
   * Fetch the static catalog.json and cache it
   */
  private async fetchCatalog(): Promise<PackRegistryEntry[]> {
    if (this.catalogCache && Date.now() - this.catalogCache.fetchedAt < CATALOG_CACHE_TTL_MS) {
      return this.catalogCache.entries;
    }

    try {
      const catalogUrl = this.registryUrl.endsWith("/")
        ? `${this.registryUrl}pack-catalog.json`
        : `${this.registryUrl}/pack-catalog.json`;

      const response = await this.fetchWithTimeout(catalogUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch pack catalog: ${response.status}`);
      }

      const data = (await response.json()) as { packs?: PackRegistryEntry[] };
      const entries = Array.isArray(data.packs) ? data.packs : [];
      this.catalogCache = { entries, fetchedAt: Date.now() };
      console.log(`[PackRegistry] Loaded catalog with ${entries.length} packs`);
      return entries;
    } catch (error) {
      console.error("[PackRegistry] Failed to fetch catalog:", error);
      return this.catalogCache?.entries || [];
    }
  }

  /**
   * Search the registry for packs
   */
  async search(
    query: string,
    options?: { page?: number; pageSize?: number; category?: string },
  ): Promise<PackSearchResult> {
    const page = options?.page ?? 1;
    const pageSize = options?.pageSize ?? 20;
    const category = options?.category;

    // Static catalog mode: fetch and filter client-side
    if (this.isStaticCatalog()) {
      return this.searchCatalog(query, page, pageSize, category);
    }

    try {
      const url = new URL(`${this.registryUrl}/packs/search`);
      url.searchParams.set("q", query);
      url.searchParams.set("page", String(page));
      url.searchParams.set("pageSize", String(pageSize));
      if (category) url.searchParams.set("category", category);

      const response = await this.fetchWithTimeout(url.toString());
      if (!response.ok) {
        throw new Error(`Registry search failed: ${response.status}`);
      }

      return (await response.json()) as PackSearchResult;
    } catch (error) {
      console.error("[PackRegistry] Search failed:", error);
      return { query, total: 0, page, pageSize, results: [] };
    }
  }

  /**
   * Search the cached catalog client-side
   */
  private async searchCatalog(
    query: string,
    page: number,
    pageSize: number,
    category?: string,
  ): Promise<PackSearchResult> {
    try {
      const entries = await this.fetchCatalog();
      const q = (query || "").toLowerCase().trim();

      let filtered = entries;

      // Filter by category if specified
      if (category) {
        filtered = filtered.filter(
          (p) => (p.category || "").toLowerCase() === category.toLowerCase(),
        );
      }

      // Filter by search query
      if (q) {
        filtered = filtered.filter(
          (p) =>
            p.name.toLowerCase().includes(q) ||
            p.displayName.toLowerCase().includes(q) ||
            p.description.toLowerCase().includes(q) ||
            p.id.toLowerCase().includes(q) ||
            (p.tags || []).some((t) => t.toLowerCase().includes(q)) ||
            (p.category || "").toLowerCase().includes(q),
        );
      }

      const start = (page - 1) * pageSize;
      const results = filtered.slice(start, start + pageSize);

      return { query, total: filtered.length, page, pageSize, results };
    } catch (error) {
      console.error("[PackRegistry] Catalog search failed:", error);
      return { query, total: 0, page, pageSize, results: [] };
    }
  }

  /**
   * Get pack details from registry
   */
  async getPackDetails(packId: string): Promise<PackRegistryEntry | null> {
    const safeId = sanitizePackId(packId);
    if (!safeId) {
      console.error(`[PackRegistry] Invalid pack ID: ${packId}`);
      return null;
    }

    // Static catalog mode
    if (this.isStaticCatalog()) {
      const entries = await this.fetchCatalog();
      return entries.find((p) => p.id === safeId) || null;
    }

    try {
      const response = await this.fetchWithTimeout(`${this.registryUrl}/packs/${safeId}`);
      if (!response.ok) {
        if (response.status === 404) return null;
        throw new Error(`Failed to get pack details: ${response.status}`);
      }
      return (await response.json()) as PackRegistryEntry;
    } catch (error) {
      console.error(`[PackRegistry] Failed to get pack ${packId}:`, error);
      return null;
    }
  }

  /**
   * Get available categories from the catalog
   */
  async getCategories(): Promise<string[]> {
    if (this.isStaticCatalog()) {
      const entries = await this.fetchCatalog();
      const categories = new Set(entries.map((p) => p.category).filter(Boolean) as string[]);
      return Array.from(categories).sort();
    }

    try {
      const response = await this.fetchWithTimeout(`${this.registryUrl}/packs/categories`);
      if (!response.ok) return [];
      const data = (await response.json()) as { categories?: string[] };
      return data.categories || [];
    } catch {
      return [];
    }
  }

  /**
   * Check for updates to installed packs by comparing local versions with registry versions.
   * Returns a list of packs that have newer versions available.
   */
  async checkUpdates(
    installedPacks: { name: string; version: string }[],
  ): Promise<{ name: string; currentVersion: string; latestVersion: string }[]> {
    const updates: { name: string; currentVersion: string; latestVersion: string }[] = [];

    try {
      if (this.isStaticCatalog()) {
        const entries = await this.fetchCatalog();
        const registryMap = new Map(entries.map((e) => [e.name || e.id, e]));

        for (const pack of installedPacks) {
          const registryEntry = registryMap.get(pack.name);
          if (registryEntry && registryEntry.version && pack.version) {
            if (this.isNewerVersion(registryEntry.version, pack.version)) {
              updates.push({
                name: pack.name,
                currentVersion: pack.version,
                latestVersion: registryEntry.version,
              });
            }
          }
        }
      } else {
        for (const pack of installedPacks) {
          const registryEntry = await this.getPackDetails(pack.name);
          if (!registryEntry || !registryEntry.version || !pack.version) {
            continue;
          }

          if (this.isNewerVersion(registryEntry.version, pack.version)) {
            updates.push({
              name: pack.name,
              currentVersion: pack.version,
              latestVersion: registryEntry.version,
            });
          }
        }
      }
    } catch (error) {
      console.error("[PackRegistry] Failed to check for updates:", error);
    }

    return updates;
  }

  /**
   * Simple semver comparison: returns true if `remote` is newer than `local`
   */
  private isNewerVersion(remote: string, local: string): boolean {
    const r = remote.split(".").map(Number);
    const l = local.split(".").map(Number);
    for (let i = 0; i < 3; i++) {
      const rv = r[i] || 0;
      const lv = l[i] || 0;
      if (rv > lv) return true;
      if (rv < lv) return false;
    }
    return false;
  }

  /**
   * Clear the catalog cache (force re-fetch on next query)
   */
  clearCache(): void {
    this.catalogCache = null;
  }

  /**
   * Get the registry URL
   */
  getRegistryUrl(): string {
    return this.registryUrl;
  }
}

/** Singleton instance */
let instance: PackRegistry | null = null;

export function getPackRegistry(): PackRegistry {
  if (!instance) {
    instance = new PackRegistry();
  }
  return instance;
}
