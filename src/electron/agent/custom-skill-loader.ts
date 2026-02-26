/**
 * Custom Skill Loader
 *
 * Loads skills from multiple sources with precedence:
 * - Bundled skills (resources/skills/) - lowest precedence
 * - Managed skills (~/Library/Application Support/cowork-os/skills/) - medium precedence
 * - Workspace skills (workspace/skills/) - highest precedence
 *
 * Skills with the same ID from higher precedence sources override lower ones.
 */

import * as fs from "fs";
import * as path from "path";
import {
  CustomSkill,
  SkillSource,
  SkillStatusEntry,
  SkillStatusReport,
  SkillsConfig,
} from "../../shared/types";
import { SkillEligibilityChecker, getSkillEligibilityChecker } from "./skill-eligibility";
import { getSkillRegistry as _getSkillRegistry } from "./skill-registry";
import { InputSanitizer } from "./security";
import { getUserDataDir } from "../utils/user-data-dir";

const SKILLS_FOLDER_NAME = "skills";
const SKILL_FILE_EXTENSION = ".json";
const RELOAD_DEBOUNCE_MS = 100; // Debounce rapid reload calls

export interface SkillLoaderConfig {
  bundledSkillsDir?: string;
  managedSkillsDir?: string;
  workspaceSkillsDir?: string;
  skillsConfig?: SkillsConfig;
}

export class CustomSkillLoader {
  private static readonly LOW_SIGNAL_ROUTING_HINT_PATTERNS = {
    dontUseWhen: [/planning documents,\s*high-level strategy,\s*or non-executable discussion/i],
    outputs: [/^Outcome from .*task-specific result plus concrete action notes\.?$/i],
    successCriteria: [
      /returns concrete actions and decisions matching the requested task/i,
      /no fabricated tool-side behavior/i,
    ],
  } as const;

  private bundledSkillsDir: string;
  private managedSkillsDir: string;
  private workspaceSkillsDir: string | null = null;
  private skills: Map<string, CustomSkill> = new Map();
  private initialized: boolean = false;
  private skillsConfig?: SkillsConfig;
  private eligibilityChecker: SkillEligibilityChecker;

  // Debounce state for reloadSkills
  private reloadDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private reloadPromise: Promise<CustomSkill[]> | null = null;
  private isReloading: boolean = false;

  constructor(config?: SkillLoaderConfig) {
    // Bundled skills directory
    const isDev = process.env.NODE_ENV === "development";
    if (config?.bundledSkillsDir) {
      this.bundledSkillsDir = config.bundledSkillsDir;
    } else if (isDev) {
      this.bundledSkillsDir = path.join(process.cwd(), "resources", SKILLS_FOLDER_NAME);
    } else {
      this.bundledSkillsDir = path.join(process.resourcesPath || "", SKILLS_FOLDER_NAME);
    }

    // Managed skills directory (from registry)
    this.managedSkillsDir =
      config?.managedSkillsDir || path.join(getUserDataDir(), SKILLS_FOLDER_NAME);

    // Workspace skills directory (set later when workspace is loaded)
    this.workspaceSkillsDir = config?.workspaceSkillsDir || null;

    // Skills config
    this.skillsConfig = config?.skillsConfig;

    // Initialize eligibility checker
    this.eligibilityChecker = getSkillEligibilityChecker(this.skillsConfig);
  }

  /**
   * Initialize the skill loader - loads all skills from all sources
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Ensure managed skills directory exists
    if (!fs.existsSync(this.managedSkillsDir)) {
      fs.mkdirSync(this.managedSkillsDir, { recursive: true });
    }

    // Load all skills
    await this.reloadSkills();

    this.initialized = true;
    console.log(`[CustomSkillLoader] Initialized with ${this.skills.size} skills`);
    console.log(`[CustomSkillLoader] Bundled: ${this.bundledSkillsDir}`);
    console.log(`[CustomSkillLoader] Managed: ${this.managedSkillsDir}`);
    if (this.workspaceSkillsDir) {
      console.log(`[CustomSkillLoader] Workspace: ${this.workspaceSkillsDir}`);
    }
  }

  /**
   * Set the workspace skills directory
   */
  setWorkspaceSkillsDir(workspacePath: string): void {
    this.workspaceSkillsDir = path.join(workspacePath, SKILLS_FOLDER_NAME);
  }

  /**
   * Get directory paths
   */
  getBundledSkillsDir(): string {
    return this.bundledSkillsDir;
  }

  getManagedSkillsDir(): string {
    return this.managedSkillsDir;
  }

  getWorkspaceSkillsDir(): string | null {
    return this.workspaceSkillsDir;
  }

  /**
   * Get the skills directory path (for backward compatibility)
   */
  getSkillsDirectory(): string {
    return this.bundledSkillsDir;
  }

  /**
   * Load skills from a directory
   */
  private loadSkillsFromDir(dir: string, source: SkillSource): CustomSkill[] {
    const skills: CustomSkill[] = [];

    if (!fs.existsSync(dir)) {
      return skills;
    }

    try {
      const files = fs.readdirSync(dir);
      const skillFiles = files.filter((f) => f.endsWith(SKILL_FILE_EXTENSION));

      for (const file of skillFiles) {
        try {
          const filePath = path.join(dir, file);
          const content = fs.readFileSync(filePath, "utf-8");
          const skill = JSON.parse(content) as CustomSkill;

          // Add metadata
          skill.filePath = filePath;
          skill.source = source;

          // Validate skill has required fields
          if (this.validateSkill(skill)) {
            skills.push(skill);
          } else {
            console.warn(`[CustomSkillLoader] Invalid skill file: ${file}`);
          }
        } catch (error) {
          console.error(`[CustomSkillLoader] Failed to load skill file ${file}:`, error);
        }
      }
    } catch (error) {
      console.error(`[CustomSkillLoader] Failed to read directory ${dir}:`, error);
    }

    return skills;
  }

  /**
   * Reload all skills from all sources
   * Precedence: workspace > managed > bundled
   * Uses debouncing to prevent rapid consecutive calls
   */
  async reloadSkills(): Promise<CustomSkill[]> {
    // If already reloading, return the existing promise
    if (this.isReloading && this.reloadPromise) {
      return this.reloadPromise;
    }

    // Clear any pending debounce timer
    if (this.reloadDebounceTimer) {
      clearTimeout(this.reloadDebounceTimer);
      this.reloadDebounceTimer = null;
    }

    // Create a debounced reload promise
    this.reloadPromise = new Promise((resolve) => {
      this.reloadDebounceTimer = setTimeout(async () => {
        this.isReloading = true;
        try {
          const result = await this.doReloadSkills();
          resolve(result);
        } finally {
          this.isReloading = false;
          this.reloadPromise = null;
          this.reloadDebounceTimer = null;
        }
      }, RELOAD_DEBOUNCE_MS);
    });

    return this.reloadPromise;
  }

  /**
   * Internal method to actually reload skills
   */
  private async doReloadSkills(): Promise<CustomSkill[]> {
    this.skills.clear();

    // Load from all sources
    const bundledSkills = this.loadSkillsFromDir(this.bundledSkillsDir, "bundled");
    const managedSkills = this.loadSkillsFromDir(this.managedSkillsDir, "managed");
    const workspaceSkills = this.workspaceSkillsDir
      ? this.loadSkillsFromDir(this.workspaceSkillsDir, "workspace")
      : [];

    // Merge with precedence: bundled < managed < workspace
    for (const skill of bundledSkills) {
      this.skills.set(skill.id, skill);
    }
    for (const skill of managedSkills) {
      this.skills.set(skill.id, skill);
    }
    for (const skill of workspaceSkills) {
      this.skills.set(skill.id, skill);
    }

    const counts = {
      bundled: bundledSkills.length,
      managed: managedSkills.length,
      workspace: workspaceSkills.length,
      total: this.skills.size,
    };

    const rawTotal = counts.bundled + counts.managed + counts.workspace;
    const overridden = rawTotal - counts.total;
    console.log(
      `[CustomSkillLoader] Loaded ${counts.total} skills ` +
        `(bundled: ${counts.bundled}, managed: ${counts.managed}, workspace: ${counts.workspace}` +
        (overridden > 0 ? `, ${overridden} overridden` : "") +
        ")",
    );

    return this.listSkills();
  }

  /**
   * Validate a skill has all required fields
   */
  private validateSkill(skill: CustomSkill): boolean {
    return !!(
      skill.id &&
      skill.name &&
      skill.description &&
      skill.prompt &&
      typeof skill.id === "string" &&
      typeof skill.name === "string" &&
      typeof skill.description === "string" &&
      typeof skill.prompt === "string"
    );
  }

  /**
   * Register a skill from a plugin (not from a file on disk).
   * Plugin skills have "managed" source and are stored only in memory.
   * Workspace skills take precedence and will not be overridden.
   */
  registerPluginSkill(skill: CustomSkill): void {
    if (!this.validateSkill(skill)) {
      console.warn(`[CustomSkillLoader] Invalid plugin skill: ${skill.id}`);
      return;
    }
    // Plugin skills don't override workspace skills
    const existing = this.skills.get(skill.id);
    if (existing && existing.source === "workspace") {
      console.log(
        `[CustomSkillLoader] Skipping plugin skill ${skill.id} (workspace override exists)`,
      );
      return;
    }
    this.skills.set(skill.id, skill);
    console.log(`[CustomSkillLoader] Plugin skill registered: ${skill.id}`);
  }

  /**
   * List all loaded skills
   */
  listSkills(): CustomSkill[] {
    return Array.from(this.skills.values()).sort((a, b) => {
      // Sort by priority first (lower = higher priority, default 100)
      const priorityA = a.priority ?? 100;
      const priorityB = b.priority ?? 100;
      if (priorityA !== priorityB) {
        return priorityA - priorityB;
      }
      // Then by category
      if (a.category && b.category && a.category !== b.category) {
        return a.category.localeCompare(b.category);
      }
      // Finally by name
      return a.name.localeCompare(b.name);
    });
  }

  /**
   * List skills by source
   */
  listSkillsBySource(source: SkillSource): CustomSkill[] {
    return this.listSkills().filter((skill) => skill.source === source);
  }

  /**
   * List only task skills (excludes guideline skills)
   * Used for the skill dropdown in UI
   */
  listTaskSkills(): CustomSkill[] {
    return this.listSkills().filter((skill) => skill.type !== "guideline");
  }

  /**
   * List only guideline skills
   */
  listGuidelineSkills(): CustomSkill[] {
    return this.listSkills().filter((skill) => skill.type === "guideline");
  }

  /**
   * Get enabled guideline skills for system prompt injection
   * Returns the combined prompt content of all enabled guideline skills
   * Guidelines are validated and sanitized to prevent injection attacks
   */
  getEnabledGuidelinesPrompt(): string {
    const enabledGuidelines = this.listGuidelineSkills().filter((skill) => skill.enabled !== false);
    if (enabledGuidelines.length === 0) {
      return "";
    }
    // Validate and sanitize each guideline before injection
    return enabledGuidelines
      .map((skill) => {
        const validation = InputSanitizer.validateSkillGuidelines(skill.prompt);
        if (!validation.valid) {
          console.warn(
            `[CustomSkillLoader] Security: Skill "${skill.id}" guidelines contain suspicious patterns:`,
            validation.issues,
          );
          return validation.sanitized;
        }
        return skill.prompt;
      })
      .join("\n\n");
  }

  /**
   * List skills that can be automatically invoked by the model
   * Excludes guidelines and skills with disableModelInvocation set
   */
  listModelInvocableSkills(options: { availableToolNames?: Set<string> } = {}): CustomSkill[] {
    const availableToolNames = options.availableToolNames;
    return this.listSkills().filter((skill) => {
      // Exclude guideline skills
      if (skill.type === "guideline") return false;
      // Exclude disabled skills
      if (skill.enabled === false) return false;
      // Exclude skills that explicitly disable model invocation
      if (skill.invocation?.disableModelInvocation === true) return false;

      // If tool availability is provided, filter out skills that cannot run in this context.
      if (availableToolNames) {
        const skillRequires = (skill.requires || {}) as Any;
        const requiredTools: string[] = Array.isArray(skillRequires.tools)
          ? skillRequires.tools.filter(
              (tool: unknown): tool is string => typeof tool === "string" && tool.trim().length > 0,
            )
          : [];

        if (requiredTools.some((tool) => !availableToolNames.has(tool))) {
          return false;
        }

        // Skills requiring external binaries generally need run_command access.
        const hasBinaryRequirements =
          (Array.isArray(skill.requires?.bins) && skill.requires.bins.length > 0) ||
          (Array.isArray(skill.requires?.anyBins) && skill.requires.anyBins.length > 0);
        if (hasBinaryRequirements && !availableToolNames.has("run_command")) {
          return false;
        }
      }

      return true;
    });
  }

  /**
   * Get formatted skill descriptions for the model's system prompt
   * Groups skills by category and includes parameter info
   */
  getSkillDescriptionsForModel(options: { availableToolNames?: Set<string> } = {}): string {
    const skills = this.listModelInvocableSkills(options);
    if (skills.length === 0) {
      return "";
    }

    // Group skills by category
    const byCategory: Record<string, CustomSkill[]> = {};
    for (const skill of skills) {
      const category = skill.category || "General";
      if (!byCategory[category]) {
        byCategory[category] = [];
      }
      byCategory[category].push(skill);
    }

    // Format descriptions
    const lines: string[] = [];
    for (const [category, categorySkills] of Object.entries(byCategory).sort()) {
      lines.push(`\n${category}:`);
      for (const skill of categorySkills) {
        const paramInfo = skill.parameters?.length
          ? ` (params: ${skill.parameters.map((p) => p.name + (p.required ? "*" : "")).join(", ")})`
          : "";
        lines.push(`- ${skill.id}: ${skill.description}${paramInfo}`);

        const routingHints = this.getSkillRoutingHints(skill);
        for (const hint of routingHints) {
          lines.push(`  ${hint}`);
        }
      }
    }

    return lines.join("\n");
  }

  /**
   * Build compact routing and success hints for model prompt listing.
   * These are intentionally short and should act like decision boundaries.
   */
  private getSkillRoutingHints(skill: CustomSkill): string[] {
    const routing = skill.metadata?.routing;
    if (!routing) {
      return [];
    }

    const hints: string[] = [];
    if (routing.useWhen) {
      hints.push(`Use when: ${routing.useWhen}`);
    }
    if (routing.dontUseWhen && !this.isLowSignalRoutingHint("dontUseWhen", routing.dontUseWhen)) {
      hints.push(`Don't use when: ${routing.dontUseWhen}`);
    }
    if (routing.outputs && !this.isLowSignalRoutingHint("outputs", routing.outputs)) {
      hints.push(`Outputs: ${routing.outputs}`);
    }
    if (
      routing.successCriteria &&
      !this.isLowSignalRoutingHint("successCriteria", routing.successCriteria)
    ) {
      hints.push(`Success criteria: ${routing.successCriteria}`);
    }
    if (routing.expectedArtifacts?.length) {
      hints.push(`Artifacts: ${routing.expectedArtifacts.join(", ")}`);
    }

    return hints;
  }

  private isLowSignalRoutingHint(
    kind: "dontUseWhen" | "outputs" | "successCriteria",
    value: string,
  ): boolean {
    const normalized = value.trim();
    if (!normalized) return true;
    return CustomSkillLoader.LOW_SIGNAL_ROUTING_HINT_PATTERNS[kind].some((pattern) =>
      pattern.test(normalized),
    );
  }

  /**
   * Get a specific skill by ID
   */
  getSkill(id: string): CustomSkill | undefined {
    return this.skills.get(id);
  }

  /**
   * Expand a skill's prompt template with parameter values
   */
  expandPrompt(
    skill: CustomSkill,
    parameterValues: Record<string, string | number | boolean>,
    context: { artifactDir?: string } = {},
  ): string {
    let prompt = this.expandSkillPromptPlaceholders(skill.prompt, skill, context);

    // Replace {{param}} placeholders with values
    if (skill.parameters) {
      for (const param of skill.parameters) {
        const value = parameterValues[param.name] ?? param.default ?? "";
        const placeholder = new RegExp(`\\{\\{${param.name}\\}\\}`, "g");
        prompt = prompt.replace(placeholder, String(value));
      }
    }

    // Remove any remaining unreplaced placeholders
    prompt = prompt.replace(/\{\{[^}]+\}\}/g, "");

    return prompt.trim();
  }

  /**
   * Expand {baseDir} placeholders to the resolved skill base directory.
   */
  expandBaseDir(prompt: string, skill: CustomSkill): string {
    if (!prompt.includes("{baseDir}")) {
      return prompt;
    }
    const baseDir = this.resolveBaseDir(skill);
    return prompt.replace(/\{baseDir\}/g, baseDir);
  }

  private expandSkillPromptPlaceholders(
    prompt: string,
    skill: CustomSkill,
    context: { artifactDir?: string },
  ): string {
    let output = this.expandBaseDir(prompt, skill);
    if (context.artifactDir) {
      output = output.replace(/\{artifactDir\}/g, context.artifactDir);
    }
    return output;
  }

  private resolveBaseDir(skill: CustomSkill): string {
    const fileDir = skill.filePath ? path.dirname(skill.filePath) : this.bundledSkillsDir;
    const candidates = [
      fileDir,
      this.bundledSkillsDir,
      this.managedSkillsDir,
      this.workspaceSkillsDir || "",
    ].filter(Boolean) as string[];

    for (const dir of candidates) {
      try {
        if (fs.existsSync(path.join(dir, "scripts"))) {
          return dir;
        }
      } catch {
        // ignore and continue
      }
    }

    return fileDir;
  }

  /**
   * Get eligible skills (those that meet all requirements)
   */
  async getEligibleSkills(): Promise<CustomSkill[]> {
    const statusEntries = await this.getSkillStatus();
    return statusEntries.skills
      .filter((entry) => entry.eligible)
      .map((entry) => this.getSkill(entry.id)!)
      .filter(Boolean);
  }

  /**
   * Get skill status with eligibility information
   */
  async getSkillStatus(): Promise<SkillStatusReport> {
    const skills = this.listSkills();
    const statusEntries = await this.eligibilityChecker.buildStatusEntries(skills);

    const summary = {
      total: statusEntries.length,
      eligible: statusEntries.filter((s) => s.eligible).length,
      disabled: statusEntries.filter((s) => s.disabled).length,
      missingRequirements: statusEntries.filter(
        (s) => !s.eligible && !s.disabled && !s.blockedByAllowlist,
      ).length,
    };

    return {
      workspaceDir: this.workspaceSkillsDir || "",
      managedSkillsDir: this.managedSkillsDir,
      bundledSkillsDir: this.bundledSkillsDir,
      skills: statusEntries,
      summary,
    };
  }

  /**
   * Get status for a single skill
   */
  async getSkillStatusEntry(skillId: string): Promise<SkillStatusEntry | null> {
    const skill = this.getSkill(skillId);
    if (!skill) return null;

    return this.eligibilityChecker.buildStatusEntry(skill);
  }

  /**
   * Update skills config
   */
  updateConfig(config: SkillsConfig): void {
    this.skillsConfig = config;
    this.eligibilityChecker.updateConfig(config);
  }

  /**
   * Clear eligibility cache (useful after installing dependencies)
   */
  clearEligibilityCache(): void {
    this.eligibilityChecker.clearCache();
  }

  /**
   * Create a skill in the workspace directory
   */
  async createWorkspaceSkill(
    skill: Omit<CustomSkill, "filePath" | "source">,
  ): Promise<CustomSkill> {
    if (!this.workspaceSkillsDir) {
      throw new Error("Workspace skills directory not set");
    }

    // Ensure workspace skills directory exists
    if (!fs.existsSync(this.workspaceSkillsDir)) {
      fs.mkdirSync(this.workspaceSkillsDir, { recursive: true });
    }

    const filePath = path.join(this.workspaceSkillsDir, `${skill.id}.json`);
    const fullSkill: CustomSkill = {
      ...skill,
      source: "workspace",
      filePath,
    };

    fs.writeFileSync(filePath, JSON.stringify(fullSkill, null, 2), "utf-8");

    // Reload skills to pick up the new one
    await this.reloadSkills();

    return fullSkill;
  }

  /**
   * Update a skill
   */
  async updateSkill(
    skillId: string,
    updates: Partial<Omit<CustomSkill, "id" | "filePath" | "source">>,
  ): Promise<CustomSkill | null> {
    const skill = this.getSkill(skillId);
    if (!skill || !skill.filePath) {
      return null;
    }

    // Only allow updating workspace and managed skills
    if (skill.source === "bundled") {
      throw new Error("Cannot update bundled skills");
    }

    const updatedSkill: CustomSkill = {
      ...skill,
      ...updates,
    };

    fs.writeFileSync(skill.filePath, JSON.stringify(updatedSkill, null, 2), "utf-8");

    // Reload skills to pick up the update
    await this.reloadSkills();

    return updatedSkill;
  }

  /**
   * Delete a workspace skill
   */
  async deleteWorkspaceSkill(skillId: string): Promise<boolean> {
    const skill = this.getSkill(skillId);
    if (!skill || !skill.filePath || skill.source !== "workspace") {
      return false;
    }

    try {
      fs.unlinkSync(skill.filePath);
      await this.reloadSkills();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Delete a managed skill (from registry)
   */
  async deleteManagedSkill(skillId: string): Promise<boolean> {
    const skill = this.getSkill(skillId);
    if (!skill || !skill.filePath || skill.source !== "managed") {
      return false;
    }

    try {
      fs.unlinkSync(skill.filePath);
      await this.reloadSkills();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Open the managed skills folder in the system file browser
   */
  async openSkillsFolder(): Promise<void> {
    const { shell } = await import("electron");

    // Ensure directory exists
    if (!fs.existsSync(this.managedSkillsDir)) {
      fs.mkdirSync(this.managedSkillsDir, { recursive: true });
    }

    await shell.openPath(this.managedSkillsDir);
  }

  // === Backward compatibility aliases ===

  /**
   * Create a skill (alias for createWorkspaceSkill)
   * @deprecated Use createWorkspaceSkill instead
   */
  async createSkill(skill: Omit<CustomSkill, "filePath" | "source">): Promise<CustomSkill> {
    // For backward compatibility, if no workspace is set, create in managed dir
    if (!this.workspaceSkillsDir) {
      const filePath = path.join(this.managedSkillsDir, `${skill.id}.json`);
      const fullSkill: CustomSkill = {
        ...skill,
        source: "managed",
        filePath,
      };
      fs.writeFileSync(filePath, JSON.stringify(fullSkill, null, 2), "utf-8");
      await this.reloadSkills();
      return fullSkill;
    }
    return this.createWorkspaceSkill(skill);
  }

  /**
   * Delete a skill (checks both workspace and managed)
   * @deprecated Use deleteWorkspaceSkill or deleteManagedSkill instead
   */
  async deleteSkill(skillId: string): Promise<boolean> {
    const skill = this.getSkill(skillId);
    if (!skill) return false;

    if (skill.source === "workspace") {
      return this.deleteWorkspaceSkill(skillId);
    }
    if (skill.source === "managed") {
      return this.deleteManagedSkill(skillId);
    }
    return false;
  }
}

// Singleton instance
let instance: CustomSkillLoader | null = null;

export function getCustomSkillLoader(config?: SkillLoaderConfig): CustomSkillLoader {
  if (!instance) {
    instance = new CustomSkillLoader(config);
  }
  return instance;
}

/**
 * Reset the singleton instance (useful for testing)
 */
export function resetCustomSkillLoader(): void {
  instance = null;
}
