/**
 * Custom Skill Loader
 *
 * Loads skills from multiple sources with precedence:
 * - Bundled skills (resources/skills/) - lowest precedence
 * - Optional external skill directories - medium precedence
 * - Managed skills (~/Library/Application Support/cowork-os/skills/) - medium-high precedence
 * - Workspace skills (<workspace>/skills/) - highest precedence
 *
 * Skills with the same ID from higher precedence sources override lower ones, with one
 * exception: a managed skill that is an unmodified copy of a bundled version CoWork shipped
 * earlier (see skill-lineage.ts) does not hide the bundled skill. The bundled skill is used
 * and the set-aside copy is listed in the skill status report.
 *
 * The shared loader holds bundled, external, managed and plugin skills. Workspace skills
 * belong to one workspace, so tasks read them through `forWorkspace(workspacePath)`, a view
 * that layers that workspace's skills on top without changing what other tasks see.
 */

import * as fs from "fs";
import * as path from "path";
import {
  CapabilitySecurityReport,
  CustomSkill,
  ShadowedSkillCopy,
  SkillSource,
  SkillStatusEntry,
  SkillStatusReport,
  SkillsConfig,
} from "../../shared/types";
import { SkillEligibilityChecker, getSkillEligibilityChecker } from "./skill-eligibility";
import { getSkillRegistry as _getSkillRegistry } from "./skill-registry";
import { InputSanitizer } from "./security";
import { getUserDataDir } from "../utils/user-data-dir";
import { isStaleBundledSnapshot } from "./skill-lineage";
import { createLogger } from "../utils/logger";
import {
  isModelInvocableSkill,
  matchesSkillRoutingQuery,
  rankModelInvocableSkillsForQuery,
  rankSkillsForQuery,
  sanitizeRoutingQuery,
} from "../../shared/skill-routing";

const SKILLS_FOLDER_NAME = "skills";
const SKILL_FILE_EXTENSION = ".json";
const RELOAD_DEBOUNCE_MS = 100; // Debounce rapid reload calls
const logger = createLogger("CustomSkillLoader");
const DEFAULT_MODEL_SKILL_SHORTLIST_SIZE = 20;
const DEFAULT_ROUTING_CONFIDENCE_THRESHOLD = 0.55;
const DEFAULT_SKILL_TEXT_BUDGET_CHARS = 12_000;

export interface SkillLoaderConfig {
  bundledSkillsDir?: string;
  managedSkillsDir?: string;
  workspaceSkillsDir?: string;
  skillsConfig?: SkillsConfig;
}

function normalizeExternalSkillDirectories(input: string[] | undefined): string[] {
  if (!Array.isArray(input)) return [];
  const normalized = new Set<string>();
  for (const value of input) {
    if (typeof value !== "string" || value.trim().length === 0) continue;
    const resolved = path.resolve(value.trim());
    if (!path.isAbsolute(resolved)) continue;
    if (!fs.existsSync(resolved)) continue;
    try {
      if (!fs.statSync(resolved).isDirectory()) continue;
      normalized.add(resolved);
    } catch {
      // Ignore unreadable paths.
    }
  }
  return Array.from(normalized.values());
}

function validateExternalSkillDirectories(input: string[]): void {
  for (const value of input) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error("External skill directories must be non-empty absolute paths");
    }
    const resolved = path.resolve(value.trim());
    if (!path.isAbsolute(resolved)) {
      throw new Error(`External skill directory must be absolute: ${value}`);
    }
    if (!fs.existsSync(resolved)) {
      throw new Error(`External skill directory does not exist: ${resolved}`);
    }
    if (!fs.statSync(resolved).isDirectory()) {
      throw new Error(`External skill directory must be a directory: ${resolved}`);
    }
  }
}

export interface ModelSkillDescriptionOptions {
  availableToolNames?: Set<string>;
  routingQuery?: string;
  shortlistSize?: number;
  lowConfidenceThreshold?: number;
  textBudgetChars?: number;
  includePrereqBlockedSkills?: boolean;
  /** JEV may reorder this already-eligible shortlist; it cannot add skills. */
  preferredSkillOrder?: readonly string[];
}

export interface RuntimeSkillDescriptor {
  name: string;
  description: string;
  whenToUse: string;
  requiredTools?: string[];
  disableModelInvocation: boolean;
  userInvocable: boolean;
  skill: CustomSkill;
}

interface RankedSkillMatch {
  skill: CustomSkill;
  score: number;
}

interface RankSkillsForQueryOptions {
  availableToolNames?: Set<string>;
  limit?: number;
  includePrereqBlockedSkills?: boolean;
}

function isPackagedElectronApp(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require("electron") as Any;
    return Boolean(electron?.app?.isPackaged);
  } catch {
    return false;
  }
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
  private externalSkillDirs: string[] = [];
  private workspaceSkillsDir: string | null = null;
  private skills: Map<string, CustomSkill> = new Map();
  private initialized: boolean = false;
  private initializationPromise: Promise<void> | null = null;
  private skillsConfig?: SkillsConfig;
  private eligibilityChecker: SkillEligibilityChecker;
  private securityReports: Map<string, CapabilitySecurityReport> = new Map();
  private shadowedSkillCopies: ShadowedSkillCopy[] = [];
  /** Bumped whenever the shared skill set changes, so workspace views rebuild their merge. */
  private skillsGeneration = 0;

  /** Set on workspace views only: the shared loader the view reads through. */
  private scopeRoot: CustomSkillLoader | null = null;
  private workspaceSkillCache: Map<string, { signature: string; skills: CustomSkill[] }> =
    new Map();
  private workspaceViews: Map<string, CustomSkillLoader> = new Map();
  private scopedMergeCache: {
    generation: number;
    signature: string;
    skills: Map<string, CustomSkill>;
  } | null = null;

  // Debounce state for reloadSkills
  private reloadDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private reloadPromise: Promise<CustomSkill[]> | null = null;
  private isReloading: boolean = false;
  private lastLoadStats: {
    bundled: number;
    external: number;
    managed: number;
    workspace: number;
    total: number;
    overridden: number;
  } = {
    bundled: 0,
    external: 0,
    managed: 0,
    workspace: 0,
    total: 0,
    overridden: 0,
  };

  constructor(config?: SkillLoaderConfig) {
    // Bundled skills directory
    if (config?.bundledSkillsDir) {
      this.bundledSkillsDir = config.bundledSkillsDir;
    } else {
      this.bundledSkillsDir = isPackagedElectronApp()
        ? path.join(process.resourcesPath || "", SKILLS_FOLDER_NAME)
        : path.join(process.cwd(), "resources", SKILLS_FOLDER_NAME);
    }

    // Managed skills directory (from registry)
    this.managedSkillsDir =
      config?.managedSkillsDir || path.join(getUserDataDir(), SKILLS_FOLDER_NAME);

    // Workspace skills directory (set later when workspace is loaded)
    this.workspaceSkillsDir = config?.workspaceSkillsDir || null;

    // Skills config
    this.skillsConfig = config?.skillsConfig;
    this.externalSkillDirs = normalizeExternalSkillDirectories(
      config?.skillsConfig?.externalSkillDirectories,
    );

    // Initialize eligibility checker
    this.eligibilityChecker = getSkillEligibilityChecker(this.skillsConfig);
  }

  /**
   * Initialize the skill loader - loads all skills from all sources
   */
  async initialize(): Promise<void> {
    if (this.scopeRoot) return this.scopeRoot.initialize();
    if (this.initialized) return;
    if (this.initializationPromise) return this.initializationPromise;

    this.initializationPromise = (async () => {
      // Ensure managed skills directory exists
      if (!fs.existsSync(this.managedSkillsDir)) {
        fs.mkdirSync(this.managedSkillsDir, { recursive: true });
      }

      // Load all skills
      await this.reloadSkills();

      this.initialized = true;
      logger.info(`Initialized with ${this.skills.size} skills`);
      logger.debug(`Bundled: ${this.bundledSkillsDir}`);
      logger.debug(`Managed: ${this.managedSkillsDir}`);
      for (const externalDir of this.externalSkillDirs) {
        logger.debug(`External: ${externalDir}`);
      }
      if (this.workspaceSkillsDir) {
        logger.debug(`Workspace: ${this.workspaceSkillsDir}`);
      }
    })().finally(() => {
      this.initializationPromise = null;
    });

    return this.initializationPromise;
  }

  /**
   * Set the workspace skills directory for this loader. On the shared loader this applies
   * to every caller, so tasks use `forWorkspace` instead.
   */
  setWorkspaceSkillsDir(workspacePath: string): void {
    if (this.scopeRoot) {
      throw new Error("A workspace skill view is fixed to its workspace; use forWorkspace()");
    }
    this.workspaceSkillsDir = path.join(workspacePath, SKILLS_FOLDER_NAME);
  }

  /**
   * A view of this loader that adds `<workspacePath>/skills/` at the highest precedence.
   * Reads (getSkill, listSkills, routing, guidelines, {baseDir}) see the workspace skills;
   * the shared loader and other workspaces' views do not. Workspace skill files are re-read
   * when the folder changes, so a skill saved during a task applies to its next lookup.
   */
  forWorkspace(workspacePath: string | null | undefined): CustomSkillLoader {
    const root = this.scopeRoot ?? this;
    if (typeof workspacePath !== "string" || workspacePath.trim().length === 0) {
      return root;
    }
    const workspaceSkillsDir = path.join(path.resolve(workspacePath), SKILLS_FOLDER_NAME);
    const existing = root.workspaceViews.get(workspaceSkillsDir);
    if (existing) return existing;
    // A prototype view shares the root's maps and settings; only the workspace folder
    // and the view's merge cache are its own. Methods that change shared state forward
    // to the root (see `scopeRoot` checks).
    const view = Object.create(root) as CustomSkillLoader;
    view.scopeRoot = root;
    view.workspaceSkillsDir = workspaceSkillsDir;
    view.scopedMergeCache = null;
    root.workspaceViews.set(workspaceSkillsDir, view);
    return view;
  }

  /**
   * The skills this loader answers with: the shared set, plus the workspace skills when
   * this is a workspace view.
   */
  private effectiveSkills(): Map<string, CustomSkill> {
    const root = this.scopeRoot;
    if (!root || !this.workspaceSkillsDir) {
      return this.skills;
    }
    const { signature, skills: workspaceSkills } = root.loadWorkspaceSkills(
      this.workspaceSkillsDir,
    );
    const cached = this.scopedMergeCache;
    if (cached && cached.generation === root.skillsGeneration && cached.signature === signature) {
      return cached.skills;
    }
    let merged = root.skills;
    if (workspaceSkills.length > 0) {
      merged = new Map(root.skills);
      for (const skill of workspaceSkills) {
        merged.set(skill.id, skill);
      }
    }
    this.scopedMergeCache = { generation: root.skillsGeneration, signature, skills: merged };
    return merged;
  }

  /**
   * Load a workspace skill folder, reusing the last read while no manifest in it changed.
   */
  private loadWorkspaceSkills(dir: string): { signature: string; skills: CustomSkill[] } {
    const signature = this.getSkillDirSignature(dir);
    const cached = this.workspaceSkillCache.get(dir);
    if (cached && cached.signature === signature) {
      return cached;
    }
    const entry = {
      signature,
      skills: signature ? this.loadSkillsFromDir(dir, "workspace") : [],
    };
    this.workspaceSkillCache.set(dir, entry);
    return entry;
  }

  private getSkillDirSignature(dir: string): string {
    try {
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        return "";
      }
      return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(SKILL_FILE_EXTENSION) && !this.isSecurityMetadataFile(f))
        .sort()
        .map((f) => {
          try {
            const stat = fs.statSync(path.join(dir, f));
            return `${f}:${stat.mtimeMs}:${stat.size}`;
          } catch {
            return `${f}:missing`;
          }
        })
        .join("|");
    } catch {
      return "";
    }
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

  getExternalSkillDirs(): string[] {
    return [...this.externalSkillDirs];
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
      const skillFiles = files.filter(
        (f) => f.endsWith(SKILL_FILE_EXTENSION) && !this.isSecurityMetadataFile(f),
      );

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
            logger.warn(`Invalid skill file: ${file}`);
          }
        } catch (error) {
          logger.error(`Failed to load skill file ${file}:`, error);
        }
      }
    } catch (error) {
      logger.error(`Failed to read directory ${dir}:`, error);
    }

    return skills;
  }

  /**
   * Reload all skills from all sources
   * Precedence: workspace > managed > bundled
   * Uses debouncing to prevent rapid consecutive calls
   */
  async reloadSkills(): Promise<CustomSkill[]> {
    if (this.scopeRoot) {
      await this.scopeRoot.reloadSkills();
      return this.listSkills();
    }

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
    this.securityReports.clear();

    await this.verifyManagedSkills();

    // Load from all sources
    const bundledSkills = this.loadSkillsFromDir(this.bundledSkillsDir, "bundled");
    const externalSkills = this.externalSkillDirs.flatMap((dir) =>
      this.loadSkillsFromDir(dir, "external"),
    );
    const managedSkills = this.loadSkillsFromDir(this.managedSkillsDir, "managed");
    const workspaceSkills = this.workspaceSkillsDir
      ? this.loadSkillsFromDir(this.workspaceSkillsDir, "workspace")
      : [];

    // Merge with precedence: bundled < external < managed < workspace
    const bundledById = new Map<string, CustomSkill>();
    for (const skill of bundledSkills) {
      this.skills.set(skill.id, skill);
      bundledById.set(skill.id, skill);
    }
    for (const skill of externalSkills) {
      this.skills.set(skill.id, skill);
    }
    const shadowed: ShadowedSkillCopy[] = [];
    const setAsideManagedIds = new Set<string>();
    for (const skill of managedSkills) {
      const bundled = bundledById.get(skill.id);
      if (bundled && this.isStaleManagedSnapshot(skill, bundled)) {
        // An unmodified copy of an earlier bundled version: keep the current bundled skill,
        // but honour the copy's off switch, which older app versions stored in the copy.
        const current = this.skills.get(skill.id) ?? bundled;
        this.skills.set(
          skill.id,
          skill.enabled === false && current.enabled !== false
            ? { ...current, enabled: false }
            : current,
        );
        setAsideManagedIds.add(skill.id);
        shadowed.push({
          id: skill.id,
          name: skill.name,
          filePath: skill.filePath || "",
          source: "managed",
          reason: "stale_bundled_copy",
          activeSource: current.source || "bundled",
        });
        continue;
      }
      if (bundled) {
        shadowed.push({
          id: bundled.id,
          name: bundled.name,
          filePath: bundled.filePath || "",
          source: "bundled",
          reason: "overridden_by_managed",
          activeSource: "managed",
        });
      }
      this.skills.set(skill.id, skill);
    }
    for (const skill of workspaceSkills) {
      this.skills.set(skill.id, skill);
    }
    this.shadowedSkillCopies = shadowed;
    this.skillsGeneration += 1;
    for (const id of setAsideManagedIds) {
      // The integrity report belongs to the set-aside copy, not the bundled skill in use.
      this.securityReports.delete(id);
    }

    const counts = {
      bundled: bundledSkills.length,
      external: externalSkills.length,
      managed: managedSkills.length,
      workspace: workspaceSkills.length,
      total: this.skills.size,
    };

    const rawTotal = counts.bundled + counts.external + counts.managed + counts.workspace;
    const overridden = rawTotal - counts.total;
    this.lastLoadStats = {
      ...counts,
      overridden,
    };
    logger.info(
      `Loaded ${counts.total} skills (bundled: ${counts.bundled}, external: ${counts.external}, managed: ${counts.managed}, workspace: ${counts.workspace}, overridden: ${overridden})`,
    );

    await this.populateSecurityReports(
      externalSkills,
      managedSkills.filter((skill) => !setAsideManagedIds.has(skill.id)),
    );

    return this.listSkills();
  }

  /**
   * A managed skill is set aside for its bundled counterpart only when its manifest matches
   * a bundled version CoWork shipped and it has no companion folder of its own (scripts or
   * references the user may have changed). Anything else is the user's and keeps winning.
   */
  private isStaleManagedSnapshot(managed: CustomSkill, bundled: CustomSkill): boolean {
    if (!isStaleBundledSnapshot(managed, bundled)) return false;
    const manifestPath = managed.filePath;
    if (!manifestPath) return false;
    const companionDir = path.join(path.dirname(manifestPath), managed.id);
    try {
      return !fs.existsSync(companionDir);
    } catch {
      return false;
    }
  }

  private isSecurityMetadataFile(fileName: string): boolean {
    const lower = fileName.toLowerCase();
    return lower === "build-mode.json" || lower.endsWith(".security.json");
  }

  private async verifyManagedSkills(): Promise<void> {
    const skillRegistry = _getSkillRegistry();
    for (const skill of skillRegistry.listManagedSkills()) {
      try {
        const report = await skillRegistry.verifyManagedSkillIntegrity(skill.id);
        if (report) {
          this.securityReports.set(skill.id, report);
        }
      } catch (error) {
        logger.warn(`Managed skill verification failed for ${skill.id}`, error);
      }
    }
  }

  private async populateSecurityReports(
    externalSkills: CustomSkill[],
    managedSkills: CustomSkill[],
  ): Promise<void> {
    for (const skill of managedSkills) {
      if (this.securityReports.has(skill.id)) {
        continue;
      }
      const report = _getSkillRegistry().getImportSecurityReport({
        bundleKind: "skill",
        bundleId: skill.id,
      });
      if (report) {
        this.securityReports.set(skill.id, report);
      }
    }

    for (const skill of externalSkills) {
      try {
        const report = await _getSkillRegistry().inspectExternalSkill(skill);
        if (report) {
          this.securityReports.set(skill.id, report);
        }
      } catch (error) {
        logger.warn(`External skill security inspection failed for ${skill.id}`, error);
      }
    }
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
    if (this.scopeRoot) return this.scopeRoot.registerPluginSkill(skill);
    if (!this.validateSkill(skill)) {
      logger.warn(`Invalid plugin skill: ${skill.id}`);
      return;
    }
    // Plugin skills don't override workspace skills
    const existing = this.skills.get(skill.id);
    if (existing && existing.source === "workspace") {
      logger.debug(`Skipping plugin skill ${skill.id} (workspace override exists)`);
      return;
    }
    this.skills.set(skill.id, skill);
    this.skillsGeneration += 1;
    logger.debug(`Plugin skill registered: ${skill.id}`);
  }

  /**
   * Apply a pack skill's desired enabled state to the live skill object. Workspace
   * skills keep precedence and are never changed by a pack-level toggle.
   */
  setPluginSkillEnabled(pluginName: string, skillId: string, enabled: boolean): boolean {
    const skill = this.skills.get(skillId);
    if (!skill || skill.source === "workspace" || skill.metadata?.pluginSource !== pluginName) {
      return false;
    }
    skill.enabled = enabled;
    return true;
  }

  /**
   * Remove in-memory skills registered by a plugin pack.
   * Workspace skills with the same IDs are preserved because they are user-owned.
   */
  unregisterPluginSkills(pluginName: string): number {
    if (this.scopeRoot) return this.scopeRoot.unregisterPluginSkills(pluginName);
    let removed = 0;
    for (const [skillId, skill] of this.skills) {
      if (skill.source === "workspace") continue;
      if (skill.metadata?.pluginSource !== pluginName) continue;
      this.skills.delete(skillId);
      removed++;
    }
    if (removed > 0) {
      this.skillsGeneration += 1;
      logger.debug(`Plugin skills unregistered for ${pluginName}: ${removed}`);
    }
    return removed;
  }

  getLoadStats(): {
    bundled: number;
    external: number;
    managed: number;
    workspace: number;
    total: number;
    overridden: number;
  } {
    return { ...this.lastLoadStats };
  }

  /**
   * List all loaded skills
   */
  listSkills(): CustomSkill[] {
    return Array.from(this.effectiveSkills().values()).sort((a, b) => {
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
          logger.warn(
            `Security: Skill "${skill.id}" guidelines contain suspicious patterns:`,
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
  listModelInvocableSkills(
    options: {
      availableToolNames?: Set<string>;
      includePrereqBlockedSkills?: boolean;
    } = {},
  ): CustomSkill[] {
    return this.listSkills().filter((skill) => isModelInvocableSkill(skill, options));
  }

  matchesSkillRoutingQuery(skill: CustomSkill, query: string): boolean {
    const matched = matchesSkillRoutingQuery(skill, query);
    if (!matched)
      logger.debug(`Routing gate BLOCKED skill "${skill.id}" for query "${query.slice(0, 80)}"`);
    return matched;
  }

  private rankSkillsForQuery(skills: CustomSkill[], query: string): RankedSkillMatch[] {
    return rankSkillsForQuery(skills, query);
  }

  rankModelInvocableSkillsForQuery(
    query: string,
    options: RankSkillsForQueryOptions = {},
  ): RankedSkillMatch[] {
    return rankModelInvocableSkillsForQuery(this.listSkills(), query, options);
  }

  private shortlistSkillsForQuery(
    skills: CustomSkill[],
    query: string,
    shortlistSize: number,
  ): {
    skills: CustomSkill[];
    confidence: number;
    totalEligible: number;
  } {
    const normalizedQuery = sanitizeRoutingQuery(String(query || "")).trim();

    if (!normalizedQuery) {
      return {
        skills,
        confidence: 1,
        totalEligible: skills.length,
      };
    }

    // Hard gate: skills with routing keywords are hidden from the model unless a keyword matches.
    // This prevents keyword-gated skills (e.g. codex-cli) from appearing in the
    // model's skill list for unrelated tasks.
    const eligibleSkills = skills.filter((skill) =>
      this.matchesSkillRoutingQuery(skill, normalizedQuery),
    );
    logger.info(
      `shortlistSkillsForQuery: ${skills.length} skills → ${eligibleSkills.length} after keyword gate (query="${normalizedQuery.slice(0, 80)}")`,
    );

    const ranked = this.rankSkillsForQuery(eligibleSkills, normalizedQuery);

    return {
      skills: ranked.slice(0, shortlistSize).map((entry) => entry.skill),
      confidence: ranked[0]?.score ?? 0,
      totalEligible: eligibleSkills.length,
    };
  }

  /**
   * Get formatted skill descriptions for the model's system prompt
   * Groups skills by category and includes parameter info
   */
  getSkillDescriptionsForModel(options: ModelSkillDescriptionOptions = {}): string {
    const descriptors = this.listRuntimeSkillDescriptors({
      availableToolNames: options.availableToolNames,
      includePrereqBlockedSkills: options.includePrereqBlockedSkills,
    });
    if (descriptors.length === 0) {
      return "";
    }

    const shortlistSize =
      typeof options.shortlistSize === "number" && Number.isFinite(options.shortlistSize)
        ? Math.min(Math.max(Math.floor(options.shortlistSize), 1), 200)
        : DEFAULT_MODEL_SKILL_SHORTLIST_SIZE;
    const lowConfidenceThreshold =
      typeof options.lowConfidenceThreshold === "number" &&
      Number.isFinite(options.lowConfidenceThreshold)
        ? Math.min(Math.max(options.lowConfidenceThreshold, 0), 1)
        : DEFAULT_ROUTING_CONFIDENCE_THRESHOLD;
    const textBudgetChars =
      typeof options.textBudgetChars === "number" && Number.isFinite(options.textBudgetChars)
        ? Math.max(Math.floor(options.textBudgetChars), 1_500)
        : DEFAULT_SKILL_TEXT_BUDGET_CHARS;

    const routed = this.shortlistSkillsForQuery(
      descriptors.map((descriptor) => descriptor.skill),
      options.routingQuery || "",
      shortlistSize,
    );
    const selectedDescriptors = routed.skills
      .map((skill) => descriptors.find((descriptor) => descriptor.skill.id === skill.id))
      .filter((descriptor): descriptor is RuntimeSkillDescriptor => Boolean(descriptor));

    if (options.preferredSkillOrder && options.preferredSkillOrder.length > 0) {
      const preferredIndex = new Map(
        options.preferredSkillOrder.map((skillId, index) => [String(skillId), index]),
      );
      selectedDescriptors.sort((a, b) => {
        const aIndex = preferredIndex.get(a.skill.id);
        const bIndex = preferredIndex.get(b.skill.id);
        if (aIndex === undefined && bIndex === undefined) return 0;
        if (aIndex === undefined) return 1;
        if (bIndex === undefined) return -1;
        return aIndex - bIndex;
      });
    }

    // Group skills by category
    const byCategory: Record<string, RuntimeSkillDescriptor[]> = {};
    for (const descriptor of selectedDescriptors) {
      const category = descriptor.skill.category || "General";
      if (!byCategory[category]) {
        byCategory[category] = [];
      }
      byCategory[category].push(descriptor);
    }

    // Format descriptions
    const lines: string[] = [];
    if (selectedDescriptors.length < routed.totalEligible) {
      lines.push(
        `Routing shortlist: showing ${selectedDescriptors.length} of ${routed.totalEligible} skills for this task.`,
      );
    }
    if (routed.confidence < lowConfidenceThreshold) {
      lines.push(
        "Routing confidence is low. Review the listed skills carefully before choosing one.",
      );
    }
    for (const [category, categoryDescriptors] of Object.entries(byCategory).sort()) {
      lines.push(`\n${category}:`);
      for (const descriptor of categoryDescriptors) {
        const { skill } = descriptor;
        const paramInfo = skill.parameters?.length
          ? ` (args: ${skill.parameters.map((p) => p.name + (p.required ? "*" : "")).join(", ")})`
          : "";
        const userMarker = descriptor.userInvocable ? " [user-invocable]" : "";
        lines.push(`- ${descriptor.name}: ${descriptor.description}${paramInfo}${userMarker}`);

        const routingHints = this.getSkillRoutingHints(descriptor);
        for (const hint of routingHints) {
          lines.push(`  ${hint}`);
        }
      }
    }
    let rendered = lines.join("\n");
    if (rendered.length > textBudgetChars) {
      rendered = `${rendered.slice(0, textBudgetChars)}\n[Skill descriptions truncated for prompt budget.]`;
    }
    return rendered;
  }

  getRuntimeSkillDescriptor(skill: CustomSkill): RuntimeSkillDescriptor {
    const requiredTools = Array.isArray((skill.requires as Any)?.tools)
      ? ((skill.requires as Any).tools as unknown[]).filter(
          (tool): tool is string => typeof tool === "string" && tool.trim().length > 0,
        )
      : undefined;
    return {
      name: skill.id,
      description: String(skill.description || "").trim(),
      whenToUse:
        String(skill.metadata?.routing?.useWhen || "").trim() ||
        String(skill.description || "").trim() ||
        `Use when the ${skill.name || skill.id} skill clearly matches the task.`,
      requiredTools,
      disableModelInvocation: skill.invocation?.disableModelInvocation === true,
      userInvocable: skill.invocation?.userInvocable !== false,
      skill,
    };
  }

  listRuntimeSkillDescriptors(
    options: {
      availableToolNames?: Set<string>;
      includePrereqBlockedSkills?: boolean;
    } = {},
  ): RuntimeSkillDescriptor[] {
    return this.listModelInvocableSkills(options).map((skill) =>
      this.getRuntimeSkillDescriptor(skill),
    );
  }

  /**
   * Build compact routing and success hints for model prompt listing.
   * These are intentionally short and should act like decision boundaries.
   */
  private getSkillRoutingHints(descriptor: RuntimeSkillDescriptor): string[] {
    const { skill } = descriptor;
    const routing = skill.metadata?.routing;
    if (!routing) {
      return descriptor.whenToUse ? [`Use when: ${descriptor.whenToUse}`] : [];
    }

    const hints: string[] = [];
    if (descriptor.whenToUse) {
      hints.push(`Use when: ${descriptor.whenToUse}`);
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
    return this.effectiveSkills().get(id);
  }

  /**
   * Skill copies the loader did not use because another copy with the same id won:
   * managed copies set aside for a newer bundled skill, and bundled skills a user's
   * managed skill overrides.
   */
  getShadowedSkillCopies(): ShadowedSkillCopy[] {
    return this.shadowedSkillCopies.map((entry) => ({ ...entry }));
  }

  /**
   * Expand a skill's prompt template with parameter values
   */
  expandPrompt(
    skill: CustomSkill,
    parameterValues: Record<string, string | number | boolean>,
    context: { artifactDir?: string; workspaceArtifactDir?: string } = {},
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
    context: { artifactDir?: string; workspaceArtifactDir?: string },
  ): string {
    let output = this.expandBaseDir(prompt, skill);
    if (context.artifactDir) {
      output = output.replace(/\{artifactDir\}/g, context.artifactDir);
    }
    if (context.workspaceArtifactDir) {
      output = output.replace(/\{workspaceArtifactDir\}/g, context.workspaceArtifactDir);
    }
    return output;
  }

  private resolveBaseDir(skill: CustomSkill): string {
    const fileDir = skill.filePath ? path.dirname(skill.filePath) : this.bundledSkillsDir;
    const skillScopedDir = this.resolveSkillScopedBaseDir(skill, fileDir);
    const prompt = String(skill.prompt || "");
    const requiresScopedDir =
      prompt.includes("{baseDir}/SKILL.md") || prompt.includes("{baseDir}/references/");
    const scopedHasScripts = skillScopedDir && fs.existsSync(path.join(skillScopedDir, "scripts"));
    const referencedRelativePaths = Array.from(
      prompt.matchAll(/\{baseDir\}\/([A-Za-z0-9._\-/]+)/g),
      (match) => match[1],
    );

    if (skillScopedDir && (requiresScopedDir || scopedHasScripts)) {
      return skillScopedDir;
    }
    if (skillScopedDir && referencedRelativePaths.length > 0) {
      const scopedHits = referencedRelativePaths.filter((relPath) =>
        fs.existsSync(path.join(skillScopedDir, relPath)),
      ).length;
      const fileDirHits = referencedRelativePaths.filter((relPath) =>
        fs.existsSync(path.join(fileDir, relPath)),
      ).length;
      if (scopedHits > fileDirHits) {
        return skillScopedDir;
      }
    }

    const candidates = [
      fileDir,
      this.bundledSkillsDir,
      ...this.externalSkillDirs,
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
   * Resolve a skill-specific folder next to the skill manifest when present.
   * This makes {baseDir} point to resources/skills/<skill-id>/ for bundled skills
   * while preserving compatibility for managed/workspace skills.
   */
  private resolveSkillScopedBaseDir(skill: CustomSkill, fileDir: string): string | null {
    const baseNames = new Set<string>();
    if (skill.id && typeof skill.id === "string") {
      baseNames.add(skill.id);
    }
    if (skill.filePath) {
      baseNames.add(path.basename(skill.filePath, path.extname(skill.filePath)));
    }

    for (const baseName of baseNames) {
      const candidate = path.join(fileDir, baseName);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
          return candidate;
        }
      } catch {
        // ignore and continue
      }
    }

    return null;
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
    const statusEntries = (await this.eligibilityChecker.buildStatusEntries(skills)).map(
      (entry) => ({
        ...entry,
        securityReport: this.securityReports.get(entry.id),
      }),
    );

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
      externalSkillDirs: [...this.externalSkillDirs],
      skills: statusEntries,
      shadowedSkills: this.getShadowedSkillCopies(),
      summary,
    };
  }

  /**
   * Get status for a single skill
   */
  async getSkillStatusEntry(skillId: string): Promise<SkillStatusEntry | null> {
    const skill = this.getSkill(skillId);
    if (!skill) return null;

    const entry = await this.eligibilityChecker.buildStatusEntry(skill);
    return {
      ...entry,
      securityReport: this.securityReports.get(skillId),
    };
  }

  /**
   * Update skills config
   */
  updateConfig(config: SkillsConfig): void {
    if (this.scopeRoot) return this.scopeRoot.updateConfig(config);
    this.skillsConfig = config;
    this.externalSkillDirs = normalizeExternalSkillDirectories(config.externalSkillDirectories);
    this.eligibilityChecker.updateConfig(config);
  }

  setExternalSkillDirs(directories: string[]): string[] {
    if (this.scopeRoot) return this.scopeRoot.setExternalSkillDirs(directories);
    validateExternalSkillDirectories(directories);
    this.externalSkillDirs = normalizeExternalSkillDirectories(directories);
    this.skillsConfig = {
      skillsDirectory: this.managedSkillsDir,
      enabledSkillIds: this.skillsConfig?.enabledSkillIds || [],
      ...this.skillsConfig,
      externalSkillDirectories: [...this.externalSkillDirs],
    };
    return this.getExternalSkillDirs();
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
    if (skill.source === "external") {
      throw new Error("Cannot update external read-only skills");
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

  async openExternalSkillsFolder(dir: string): Promise<void> {
    const { shell } = await import("electron");
    validateExternalSkillDirectories([dir]);
    const normalized = normalizeExternalSkillDirectories([dir])[0];
    if (!normalized) {
      throw new Error("External skill directory must exist and be a readable absolute path");
    }
    await shell.openPath(normalized);
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
