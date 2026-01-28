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
      // Development Skills
      {
        id: 'git-commit',
        name: 'Git Commit',
        description: 'Create a well-formatted commit message from staged changes',
        icon: '📝',
        category: 'Development',
        prompt: `Please analyze the staged git changes and create a well-formatted commit message.

Steps:
1. Run \`git diff --staged\` to see the changes
2. Analyze what was changed and why
3. Create a commit message following conventional commits format:
   - type(scope): description
   - Types: feat, fix, docs, style, refactor, test, chore
4. Include a brief body if the changes are complex
5. Run \`git commit -m "message"\` with the generated message

Make the commit message clear, concise, and descriptive.`,
        parameters: [],
        enabled: true,
      },
      {
        id: 'debug-error',
        name: 'Debug Error',
        description: 'Analyze an error message and suggest fixes',
        icon: '🐛',
        category: 'Development',
        prompt: `Please help me debug this error:

{{error}}

Steps:
1. Analyze the error message and stack trace
2. Identify the root cause
3. Search for the relevant code in the project
4. Suggest specific fixes with code examples
5. Explain why the error occurred and how to prevent it

If you need more context, ask me to provide relevant files.`,
        parameters: [
          {
            name: 'error',
            type: 'string',
            description: 'The error message or stack trace',
            required: true,
          },
        ],
        enabled: true,
      },
      {
        id: 'security-audit',
        name: 'Security Audit',
        description: 'Check code for common security vulnerabilities',
        icon: '🔒',
        category: 'Development',
        prompt: `Please perform a security audit on {{path}}.

Check for:
- SQL injection vulnerabilities
- XSS (Cross-Site Scripting) risks
- Command injection possibilities
- Insecure data handling
- Hardcoded secrets or credentials
- Insecure dependencies
- Authentication/authorization issues
- Input validation problems
- Sensitive data exposure

For each issue found:
1. Describe the vulnerability
2. Explain the potential impact
3. Provide a fix with code example
4. Rate severity (Critical/High/Medium/Low)`,
        parameters: [
          {
            name: 'path',
            type: 'string',
            description: 'Path to file or folder to audit',
            required: true,
            default: '.',
          },
        ],
        enabled: true,
      },
      {
        id: 'add-documentation',
        name: 'Add Documentation',
        description: 'Generate JSDoc/docstrings for functions',
        icon: '📚',
        category: 'Development',
        prompt: `Please add documentation to all functions in {{path}}.

Requirements:
- Use {{style}} documentation style
- Document all parameters with types
- Document return values
- Add brief description of what each function does
- Include @example where helpful
- Note any side effects or exceptions

Preserve existing documentation if it's accurate, enhance if needed.`,
        parameters: [
          {
            name: 'path',
            type: 'string',
            description: 'Path to the file to document',
            required: true,
          },
          {
            name: 'style',
            type: 'select',
            description: 'Documentation style',
            required: true,
            default: 'JSDoc',
            options: ['JSDoc', 'TSDoc', 'Python docstring', 'Javadoc', 'XML comments'],
          },
        ],
        enabled: true,
      },
      {
        id: 'convert-code',
        name: 'Convert Code',
        description: 'Convert code from one language to another',
        icon: '🔄',
        category: 'Development',
        prompt: `Please convert the code in {{path}} from its current language to {{targetLanguage}}.

Requirements:
- Maintain the same functionality
- Use idiomatic patterns for the target language
- Preserve comments (translated if needed)
- Handle language-specific differences appropriately
- Add type annotations if the target language supports them

Save the converted code to a new file with the appropriate extension.`,
        parameters: [
          {
            name: 'path',
            type: 'string',
            description: 'Path to the source file',
            required: true,
          },
          {
            name: 'targetLanguage',
            type: 'select',
            description: 'Target programming language',
            required: true,
            default: 'TypeScript',
            options: ['TypeScript', 'JavaScript', 'Python', 'Go', 'Rust', 'Java', 'C#', 'Ruby'],
          },
        ],
        enabled: true,
      },
      // Project Skills
      {
        id: 'generate-readme',
        name: 'Generate README',
        description: 'Create a README.md for a project',
        icon: '📄',
        category: 'Project',
        prompt: `Please analyze this project and generate a comprehensive README.md.

Include:
- Project title and description
- Features list
- Installation instructions
- Usage examples
- Configuration options
- API documentation (if applicable)
- Contributing guidelines
- License information

Analyze the codebase to understand:
- What the project does
- How to install dependencies
- How to run/build the project
- Key configuration files

Save the README.md in the project root.`,
        parameters: [],
        enabled: true,
      },
      {
        id: 'create-changelog',
        name: 'Create Changelog',
        description: 'Generate changelog from git commits',
        icon: '📰',
        category: 'Project',
        prompt: `Please generate a CHANGELOG.md from the git history.

Steps:
1. Run \`git log --oneline\` to get recent commits
2. Group commits by type (Features, Bug Fixes, etc.)
3. Format according to Keep a Changelog standard
4. Include version numbers if tags exist
5. Add dates for each version

Format:
## [Version] - YYYY-MM-DD
### Added
### Changed
### Fixed
### Removed

Generate for the last {{commits}} commits.`,
        parameters: [
          {
            name: 'commits',
            type: 'select',
            description: 'Number of commits to include',
            required: true,
            default: '50',
            options: ['20', '50', '100', 'all'],
          },
        ],
        enabled: true,
      },
      {
        id: 'dependency-check',
        name: 'Dependency Check',
        description: 'Audit dependencies for updates and vulnerabilities',
        icon: '📦',
        category: 'Project',
        prompt: `Please audit the project dependencies.

Steps:
1. Identify the package manager (npm, yarn, pip, etc.)
2. List all dependencies with current versions
3. Check for available updates
4. Run security audit if available (npm audit, pip-audit, etc.)
5. Identify deprecated packages

Report:
- Outdated packages with latest versions
- Security vulnerabilities with severity
- Deprecated packages that need replacement
- Recommendations for updates

Be careful about breaking changes in major version updates.`,
        parameters: [],
        enabled: true,
      },
      {
        id: 'project-structure',
        name: 'Project Structure',
        description: 'Analyze and explain project architecture',
        icon: '🏗️',
        category: 'Project',
        prompt: `Please analyze this project's structure and architecture.

Provide:
1. **Directory Structure**: Visual tree of important directories
2. **Architecture Overview**: How the project is organized
3. **Key Files**: Entry points, configs, main modules
4. **Data Flow**: How data moves through the system
5. **Dependencies**: External libraries and their purposes
6. **Design Patterns**: Patterns used in the codebase
7. **Tech Stack**: Languages, frameworks, tools used

Format as a clear, well-organized document that would help a new developer understand the project.`,
        parameters: [],
        enabled: true,
      },
      // Data & Documents Skills
      {
        id: 'analyze-csv',
        name: 'Analyze CSV',
        description: 'Load a CSV and provide insights',
        icon: '📊',
        category: 'Data',
        prompt: `Please analyze the CSV file at {{path}}.

Provide:
1. **Overview**: Number of rows, columns, file size
2. **Columns**: List each column with data type and sample values
3. **Statistics**: For numeric columns - min, max, mean, median
4. **Missing Data**: Identify columns with null/empty values
5. **Patterns**: Any notable patterns or anomalies
6. **Insights**: Key findings and observations

If the file is large, analyze a representative sample.
Create visualizations or summary tables if helpful.`,
        parameters: [
          {
            name: 'path',
            type: 'string',
            description: 'Path to the CSV file',
            required: true,
          },
        ],
        enabled: true,
      },
      {
        id: 'compare-files',
        name: 'Compare Files',
        description: 'Compare two files and show differences',
        icon: '⚖️',
        category: 'Data',
        prompt: `Please compare these two files and show the differences:

File 1: {{file1}}
File 2: {{file2}}

Provide:
1. **Summary**: High-level overview of differences
2. **Added**: Lines/sections only in File 2
3. **Removed**: Lines/sections only in File 1
4. **Modified**: Lines that changed between files
5. **Statistics**: Number of additions, deletions, modifications

For code files, highlight semantic differences (not just whitespace).
For data files, compare structure and content.`,
        parameters: [
          {
            name: 'file1',
            type: 'string',
            description: 'Path to the first file',
            required: true,
          },
          {
            name: 'file2',
            type: 'string',
            description: 'Path to the second file',
            required: true,
          },
        ],
        enabled: true,
      },
      {
        id: 'proofread',
        name: 'Proofread',
        description: 'Check document for grammar and clarity',
        icon: '✏️',
        category: 'Writing',
        prompt: `Please proofread the document at {{path}}.

Check for:
- Spelling errors
- Grammar mistakes
- Punctuation issues
- Awkward phrasing
- Unclear sentences
- Consistency (terminology, formatting)
- Tone appropriateness

For each issue:
1. Quote the original text
2. Explain the problem
3. Suggest a correction

At the end, provide:
- Overall quality score (1-10)
- Summary of common issues
- General improvement suggestions`,
        parameters: [
          {
            name: 'path',
            type: 'string',
            description: 'Path to the document',
            required: true,
          },
        ],
        enabled: true,
      },
      {
        id: 'translate',
        name: 'Translate',
        description: 'Translate content to another language',
        icon: '🌐',
        category: 'Writing',
        prompt: `Please translate the content in {{path}} to {{language}}.

Requirements:
- Maintain the original meaning and tone
- Preserve formatting (markdown, code blocks, etc.)
- Keep technical terms consistent
- Adapt idioms appropriately for the target language
- Preserve any code snippets unchanged

Save the translated content to a new file with the language code suffix (e.g., README_es.md).`,
        parameters: [
          {
            name: 'path',
            type: 'string',
            description: 'Path to the file to translate',
            required: true,
          },
          {
            name: 'language',
            type: 'select',
            description: 'Target language',
            required: true,
            default: 'Spanish',
            options: ['Spanish', 'French', 'German', 'Chinese', 'Japanese', 'Korean', 'Portuguese', 'Italian', 'Russian', 'Arabic'],
          },
        ],
        enabled: true,
      },
      // Utility Skills
      {
        id: 'extract-todos',
        name: 'Extract TODOs',
        description: 'Find all TODO/FIXME comments in codebase',
        icon: '📌',
        category: 'Utilities',
        prompt: `Please find all TODO, FIXME, HACK, and XXX comments in the codebase.

Search in {{path}} and provide:
1. **Summary**: Total count by type
2. **By File**: Group findings by file
3. **By Priority**: If priority markers exist (e.g., TODO(high))
4. **Old TODOs**: Identify TODOs that might be stale

For each TODO:
- File path and line number
- The full comment text
- Surrounding context if helpful

Suggest which TODOs should be prioritized based on:
- Security implications
- Bug-related issues
- Technical debt impact`,
        parameters: [
          {
            name: 'path',
            type: 'string',
            description: 'Path to search',
            required: true,
            default: '.',
          },
        ],
        enabled: true,
      },
      {
        id: 'clean-imports',
        name: 'Clean Imports',
        description: 'Remove unused imports from files',
        icon: '🧹',
        category: 'Utilities',
        prompt: `Please clean up imports in {{path}}.

Tasks:
1. Remove unused imports
2. Sort imports alphabetically
3. Group imports by type:
   - Built-in/standard library
   - External packages
   - Internal/local imports
4. Remove duplicate imports
5. Fix import paths if needed

Apply changes and report:
- Number of imports removed
- Files modified
- Any potential issues found`,
        parameters: [
          {
            name: 'path',
            type: 'string',
            description: 'Path to file or folder',
            required: true,
            default: '.',
          },
        ],
        enabled: true,
      },
      {
        id: 'rename-symbol',
        name: 'Rename Symbol',
        description: 'Rename a variable/function across files',
        icon: '🏷️',
        category: 'Utilities',
        prompt: `Please rename "{{oldName}}" to "{{newName}}" across the project.

Steps:
1. Find all occurrences of the symbol
2. Distinguish between:
   - The actual symbol (function, variable, class)
   - String literals containing the name
   - Comments mentioning the name
3. Rename only the actual symbol references
4. Update imports/exports as needed
5. Check for naming conflicts

Report:
- Files modified
- Number of replacements
- Any manual review needed (strings, comments)

Be careful not to rename unrelated code that happens to have the same name.`,
        parameters: [
          {
            name: 'oldName',
            type: 'string',
            description: 'Current name of the symbol',
            required: true,
          },
          {
            name: 'newName',
            type: 'string',
            description: 'New name for the symbol',
            required: true,
          },
        ],
        enabled: true,
      },
      // Guideline Skills - injected into system prompt when enabled
      {
        id: 'karpathy-guidelines',
        name: 'Karpathy Coding Guidelines',
        description: 'Best practices for LLM coding behavior based on Andrej Karpathy\'s observations',
        icon: '🧠',
        category: 'Guidelines',
        type: 'guideline',
        priority: 1,
        prompt: `## Coding Guidelines

**1. Think Before Coding**
- State assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

**2. Simplicity First**
- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

**3. Surgical Changes**
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.
- Every changed line should trace directly to the user's request.

**4. Goal-Driven Execution**
- Transform tasks into verifiable goals.
- For multi-step tasks, state a brief plan with verification steps.
- Loop until success criteria are met.`,
        parameters: [],
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
