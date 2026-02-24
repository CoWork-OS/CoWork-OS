/**
 * Plugin Pack Scaffolding
 *
 * Creates new plugin pack skeletons with a valid cowork.plugin.json
 * manifest and directory structure for user customization.
 */

import * as fs from "fs";
import * as path from "path";
import { app } from "electron";

/** Valid pack categories */
const VALID_CATEGORIES = [
  "Engineering",
  "Sales",
  "Finance",
  "HR",
  "Design",
  "Data",
  "Marketing",
  "Operations",
  "Security",
  "Productivity",
  "Management",
  "Product",
  "Custom",
] as const;

interface ScaffoldOptions {
  /** Pack name (kebab-case, used as directory name and manifest name) */
  name: string;
  /** Human-readable display name */
  displayName: string;
  /** Brief description */
  description?: string;
  /** Category for grouping */
  category?: string;
  /** Emoji icon */
  icon?: string;
  /** Author name */
  author?: string;
  /** Whether to include example skill */
  includeExampleSkill?: boolean;
  /** Whether to include example agent role */
  includeExampleAgent?: boolean;
  /** Optional persona template ID to link */
  personaTemplateId?: string;
  /** Target directory (defaults to ~/.cowork/extensions/) */
  targetDir?: string;
}

interface ScaffoldResult {
  success: boolean;
  path?: string;
  error?: string;
  filesCreated?: string[];
}

/**
 * Validate a pack name for safe filesystem use
 */
function validatePackName(name: string): string | null {
  if (!name || typeof name !== "string") return null;

  const normalized = name.trim().toLowerCase();

  // Must be kebab-case: lowercase alphanumeric with hyphens
  if (!/^[a-z][a-z0-9-]*[a-z0-9]$/.test(normalized) || normalized.length > 64) {
    return null;
  }

  // Reject path traversal
  if (normalized.includes("..") || normalized.includes("/") || normalized.includes("\\")) {
    return null;
  }

  return normalized;
}

/**
 * Get the user extensions directory
 */
function getUserExtensionsDir(): string {
  const userDataPath = app?.getPath?.("userData") || path.join(process.env.HOME || "", ".cowork");
  return path.join(userDataPath, "extensions");
}

/**
 * Generate a scaffold manifest
 */
function generateManifest(options: ScaffoldOptions): object {
  const manifest: Record<string, unknown> = {
    name: `${options.name}-pack`,
    displayName: options.displayName,
    version: "1.0.0",
    description: options.description || `Custom plugin pack for ${options.displayName}`,
    type: "pack",
    author: options.author || "Custom",
    keywords: [options.name],
    icon: options.icon || "📦",
    category: options.category || "Custom",
  };

  if (options.personaTemplateId) {
    manifest.personaTemplateId = options.personaTemplateId;
  }

  manifest.tryAsking = [
    `Help me with ${options.displayName.toLowerCase()} tasks`,
    `Analyze this and provide recommendations`,
  ];

  // Skills
  const skills: object[] = [];

  if (options.includeExampleSkill !== false) {
    skills.push({
      id: `${options.name}-analyze`,
      name: `${options.displayName} Analysis`,
      description: `Analyze input and provide ${options.displayName.toLowerCase()}-specific recommendations`,
      icon: "🔍",
      category: options.category || "Custom",
      prompt: `Analyze the following input from a ${options.displayName.toLowerCase()} perspective.\n\nInput:\n{{input}}\n\nContext: {{context}}\n\nPlease provide:\n1. Key observations\n2. Recommendations\n3. Action items\n4. Potential risks or concerns`,
      parameters: [
        {
          name: "input",
          type: "string",
          description: "The input to analyze",
          required: true,
        },
        {
          name: "context",
          type: "string",
          description: "Additional context or constraints",
          required: false,
        },
      ],
      enabled: true,
    });
  }

  manifest.skills = skills;

  // Agent roles
  const agentRoles: object[] = [];

  if (options.includeExampleAgent !== false) {
    agentRoles.push({
      name: `${options.name}-assistant`,
      displayName: `${options.displayName} Assistant`,
      description: `Assists with ${options.displayName.toLowerCase()} workflows and tasks`,
      icon: options.icon || "📦",
      color: "#6366f1",
      capabilities: ["analyze", "write", "research"],
      systemPrompt: `You are a ${options.displayName} Assistant. You help users with ${options.displayName.toLowerCase()}-related tasks. Be precise, thorough, and actionable in your responses.`,
    });
  }

  manifest.agentRoles = agentRoles;

  return manifest;
}

/**
 * Create a new plugin pack skeleton
 */
export async function scaffoldPluginPack(options: ScaffoldOptions): Promise<ScaffoldResult> {
  // Validate name
  const safeName = validatePackName(options.name);
  if (!safeName) {
    return {
      success: false,
      error: `Invalid pack name "${options.name}". Use lowercase letters, numbers, and hyphens (e.g., "my-custom-pack").`,
    };
  }

  // Determine target directory
  const baseDir = options.targetDir || getUserExtensionsDir();
  const packDir = path.join(baseDir, safeName);

  // Check if already exists
  if (fs.existsSync(packDir)) {
    return {
      success: false,
      error: `Pack directory already exists: ${packDir}`,
    };
  }

  try {
    // Ensure base directory exists
    fs.mkdirSync(baseDir, { recursive: true });

    // Create pack directory
    fs.mkdirSync(packDir, { recursive: true });

    const filesCreated: string[] = [];

    // Write manifest
    const manifest = generateManifest({ ...options, name: safeName });
    const manifestPath = path.join(packDir, "cowork.plugin.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
    filesCreated.push("cowork.plugin.json");

    console.log(`[Scaffold] Created plugin pack at ${packDir}`);

    return {
      success: true,
      path: packDir,
      filesCreated,
    };
  } catch (error) {
    // Clean up on failure
    try {
      if (fs.existsSync(packDir)) {
        fs.rmSync(packDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors
    }

    return {
      success: false,
      error: `Failed to scaffold pack: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Get available categories for scaffolding
 */
export function getAvailableCategories(): string[] {
  return [...VALID_CATEGORIES];
}

/**
 * Get the user extensions directory path
 */
export function getExtensionsDir(): string {
  return getUserExtensionsDir();
}
