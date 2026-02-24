/**
 * Plugin Pack Installer
 *
 * Handles installing plugin packs from:
 * - Git repositories (clone + validate)
 * - URLs (download manifest + validate)
 * - Local directories (copy + validate)
 *
 * Follows the same patterns as SkillRegistry for consistency.
 */

import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { app } from "electron";
import { validateManifest } from "./loader";
import { PluginManifest } from "./types";

const execFileAsync = promisify(execFile);

const MANIFEST_FILENAME = "cowork.plugin.json";

/** Regex for valid pack names */
const VALID_PACK_ID = /^[a-z0-9_-]+$/;

/** Maximum clone timeout (60 seconds) */
const GIT_CLONE_TIMEOUT_MS = 60_000;

/** Maximum manifest download timeout (15 seconds) */
const FETCH_TIMEOUT_MS = 15_000;

export interface InstallProgress {
  packName: string;
  status: "downloading" | "validating" | "installing" | "completed" | "failed";
  progress: number; // 0-100
  message?: string;
  error?: string;
}

export type InstallProgressCallback = (progress: InstallProgress) => void;

export interface InstallResult {
  success: boolean;
  packName?: string;
  path?: string;
  manifest?: PluginManifest;
  error?: string;
  skillCount?: number;
  agentCount?: number;
}

export interface UninstallResult {
  success: boolean;
  packName?: string;
  error?: string;
}

/**
 * Validate and sanitize a pack ID
 */
function sanitizePackId(packId: string): string | null {
  if (!packId || typeof packId !== "string") return null;

  const normalized = packId.trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > 128) return null;

  // Reject path traversal
  if (normalized.includes("..") || normalized.includes("/") || normalized.includes("\\")) {
    console.warn(`[PackInstaller] Path traversal attempt rejected: ${packId}`);
    return null;
  }

  if (!VALID_PACK_ID.test(normalized)) {
    console.warn(`[PackInstaller] Invalid pack ID rejected: ${packId}`);
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
 * Ensure the extensions directory exists
 */
function ensureExtensionsDir(): string {
  const dir = getUserExtensionsDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Check if git is available on the system
 */
async function isGitAvailable(): Promise<boolean> {
  try {
    await execFileAsync("git", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse a git URL into repo URL and optional subdirectory
 *
 * Supports formats:
 * - github:owner/repo
 * - https://github.com/owner/repo
 * - https://github.com/owner/repo.git
 * - git@github.com:owner/repo.git
 */
function parseGitUrl(input: string): { url: string; name: string } | null {
  let url = input.trim();
  let name: string;

  // Shorthand: github:owner/repo
  if (url.startsWith("github:")) {
    const parts = url.slice(7).split("/");
    if (parts.length < 2) return null;
    name = parts[parts.length - 1].replace(/\.git$/, "");
    url = `https://github.com/${parts.join("/")}`;
  }
  // HTTPS URL
  else if (url.startsWith("https://") || url.startsWith("http://")) {
    const urlParts = url.split("/").filter(Boolean);
    name = urlParts[urlParts.length - 1].replace(/\.git$/, "");
  }
  // SSH URL
  else if (url.startsWith("git@")) {
    const match = url.match(/git@[^:]+:(.+?)(?:\.git)?$/);
    if (!match) return null;
    const parts = match[1].split("/");
    name = parts[parts.length - 1];
  } else {
    return null;
  }

  // Sanitize the derived name
  name = name.toLowerCase().replace(/[^a-z0-9-_]/g, "-");

  return { url, name };
}

/**
 * Install a plugin pack from a Git repository
 */
export async function installFromGit(
  gitUrl: string,
  onProgress?: InstallProgressCallback,
): Promise<InstallResult> {
  const notify = (partial: Partial<InstallProgress>) => {
    onProgress?.({
      packName: partial.packName || "unknown",
      status: partial.status || "downloading",
      progress: partial.progress || 0,
      ...partial,
    });
  };

  // Parse and validate URL
  const parsed = parseGitUrl(gitUrl);
  if (!parsed) {
    return { success: false, error: `Invalid git URL: ${gitUrl}` };
  }

  // Check git availability
  if (!(await isGitAvailable())) {
    return { success: false, error: "Git is not installed or not in PATH" };
  }

  const extensionsDir = ensureExtensionsDir();
  const targetDir = path.join(extensionsDir, parsed.name);

  // Check if already installed
  if (fs.existsSync(targetDir)) {
    return { success: false, error: `Pack "${parsed.name}" is already installed at ${targetDir}` };
  }

  notify({ packName: parsed.name, status: "downloading", progress: 10, message: "Cloning repository..." });

  try {
    // Shallow clone (single branch, depth 1) for speed
    await execFileAsync(
      "git",
      ["clone", "--depth", "1", "--single-branch", parsed.url, targetDir],
      { timeout: GIT_CLONE_TIMEOUT_MS },
    );

    notify({ packName: parsed.name, status: "validating", progress: 60, message: "Validating manifest..." });

    // Check for manifest
    const manifestPath = path.join(targetDir, MANIFEST_FILENAME);
    if (!fs.existsSync(manifestPath)) {
      // Clean up
      fs.rmSync(targetDir, { recursive: true, force: true });
      return { success: false, error: `Repository does not contain ${MANIFEST_FILENAME}` };
    }

    // Parse and validate manifest
    const manifestContent = fs.readFileSync(manifestPath, "utf-8");
    let manifest: PluginManifest;
    try {
      manifest = JSON.parse(manifestContent);
      if (!validateManifest(manifest)) {
        throw new Error("Invalid manifest");
      }
    } catch (validationError) {
      fs.rmSync(targetDir, { recursive: true, force: true });
      return {
        success: false,
        error: `Invalid manifest: ${validationError instanceof Error ? validationError.message : String(validationError)}`,
      };
    }

    // Remove .git directory to save space (we don't need history)
    const gitDir = path.join(targetDir, ".git");
    if (fs.existsSync(gitDir)) {
      fs.rmSync(gitDir, { recursive: true, force: true });
    }

    notify({ packName: manifest.name, status: "completed", progress: 100, message: "Installed successfully" });

    return {
      success: true,
      packName: manifest.name,
      path: targetDir,
      manifest,
      skillCount: manifest.skills?.length || 0,
      agentCount: manifest.agentRoles?.length || 0,
    };
  } catch (error) {
    // Clean up on failure
    try {
      if (fs.existsSync(targetDir)) {
        fs.rmSync(targetDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors
    }

    return {
      success: false,
      error: `Git clone failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Install a plugin pack from a URL pointing to a cowork.plugin.json
 */
export async function installFromUrl(
  url: string,
  onProgress?: InstallProgressCallback,
): Promise<InstallResult> {
  const notify = (partial: Partial<InstallProgress>) => {
    onProgress?.({
      packName: partial.packName || "unknown",
      status: partial.status || "downloading",
      progress: partial.progress || 0,
      ...partial,
    });
  };

  notify({ status: "downloading", progress: 10, message: "Fetching manifest..." });

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}: ${response.statusText}` };
    }

    const manifestData = await response.json();

    notify({ status: "validating", progress: 50, message: "Validating manifest..." });

    // Validate
    if (!validateManifest(manifestData as unknown)) {
      return { success: false, error: "Invalid plugin manifest" };
    }

    const manifest = manifestData as PluginManifest;
    const safeId = sanitizePackId(manifest.name);
    if (!safeId) {
      return { success: false, error: `Invalid pack name: ${manifest.name}` };
    }

    const extensionsDir = ensureExtensionsDir();
    const targetDir = path.join(extensionsDir, safeId);

    if (fs.existsSync(targetDir)) {
      return { success: false, error: `Pack "${safeId}" is already installed` };
    }

    notify({ packName: safeId, status: "installing", progress: 70, message: "Installing pack..." });

    // Create directory and write manifest
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(
      path.join(targetDir, MANIFEST_FILENAME),
      JSON.stringify(manifest, null, 2) + "\n",
      "utf-8",
    );

    notify({ packName: safeId, status: "completed", progress: 100, message: "Installed successfully" });

    return {
      success: true,
      packName: safeId,
      path: targetDir,
      manifest,
      skillCount: manifest.skills?.length || 0,
      agentCount: manifest.agentRoles?.length || 0,
    };
  } catch (error) {
    return {
      success: false,
      error: `Install failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Uninstall a user-installed plugin pack
 *
 * Only removes packs from the user extensions directory.
 * Bundled packs cannot be uninstalled.
 */
export async function uninstallPack(packName: string): Promise<UninstallResult> {
  const safeId = sanitizePackId(packName);
  if (!safeId) {
    return { success: false, error: `Invalid pack name: ${packName}` };
  }

  const extensionsDir = getUserExtensionsDir();
  const packDir = path.join(extensionsDir, safeId);

  // Only allow uninstalling from user extensions directory
  if (!fs.existsSync(packDir)) {
    return { success: false, error: `Pack "${safeId}" is not installed in user extensions` };
  }

  // Verify it's actually a plugin pack
  const manifestPath = path.join(packDir, MANIFEST_FILENAME);
  if (!fs.existsSync(manifestPath)) {
    return { success: false, error: `Directory "${safeId}" does not contain a valid plugin pack` };
  }

  try {
    fs.rmSync(packDir, { recursive: true, force: true });
    console.log(`[PackInstaller] Uninstalled pack: ${safeId}`);
    return { success: true, packName: safeId };
  } catch (error) {
    return {
      success: false,
      error: `Uninstall failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * List user-installed plugin packs (from ~/.cowork/extensions/)
 */
export function listInstalledPacks(): { name: string; path: string; manifest?: PluginManifest }[] {
  const extensionsDir = getUserExtensionsDir();

  if (!fs.existsSync(extensionsDir)) {
    return [];
  }

  const results: { name: string; path: string; manifest?: PluginManifest }[] = [];

  const entries = fs.readdirSync(extensionsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const packDir = path.join(extensionsDir, entry.name);
    const manifestPath = path.join(packDir, MANIFEST_FILENAME);

    if (!fs.existsSync(manifestPath)) continue;

    try {
      const content = fs.readFileSync(manifestPath, "utf-8");
      const manifest = JSON.parse(content) as PluginManifest;
      results.push({ name: entry.name, path: packDir, manifest });
    } catch {
      results.push({ name: entry.name, path: packDir });
    }
  }

  return results;
}
