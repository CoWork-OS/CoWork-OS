/**
 * Skill Registry Service
 *
 * Handles communication with the remote skill registry for:
 * - Searching skills
 * - Installing skills
 * - Updating skills
 * - Publishing skills (future)
 */

import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import JSZip from "jszip";
import { getUserDataDir } from "../utils/user-data-dir";
import {
  CapabilitySecurityReport,
  CustomSkill,
  ImportSecurityReportRequest,
  InstallSecurityOutcome,
  QuarantinedImportRecord,
  RetryQuarantinedImportResult,
  SkillRegistryEntry,
  SkillSearchResult,
  SkillInstallProgress,
} from "../../shared/types";
import { getCapabilityBundleSecurityService } from "../security/capability-bundle-security";

// Default registry URL - can be overridden via SKILLHUB_REGISTRY env var.
// When pointing to a GitHub raw URL with a catalog.json, the static catalog mode is used.
const DEFAULT_REGISTRY_URL =
  process.env.SKILLHUB_REGISTRY ||
  "https://raw.githubusercontent.com/CoWork-OS/CoWork-OS/main/registry";
const SKILLS_FOLDER_NAME = "skills";
const execFileAsync = promisify(execFile);

// Cache for the static catalog (avoids re-fetching on every search)
const CATALOG_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const FETCH_TIMEOUT_MS = 15_000;
const GIT_CLONE_TIMEOUT_MS = 60_000;
const MAX_IMPORTED_SKILL_TEXT_BYTES = 512 * 1024;
const MAX_IMPORTED_SKILL_ZIP_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_IMPORTED_SKILL_FILE_BYTES = 512 * 1024;
const MAX_IMPORTED_SKILL_TOTAL_BYTES = 5 * 1024 * 1024;
const MAX_IMPORTED_SKILL_FILE_COUNT = 200;
const CLAWHUB_API_URL = "https://clawhub.ai/api/v1";
const CLAWHUB_CONVEX_URL = "https://wry-manatee-359.convex.cloud";
const CLAWHUB_WEB_URL = "https://clawhub.ai";
const IMPORTED_SKILL_ICON = "📦";
const IMPORTED_SKILL_CATEGORY = "Imported";
const IMPORT_COPY_SKIP_NAMES = new Set([
  ".git",
  ".github",
  ".gitlab",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
]);
const IMPORT_STAGE_MANIFEST_FILENAME = "manifest.json";
const IMPORT_STAGE_BUNDLE_DIRNAME = "bundle";

// Regex for valid skill IDs: lowercase alphanumeric, hyphens, underscores
// This prevents path traversal attacks via malicious skill IDs
const VALID_SKILL_ID = /^[a-z0-9_-]+$/;

interface ParsedFrontmatterResult {
  frontmatter: Record<string, unknown>;
  body: string;
}

/**
 * Validate and sanitize a skill ID to prevent path traversal
 * Returns null if the skill ID is invalid/unsafe
 */
function sanitizeSkillId(skillId: string): string | null {
  if (!skillId || typeof skillId !== "string") {
    return null;
  }

  // Trim whitespace and convert to lowercase
  const normalized = skillId.trim().toLowerCase();

  // Check length limits
  if (normalized.length === 0 || normalized.length > 128) {
    return null;
  }

  // Reject path traversal attempts
  if (normalized.includes("..") || normalized.includes("/") || normalized.includes("\\")) {
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

function normalizeSkillSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseScalar(value: string): unknown {
  const normalized = stripQuotes(value);
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  if (normalized === "null") return null;
  return normalized;
}

function parseFrontmatter(raw: string): ParsedFrontmatterResult {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { frontmatter: {}, body: raw };
  }
  const end = normalized.indexOf("\n---\n", 4);
  if (end === -1) {
    return { frontmatter: {}, body: raw };
  }

  const block = normalized.slice(4, end);
  const body = normalized.slice(end + 5);
  const lines = block.split("\n");
  const frontmatter: Record<string, unknown> = {};

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(/^([A-Za-z0-9_.-]+):(?:\s*(.*))?$/);
    if (!match) continue;

    const [, key, rawValue = ""] = match;
    if (rawValue.trim().length > 0) {
      frontmatter[key] = parseScalar(rawValue);
      continue;
    }

    const items: string[] = [];
    let nextIndex = index + 1;
    while (nextIndex < lines.length) {
      const itemMatch = lines[nextIndex]?.match(/^\s*-\s+(.+)$/);
      if (!itemMatch) break;
      items.push(stripQuotes(itemMatch[1] || ""));
      nextIndex += 1;
    }

    if (items.length > 0) {
      frontmatter[key] = items;
      index = nextIndex - 1;
    } else {
      frontmatter[key] = "";
    }
  }

  return { frontmatter, body };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function arrayValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return [value.trim()];
  }
  return [];
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getResponseContentLength(response: Response): number | undefined {
  const headerValue = response.headers?.get?.("content-length");
  if (!headerValue) return undefined;
  const parsed = Number.parseInt(headerValue, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

async function readResponseBytesWithLimit(
  response: Response,
  maxBytes: number,
  context: string,
): Promise<Uint8Array> {
  const contentLength = getResponseContentLength(response);
  if (contentLength !== undefined && contentLength > maxBytes) {
    throw new Error(`${context} exceeds the ${maxBytes}-byte import limit`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    throw new Error(`${context} exceeds the ${maxBytes}-byte import limit`);
  }
  return bytes;
}

async function readResponseTextWithLimit(
  response: Response,
  maxBytes: number,
  context: string,
): Promise<string> {
  const bytes = await readResponseBytesWithLimit(response, maxBytes, context);
  return Buffer.from(bytes).toString("utf8");
}

function parseGitUrl(input: string): { url: string; name: string } | null {
  let url = input.trim();
  let name: string;

  if (url.startsWith("github:")) {
    const parts = url.slice(7).split("/");
    if (parts.length < 2) return null;
    name = parts[parts.length - 1].replace(/\.git$/, "");
    url = `https://github.com/${parts.join("/")}`;
  } else if (url.startsWith("https://") || url.startsWith("http://")) {
    const urlParts = url.split("/").filter(Boolean);
    name = urlParts[urlParts.length - 1]?.replace(/\.git$/, "") || "skill";
  } else if (url.startsWith("git@")) {
    const match = url.match(/git@[^:]+:(.+?)(?:\.git)?$/);
    if (!match) return null;
    const parts = match[1].split("/");
    name = parts[parts.length - 1] || "skill";
  } else {
    return null;
  }

  return {
    url,
    name: normalizeSkillSlug(name) || "skill",
  };
}

function parseClawHubInput(input: string): { slug: string; url?: string } | null {
  const raw = input.trim();
  if (!raw) {
    return null;
  }

  if (/^clawhub:/i.test(raw)) {
    const slug = normalizeSkillSlug(raw.slice("clawhub:".length));
    return slug ? { slug } : null;
  }

  if (/^https?:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
      if (host !== "clawhub.ai") {
        return null;
      }
      const pathParts = parsed.pathname.replace(/\/+$/g, "").split("/").filter(Boolean);
      if (pathParts.length >= 2 && pathParts[0] !== "skills") {
        const slug = normalizeSkillSlug(pathParts[pathParts.length - 1] || "");
        return slug ? { slug, url: raw } : null;
      }
      if (pathParts.length === 1 && pathParts[0] !== "skills") {
        const slug = normalizeSkillSlug(pathParts[0] || "");
        return slug ? { slug, url: raw } : null;
      }
      return null;
    } catch {
      return null;
    }
  }

  const slug = normalizeSkillSlug(raw);
  return slug ? { slug } : null;
}

export interface SkillRegistryConfig {
  registryUrl?: string;
  managedSkillsDir?: string;
}

export type InstallProgressCallback = (progress: SkillInstallProgress) => void;
export type SkillInstallResult = {
  success: boolean;
  skill?: CustomSkill;
  error?: string;
  security?: InstallSecurityOutcome;
};

export class SkillRegistry {
  private registryUrl: string;
  private managedSkillsDir: string;
  private catalogCache: { entries: SkillRegistryEntry[]; fetchedAt: number } | null = null;
  private readonly securityService = getCapabilityBundleSecurityService();

  constructor(config?: SkillRegistryConfig) {
    this.registryUrl = config?.registryUrl || DEFAULT_REGISTRY_URL;
    this.managedSkillsDir =
      config?.managedSkillsDir || path.join(getUserDataDir(), SKILLS_FOLDER_NAME);

    // Ensure managed skills directory exists
    this.ensureSkillsDirectory();
  }

  /**
   * Detect whether the registry URL points to a static catalog (GitHub raw content)
   * rather than a REST API server.
   */
  private isStaticCatalog(): boolean {
    const url = this.registryUrl.toLowerCase();
    return (
      url.includes("raw.githubusercontent.com") ||
      url.includes("github.io") ||
      url.endsWith("/registry") ||
      url.endsWith("/registry/")
    );
  }

  /**
   * Fetch the static catalog.json and cache it.
   */
  private async fetchCatalog(): Promise<SkillRegistryEntry[]> {
    if (this.catalogCache && Date.now() - this.catalogCache.fetchedAt < CATALOG_CACHE_TTL_MS) {
      return this.catalogCache.entries;
    }

    try {
      const catalogUrl = this.registryUrl.endsWith("/")
        ? `${this.registryUrl}catalog.json`
        : `${this.registryUrl}/catalog.json`;

      const response = await fetch(catalogUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch catalog: ${response.status}`);
      }

      const data = (await response.json()) as { skills?: SkillRegistryEntry[] };
      const entries = Array.isArray(data.skills) ? data.skills : [];
      this.catalogCache = { entries, fetchedAt: Date.now() };
      console.log(`[SkillRegistry] Loaded catalog with ${entries.length} skills`);
      return entries;
    } catch (error) {
      console.error("[SkillRegistry] Failed to fetch catalog:", error);
      return this.catalogCache?.entries || [];
    }
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

  private async fetchWithTimeout(url: string): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      return await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildTempDir(hint: string): string {
    const safeHint = normalizeSkillSlug(hint) || "skill";
    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    return path.join(this.managedSkillsDir, `.tmp-${safeHint}-${nonce}`);
  }

  private makeWritableRecursive(targetPath: string): void {
    const stat = fs.lstatSync(targetPath);
    if (stat.isSymbolicLink()) {
      return;
    }

    if (typeof fs.chmodSync === "function") {
      fs.chmodSync(targetPath, stat.isDirectory() ? 0o700 : 0o600);
    }

    if (!stat.isDirectory()) {
      return;
    }

    for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
      this.makeWritableRecursive(path.join(targetPath, entry.name));
    }
  }

  private removeTempDir(tempDir: string): void {
    if (!fs.existsSync(tempDir)) {
      return;
    }

    try {
      fs.rmSync(tempDir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
      return;
    } catch (firstError) {
      try {
        this.makeWritableRecursive(tempDir);
        fs.rmSync(tempDir, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        });
      } catch (retryError) {
        console.warn(
          "[SkillRegistry] Failed to clean up temporary skill import directory:",
          tempDir,
          retryError instanceof Error ? retryError.message : retryError,
          "initial error:",
          firstError instanceof Error ? firstError.message : firstError,
        );
      }
    }
  }

  private isSkillMetadataFile(fileName: string): boolean {
    const lower = fileName.toLowerCase();
    return lower.endsWith(".security.json") || lower === "build-mode.json";
  }

  private removeManagedSkillArtifacts(skillId: string): void {
    const manifestPath = path.join(this.managedSkillsDir, `${skillId}.json`);
    if (fs.existsSync(manifestPath)) {
      fs.unlinkSync(manifestPath);
    }

    const companionDir = path.join(this.managedSkillsDir, skillId);
    if (fs.existsSync(companionDir)) {
      fs.rmSync(companionDir, { recursive: true, force: true });
    }

    const reportPath = this.securityService.getSkillReportPath(this.managedSkillsDir, skillId);
    if (fs.existsSync(reportPath)) {
      fs.unlinkSync(reportPath);
    }
  }

  private moveManagedSkillArtifacts(skillId: string, targetDir: string): void {
    fs.mkdirSync(targetDir, { recursive: true });
    const manifestPath = path.join(this.managedSkillsDir, `${skillId}.json`);
    const companionDir = path.join(this.managedSkillsDir, skillId);
    const reportPath = this.securityService.getSkillReportPath(this.managedSkillsDir, skillId);

    if (fs.existsSync(manifestPath)) {
      fs.renameSync(manifestPath, path.join(targetDir, `${skillId}.json`));
    }
    if (fs.existsSync(companionDir)) {
      fs.renameSync(companionDir, path.join(targetDir, skillId));
    }
    if (fs.existsSync(reportPath)) {
      fs.renameSync(reportPath, path.join(targetDir, path.basename(reportPath)));
    }
  }

  private restoreManagedSkillArtifacts(skillId: string, sourceDir: string): void {
    const manifestBackupPath = path.join(sourceDir, `${skillId}.json`);
    const companionBackupDir = path.join(sourceDir, skillId);
    const reportPath = this.securityService.getSkillReportPath(this.managedSkillsDir, skillId);
    const reportBackupPath = path.join(sourceDir, path.basename(reportPath));

    if (fs.existsSync(manifestBackupPath)) {
      fs.renameSync(manifestBackupPath, path.join(this.managedSkillsDir, `${skillId}.json`));
    }
    if (fs.existsSync(companionBackupDir)) {
      fs.renameSync(companionBackupDir, path.join(this.managedSkillsDir, skillId));
    }
    if (fs.existsSync(reportBackupPath)) {
      fs.renameSync(reportBackupPath, reportPath);
    }
  }

  private writeSkillStage(
    stageDir: string,
    skill: CustomSkill,
    sourceDir?: string,
  ): CustomSkill {
    fs.mkdirSync(stageDir, { recursive: true });
    const safeId = sanitizeSkillId(skill.id);
    if (!safeId) {
      throw new Error(`Invalid skill ID: ${skill.id}`);
    }

    const manifestPath = path.join(this.managedSkillsDir, `${safeId}.json`);
    const normalizedSkill: CustomSkill = {
      ...skill,
      id: safeId,
      source: "managed",
      filePath: manifestPath,
    };

    fs.writeFileSync(
      path.join(stageDir, IMPORT_STAGE_MANIFEST_FILENAME),
      JSON.stringify(normalizedSkill, null, 2),
      "utf-8",
    );

    if (sourceDir) {
      this.validateImportBundleDir(sourceDir);
      this.copyImportBundle(sourceDir, path.join(stageDir, IMPORT_STAGE_BUNDLE_DIRNAME));
    }

    return normalizedSkill;
  }

  private toInstallOutcome(
    report: CapabilitySecurityReport | undefined,
    fallbackState: InstallSecurityOutcome["state"] = "failed",
  ): InstallSecurityOutcome | undefined {
    if (!report) {
      return fallbackState === "failed" ? { state: "failed" } : undefined;
    }

    if (report.verdict === "quarantined") {
      return {
        state: "quarantined",
        summary: report.summary,
        report,
      };
    }

    return {
      state: report.verdict === "warning" ? "installed_with_warning" : "installed",
      summary: report.summary,
      report,
    };
  }

  private buildImportedSkillPrompt(name: string, bundleDir: string): string {
    const lines = [
      `# ${name}`,
      "",
      "Follow the imported skill instructions in `{baseDir}/SKILL.md`.",
    ];

    if (fs.existsSync(path.join(bundleDir, "references"))) {
      lines.push("Read the relevant files in `{baseDir}/references/` before acting.");
    }
    if (fs.existsSync(path.join(bundleDir, "scripts"))) {
      lines.push("Prefer bundled scripts from `{baseDir}/scripts/` when they fit the task.");
    }

    lines.push("Return work that matches the skill's own scope, workflow, and success criteria.");
    return lines.join("\n");
  }

  private detectSkillBundleRoot(rootDir: string): string | null {
    const directSkill = path.join(rootDir, "SKILL.md");
    if (fs.existsSync(directSkill)) {
      return rootDir;
    }

    const directChildren = fs.readdirSync(rootDir, { withFileTypes: true });
    const candidates = directChildren
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(rootDir, entry.name))
      .filter((dirPath) => fs.existsSync(path.join(dirPath, "SKILL.md")));

    if (candidates.length === 1) {
      return candidates[0];
    }

    const skillsDir = path.join(rootDir, "skills");
    if (candidates.length === 0 && fs.existsSync(skillsDir)) {
      const nestedCandidates = fs
        .readdirSync(skillsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(skillsDir, entry.name))
        .filter((dirPath) => fs.existsSync(path.join(dirPath, "SKILL.md")));

      if (nestedCandidates.length === 1) {
        return nestedCandidates[0];
      }
    }

    return null;
  }

  private findCustomSkillManifest(rootDir: string): { manifestPath: string; supportDir?: string } | null {
    const candidates = fs
      .readdirSync(rootDir)
      .filter(
        (entry) =>
          entry.endsWith(".json") &&
          entry !== "package.json" &&
          entry !== "metadata.json" &&
          !this.isSkillMetadataFile(entry),
      );

    for (const fileName of candidates) {
      const manifestPath = path.join(rootDir, fileName);
      try {
        const raw = fs.readFileSync(manifestPath, "utf-8");
        const parsed = JSON.parse(raw) as CustomSkill;
        if (!this.validateSkillData(parsed)) {
          continue;
        }

        const supportDirCandidate = path.join(rootDir, path.basename(fileName, ".json"));
        return {
          manifestPath,
          supportDir: fs.existsSync(supportDirCandidate) ? supportDirCandidate : undefined,
        };
      } catch {
        continue;
      }
    }

    return null;
  }

  private importSkillBundle(bundleDir: string, sourceRef: string): CustomSkill {
    const skillMdPath = path.join(bundleDir, "SKILL.md");
    const skillMd = fs.readFileSync(skillMdPath, "utf-8");
    const { frontmatter, body } = parseFrontmatter(skillMd);

    let metadataJson: Record<string, unknown> = {};
    const metadataPath = path.join(bundleDir, "metadata.json");
    if (fs.existsSync(metadataPath)) {
      try {
        metadataJson = JSON.parse(fs.readFileSync(metadataPath, "utf-8")) as Record<string, unknown>;
      } catch (error) {
        console.warn("[SkillRegistry] Failed to parse metadata.json for imported skill:", error);
      }
    }

    const fallbackName = path.basename(bundleDir);
    const name =
      stringValue(frontmatter.name) ||
      stringValue(metadataJson.name) ||
      fallbackName;
    const slugCandidate =
      stringValue(frontmatter.slug) ||
      stringValue(frontmatter.id) ||
      normalizeSkillSlug(name) ||
      normalizeSkillSlug(fallbackName);
    const safeId = sanitizeSkillId(slugCandidate || "");
    if (!safeId) {
      throw new Error(`Unable to derive a valid skill ID from "${name}"`);
    }

    const description =
      stringValue(frontmatter.description) ||
      stringValue(metadataJson.description) ||
      stringValue(metadataJson.abstract) ||
      body.split("\n").map((line) => line.trim()).find(Boolean) ||
      `Imported skill from ${sourceRef}`;
    const version = stringValue(metadataJson.version) || "1.0.0";
    const author =
      stringValue(frontmatter.author) ||
      stringValue(metadataJson.author) ||
      "External";
    const category =
      stringValue(frontmatter.category) ||
      stringValue(metadataJson.organization) ||
      IMPORTED_SKILL_CATEGORY;
    const tags = Array.from(
      new Set([
        ...arrayValue(frontmatter.tags),
        ...arrayValue(metadataJson.tags),
        "external",
      ]),
    );

    return {
      id: safeId,
      name,
      description,
      icon: stringValue(frontmatter.icon) || IMPORTED_SKILL_ICON,
      prompt: this.buildImportedSkillPrompt(name, bundleDir),
      category,
      enabled: true,
      source: "managed",
      invocation: {
        disableModelInvocation: true,
      },
      metadata: {
        version,
        author,
        homepage: sourceRef,
        repository: sourceRef,
        tags,
      },
    };
  }

  private copyImportBundle(sourceDir: string, targetDir: string): void {
    const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
    fs.mkdirSync(targetDir, { recursive: true });

    for (const entry of entries) {
      if (IMPORT_COPY_SKIP_NAMES.has(entry.name)) {
        continue;
      }

      const sourcePath = path.join(sourceDir, entry.name);
      const targetPath = path.join(targetDir, entry.name);
      if (entry.isDirectory()) {
        this.copyImportBundle(sourcePath, targetPath);
      } else if (entry.isFile()) {
        fs.copyFileSync(sourcePath, targetPath);
      }
    }
  }

  private validateImportBundleDir(rootDir: string): void {
    let fileCount = 0;
    let totalBytes = 0;

    const visit = (dirPath: string) => {
      for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
        if (IMPORT_COPY_SKIP_NAMES.has(entry.name)) {
          continue;
        }

        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          visit(fullPath);
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }

        fileCount += 1;
        if (fileCount > MAX_IMPORTED_SKILL_FILE_COUNT) {
          throw new Error(
            `Imported skill bundle exceeds the ${MAX_IMPORTED_SKILL_FILE_COUNT}-file limit`,
          );
        }

        const size = fs.statSync(fullPath).size;
        if (size > MAX_IMPORTED_SKILL_FILE_BYTES) {
          throw new Error(
            `Imported skill file "${path.basename(fullPath)}" exceeds the ${MAX_IMPORTED_SKILL_FILE_BYTES}-byte limit`,
          );
        }

        totalBytes += size;
        if (totalBytes > MAX_IMPORTED_SKILL_TOTAL_BYTES) {
          throw new Error(
            `Imported skill bundle exceeds the ${MAX_IMPORTED_SKILL_TOTAL_BYTES}-byte limit`,
          );
        }
      }
    };

    visit(rootDir);
  }

  private async installImportedSkill(
    skill: CustomSkill,
    options: {
      sourceDir?: string;
      source: "registry" | "clawhub" | "url" | "git";
    },
  ): Promise<SkillInstallResult> {
    const safeId = sanitizeSkillId(skill.id);
    if (!safeId) {
      return { success: false, error: `Invalid skill ID: ${skill.id}` };
    }

    if (this.isInstalled(safeId)) {
      return { success: false, error: `Skill ${safeId} is already installed` };
    }

    const stageDir = this.buildTempDir(safeId);
    try {
      const normalizedSkill = this.writeSkillStage(stageDir, skill, options.sourceDir);
      const report = await this.securityService.scanSkillStage({
        bundleId: safeId,
        displayName: normalizedSkill.name,
        source: options.source,
        managed: true,
        stageDir,
      });

      if (report.verdict === "quarantined") {
        this.securityService.quarantineSkillStage(
          stageDir,
          this.managedSkillsDir,
          safeId,
          normalizedSkill.name,
          options.source,
          report,
        );
        return {
          success: false,
          error: report.summary,
          security: this.toInstallOutcome(report),
        };
      }

      this.securityService.activateSkillStage(stageDir, this.managedSkillsDir, safeId, report);
      return {
        success: true,
        skill: normalizedSkill,
        security: this.toInstallOutcome(report),
      };
    } catch (error) {
      this.removeManagedSkillArtifacts(safeId);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        security: { state: "failed" },
      };
    } finally {
      this.removeTempDir(stageDir);
    }
  }

  private async isGitAvailable(): Promise<boolean> {
    try {
      await execFileAsync("git", ["--version"]);
      return true;
    } catch {
      return false;
    }
  }

  private async fetchJson(url: string): Promise<unknown | null> {
    try {
      const response = await this.fetchWithTimeout(url);
      if (!response.ok) {
        return null;
      }
      return await response.json();
    } catch {
      return null;
    }
  }

  private async fetchClawHubConvex(
    kind: "query" | "action",
    udfPath: string,
    args: Record<string, unknown>,
  ): Promise<unknown | null> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const response = await fetch(`${CLAWHUB_CONVEX_URL}/api/${kind}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            path: udfPath,
            args,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          return null;
        }

        const data = (await response.json()) as
          | { status?: string; value?: unknown }
          | null;
        if (!data || data.status !== "success") {
          return null;
        }

        return data.value ?? null;
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      return null;
    }
  }

  private normalizeClawHubTags(tags: unknown): string[] {
    if (Array.isArray(tags)) {
      return tags.filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0);
    }
    if (tags && typeof tags === "object") {
      return Object.keys(tags as Record<string, unknown>).filter((tag) => tag !== "latest");
    }
    return [];
  }

  private clawHubStatsFields(
    stats: Record<string, unknown> | undefined,
  ): Pick<SkillRegistryEntry, "downloads" | "stars" | "installsCurrent" | "installsAllTime"> {
    return {
      downloads: numberValue(stats?.downloads),
      stars: numberValue(stats?.stars),
      installsCurrent: numberValue(stats?.installsCurrent),
      installsAllTime: numberValue(stats?.installsAllTime),
    };
  }

  private buildClawHubCandidates(query: string): string[] {
    const trimmed = query.trim();
    const direct = parseClawHubInput(trimmed);
    const terms = trimmed
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .map((term) => term.trim())
      .filter(Boolean);

    const candidates = new Set<string>();
    if (direct?.slug) {
      candidates.add(direct.slug);
    }
    if (terms.length > 0) {
      const base = terms.join("-");
      candidates.add(base);
      if (terms.length >= 2) {
        candidates.add(`${base}-agent`);
        candidates.add(`${base}-skill`);
        candidates.add(`${base}-tool`);
        candidates.add(`${base}-assistant`);
        candidates.add(`${base}-playbook`);
      }
    }
    return Array.from(candidates).filter(Boolean);
  }

  private async getClawHubSkill(slug: string): Promise<{
    skill: Record<string, unknown>;
    latestVersion?: Record<string, unknown>;
    owner?: Record<string, unknown>;
  } | null> {
    const data = await this.fetchJson(`${CLAWHUB_API_URL}/skills/${slug}`);
    if (!data || typeof data !== "object") {
      return null;
    }

    const payload = data as Record<string, unknown>;
    const nestedSkill = payload.skill;
    if (!nestedSkill || typeof nestedSkill !== "object") {
      return null;
    }

    return {
      skill: nestedSkill as Record<string, unknown>,
      latestVersion:
        payload.latestVersion && typeof payload.latestVersion === "object"
          ? (payload.latestVersion as Record<string, unknown>)
          : undefined,
      owner:
        payload.owner && typeof payload.owner === "object"
          ? (payload.owner as Record<string, unknown>)
          : undefined,
    };
  }

  private mapClawHubEntry(
    payload: {
      skill: Record<string, unknown>;
      latestVersion?: Record<string, unknown>;
      owner?: Record<string, unknown>;
    },
    fallbackSlug: string,
  ): SkillRegistryEntry {
    const slug = stringValue(payload.skill.slug) || fallbackSlug;
    const latestVersion =
      stringValue(payload.latestVersion?.version) ||
      stringValue((payload.skill.tags as Record<string, unknown> | undefined)?.latest) ||
      "latest";
    const ownerHandle =
      stringValue(payload.owner?.handle) ||
      stringValue(payload.owner?.displayName);
    const stats =
      payload.skill.stats && typeof payload.skill.stats === "object"
        ? (payload.skill.stats as Record<string, unknown>)
        : undefined;

    return {
      id: slug,
      name: stringValue(payload.skill.displayName) || stringValue(payload.skill.name) || slug,
      description: stringValue(payload.skill.summary) || stringValue(payload.skill.description) || "",
      version: latestVersion,
      source: "clawhub",
      author: ownerHandle ? `@${ownerHandle.replace(/^@/, "")}` : "ClawHub",
      ...this.clawHubStatsFields(stats),
      tags: this.normalizeClawHubTags(payload.skill.tags),
      icon: IMPORTED_SKILL_ICON,
      category: "ClawHub",
      updatedAt:
        typeof payload.skill.updatedAt === "number"
          ? new Date(payload.skill.updatedAt).toISOString()
          : undefined,
      homepage: ownerHandle
        ? `${CLAWHUB_WEB_URL}/${ownerHandle.replace(/^@/, "")}/${slug}`
        : `${CLAWHUB_WEB_URL}/skills`,
    };
  }

  private mapClawHubListItem(item: Record<string, unknown>): SkillRegistryEntry | null {
    const skill =
      item.skill && typeof item.skill === "object"
        ? (item.skill as Record<string, unknown>)
        : item;
    const slug = stringValue(skill.slug);
    if (!slug) {
      return null;
    }

    const owner =
      item.owner && typeof item.owner === "object"
        ? (item.owner as Record<string, unknown>)
        : undefined;
    const ownerHandle =
      stringValue(item.ownerHandle) ||
      stringValue(owner?.handle) ||
      stringValue(owner?.displayName);
    const latestVersion =
      item.latestVersion && typeof item.latestVersion === "object"
        ? (item.latestVersion as Record<string, unknown>)
        : item.version && typeof item.version === "object"
          ? (item.version as Record<string, unknown>)
          : undefined;
    const stats =
      skill.stats && typeof skill.stats === "object"
        ? (skill.stats as Record<string, unknown>)
        : undefined;

    return {
      id: slug,
      name: stringValue(skill.displayName) || stringValue(skill.name) || slug,
      description: stringValue(skill.summary) || stringValue(skill.description) || "",
      version:
        stringValue(latestVersion?.version) ||
        stringValue(
          skill.tags && typeof skill.tags === "object"
            ? (skill.tags as Record<string, unknown>).latest
            : undefined,
        ) ||
        "latest",
      source: "clawhub",
      author: ownerHandle ? `@${ownerHandle.replace(/^@/, "")}` : "ClawHub",
      ...this.clawHubStatsFields(stats),
      tags: this.normalizeClawHubTags(skill.tags),
      icon: IMPORTED_SKILL_ICON,
      category: "ClawHub",
      updatedAt:
        typeof skill.updatedAt === "number"
          ? new Date(skill.updatedAt).toISOString()
          : undefined,
      homepage: ownerHandle
        ? `${CLAWHUB_WEB_URL}/${ownerHandle.replace(/^@/, "")}/${slug}`
        : `${CLAWHUB_WEB_URL}/skills`,
    };
  }

  private findInstalledClawHubSkill(slug: string): CustomSkill | null {
    const managedSkills = this.listManagedSkills();
    for (const skill of managedSkills) {
      if (skill.id === slug) {
        return skill;
      }

      const homepageSlug = parseClawHubInput(skill.metadata?.homepage || "");
      if (homepageSlug?.slug === slug) {
        return skill;
      }

      const repositorySlug = parseClawHubInput(skill.metadata?.repository || "");
      if (repositorySlug?.slug === slug) {
        return skill;
      }
    }

    return null;
  }

  private async inspectClawHub(query: string): Promise<SkillRegistryEntry | null> {
    const candidates = this.buildClawHubCandidates(query);
    for (const candidate of candidates) {
      const payload = await this.getClawHubSkill(candidate);
      if (payload) {
        return this.mapClawHubEntry(payload, candidate);
      }
    }
    return null;
  }

  private async resolveClawHubVersion(
    slug: string,
    payload: {
      skill: Record<string, unknown>;
      latestVersion?: Record<string, unknown>;
    },
  ): Promise<string | null> {
    const explicit = stringValue(payload.latestVersion?.version);
    if (explicit) {
      return explicit;
    }

    const tagLatest = stringValue(
      payload.skill.tags && typeof payload.skill.tags === "object"
        ? (payload.skill.tags as Record<string, unknown>).latest
        : undefined,
    );
    if (tagLatest) {
      return tagLatest;
    }

    const versionsData = await this.fetchJson(`${CLAWHUB_API_URL}/skills/${slug}/versions`);
    const items =
      versionsData && typeof versionsData === "object" && Array.isArray((versionsData as Record<string, unknown>).items)
        ? ((versionsData as Record<string, unknown>).items as unknown[])
        : Array.isArray(versionsData)
          ? versionsData
          : [];
    const first = items[0];
    if (first && typeof first === "object") {
      return stringValue((first as Record<string, unknown>).version) || null;
    }

    return null;
  }

  private async downloadClawHubFiles(slug: string, version: string): Promise<Record<string, string>> {
    const url = `${CLAWHUB_API_URL}/download?slug=${encodeURIComponent(slug)}&version=${encodeURIComponent(version)}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`ClawHub download failed with HTTP ${response.status}`);
    }

    const zipBytes = await readResponseBytesWithLimit(
      response,
      MAX_IMPORTED_SKILL_ZIP_RESPONSE_BYTES,
      `ClawHub bundle ${slug}@${version}`,
    );
    const zip = await JSZip.loadAsync(zipBytes);
    const files: Record<string, string> = {};
    const entries = Object.values(zip.files);
    if (entries.length > MAX_IMPORTED_SKILL_FILE_COUNT) {
      throw new Error(
        `ClawHub bundle ${slug}@${version} exceeds the ${MAX_IMPORTED_SKILL_FILE_COUNT}-file limit`,
      );
    }

    let totalBytes = 0;
    for (const entry of entries) {
      if (entry.dir) {
        continue;
      }
      const normalizedName = path.posix
        .normalize(entry.name.replace(/\\/g, "/").replace(/^\/+/, ""))
        .replace(/^\/+/, "");
      if (
        !normalizedName ||
        normalizedName === "." ||
        normalizedName === ".." ||
        normalizedName.startsWith("../")
      ) {
        continue;
      }
      const contentBytes = await entry.async("uint8array");
      if (contentBytes.byteLength > MAX_IMPORTED_SKILL_FILE_BYTES) {
        throw new Error(
          `ClawHub bundle file "${normalizedName}" exceeds the ${MAX_IMPORTED_SKILL_FILE_BYTES}-byte limit`,
        );
      }
      totalBytes += contentBytes.byteLength;
      if (totalBytes > MAX_IMPORTED_SKILL_TOTAL_BYTES) {
        throw new Error(
          `ClawHub bundle ${slug}@${version} exceeds the ${MAX_IMPORTED_SKILL_TOTAL_BYTES}-byte limit`,
        );
      }
      files[normalizedName] = Buffer.from(contentBytes).toString("utf8");
    }
    return files;
  }

  private async writeImportedFiles(tempDir: string, files: Record<string, string>): Promise<void> {
    await Promise.all(
      Object.entries(files).map(async ([relativePath, content]) => {
        const targetPath = path.join(tempDir, relativePath);
        const targetDir = path.dirname(targetPath);
        fs.mkdirSync(targetDir, { recursive: true });
        fs.writeFileSync(targetPath, content, "utf-8");
      }),
    );
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
  async search(
    query: string,
    options?: { page?: number; pageSize?: number },
  ): Promise<SkillSearchResult> {
    const page = options?.page ?? 1;
    const pageSize = options?.pageSize ?? 20;

    // Static catalog mode: fetch catalog.json and filter client-side
    if (this.isStaticCatalog()) {
      return this.searchCatalog(query, page, pageSize);
    }

    try {
      const url = new URL(`${this.registryUrl}/skills/search`);
      url.searchParams.set("q", query);
      url.searchParams.set("page", String(page));
      url.searchParams.set("pageSize", String(pageSize));

      const response = await fetch(url.toString());

      if (!response.ok) {
        throw new Error(`Registry search failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      return data as SkillSearchResult;
    } catch (error) {
      console.error("[SkillRegistry] Search failed:", error);
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

  async searchClawHub(
    query: string,
    options?: { page?: number; pageSize?: number },
  ): Promise<SkillSearchResult> {
    const page = options?.page ?? 1;
    const pageSize = options?.pageSize ?? 20;
    const trimmed = query.trim();

    try {
      let results: SkillRegistryEntry[] = [];

      if (!trimmed) {
        const value = await this.fetchClawHubConvex("query", "skills:listPublicPageV4", {
          numItems: pageSize,
          sort: "downloads",
          dir: "desc",
          highlightedOnly: false,
          nonSuspiciousOnly: false,
        });
        const items =
          value && typeof value === "object" && Array.isArray((value as Record<string, unknown>).page)
            ? ((value as Record<string, unknown>).page as unknown[])
            : [];

        results = items
          .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
          .map((item) => this.mapClawHubListItem(item))
          .filter((entry): entry is SkillRegistryEntry => Boolean(entry));
      } else {
        const value = await this.fetchClawHubConvex("action", "search:searchSkills", {
          query: trimmed,
          highlightedOnly: false,
          nonSuspiciousOnly: false,
          limit: pageSize,
        });
        const items = Array.isArray(value) ? value : [];

        results = items
          .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
          .map((item) => this.mapClawHubListItem(item))
          .filter((entry): entry is SkillRegistryEntry => Boolean(entry));
      }

      if (trimmed) {
        const exact = await this.inspectClawHub(trimmed);
        if (exact && !results.some((entry) => entry.id === exact.id)) {
          results.unshift(exact);
        }
      }

      return {
        query,
        total: results.length,
        page,
        pageSize,
        results: results.slice((page - 1) * pageSize, page * pageSize),
      };
    } catch (error) {
      console.error("[SkillRegistry] ClawHub search failed:", error);
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
   * Search the cached catalog client-side
   */
  private async searchCatalog(
    query: string,
    page: number,
    pageSize: number,
  ): Promise<SkillSearchResult> {
    try {
      const entries = await this.fetchCatalog();
      const q = (query || "").toLowerCase().trim();

      const filtered = q
        ? entries.filter(
            (s) =>
              s.name.toLowerCase().includes(q) ||
              s.description.toLowerCase().includes(q) ||
              s.id.toLowerCase().includes(q) ||
              (s.tags || []).some((t) => t.toLowerCase().includes(q)) ||
              (s.category || "").toLowerCase().includes(q),
          )
        : entries;

      const start = (page - 1) * pageSize;
      const results = filtered.slice(start, start + pageSize);

      return {
        query,
        total: filtered.length,
        page,
        pageSize,
        results,
      };
    } catch (error) {
      console.error("[SkillRegistry] Catalog search failed:", error);
      return { query, total: 0, page, pageSize, results: [] };
    }
  }

  /**
   * Get skill details from registry
   */
  async getSkillDetails(skillId: string): Promise<SkillRegistryEntry | null> {
    if (/^clawhub:/i.test(skillId.trim())) {
      const parsed = parseClawHubInput(skillId);
      return parsed ? this.inspectClawHub(parsed.slug) : null;
    }

    // Validate skill ID
    const safeId = sanitizeSkillId(skillId);
    if (!safeId) {
      console.error(`[SkillRegistry] Invalid skill ID: ${skillId}`);
      return null;
    }

    // Static catalog mode: lookup from catalog.json
    if (this.isStaticCatalog()) {
      const entries = await this.fetchCatalog();
      return entries.find((s) => s.id === safeId) || null;
    }

    try {
      const response = await fetch(`${this.registryUrl}/skills/${safeId}`);

      if (!response.ok) {
        if (response.status === 404) {
          return null;
        }
        throw new Error(`Failed to get skill details: ${response.status}`);
      }

      return (await response.json()) as SkillRegistryEntry;
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
    onProgress?: InstallProgressCallback,
  ): Promise<SkillInstallResult> {
    const clawHubSource = parseClawHubInput(skillId);
    if (clawHubSource && /^clawhub:/i.test(skillId.trim())) {
      return this.installFromClawHub(skillId);
    }

    // Validate skill ID before any operations
    const safeId = sanitizeSkillId(skillId);
    if (!safeId) {
      return { success: false, error: `Invalid skill ID: ${skillId}` };
    }

    const notify = (progress: Partial<SkillInstallProgress>) => {
      onProgress?.({
        skillId: safeId,
        status: "downloading",
        ...progress,
      } as SkillInstallProgress);
    };

    try {
      notify({ status: "downloading", progress: 0, message: "Fetching skill from registry..." });

      // Fetch skill data from registry
      const url = this.isStaticCatalog()
        ? `${this.registryUrl.replace(/\/$/, "")}/skills/${safeId}.json`
        : version
          ? `${this.registryUrl}/skills/${safeId}/download?version=${version}`
          : `${this.registryUrl}/skills/${safeId}/download`;

      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`Failed to download skill: ${response.status} ${response.statusText}`);
      }

      notify({ status: "downloading", progress: 50, message: "Downloading skill data..." });

      const skillData = await response.json();

      notify({ status: "extracting", progress: 70, message: "Processing skill..." });

      // Validate skill data
      if (!this.validateSkillData(skillData)) {
        throw new Error("Invalid skill data received from registry");
      }

      notify({ status: "installing", progress: 80, message: "Scanning skill..." });

      const skill: CustomSkill = {
        ...skillData,
        source: "managed",
      };

      const result = await this.installImportedSkill(skill, { source: "registry" });
      if (result.success) {
        notify({
          status: "completed",
          progress: 100,
          message:
            result.security?.state === "installed_with_warning"
              ? "Skill installed with security warning"
              : "Skill installed successfully",
        });
      } else if (result.security?.state === "quarantined") {
        notify({ status: "failed", progress: 0, message: result.security.summary, error: result.security.summary });
      }

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[SkillRegistry] Install failed for ${safeId}:`, errorMessage);

      notify({ status: "failed", progress: 0, message: errorMessage, error: errorMessage });

      return { success: false, error: errorMessage, security: { state: "failed" } };
    }
  }

  async installFromClawHub(
    identifierOrUrl: string,
  ): Promise<SkillInstallResult> {
    const source = parseClawHubInput(identifierOrUrl);
    if (!source) {
      return { success: false, error: `Invalid ClawHub identifier: ${identifierOrUrl}` };
    }

    const existingSkill = this.findInstalledClawHubSkill(source.slug);
    if (existingSkill) {
      return { success: true, skill: existingSkill };
    }

    const payload = await this.getClawHubSkill(source.slug);
    if (!payload) {
      return { success: false, error: `ClawHub skill not found: ${source.slug}` };
    }

    const version = await this.resolveClawHubVersion(source.slug, payload);
    if (!version) {
      return { success: false, error: `Unable to resolve a downloadable ClawHub version for ${source.slug}` };
    }

    const files = await this.downloadClawHubFiles(source.slug, version);
    if (!files["SKILL.md"]) {
      return { success: false, error: `ClawHub bundle for ${source.slug} did not include SKILL.md` };
    }

    const tempDir = this.buildTempDir(source.slug);
    try {
      fs.mkdirSync(tempDir, { recursive: true });
      await this.writeImportedFiles(tempDir, files);
      const ownerHandle = stringValue(payload.owner?.handle);
      const sourceUrl =
        source.url ||
        (ownerHandle
          ? `${CLAWHUB_WEB_URL}/${ownerHandle}/${source.slug}`
          : `${CLAWHUB_WEB_URL}/skills`);
      const skill = this.importSkillBundle(tempDir, sourceUrl);
      skill.id = source.slug;
      if (!stringValue(skill.name)) {
        skill.name = source.slug;
      }
      skill.metadata = {
        ...(skill.metadata || {}),
        version,
        author: ownerHandle || skill.metadata?.author || "ClawHub",
        homepage: sourceUrl,
        repository: sourceUrl,
        tags: Array.from(
          new Set([...(skill.metadata?.tags || []), ...this.normalizeClawHubTags(payload.skill.tags), "clawhub"]),
        ),
      };
      skill.category = "ClawHub";
      return await this.installImportedSkill(skill, { sourceDir: tempDir, source: "clawhub" });
    } catch (error) {
      return {
        success: false,
        error: `ClawHub install failed: ${error instanceof Error ? error.message : String(error)}`,
        security: { state: "failed" },
      };
    } finally {
      this.removeTempDir(tempDir);
    }
  }

  async installFromUrl(url: string): Promise<SkillInstallResult> {
    const normalizedUrl = typeof url === "string" ? url.trim() : "";
    if (!normalizedUrl) {
      return { success: false, error: "URL is required" };
    }

    if (/^https?:\/\/(?:www\.)?clawhub\.ai\//i.test(normalizedUrl)) {
      return this.installFromClawHub(normalizedUrl);
    }

    try {
      const response = await this.fetchWithTimeout(normalizedUrl);
      if (!response.ok) {
        return { success: false, error: `HTTP ${response.status}: ${response.statusText}` };
      }

      const contentType = response.headers?.get?.("content-type") || "";
      if (contentType.includes("application/json") || normalizedUrl.toLowerCase().endsWith(".json")) {
        const raw = await readResponseTextWithLimit(
          response,
          MAX_IMPORTED_SKILL_TEXT_BYTES,
          `Skill manifest ${normalizedUrl}`,
        );
        const skillData = JSON.parse(raw) as unknown;
        if (!this.validateSkillData(skillData)) {
          return { success: false, error: "Invalid skill manifest" };
        }
        return await this.installImportedSkill(skillData, { source: "url" });
      }

      const skillMd = await readResponseTextWithLimit(
        response,
        MAX_IMPORTED_SKILL_TEXT_BYTES,
        `Skill instructions ${normalizedUrl}`,
      );
      const { frontmatter } = parseFrontmatter(skillMd);
      const name =
        stringValue(frontmatter.name) ||
        path.basename(normalizedUrl).replace(/\.md$/i, "") ||
        "Imported Skill";
      const safeId = sanitizeSkillId(
        stringValue(frontmatter.slug) || stringValue(frontmatter.id) || normalizeSkillSlug(name),
      );
      if (!safeId) {
        return { success: false, error: "Unable to derive a valid skill ID from the imported SKILL.md" };
      }

      const tempDir = this.buildTempDir(safeId);
      try {
        fs.mkdirSync(tempDir, { recursive: true });
        fs.writeFileSync(path.join(tempDir, "SKILL.md"), skillMd, "utf-8");
        const skill = this.importSkillBundle(tempDir, normalizedUrl);
        return await this.installImportedSkill(skill, { sourceDir: tempDir, source: "url" });
      } finally {
        this.removeTempDir(tempDir);
      }
    } catch (error) {
      return {
        success: false,
        error: `Install failed: ${error instanceof Error ? error.message : String(error)}`,
        security: { state: "failed" },
      };
    }
  }

  async installFromGit(
    gitUrl: string,
  ): Promise<SkillInstallResult> {
    const parsed = parseGitUrl(gitUrl);
    if (!parsed) {
      return { success: false, error: `Invalid git URL: ${gitUrl}` };
    }

    if (!(await this.isGitAvailable())) {
      return { success: false, error: "Git is not installed or not in PATH" };
    }

    const tempDir = this.buildTempDir(parsed.name);
    try {
      await execFileAsync(
        "git",
        ["clone", "--depth", "1", "--single-branch", parsed.url, tempDir],
        { timeout: GIT_CLONE_TIMEOUT_MS },
      );

      const bundleRoot = this.detectSkillBundleRoot(tempDir);
      if (bundleRoot) {
        const skill = this.importSkillBundle(bundleRoot, parsed.url);
        return await this.installImportedSkill(skill, { sourceDir: bundleRoot, source: "git" });
      }

      const manifest = this.findCustomSkillManifest(tempDir);
      if (!manifest) {
        return {
          success: false,
          error: "Repository does not contain a supported skill manifest or SKILL.md bundle",
        };
      }

      const raw = fs.readFileSync(manifest.manifestPath, "utf-8");
      const skill = JSON.parse(raw) as CustomSkill;
      return await this.installImportedSkill(
        {
          ...skill,
          source: "managed",
          metadata: {
            ...(skill.metadata || {}),
            repository: parsed.url,
            homepage: skill.metadata?.homepage || parsed.url,
          },
        },
        manifest.supportDir ? { sourceDir: manifest.supportDir, source: "git" } : { source: "git" },
      );
    } catch (error) {
      return {
        success: false,
        error: `Git import failed: ${error instanceof Error ? error.message : String(error)}`,
        security: { state: "failed" },
      };
    } finally {
      this.removeTempDir(tempDir);
    }
  }

  /**
   * Update a managed skill to the latest version
   */
  async update(
    skillId: string,
    version?: string,
    onProgress?: InstallProgressCallback,
  ): Promise<SkillInstallResult> {
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

    const backupDir = this.buildTempDir(`${safeId}-backup`);
    this.moveManagedSkillArtifacts(safeId, backupDir);

    try {
      const result = await this.install(safeId, version, onProgress);
      if (result.success) {
        return result;
      }
      this.restoreManagedSkillArtifacts(safeId, backupDir);
      return result;
    } catch (error) {
      this.restoreManagedSkillArtifacts(safeId, backupDir);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        security: { state: "failed" },
      };
    } finally {
      if (fs.existsSync(backupDir)) {
        fs.rmSync(backupDir, { recursive: true, force: true });
      }
    }
  }

  /**
   * Update all managed skills
   */
  async updateAll(
    onProgress?: (skillId: string, progress: SkillInstallProgress) => void,
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
      this.removeManagedSkillArtifacts(safeId);
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
      if (!file.endsWith(".json") || this.isSkillMetadataFile(file)) continue;

      try {
        const filePath = path.join(this.managedSkillsDir, file);
        const content = fs.readFileSync(filePath, "utf-8");
        const skill = JSON.parse(content) as CustomSkill;
        skill.filePath = filePath;
        skill.source = "managed";
        skills.push(skill);
      } catch (error) {
        console.error(`[SkillRegistry] Failed to load managed skill ${file}:`, error);
      }
    }

    return skills;
  }

  async verifyManagedSkillIntegrity(skillId: string): Promise<CapabilitySecurityReport | null> {
    const skill = this.listManagedSkills().find((entry) => entry.id === skillId);
    const result = await this.securityService.verifyManagedSkillIntegrity(
      this.managedSkillsDir,
      skillId,
      skill?.name,
    );
    return result.allowed ? result.report : null;
  }

  async inspectExternalSkill(skill: CustomSkill): Promise<CapabilitySecurityReport | null> {
    return this.securityService.inspectUnmanagedSkill(skill);
  }

  listQuarantinedImports(): QuarantinedImportRecord[] {
    return this.securityService
      .listQuarantinedImports()
      .filter((record) => record.bundleKind === "skill");
  }

  getImportSecurityReport(request: ImportSecurityReportRequest): CapabilitySecurityReport | null {
    return this.securityService.getImportSecurityReport(request, this.managedSkillsDir);
  }

  async retryQuarantinedImport(recordId: string): Promise<RetryQuarantinedImportResult> {
    return this.securityService.retryQuarantinedImport(recordId);
  }

  removeQuarantinedImport(recordId: string): { success: boolean; error?: string } {
    return this.securityService.removeQuarantinedImport(recordId);
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
      const content = fs.readFileSync(skillPath, "utf-8");
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
    if (!data || typeof data !== "object") return false;

    const skill = data as Record<string, unknown>;

    return (
      typeof skill.id === "string" &&
      typeof skill.name === "string" &&
      typeof skill.description === "string" &&
      typeof skill.prompt === "string"
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
