/**
 * Custom Skill Loader
 *
 * Loads, manages, and provides access to user-defined custom skills.
 * Skills are stored as JSON files in ~/.cowork/skills/
 */

import { app, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { CustomSkill, SkillParameter } from '../../shared/types';

const SKILLS_FOLDER_NAME = 'skills';
const SKILL_FILE_EXTENSION = '.json';

export class CustomSkillLoader {
  private skillsDirectory: string;
  private skills: Map<string, CustomSkill> = new Map();
  private initialized: boolean = false;

  constructor() {
    // Default skills directory: ~/.cowork/skills/
    const userDataPath = app.getPath('userData');
    this.skillsDirectory = path.join(userDataPath, SKILLS_FOLDER_NAME);
  }

  /**
   * Initialize the skill loader - ensures directory exists and loads skills
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Ensure skills directory exists
    await this.ensureSkillsDirectory();

    // Create sample skills if directory is empty
    await this.createSampleSkillsIfEmpty();

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
   * Ensure the skills directory exists
   */
  private async ensureSkillsDirectory(): Promise<void> {
    try {
      if (!fs.existsSync(this.skillsDirectory)) {
        fs.mkdirSync(this.skillsDirectory, { recursive: true });
        console.log(`[CustomSkillLoader] Created skills directory: ${this.skillsDirectory}`);
      }
    } catch (error) {
      console.error('[CustomSkillLoader] Failed to create skills directory:', error);
      throw error;
    }
  }

  /**
   * Create sample skills if the directory is empty
   */
  private async createSampleSkillsIfEmpty(): Promise<void> {
    try {
      const files = fs.readdirSync(this.skillsDirectory);
      const skillFiles = files.filter(f => f.endsWith(SKILL_FILE_EXTENSION));

      if (skillFiles.length === 0) {
        console.log('[CustomSkillLoader] Creating sample skills...');
        await this.createSampleSkills();
      }
    } catch (error) {
      console.error('[CustomSkillLoader] Failed to check/create sample skills:', error);
    }
  }

  /**
   * Create default sample skills
   */
  private async createSampleSkills(): Promise<void> {
    const sampleSkills: CustomSkill[] = [
      {
        id: 'code-review',
        name: 'Code Review',
        description: 'Review code for best practices and potential issues',
        icon: '🔍',
        category: 'Development',
        prompt: `Please review the code in {{path}} and provide feedback on:
- Code quality and best practices
- Potential bugs or issues
- Performance considerations
- Security concerns
- Suggestions for improvement

Be constructive and specific in your feedback.`,
        parameters: [
          {
            name: 'path',
            type: 'string',
            description: 'Path to the file or folder to review',
            required: true,
            default: '.',
          },
        ],
        enabled: true,
      },
      {
        id: 'write-tests',
        name: 'Write Tests',
        description: 'Generate unit tests for existing code',
        icon: '🧪',
        category: 'Development',
        prompt: `Please analyze the code in {{path}} and write comprehensive unit tests for it.

Requirements:
- Use {{framework}} testing framework
- Cover edge cases and error handling
- Include both positive and negative test cases
- Add clear test descriptions

Save the tests in a file with appropriate naming convention.`,
        parameters: [
          {
            name: 'path',
            type: 'string',
            description: 'Path to the file to test',
            required: true,
          },
          {
            name: 'framework',
            type: 'select',
            description: 'Testing framework to use',
            required: true,
            default: 'jest',
            options: ['jest', 'mocha', 'vitest', 'pytest', 'unittest'],
          },
        ],
        enabled: true,
      },
      {
        id: 'summarize-folder',
        name: 'Summarize Folder',
        description: 'Create a summary of all files in a folder',
        icon: '📋',
        category: 'Documentation',
        prompt: `Please analyze all the files in {{path}} and create a comprehensive summary.

Include:
- Overview of the folder structure
- Purpose of each file/module
- Key functions and classes
- Dependencies and relationships between files
- Any notable patterns or conventions

Format the output as a clear, well-organized document.`,
        parameters: [
          {
            name: 'path',
            type: 'string',
            description: 'Folder path to summarize',
            required: true,
            default: '.',
          },
        ],
        enabled: true,
      },
      {
        id: 'refactor-code',
        name: 'Refactor Code',
        description: 'Improve code structure and readability',
        icon: '🔧',
        category: 'Development',
        prompt: `Please refactor the code in {{path}} to improve its quality.

Focus on:
- {{focus}}
- Maintaining the same functionality
- Adding comments where helpful
- Following best practices for the language

Explain the changes you make and why.`,
        parameters: [
          {
            name: 'path',
            type: 'string',
            description: 'Path to the file to refactor',
            required: true,
          },
          {
            name: 'focus',
            type: 'select',
            description: 'What to focus on',
            required: true,
            default: 'readability',
            options: ['readability', 'performance', 'modularity', 'error handling', 'all of the above'],
          },
        ],
        enabled: true,
      },
      {
        id: 'explain-code',
        name: 'Explain Code',
        description: 'Get a detailed explanation of how code works',
        icon: '📖',
        category: 'Learning',
        prompt: `Please explain the code in {{path}} in detail.

Include:
- What the code does at a high level
- How it works step by step
- Key concepts and patterns used
- Any complex or tricky parts
- How it fits into the larger system (if applicable)

Explain at a {{level}} level.`,
        parameters: [
          {
            name: 'path',
            type: 'string',
            description: 'Path to the file to explain',
            required: true,
          },
          {
            name: 'level',
            type: 'select',
            description: 'Explanation depth',
            required: true,
            default: 'intermediate',
            options: ['beginner', 'intermediate', 'advanced'],
          },
        ],
        enabled: true,
      },
    ];

    for (const skill of sampleSkills) {
      await this.saveSkill(skill);
    }

    console.log(`[CustomSkillLoader] Created ${sampleSkills.length} sample skills`);
  }

  /**
   * Reload all skills from disk
   */
  async reloadSkills(): Promise<CustomSkill[]> {
    this.skills.clear();

    try {
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
      // Sort by category first, then by name
      if (a.category && b.category && a.category !== b.category) {
        return a.category.localeCompare(b.category);
      }
      return a.name.localeCompare(b.name);
    });
  }

  /**
   * Get a specific skill by ID
   */
  getSkill(id: string): CustomSkill | undefined {
    return this.skills.get(id);
  }

  /**
   * Save a skill to disk
   */
  async saveSkill(skill: CustomSkill): Promise<CustomSkill> {
    // Ensure ID is valid filename
    const safeId = skill.id.replace(/[^a-zA-Z0-9-_]/g, '-');
    const fileName = `${safeId}${SKILL_FILE_EXTENSION}`;
    const filePath = path.join(this.skillsDirectory, fileName);

    // Set default values
    skill.enabled = skill.enabled !== false;
    skill.icon = skill.icon || '⚡';
    skill.filePath = filePath;

    try {
      fs.writeFileSync(filePath, JSON.stringify(skill, null, 2), 'utf-8');
      this.skills.set(skill.id, skill);
      console.log(`[CustomSkillLoader] Saved skill: ${skill.name}`);
      return skill;
    } catch (error) {
      console.error(`[CustomSkillLoader] Failed to save skill ${skill.id}:`, error);
      throw error;
    }
  }

  /**
   * Create a new skill
   */
  async createSkill(skillData: Omit<CustomSkill, 'filePath'>): Promise<CustomSkill> {
    // Generate ID from name if not provided
    if (!skillData.id) {
      skillData.id = skillData.name
        .toLowerCase()
        .replace(/[^a-zA-Z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
    }

    // Check for duplicate ID
    if (this.skills.has(skillData.id)) {
      throw new Error(`Skill with ID "${skillData.id}" already exists`);
    }

    return this.saveSkill(skillData as CustomSkill);
  }

  /**
   * Update an existing skill
   */
  async updateSkill(id: string, updates: Partial<CustomSkill>): Promise<CustomSkill> {
    const existing = this.skills.get(id);
    if (!existing) {
      throw new Error(`Skill "${id}" not found`);
    }

    // If ID is being changed, delete the old file
    if (updates.id && updates.id !== id) {
      await this.deleteSkill(id);
      return this.createSkill({ ...existing, ...updates } as CustomSkill);
    }

    const updated = { ...existing, ...updates };
    return this.saveSkill(updated);
  }

  /**
   * Delete a skill
   */
  async deleteSkill(id: string): Promise<boolean> {
    const skill = this.skills.get(id);
    if (!skill) {
      return false;
    }

    try {
      if (skill.filePath && fs.existsSync(skill.filePath)) {
        fs.unlinkSync(skill.filePath);
      }
      this.skills.delete(id);
      console.log(`[CustomSkillLoader] Deleted skill: ${id}`);
      return true;
    } catch (error) {
      console.error(`[CustomSkillLoader] Failed to delete skill ${id}:`, error);
      throw error;
    }
  }

  /**
   * Open the skills folder in the system file manager
   */
  async openSkillsFolder(): Promise<void> {
    await this.ensureSkillsDirectory();
    shell.openPath(this.skillsDirectory);
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
