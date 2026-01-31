/**
 * Skill Registry Service
 *
 * Handles communication with the remote skill registry for:
 * - Searching skills
 * - Installing skills
 * - Updating skills
 * - Publishing skills (future)
 */

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import {
  CustomSkill,
  SkillRegistryEntry,
  SkillSearchResult,
  SkillInstallProgress,
} from '../../shared/types';

// Default registry URL - can be overridden via SKILLHUB_REGISTRY env var
const DEFAULT_REGISTRY_URL = process.env.SKILLHUB_REGISTRY || 'https://skill-hub.com/api';
const SKILLS_FOLDER_NAME = 'skills';

// Regex for valid skill IDs: lowercase alphanumeric, hyphens, underscores
// This prevents path traversal attacks via malicious skill IDs
const VALID_SKILL_ID = /^[a-z0-9_-]+$/;

/**
 * Validate and sanitize a skill ID to prevent path traversal
 * Returns null if the skill ID is invalid/unsafe
 */
function sanitizeSkillId(skillId: string): string | null {
  if (!skillId || typeof skillId !== 'string') {
    return null;
  }

  // Trim whitespace and convert to lowercase
  const normalized = skillId.trim().toLowerCase();

  // Check length limits
  if (normalized.length === 0 || normalized.length > 128) {
    return null;
  }

  // Reject path traversal attempts
  if (normalized.includes('..') || normalized.includes('/') || normalized.includes('\\')) {
    console.warn(`[SkillRegistry] Path traversal attempt rejected: ${skillId}`);
    return null;
  }

  // Validate against allowed pattern
  if (!VALID_SKILL_ID.test(normalized)) {
    console.warn(`[SkillRegistry] Invalid skill ID rejected: ${skillId}`);
    return null;
  }

  return normalized;
}

export interface SkillRegistryConfig {
  registryUrl?: string;
  managedSkillsDir?: string;
}

export type InstallProgressCallback = (progress: SkillInstallProgress) => void;

export class SkillRegistry {
  private registryUrl: string;
  private managedSkillsDir: string;

  constructor(config?: SkillRegistryConfig) {
    this.registryUrl = config?.registryUrl || DEFAULT_REGISTRY_URL;
    this.managedSkillsDir =
      config?.managedSkillsDir ||
      path.join(app.getPath('userData'), SKILLS_FOLDER_NAME);

    // Ensure managed skills directory exists
    this.ensureSkillsDirectory();
  }

  /**
   * Ensure the managed skills directory exists
   */
  private ensureSkillsDirectory(): void {
    if (!fs.existsSync(this.managedSkillsDir)) {
      fs.mkdirSync(this.managedSkillsDir, { recursive: true });
      console.log(`[SkillRegistry] Created managed skills directory: ${this.managedSkillsDir}`);
    }
  }

  /**
   * Get the managed skills directory path
   */
  getManagedSkillsDir(): string {
    return this.managedSkillsDir;
  }

  /**
   * Search the registry for skills
   */
  async search(query: string, options?: { page?: number; pageSize?: number }): Promise<SkillSearchResult> {
    const page = options?.page ?? 1;
    const pageSize = options?.pageSize ?? 20;

    try {
      const url = new URL(`${this.registryUrl}/skills/search`);
      url.searchParams.set('q', query);
      url.searchParams.set('page', String(page));
      url.searchParams.set('pageSize', String(pageSize));

      const response = await fetch(url.toString());

      if (!response.ok) {
        throw new Error(`Registry search failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      return data as SkillSearchResult;
    } catch (error) {
      console.error('[SkillRegistry] Search failed:', error);
      // Return empty result on error
      return {
        query,
        total: 0,
        page,
        pageSize,
        results: [],
      };
    }
  }

  /**
   * Get skill details from registry
   */
  async getSkillDetails(skillId: string): Promise<SkillRegistryEntry | null> {
    // Validate skill ID
    const safeId = sanitizeSkillId(skillId);
    if (!safeId) {
      console.error(`[SkillRegistry] Invalid skill ID: ${skillId}`);
      return null;
    }

    try {
      const response = await fetch(`${this.registryUrl}/skills/${safeId}`);

      if (!response.ok) {
        if (response.status === 404) {
          return null;
        }
        throw new Error(`Failed to get skill details: ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      console.error(`[SkillRegistry] Failed to get skill ${skillId}:`, error);
      return null;
    }
  }

  /**
   * Install a skill from the registry
   */
  async install(
    skillId: string,
    version?: string,
    onProgress?: InstallProgressCallback
  ): Promise<{ success: boolean; skill?: CustomSkill; error?: string }> {
    // Validate skill ID before any operations
    const safeId = sanitizeSkillId(skillId);
    if (!safeId) {
      return { success: false, error: `Invalid skill ID: ${skillId}` };
    }

    const notify = (progress: Partial<SkillInstallProgress>) => {
      onProgress?.({
        skillId: safeId,
        status: 'downloading',
        ...progress,
      } as SkillInstallProgress);
    };

    try {
      notify({ status: 'downloading', progress: 0, message: 'Fetching skill from registry...' });

      // Fetch skill data from registry
      const url = version
        ? `${this.registryUrl}/skills/${safeId}/download?version=${version}`
        : `${this.registryUrl}/skills/${safeId}/download`;

      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`Failed to download skill: ${response.status} ${response.statusText}`);
      }

      notify({ status: 'downloading', progress: 50, message: 'Downloading skill data...' });

      const skillData = await response.json();

      notify({ status: 'extracting', progress: 70, message: 'Processing skill...' });

      // Validate skill data
      if (!this.validateSkillData(skillData)) {
        throw new Error('Invalid skill data received from registry');
      }

      notify({ status: 'installing', progress: 80, message: 'Installing skill...' });

      // Save skill to managed skills directory (using validated safeId)
      const skillPath = path.join(this.managedSkillsDir, `${safeId}.json`);
      const skill: CustomSkill = {
        ...skillData,
        source: 'managed',
        filePath: skillPath,
      };

      fs.writeFileSync(skillPath, JSON.stringify(skill, null, 2), 'utf-8');

      notify({ status: 'completed', progress: 100, message: 'Skill installed successfully' });

      console.log(`[SkillRegistry] Installed skill: ${safeId} at ${skillPath}`);

      return { success: true, skill };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[SkillRegistry] Install failed for ${safeId}:`, errorMessage);

      notify({ status: 'failed', progress: 0, message: errorMessage, error: errorMessage });

      return { success: false, error: errorMessage };
    }
  }

  /**
   * Update a managed skill to the latest version
   */
  async update(
    skillId: string,
    version?: string,
    onProgress?: InstallProgressCallback
  ): Promise<{ success: boolean; skill?: CustomSkill; error?: string }> {
    // Validate skill ID
    const safeId = sanitizeSkillId(skillId);
    if (!safeId) {
      return { success: false, error: `Invalid skill ID: ${skillId}` };
    }

    // Check if skill is installed
    const skillPath = path.join(this.managedSkillsDir, `${safeId}.json`);
    if (!fs.existsSync(skillPath)) {
      return { success: false, error: `Skill ${safeId} is not installed` };
    }

    // Re-install with latest version
    return this.install(safeId, version, onProgress);
  }

  /**
   * Update all managed skills
   */
  async updateAll(
    onProgress?: (skillId: string, progress: SkillInstallProgress) => void
  ): Promise<{ updated: string[]; failed: string[] }> {
    const updated: string[] = [];
    const failed: string[] = [];

    const managedSkills = this.listManagedSkills();

    for (const skill of managedSkills) {
      const result = await this.update(skill.id, undefined, (progress) => {
        onProgress?.(skill.id, progress);
      });

      if (result.success) {
        updated.push(skill.id);
      } else {
        failed.push(skill.id);
      }
    }

    return { updated, failed };
  }

  /**
   * Uninstall a managed skill
   */
  uninstall(skillId: string): { success: boolean; error?: string } {
    // Validate skill ID
    const safeId = sanitizeSkillId(skillId);
    if (!safeId) {
      return { success: false, error: `Invalid skill ID: ${skillId}` };
    }

    const skillPath = path.join(this.managedSkillsDir, `${safeId}.json`);

    if (!fs.existsSync(skillPath)) {
      return { success: false, error: `Skill ${safeId} is not installed` };
    }

    try {
      fs.unlinkSync(skillPath);
      console.log(`[SkillRegistry] Uninstalled skill: ${safeId}`);
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[SkillRegistry] Uninstall failed for ${safeId}:`, errorMessage);
      return { success: false, error: errorMessage };
    }
  }

  /**
   * List all managed (installed from registry) skills
   */
  listManagedSkills(): CustomSkill[] {
    const skills: CustomSkill[] = [];

    if (!fs.existsSync(this.managedSkillsDir)) {
      return skills;
    }

    const files = fs.readdirSync(this.managedSkillsDir);

    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      try {
        const filePath = path.join(this.managedSkillsDir, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        const skill = JSON.parse(content) as CustomSkill;
        skill.filePath = filePath;
        skill.source = 'managed';
        skills.push(skill);
      } catch (error) {
        console.error(`[SkillRegistry] Failed to load managed skill ${file}:`, error);
      }
    }

    return skills;
  }

  /**
   * Check if a skill is installed
   */
  isInstalled(skillId: string): boolean {
    // Validate skill ID
    const safeId = sanitizeSkillId(skillId);
    if (!safeId) {
      return false;
    }

    const skillPath = path.join(this.managedSkillsDir, `${safeId}.json`);
    return fs.existsSync(skillPath);
  }

  /**
   * Get installed skill version
   */
  getInstalledVersion(skillId: string): string | null {
    // Validate skill ID
    const safeId = sanitizeSkillId(skillId);
    if (!safeId) {
      return null;
    }

    const skillPath = path.join(this.managedSkillsDir, `${safeId}.json`);

    if (!fs.existsSync(skillPath)) {
      return null;
    }

    try {
      const content = fs.readFileSync(skillPath, 'utf-8');
      const skill = JSON.parse(content) as CustomSkill;
      return skill.metadata?.version || null;
    } catch {
      return null;
    }
  }

  /**
   * Check for available updates
   */
  async checkForUpdates(skillId: string): Promise<{
    hasUpdate: boolean;
    currentVersion: string | null;
    latestVersion: string | null;
  }> {
    // Validate skill ID (getInstalledVersion and getSkillDetails also validate, but check early)
    const safeId = sanitizeSkillId(skillId);
    if (!safeId) {
      return { hasUpdate: false, currentVersion: null, latestVersion: null };
    }

    const currentVersion = this.getInstalledVersion(safeId);
    const details = await this.getSkillDetails(safeId);

    if (!details) {
      return { hasUpdate: false, currentVersion, latestVersion: null };
    }

    const hasUpdate = currentVersion !== details.version;

    return {
      hasUpdate,
      currentVersion,
      latestVersion: details.version,
    };
  }

  /**
   * Validate skill data from registry
   */
  private validateSkillData(data: unknown): data is CustomSkill {
    if (!data || typeof data !== 'object') return false;

    const skill = data as Record<string, unknown>;

    return (
      typeof skill.id === 'string' &&
      typeof skill.name === 'string' &&
      typeof skill.description === 'string' &&
      typeof skill.prompt === 'string'
    );
  }

  /**
   * Update registry URL
   */
  setRegistryUrl(url: string): void {
    this.registryUrl = url;
  }

  /**
   * Get current registry URL
   */
  getRegistryUrl(): string {
    return this.registryUrl;
  }
}

// Singleton instance
let instance: SkillRegistry | null = null;

export function getSkillRegistry(config?: SkillRegistryConfig): SkillRegistry {
  if (!instance) {
    instance = new SkillRegistry(config);
  }
  return instance;
}

/**
 * Reset the singleton instance (useful for testing)
 */
export function resetSkillRegistry(): void {
  instance = null;
}
