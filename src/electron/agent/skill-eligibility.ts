/**
 * Skill Eligibility Checker
 *
 * Determines if a skill is eligible to run based on its requirements:
 * - Required binaries (bins)
 * - Any-of binaries (anyBins)
 * - Environment variables (env)
 * - Config paths (config)
 * - Operating system (os)
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import {
  CustomSkill,
  SkillEligibility,
  SkillStatusEntry,
  SkillsConfig,
} from '../../shared/types';

const execAsync = promisify(exec);

// Regex for valid binary names: alphanumeric, hyphens, underscores, dots
// This prevents command injection via malicious binary names
const VALID_BINARY_NAME = /^[a-zA-Z0-9._-]+$/;

/**
 * Validate and sanitize a binary name to prevent command injection
 * Returns null if the binary name is invalid/unsafe
 */
function sanitizeBinaryName(bin: string): string | null {
  if (!bin || typeof bin !== 'string') {
    return null;
  }

  // Trim whitespace
  const trimmed = bin.trim();

  // Check length limits (reasonable binary name length)
  if (trimmed.length === 0 || trimmed.length > 256) {
    return null;
  }

  // Validate against allowed pattern
  if (!VALID_BINARY_NAME.test(trimmed)) {
    console.warn(`[SkillEligibilityChecker] Invalid binary name rejected: ${bin}`);
    return null;
  }

  return trimmed;
}

export class SkillEligibilityChecker {
  private binCache: Map<string, boolean> = new Map();
  private config?: SkillsConfig;

  constructor(config?: SkillsConfig) {
    this.config = config;
  }

  /**
   * Check if a binary exists in PATH
   */
  async checkBinary(bin: string): Promise<boolean> {
    // Sanitize binary name to prevent command injection
    const safeBin = sanitizeBinaryName(bin);
    if (!safeBin) {
      // Invalid binary name - treat as not found
      return false;
    }

    // Check cache first
    if (this.binCache.has(safeBin)) {
      return this.binCache.get(safeBin)!;
    }

    try {
      // Use 'which' on Unix-like systems, 'where' on Windows
      const command = process.platform === 'win32' ? `where ${safeBin}` : `which ${safeBin}`;
      await execAsync(command);
      this.binCache.set(safeBin, true);
      return true;
    } catch {
      this.binCache.set(safeBin, false);
      return false;
    }
  }

  /**
   * Check if all specified binaries exist
   */
  async checkAllBinaries(bins: string[]): Promise<{ found: string[]; missing: string[] }> {
    const results = await Promise.all(
      bins.map(async (bin) => ({
        bin,
        exists: await this.checkBinary(bin),
      }))
    );

    return {
      found: results.filter((r) => r.exists).map((r) => r.bin),
      missing: results.filter((r) => !r.exists).map((r) => r.bin),
    };
  }

  /**
   * Check if at least one of the specified binaries exists
   */
  async checkAnyBinary(bins: string[]): Promise<{ found: string[]; missing: string[] }> {
    const results = await Promise.all(
      bins.map(async (bin) => ({
        bin,
        exists: await this.checkBinary(bin),
      }))
    );

    const found = results.filter((r) => r.exists).map((r) => r.bin);
    // If any binary is found, none are "missing" for anyBins requirement
    // If none are found, all are missing
    const missing = found.length > 0 ? [] : bins;

    return { found, missing };
  }

  /**
   * Check if an environment variable is set
   */
  checkEnvVar(envVar: string): boolean {
    const value = process.env[envVar];
    return value !== undefined && value !== '';
  }

  /**
   * Check if all specified environment variables are set
   */
  checkAllEnvVars(envVars: string[]): { found: string[]; missing: string[] } {
    const found: string[] = [];
    const missing: string[] = [];

    for (const envVar of envVars) {
      if (this.checkEnvVar(envVar)) {
        found.push(envVar);
      } else {
        missing.push(envVar);
      }
    }

    return { found, missing };
  }

  /**
   * Check if config path is truthy (placeholder for future config system)
   */
  checkConfigPath(configPath: string): boolean {
    // TODO: Implement config path checking when config system is available
    // For now, always return false (missing)
    return false;
  }

  /**
   * Check if all specified config paths are truthy
   */
  checkAllConfigPaths(configPaths: string[]): { found: string[]; missing: string[] } {
    const found: string[] = [];
    const missing: string[] = [];

    for (const configPath of configPaths) {
      if (this.checkConfigPath(configPath)) {
        found.push(configPath);
      } else {
        missing.push(configPath);
      }
    }

    return { found, missing };
  }

  /**
   * Check if current OS matches required OS
   */
  checkOS(requiredOS: string[]): { matches: boolean; current: string; missing: string[] } {
    const current = process.platform;
    const matches = requiredOS.length === 0 || requiredOS.includes(current);

    return {
      matches,
      current,
      missing: matches ? [] : requiredOS,
    };
  }

  /**
   * Check if a skill is blocked by allowlist/denylist
   */
  isBlockedByList(skillId: string): boolean {
    if (!this.config) return false;

    // Check denylist first
    if (this.config.denylist?.includes(skillId)) {
      return true;
    }

    // Check allowlist (if set, skill must be in it)
    if (this.config.allowlist && this.config.allowlist.length > 0) {
      return !this.config.allowlist.includes(skillId);
    }

    return false;
  }

  /**
   * Check all requirements for a skill and return eligibility status
   */
  async checkEligibility(skill: CustomSkill): Promise<SkillEligibility> {
    const missing = {
      bins: [] as string[],
      anyBins: [] as string[],
      env: [] as string[],
      config: [] as string[],
      os: [] as string[],
    };

    const requires = skill.requires;

    // Check required binaries
    if (requires?.bins && requires.bins.length > 0) {
      const binCheck = await this.checkAllBinaries(requires.bins);
      missing.bins = binCheck.missing;
    }

    // Check any-of binaries
    if (requires?.anyBins && requires.anyBins.length > 0) {
      const anyBinCheck = await this.checkAnyBinary(requires.anyBins);
      missing.anyBins = anyBinCheck.missing;
    }

    // Check environment variables
    if (requires?.env && requires.env.length > 0) {
      const envCheck = this.checkAllEnvVars(requires.env);
      missing.env = envCheck.missing;
    }

    // Check config paths
    if (requires?.config && requires.config.length > 0) {
      const configCheck = this.checkAllConfigPaths(requires.config);
      missing.config = configCheck.missing;
    }

    // Check OS
    if (requires?.os && requires.os.length > 0) {
      const osCheck = this.checkOS(requires.os);
      missing.os = osCheck.missing;
    }

    // Check if skill is disabled
    const disabled = skill.enabled === false;

    // Check if blocked by allowlist/denylist
    const blockedByAllowlist = this.isBlockedByList(skill.id);

    // Skill is eligible if not disabled, not blocked, and no missing requirements
    const hasMissingRequirements =
      missing.bins.length > 0 ||
      missing.anyBins.length > 0 ||
      missing.env.length > 0 ||
      missing.config.length > 0 ||
      missing.os.length > 0;

    const eligible = !disabled && !blockedByAllowlist && !hasMissingRequirements;

    return {
      eligible,
      disabled,
      blockedByAllowlist,
      missing,
    };
  }

  /**
   * Build a full status entry for a skill
   */
  async buildStatusEntry(skill: CustomSkill): Promise<SkillStatusEntry> {
    const eligibility = await this.checkEligibility(skill);
    const requires = skill.requires || {};

    return {
      ...skill,
      eligible: eligibility.eligible,
      disabled: eligibility.disabled,
      blockedByAllowlist: eligibility.blockedByAllowlist,
      requirements: {
        bins: requires.bins || [],
        anyBins: requires.anyBins || [],
        env: requires.env || [],
        config: requires.config || [],
        os: requires.os || [],
      },
      missing: eligibility.missing,
    };
  }

  /**
   * Build status entries for multiple skills
   */
  async buildStatusEntries(skills: CustomSkill[]): Promise<SkillStatusEntry[]> {
    return Promise.all(skills.map((skill) => this.buildStatusEntry(skill)));
  }

  /**
   * Clear the binary cache (useful after installations)
   */
  clearCache(): void {
    this.binCache.clear();
  }

  /**
   * Update config (for allowlist/denylist changes)
   */
  updateConfig(config: SkillsConfig): void {
    this.config = config;
  }
}

// Singleton instance
let instance: SkillEligibilityChecker | null = null;

export function getSkillEligibilityChecker(config?: SkillsConfig): SkillEligibilityChecker {
  if (!instance) {
    instance = new SkillEligibilityChecker(config);
  } else if (config) {
    instance.updateConfig(config);
  }
  return instance;
}
