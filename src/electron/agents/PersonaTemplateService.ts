import * as fs from "fs";
import * as path from "path";
import type {
  PersonaTemplate,
  PersonaTemplateCategory,
  PersonaTemplateActivationResult,
  ActivatePersonaTemplateRequest,
  PersonaTemplateSkillRef,
  ProactiveTaskDefinition,
  CreateAgentRoleRequest,
} from "../../shared/types";
import type { AgentRoleRepository } from "./AgentRoleRepository";

const TEMPLATES_FOLDER_NAME = "persona-templates";

interface PersonaTemplateServiceConfig {
  bundledTemplatesDir?: string;
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

const CATEGORY_LABELS: Record<PersonaTemplateCategory, string> = {
  engineering: "Engineering",
  management: "Management",
  product: "Product",
  data: "Data & Analytics",
  operations: "Operations",
};

/**
 * Service for loading and activating persona templates (digital twins).
 * Follows the same pattern as CustomSkillLoader for bundled JSON loading.
 */
export class PersonaTemplateService {
  private templates: Map<string, PersonaTemplate> = new Map();
  private bundledTemplatesDir: string;
  private initialized = false;

  constructor(
    private agentRoleRepo: AgentRoleRepository,
    config?: PersonaTemplateServiceConfig,
  ) {
    if (config?.bundledTemplatesDir) {
      this.bundledTemplatesDir = config.bundledTemplatesDir;
    } else {
      this.bundledTemplatesDir = isPackagedElectronApp()
        ? path.join(process.resourcesPath || "", TEMPLATES_FOLDER_NAME)
        : path.join(process.cwd(), "resources", TEMPLATES_FOLDER_NAME);
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    this.loadTemplates();
    this.initialized = true;
    console.log(
      `[PersonaTemplateService] Initialized with ${this.templates.size} templates from ${this.bundledTemplatesDir}`,
    );
  }

  private loadTemplates(): void {
    this.templates.clear();

    if (!fs.existsSync(this.bundledTemplatesDir)) {
      console.warn(
        `[PersonaTemplateService] Templates directory not found: ${this.bundledTemplatesDir}`,
      );
      return;
    }

    try {
      const files = fs.readdirSync(this.bundledTemplatesDir);
      const jsonFiles = files.filter((f) => f.endsWith(".json"));

      for (const file of jsonFiles) {
        try {
          const filePath = path.join(this.bundledTemplatesDir, file);
          const content = fs.readFileSync(filePath, "utf-8");
          const template = JSON.parse(content) as PersonaTemplate;

          if (this.validateTemplate(template)) {
            this.templates.set(template.id, template);
          } else {
            console.warn(`[PersonaTemplateService] Invalid template in ${file}, skipping`);
          }
        } catch (err) {
          console.error(`[PersonaTemplateService] Failed to load ${file}:`, err);
        }
      }
    } catch (err) {
      console.error("[PersonaTemplateService] Failed to read templates directory:", err);
    }
  }

  private validateTemplate(template: PersonaTemplate): boolean {
    return !!(
      template.id &&
      template.name &&
      template.description &&
      template.version &&
      template.icon &&
      template.color &&
      template.category &&
      template.role &&
      template.role.capabilities &&
      Array.isArray(template.role.capabilities) &&
      template.role.capabilities.length > 0 &&
      template.role.systemPrompt &&
      template.heartbeat &&
      template.cognitiveOffload &&
      Array.isArray(template.cognitiveOffload.primaryCategories) &&
      Array.isArray(template.cognitiveOffload.proactiveTasks) &&
      Array.isArray(template.skills) &&
      Array.isArray(template.tags)
    );
  }

  /**
   * List all templates, optionally filtered by category or tag
   */
  listTemplates(filter?: { category?: PersonaTemplateCategory; tag?: string }): PersonaTemplate[] {
    let templates = Array.from(this.templates.values());

    if (filter?.category) {
      templates = templates.filter((t) => t.category === filter.category);
    }

    if (filter?.tag) {
      const tag = filter.tag.toLowerCase();
      templates = templates.filter((t) => t.tags.some((tt) => tt.toLowerCase().includes(tag)));
    }

    return templates.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Get a single template by ID
   */
  getTemplate(id: string): PersonaTemplate | undefined {
    return this.templates.get(id);
  }

  /**
   * Get all categories with counts
   */
  getCategories(): Array<{ id: PersonaTemplateCategory; label: string; count: number }> {
    const counts = new Map<PersonaTemplateCategory, number>();
    for (const template of this.templates.values()) {
      counts.set(template.category, (counts.get(template.category) || 0) + 1);
    }

    return (Object.entries(CATEGORY_LABELS) as [PersonaTemplateCategory, string][])
      .filter(([id]) => (counts.get(id) || 0) > 0)
      .map(([id, label]) => ({
        id,
        label,
        count: counts.get(id) || 0,
      }));
  }

  /**
   * Preview what will be created when activating a template, without creating it
   */
  previewActivation(templateId: string): {
    roleName: string;
    displayName: string;
    skills: PersonaTemplateSkillRef[];
    proactiveTasks: ProactiveTaskDefinition[];
  } | null {
    const template = this.templates.get(templateId);
    if (!template) return null;

    return {
      roleName: this.generateRoleName(template.id),
      displayName: template.name + " Twin",
      skills: template.skills,
      proactiveTasks: template.cognitiveOffload.proactiveTasks,
    };
  }

  /**
   * Activate a persona template: creates an AgentRole with all configuration
   */
  activate(request: ActivatePersonaTemplateRequest): PersonaTemplateActivationResult {
    const template = this.templates.get(request.templateId);
    if (!template) {
      throw new Error(`Persona template not found: ${request.templateId}`);
    }

    const customization = request.customization || {};
    const warnings: string[] = [];

    // Build soul JSON with cognitive offload config embedded
    const soulData = this.buildSoulData(template, customization.enabledProactiveTasks);
    const soulJson = JSON.stringify(soulData);

    // Generate unique role name
    const roleName = this.generateRoleName(template.id);

    // Check for name collision
    const existing = this.agentRoleRepo.findByName(roleName);
    if (existing) {
      throw new Error(
        `An agent role with name "${roleName}" already exists. Delete it first or customize the name.`,
      );
    }

    // Build CreateAgentRoleRequest
    const createRequest: CreateAgentRoleRequest = {
      name: roleName,
      displayName: customization.displayName || template.name + " Twin",
      description: template.description,
      icon: customization.icon || template.icon,
      color: customization.color || template.color,
      personalityId: template.role.personalityId,
      modelKey: customization.modelKey,
      providerType: customization.providerType,
      systemPrompt: template.role.systemPrompt,
      capabilities: template.role.capabilities,
      toolRestrictions: template.role.toolRestrictions,
      autonomyLevel: template.role.autonomyLevel,
      soul: soulJson,
      heartbeatEnabled: template.heartbeat.enabled,
      heartbeatIntervalMinutes:
        customization.heartbeatIntervalMinutes || template.heartbeat.intervalMinutes,
      heartbeatStaggerOffset: template.heartbeat.staggerOffset,
    };

    // Create the agent role
    let agentRole;
    try {
      agentRole = this.agentRoleRepo.create(createRequest);
    } catch (err) {
      throw new Error(
        `Failed to create agent role for template "${template.name}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Check which referenced skills exist (informational only)
    const installedSkillIds: string[] = [];
    for (const skillRef of template.skills) {
      // We can't check skill existence here since we don't have the skill loader,
      // but we track them for the result
      installedSkillIds.push(skillRef.skillId);
    }

    // Count enabled proactive tasks
    const proactiveTaskCount = template.cognitiveOffload.proactiveTasks.filter((t) => {
      if (customization.enabledProactiveTasks) {
        return customization.enabledProactiveTasks.includes(t.id);
      }
      return t.enabled;
    }).length;

    return {
      agentRole,
      installedSkillIds,
      proactiveTaskCount,
      warnings,
    };
  }

  /**
   * Build the soul JSON data with cognitive offload config
   */
  private buildSoulData(
    template: PersonaTemplate,
    enabledProactiveTasks?: string[],
  ): Record<string, unknown> {
    // Parse the template's base soul JSON
    let baseSoul: Record<string, unknown> = {};
    try {
      baseSoul = JSON.parse(template.role.soul);
    } catch {
      // If soul isn't valid JSON, use it as a name
      baseSoul = { name: template.role.soul };
    }

    // Merge cognitive offload config into soul
    const proactiveTasks = template.cognitiveOffload.proactiveTasks.map((task) => ({
      ...task,
      enabled: enabledProactiveTasks ? enabledProactiveTasks.includes(task.id) : task.enabled,
    }));

    return {
      ...baseSoul,
      cognitiveOffload: {
        primaryCategories: template.cognitiveOffload.primaryCategories,
        proactiveTasks,
      },
      sourceTemplateId: template.id,
      sourceTemplateVersion: template.version,
    };
  }

  /**
   * Generate a unique role name from template ID
   */
  private generateRoleName(templateId: string): string {
    const baseName = `twin-${templateId}`;

    // Check if base name is available
    if (!this.agentRoleRepo.findByName(baseName)) {
      return baseName;
    }

    // Try with numeric suffix
    for (let i = 2; i <= 99; i++) {
      const suffixed = `${baseName}-${i}`;
      if (!this.agentRoleRepo.findByName(suffixed)) {
        return suffixed;
      }
    }

    // Fallback: use timestamp
    return `${baseName}-${Date.now()}`;
  }
}

// Singleton
let instance: PersonaTemplateService | null = null;

export function getPersonaTemplateService(
  agentRoleRepo?: AgentRoleRepository,
  config?: PersonaTemplateServiceConfig,
): PersonaTemplateService {
  if (!instance) {
    if (!agentRoleRepo) {
      throw new Error("PersonaTemplateService requires AgentRoleRepository on first init");
    }
    instance = new PersonaTemplateService(agentRoleRepo, config);
  }
  return instance;
}
