/**
 * Custom Skill Loader
 *
 * Loads and provides access to bundled skills.
 * Skills are stored as JSON files in resources/skills/ directory.
 */

import * as fs from 'fs';
import * as path from 'path';
import { CustomSkill } from '../../shared/types';

const SKILLS_FOLDER_NAME = 'skills';
const SKILL_FILE_EXTENSION = '.json';

export class CustomSkillLoader {
  private skillsDirectory: string;
  private skills: Map<string, CustomSkill> = new Map();
  private initialized: boolean = false;

  constructor() {
    // Skills are bundled in the resources/skills directory
    // In development: resources/skills
    // In production: process.resourcesPath/skills (inside the app bundle)
    const isDev = process.env.NODE_ENV === 'development';
    if (isDev) {
      this.skillsDirectory = path.join(process.cwd(), 'resources', SKILLS_FOLDER_NAME);
    } else {
      // In production, resources are in the app bundle
      this.skillsDirectory = path.join(process.resourcesPath || '', SKILLS_FOLDER_NAME);
    }
  }

  /**
   * Initialize the skill loader - loads all bundled skills
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Load all skills
    await this.reloadSkills();

    this.initialized = true;
    console.log(`[CustomSkillLoader] Initialized with ${this.skills.size} skills from ${this.skillsDirectory}`);
  }

  /**
   * Get the skills directory path
   */
  getSkillsDirectory(): string {
    return this.skillsDirectory;
  }

  /**
   * Reload all skills from disk
   */
  async reloadSkills(): Promise<CustomSkill[]> {
    this.skills.clear();

    try {
      if (!fs.existsSync(this.skillsDirectory)) {
        console.warn(`[CustomSkillLoader] Skills directory not found: ${this.skillsDirectory}`);
        return [];
      }

      const files = fs.readdirSync(this.skillsDirectory);
      const skillFiles = files.filter(f => f.endsWith(SKILL_FILE_EXTENSION));

      for (const file of skillFiles) {
        try {
          const filePath = path.join(this.skillsDirectory, file);
          const content = fs.readFileSync(filePath, 'utf-8');
          const skill = JSON.parse(content) as CustomSkill;

          // Add file path to skill for reference
          skill.filePath = filePath;

          // Validate skill has required fields
          if (this.validateSkill(skill)) {
            this.skills.set(skill.id, skill);
          } else {
            console.warn(`[CustomSkillLoader] Invalid skill file: ${file}`);
          }
        } catch (error) {
          console.error(`[CustomSkillLoader] Failed to load skill file ${file}:`, error);
        }
      }

      console.log(`[CustomSkillLoader] Loaded ${this.skills.size} skills`);
      return this.listSkills();
    } catch (error) {
      console.error('[CustomSkillLoader] Failed to reload skills:', error);
      return [];
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
      typeof skill.id === 'string' &&
      typeof skill.name === 'string' &&
      typeof skill.description === 'string' &&
      typeof skill.prompt === 'string'
    );
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
   * List only task skills (excludes guideline skills)
   * Used for the skill dropdown in UI
   */
  listTaskSkills(): CustomSkill[] {
    return this.listSkills().filter(skill => skill.type !== 'guideline');
  }

  /**
   * List only guideline skills
   */
  listGuidelineSkills(): CustomSkill[] {
    return this.listSkills().filter(skill => skill.type === 'guideline');
  }

  /**
   * Get enabled guideline skills for system prompt injection
   * Returns the combined prompt content of all enabled guideline skills
   */
  getEnabledGuidelinesPrompt(): string {
    const enabledGuidelines = this.listGuidelineSkills().filter(skill => skill.enabled !== false);
    if (enabledGuidelines.length === 0) {
      return '';
    }
    return enabledGuidelines.map(skill => skill.prompt).join('\n\n');
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
  expandPrompt(skill: CustomSkill, parameterValues: Record<string, string | number | boolean>): string {
    let prompt = skill.prompt;

    // Replace {{param}} placeholders with values
    if (skill.parameters) {
      for (const param of skill.parameters) {
        const value = parameterValues[param.name] ?? param.default ?? '';
        const placeholder = new RegExp(`\\{\\{${param.name}\\}\\}`, 'g');
        prompt = prompt.replace(placeholder, String(value));
      }
    }

    // Remove any remaining unreplaced placeholders
    prompt = prompt.replace(/\{\{[^}]+\}\}/g, '');

    return prompt.trim();
  }
}

// Singleton instance
let instance: CustomSkillLoader | null = null;

export function getCustomSkillLoader(): CustomSkillLoader {
  if (!instance) {
    instance = new CustomSkillLoader();
  }
  return instance;
}
