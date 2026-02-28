import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import { Workspace } from "../../../shared/types";
import { AgentDaemon } from "../daemon";
import { GuardrailManager } from "../../guardrails/guardrail-manager";
import {
  checkProjectAccess,
  getProjectIdFromWorkspaceRelPath,
  getWorkspaceRelativePosixPath,
} from "../../security/project-access";
import mammoth from "mammoth";
import { extractPptxContentFromFile } from "../../utils/pptx-extractor";
import { parsePdfBuffer } from "../../utils/pdf-parser";

// Limits to prevent context overflow
const DEFAULT_READ_WINDOW_CHARS = 300 * 1024; // 300KB default read window
const MAX_READ_WINDOW_CHARS = 1_000_000; // 1MB max read window
const MAX_DIR_ENTRIES = 100; // Max files to list per directory
const MAX_SEARCH_RESULTS = 50; // Max search results
const MAX_NAME_PAD = 48; // Cap for aligned directory listings

interface ReadWindow {
  start: number;
  end: number;
  total: number;
}

interface ReadWindowOptions {
  startChar: number;
  maxChars: number;
}

function getElectronShell(): Any | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
// oxlint-disable-next-line typescript-eslint(no-require-imports)
    const electron = require("electron") as Any;
    const shell = electron?.shell;
    if (shell) return shell;
  } catch {
    // Not running under Electron.
  }
  return null;
}

/**
 * FileTools implements safe file operations within the workspace
 */
export class FileTools {
  constructor(
    private workspace: Workspace,
    private daemon: AgentDaemon,
    private taskId: string,
  ) {}

  /**
   * Update the workspace for this tool
   */
  setWorkspace(workspace: Workspace): void {
    this.workspace = workspace;
  }

  /**
   * Dangerous paths that should never be written to, even with unrestricted access
   */
  private static readonly PROTECTED_PATHS = [
    "/System",
    "/Library",
    "/usr",
    "/bin",
    "/sbin",
    "/etc",
    "/var",
    "/private",
    "C:\\Windows",
    "C:\\Program Files",
    "C:\\Program Files (x86)",
  ];

  /**
   * Check if a path is in a protected system location
   */
  private isProtectedPath(absolutePath: string): boolean {
    const normalizedPath = path.normalize(absolutePath).toLowerCase();
    return FileTools.PROTECTED_PATHS.some((protectedPath) =>
      normalizedPath.startsWith(protectedPath.toLowerCase()),
    );
  }

  /**
   * Check if path is allowed based on allowedPaths configuration
   */
  private isPathAllowed(absolutePath: string): boolean {
    const allowedPaths = this.workspace.permissions.allowedPaths;
    if (!allowedPaths || allowedPaths.length === 0) {
      return false;
    }

    const normalizedPath = path.normalize(absolutePath);
    return allowedPaths.some((allowed) => {
      const normalizedAllowed = path.normalize(allowed);
      // Check if the path starts with or equals an allowed path
      return (
        normalizedPath === normalizedAllowed ||
        normalizedPath.startsWith(normalizedAllowed + path.sep)
      );
    });
  }

  /**
   * If the model produced a stale absolute path rooted in a previous location
   * (for example "/old/root/<workspaceName>/..."), remap it into the active
   * workspace when the original absolute path no longer exists.
   */
  private remapStaleAbsolutePathToWorkspace(
    absolutePath: string,
    normalizedWorkspace: string,
  ): string | null {
    if (!path.isAbsolute(absolutePath)) return null;
    if (fsSync.existsSync(absolutePath)) return null;

    const workspaceName = path.basename(normalizedWorkspace).toLowerCase();
    if (!workspaceName) return null;

    const normalizedAbsolute = path.normalize(absolutePath);
    const parts = normalizedAbsolute.split(path.sep).filter(Boolean);
    const workspaceIdx = parts.findIndex((part) => part.toLowerCase() === workspaceName);
    if (workspaceIdx < 0) return null;

    const suffix = parts.slice(workspaceIdx + 1);
    const remapped =
      suffix.length > 0 ? path.join(normalizedWorkspace, ...suffix) : normalizedWorkspace;
    const relative = path.relative(normalizedWorkspace, remapped);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return null;

    return remapped;
  }

  /**
   * Resolve path, supporting both workspace-relative and absolute paths
   * When unrestrictedFileAccess is enabled, allows absolute paths anywhere (except protected locations)
   * When allowedPaths is configured, allows specific paths outside workspace
   */
  private resolvePath(inputPath: string, operation: "read" | "write" | "delete" = "read"): string {
    const normalizedWorkspace = path.resolve(this.workspace.path);

    // Handle absolute paths
    if (path.isAbsolute(inputPath)) {
      const absolutePath = path.normalize(inputPath);

      // Check if it's inside workspace (always allowed)
      const relativeToWorkspace = path.relative(normalizedWorkspace, absolutePath);
      if (!relativeToWorkspace.startsWith("..") && !path.isAbsolute(relativeToWorkspace)) {
        return absolutePath;
      }

      // Recover from stale absolute paths that still embed the current
      // workspace folder name but point to an old root.
      const remappedPath = this.remapStaleAbsolutePathToWorkspace(
        absolutePath,
        normalizedWorkspace,
      );
      if (remappedPath) {
        this.daemon.logEvent(this.taskId, "log", {
          message: `Remapped stale absolute path to workspace: ${absolutePath} -> ${remappedPath}`,
        });
        return remappedPath;
      }

      // Outside workspace - check permissions
      if (this.workspace.isTemp || this.workspace.permissions.unrestrictedFileAccess) {
        // With unrestricted access, block protected paths for writes
        if (operation !== "read" && this.isProtectedPath(absolutePath)) {
          throw new Error(`Cannot ${operation} protected system path: ${absolutePath}`);
        }
        return absolutePath;
      }

      // Check if in allowed paths
      if (this.isPathAllowed(absolutePath)) {
        if (operation !== "read" && this.isProtectedPath(absolutePath)) {
          throw new Error(`Cannot ${operation} protected system path: ${absolutePath}`);
        }
        return absolutePath;
      }

      throw new Error(
        'Path is outside workspace boundary. Enable "Unrestricted File Access" in workspace settings ' +
          'or add specific paths to "Allowed Paths" to access files outside the workspace. ' +
          `Attempted path: ${absolutePath}. Workspace: ${normalizedWorkspace}.`,
      );
    }

    // Handle relative paths (relative to workspace)
    const resolved = path.resolve(normalizedWorkspace, inputPath);
    const relative = path.relative(normalizedWorkspace, resolved);

    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      // Path escapes workspace via ../ traversal
      if (this.workspace.isTemp || this.workspace.permissions.unrestrictedFileAccess) {
        if (operation !== "read" && this.isProtectedPath(resolved)) {
          throw new Error(`Cannot ${operation} protected system path: ${resolved}`);
        }
        return resolved;
      }

      if (this.isPathAllowed(resolved)) {
        if (operation !== "read" && this.isProtectedPath(resolved)) {
          throw new Error(`Cannot ${operation} protected system path: ${resolved}`);
        }
        return resolved;
      }

      throw new Error(
        'Path traversal outside workspace is not allowed. Enable "Unrestricted File Access" ' +
          "in workspace settings to access files outside the workspace. " +
          `Attempted path: ${resolved}. Workspace: ${normalizedWorkspace}.`,
      );
    }

    return resolved;
  }

  /**
   * Check if operation is allowed based on permissions
   */
  private checkPermission(operation: "read" | "write" | "delete"): void {
    if (operation === "read" && !this.workspace.permissions.read) {
      throw new Error("Read permission not granted");
    }
    if (operation === "write" && !this.workspace.permissions.write) {
      throw new Error("Write permission not granted");
    }
    if (operation === "delete" && !this.workspace.permissions.delete) {
      throw new Error("Delete permission not granted");
    }
  }

  private async enforceProjectAccess(absolutePath: string): Promise<void> {
    const relPosix = getWorkspaceRelativePosixPath(this.workspace.path, absolutePath);
    if (relPosix === null) return;
    const projectId = getProjectIdFromWorkspaceRelPath(relPosix);
    if (!projectId) return;

    const taskGetter = (this.daemon as Any)?.getTask;
    const task =
      typeof taskGetter === "function" ? taskGetter.call(this.daemon, this.taskId) : null;
    const agentRoleId = task?.assignedAgentRoleId || null;
    const res = await checkProjectAccess({
      workspacePath: this.workspace.path,
      projectId,
      agentRoleId,
    });
    if (!res.allowed) {
      throw new Error(res.reason || `Access denied for project "${projectId}"`);
    }
  }

  private isInsideWorkspace(absolutePath: string): boolean {
    const normalizedWorkspace = path.resolve(this.workspace.path);
    const normalizedPath = path.resolve(absolutePath);
    const relative = path.relative(normalizedWorkspace, normalizedPath);
    return !relative.startsWith("..") && !path.isAbsolute(relative);
  }

  private isInsideWorkspaceRealpathAware(absolutePath: string): boolean {
    if (this.isInsideWorkspace(absolutePath)) return true;

    try {
      const workspaceReal = fsSync.realpathSync.native
        ? fsSync.realpathSync.native(this.workspace.path)
        : fsSync.realpathSync(this.workspace.path);
      const pathReal = fsSync.realpathSync.native
        ? fsSync.realpathSync.native(absolutePath)
        : fsSync.realpathSync(absolutePath);
      const relative = path.relative(path.resolve(workspaceReal), path.resolve(pathReal));
      return !relative.startsWith("..") && !path.isAbsolute(relative);
    } catch {
      return false;
    }
  }

  private assertResolvedPathAllowed(
    absolutePath: string,
    operation: "read" | "write",
    context: "target" | "parent",
  ): void {
    if (this.isInsideWorkspaceRealpathAware(absolutePath)) return;

    if (this.workspace.isTemp || this.workspace.permissions.unrestrictedFileAccess) {
      if (operation !== "read" && this.isProtectedPath(absolutePath)) {
        throw new Error(`Cannot ${operation} protected system path: ${absolutePath}`);
      }
      return;
    }

    if (this.isPathAllowed(absolutePath)) {
      if (operation !== "read" && this.isProtectedPath(absolutePath)) {
        throw new Error(`Cannot ${operation} protected system path: ${absolutePath}`);
      }
      return;
    }

    throw new Error(
      `Path resolves outside workspace boundary via symbolic link (${context}). ` +
        `Resolved path: ${absolutePath}. Workspace: ${path.resolve(this.workspace.path)}.`,
    );
  }

  private async realpathIfExists(p: string): Promise<string | null> {
    try {
      return await fs.realpath(p);
    } catch (error: Any) {
      if (this.isNotFoundError(error)) return null;
      throw error;
    }
  }

  private async realpathNearestExistingAncestor(p: string): Promise<string | null> {
    let current = path.resolve(p);
    while (true) {
      const real = await this.realpathIfExists(current);
      if (real) return real;
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }

  /**
   * Prevent symlink-based workspace escapes by validating the real path target.
   * For writes, also validates the nearest existing ancestor of the destination path.
   */
  private async enforceSymlinkSafeAccess(
    absolutePath: string,
    operation: "read" | "write",
  ): Promise<void> {
    const realTarget = await this.realpathIfExists(absolutePath);
    if (realTarget) {
      this.assertResolvedPathAllowed(realTarget, operation, "target");
    }

    if (operation === "write") {
      const ancestor = await this.realpathNearestExistingAncestor(path.dirname(absolutePath));
      if (ancestor) {
        this.assertResolvedPathAllowed(ancestor, operation, "parent");
      }
    }
  }

  /**
   * Read a plain-text file for local processing (does not append truncation markers).
   *
   * Intended for internal tools that do NOT return the raw content back to the LLM,
   * allowing a higher size ceiling than `read_file` without blowing up the context.
   */
  async readTextFileRaw(
    relativePath: string,
    options?: { maxBytes?: number },
  ): Promise<{ content: string; size: number; truncated: boolean }> {
    if (!relativePath || typeof relativePath !== "string") {
      throw new Error("Invalid path: path must be a non-empty string");
    }

    const maxBytes =
      typeof options?.maxBytes === "number" && Number.isFinite(options.maxBytes)
        ? Math.max(1, Math.min(10_000_000, options.maxBytes))
        : 1_000_000;

    const binaryExtensions = [
      ".docx",
      ".xlsx",
      ".pptx",
      ".ppt",
      ".pdf",
      ".zip",
      ".png",
      ".jpg",
      ".jpeg",
      ".gif",
      ".mp3",
      ".mp4",
      ".exe",
      ".dmg",
    ];

    this.checkPermission("read");
    let fullPath = this.resolvePath(relativePath, "read");
    let ext = path.extname(fullPath).toLowerCase();

    if (binaryExtensions.includes(ext)) {
      throw new Error(
        `readTextFileRaw does not support binary file type "${ext}". Use read_file instead.`,
      );
    }

    try {
      await this.enforceProjectAccess(fullPath);
      let stats: Any;
      try {
        stats = await fs.stat(fullPath);
      } catch (error: Any) {
        if (this.isNotFoundError(error) && !path.isAbsolute(relativePath)) {
          const fallbackPath = await this.resolveCaseInsensitivePath(relativePath);
          if (fallbackPath && fallbackPath !== fullPath) {
            fullPath = fallbackPath;
            ext = path.extname(fullPath).toLowerCase();
            if (binaryExtensions.includes(ext)) {
              throw new Error(
                `readTextFileRaw does not support binary file type "${ext}". Use read_file instead.`,
              );
            }
            await this.enforceProjectAccess(fullPath);
            stats = await fs.stat(fullPath);
          } else {
            throw error;
          }
        } else {
          throw error;
        }
      }
      await this.enforceSymlinkSafeAccess(fullPath, "read");

      if (!stats?.isFile?.()) {
        throw new Error("Path is not a file");
      }

      if (stats.size <= maxBytes) {
        const content = await fs.readFile(fullPath, "utf8");
        return { content, size: stats.size, truncated: false };
      }

      const fileHandle = await fs.open(fullPath, "r");
      try {
        const buffer = Buffer.alloc(maxBytes);
        const readRes = await fileHandle.read(buffer, 0, maxBytes, 0);
        const content = buffer.toString("utf8", 0, readRes.bytesRead);
        return { content, size: stats.size, truncated: true };
      } finally {
        await fileHandle.close();
      }
    } catch (error: Any) {
      throw new Error(`Failed to read file: ${error.message}`);
    }
  }

  /**
   * Read file contents (with size limit to prevent context overflow)
   * Supports plain text, DOCX, PDF, and PPTX files
   */
  async readFile(
    relativePath: string,
    options?: { startChar?: number; maxChars?: number },
  ): Promise<{
    content: string;
    size: number;
    truncated?: boolean;
    format?: string;
    path: string;
    window?: ReadWindow;
  }> {
    // Validate input
    if (!relativePath || typeof relativePath !== "string") {
      throw new Error("Invalid path: path must be a non-empty string");
    }
    const readWindow = this.normalizeReadWindowOptions(options);

    this.checkPermission("read");
    let fullPath = this.resolvePath(relativePath, "read");
    let ext = path.extname(fullPath).toLowerCase();

    try {
      await this.enforceProjectAccess(fullPath);
      let stats: { size: number };
      try {
        stats = await fs.stat(fullPath);
      } catch (error: Any) {
        if (this.isNotFoundError(error) && !path.isAbsolute(relativePath)) {
          const fallbackPath = await this.resolveCaseInsensitivePath(relativePath);
          if (fallbackPath && fallbackPath !== fullPath) {
            fullPath = fallbackPath;
            ext = path.extname(fullPath).toLowerCase();
            await this.enforceProjectAccess(fullPath);
            stats = await fs.stat(fullPath);
          } else {
            throw error;
          }
        } else {
          throw error;
        }
      }
      await this.enforceSymlinkSafeAccess(fullPath, "read");
      let canonicalPath = fullPath;
      try {
        canonicalPath = await fs.realpath(fullPath);
      } catch {
        // Keep resolved path when realpath is unavailable.
      }
      let canonicalWorkspacePath = this.workspace.path;
      try {
        canonicalWorkspacePath = await fs.realpath(this.workspace.path);
      } catch {
        // Keep configured workspace path when realpath is unavailable.
      }
      const toWorkspaceRelative = (base: string, target: string): string | null => {
        const rel = path.relative(base, target);
        if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
          return rel.replace(/\\/g, "/");
        }
        return null;
      };
      const outputPath = (() => {
        const rel =
          toWorkspaceRelative(this.workspace.path, canonicalPath) ||
          toWorkspaceRelative(canonicalWorkspacePath, canonicalPath) ||
          toWorkspaceRelative(this.workspace.path, fullPath);
        if (rel) return rel;
        return canonicalPath;
      })();

      // Handle DOCX files
      if (ext === ".docx") {
        const out = await this.readDocxFile(fullPath, stats.size, readWindow);
        return { ...out, path: outputPath };
      }

      // Handle PDF files
      if (ext === ".pdf") {
        const out = await this.readPdfFile(fullPath, stats.size, readWindow);
        return { ...out, path: outputPath };
      }

      // Handle PPTX files
      if (ext === ".pptx") {
        const out = await this.readPptxFile(fullPath, stats.size, readWindow);
        return { ...out, path: outputPath };
      }

      // Legacy PPT files
      if (ext === ".ppt") {
        throw new Error("Legacy .ppt files are not supported. Please upload as .pptx.");
      }

      // Handle plain text files using an explicit read window.
      const start = Math.min(readWindow.startChar, Math.max(0, stats.size));
      const bytesRemaining = Math.max(0, stats.size - start);
      const bytesToRead = Math.min(readWindow.maxChars, bytesRemaining);

      const fileHandle = await fs.open(fullPath, "r");
      let content = "";
      try {
        if (bytesToRead > 0) {
          const buffer = Buffer.alloc(bytesToRead);
          const readRes = await fileHandle.read(buffer, 0, bytesToRead, start);
          content = buffer.toString("utf-8", 0, readRes.bytesRead);
        }
      } finally {
        await fileHandle.close();
      }

      const end = start + bytesToRead;
      const truncated = start > 0 || end < stats.size;
      if (truncated) {
        content += `\n\n[... File window ${start}-${end} of ${stats.size} bytes ...]`;
      }

      return {
        content,
        size: stats.size,
        truncated,
        path: outputPath,
        window: { start, end, total: stats.size },
      };
    } catch (error: Any) {
      throw new Error(`Failed to read file: ${error.message}`);
    }
  }

  private isNotFoundError(error: Any): boolean {
    const code = error?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return true;
    const message = String(error?.message || "");
    return /no such file/i.test(message) || /not found/i.test(message);
  }

  /**
   * Try resolving a path case-insensitively within the workspace.
   * Only applies to workspace-relative paths without traversal.
   */
  private async resolveCaseInsensitivePath(relativePath: string): Promise<string | null> {
    const normalized = path.normalize(relativePath);
    if (path.isAbsolute(normalized)) return null;

    const parts = normalized.split(path.sep).filter(Boolean);
    if (parts.some((part) => part === "..")) return null;

    let current = this.workspace.path;
    for (let i = 0; i < parts.length; i++) {
      const segment = parts[i];
      const lower = segment.toLowerCase();
      let entries: Array<{ name: string; isDirectory: () => boolean }>;
      try {
        entries = await fs.readdir(current, { withFileTypes: true });
      } catch {
        return null;
      }

      if (entries.length > MAX_DIR_ENTRIES * 5) {
        return null;
      }

      const match = entries.find((entry) => entry.name.toLowerCase() === lower);
      if (!match) return null;

      const nextPath = path.join(current, match.name);
      const isLast = i === parts.length - 1;
      if (!isLast && !match.isDirectory()) {
        return null;
      }
      current = nextPath;
    }

    return current;
  }

  private normalizeReadWindowOptions(options?: {
    startChar?: number;
    maxChars?: number;
  }): ReadWindowOptions {
    const startCandidate = Number(options?.startChar);
    const maxCharsCandidate = Number(options?.maxChars);

    const startChar =
      Number.isFinite(startCandidate) && startCandidate >= 0 ? Math.floor(startCandidate) : 0;
    const maxChars = Number.isFinite(maxCharsCandidate)
      ? Math.floor(maxCharsCandidate)
      : DEFAULT_READ_WINDOW_CHARS;

    return {
      startChar,
      maxChars: Math.min(MAX_READ_WINDOW_CHARS, Math.max(1, maxChars)),
    };
  }

  private sliceContentWindow(content: string, readWindow: ReadWindowOptions): {
    content: string;
    truncated: boolean;
    window: ReadWindow;
  } {
    const total = content.length;
    const start = Math.min(readWindow.startChar, total);
    const end = Math.min(total, start + readWindow.maxChars);
    const truncated = start > 0 || end < total;

    return {
      content: content.slice(start, end),
      truncated,
      window: { start, end, total },
    };
  }

  /**
   * Read DOCX file and extract text content
   */
  private async readDocxFile(
    fullPath: string,
    size: number,
    readWindow: ReadWindowOptions,
  ): Promise<{
    content: string;
    size: number;
    truncated?: boolean;
    format: string;
    window: ReadWindow;
  }> {
    try {
      const result = await mammoth.extractRawText({ path: fullPath });
      const sliced = this.sliceContentWindow(result.value || "", readWindow);
      let content = sliced.content;

      if (sliced.truncated) {
        content += `\n\n[... Content window ${sliced.window.start}-${sliced.window.end} of ${sliced.window.total} chars ...]`;
      }

      // Add any warnings from mammoth
      if (result.messages && result.messages.length > 0) {
        const warnings = result.messages.map((m) => m.message).join("\n");
        content = `[Document warnings: ${warnings}]\n\n${content}`;
      }

      return {
        content,
        size,
        truncated: sliced.truncated,
        format: "docx",
        window: sliced.window,
      };
    } catch (error: Any) {
      throw new Error(`Failed to read DOCX file: ${error.message}`);
    }
  }

  /**
   * Read PDF file and extract text content
   */
  private async readPdfFile(
    fullPath: string,
    size: number,
    readWindow: ReadWindowOptions,
  ): Promise<{
    content: string;
    size: number;
    truncated?: boolean;
    format: string;
    window: ReadWindow;
  }> {
    try {
      const dataBuffer = await fs.readFile(fullPath);
      const data = await parsePdfBuffer(dataBuffer);

      let extracted = data.text;

      // Add metadata header
      const metadata: string[] = [];
      if (data.numpages) metadata.push(`Pages: ${data.numpages}`);
      if (data.info?.Title) metadata.push(`Title: ${data.info.Title}`);
      if (data.info?.Author) metadata.push(`Author: ${data.info.Author}`);

      if (metadata.length > 0) {
        extracted = `[PDF Metadata: ${metadata.join(" | ")}]\n\n${extracted}`;
      }

      const sliced = this.sliceContentWindow(extracted, readWindow);
      let content = sliced.content;
      if (sliced.truncated) {
        content += `\n\n[... Content window ${sliced.window.start}-${sliced.window.end} of ${sliced.window.total} chars ...]`;
      }

      return {
        content,
        size,
        truncated: sliced.truncated,
        format: "pdf",
        window: sliced.window,
      };
    } catch (error: Any) {
      throw new Error(`Failed to read PDF file: ${error.message}`);
    }
  }

  /**
   * Read PPTX file and extract slide text content
   */
  private async readPptxFile(
    fullPath: string,
    size: number,
    readWindow: ReadWindowOptions,
  ): Promise<{
    content: string;
    size: number;
    truncated?: boolean;
    format: string;
    window: ReadWindow;
  }> {
    try {
      const extractionLimit = Math.min(
        MAX_READ_WINDOW_CHARS,
        Math.max(readWindow.startChar + readWindow.maxChars + 1024, DEFAULT_READ_WINDOW_CHARS),
      );
      const extracted = await extractPptxContentFromFile(fullPath, {
        outputCharLimit: extractionLimit,
        maxFileSizeBytes: 50 * 1024 * 1024,
      });
      const sourceTruncated = extracted.includes("[... Content truncated.");
      const sliced = this.sliceContentWindow(extracted, readWindow);
      let content = sliced.content;
      const truncated = sourceTruncated || sliced.truncated;

      if (truncated) {
        content += `\n\n[... Content window ${sliced.window.start}-${sliced.window.end} of at least ${sliced.window.total} chars ...]`;
      }

      return {
        content,
        size,
        truncated,
        format: "pptx",
        window: sliced.window,
      };
    } catch (error: Any) {
      throw new Error(`Failed to read PPTX file: ${error.message}`);
    }
  }

  /**
   * Write file contents
   */
  async writeFile(
    relativePath: string,
    content: string,
  ): Promise<{ success: boolean; path: string }> {
    // Validate inputs before proceeding
    if (!relativePath || typeof relativePath !== "string") {
      throw new Error("Invalid path: path must be a non-empty string");
    }

    // Check for binary file extensions that shouldn't be written with write_file
    const ext = path.extname(relativePath).toLowerCase();
    const binaryExtensions = [
      ".docx",
      ".xlsx",
      ".pptx",
      ".ppt",
      ".pdf",
      ".zip",
      ".png",
      ".jpg",
      ".jpeg",
      ".gif",
      ".mp3",
      ".mp4",
      ".exe",
      ".dmg",
    ];
    if (binaryExtensions.includes(ext)) {
      const suggestions: Record<string, string> = {
        ".docx": 'Use "create_document" or "edit_document" tool instead',
        ".xlsx": 'Use "create_spreadsheet" tool instead',
        ".pptx": 'Use "create_presentation" tool instead',
        ".pdf": 'Use "create_document" with format="pdf" instead',
      };
      const suggestion = suggestions[ext] || "Use the appropriate skill tool for binary files";
      throw new Error(
        `Cannot use write_file for binary file type "${ext}". ` +
          `The write_file tool is for text files only. ${suggestion}.`,
      );
    }

    if (content === undefined || content === null) {
      throw new Error("Invalid content: content parameter is required but was not provided");
    }
    if (typeof content !== "string") {
      throw new Error(`Invalid content: expected string but received ${typeof content}`);
    }

    this.checkPermission("write");
    const fullPath = this.resolvePath(relativePath, "write");
    await this.enforceProjectAccess(fullPath);
    await this.enforceSymlinkSafeAccess(fullPath, "write");

    // Check file size against guardrail limits
    const contentSizeBytes = Buffer.byteLength(content, "utf-8");
    const sizeCheck = GuardrailManager.isFileSizeExceeded(contentSizeBytes);
    if (sizeCheck.exceeded) {
      throw new Error(
        `File size limit exceeded: ${sizeCheck.sizeMB.toFixed(2)}MB exceeds limit of ${sizeCheck.limitMB}MB.\n` +
          `You can adjust this limit in Settings > Guardrails.`,
      );
    }

    try {
      // Ensure directory exists
      await fs.mkdir(path.dirname(fullPath), { recursive: true });

      // Write file
      await fs.writeFile(fullPath, content, "utf-8");

      // Build content preview (full content up to 20KB cap)
      const MAX_PREVIEW_CHARS = 20_000;
      const lines = content.split("\n");
      let preview =
        content.length > MAX_PREVIEW_CHARS ? content.slice(0, MAX_PREVIEW_CHARS) : content;
      const previewTruncated = content.length > MAX_PREVIEW_CHARS;
      const ext = path.extname(relativePath).toLowerCase().replace(".", "");

      // Log artifact
      this.daemon.logEvent(this.taskId, "file_created", {
        path: relativePath,
        size: content.length,
        lineCount: lines.length,
        contentPreview: preview,
        previewTruncated,
        language: ext,
      });

      return {
        success: true,
        path: relativePath,
      };
    } catch (error: Any) {
      throw new Error(`Failed to write file: ${error.message}`);
    }
  }

  /**
   * List directory contents (limited to prevent context overflow)
   */
  async listDirectory(relativePath: string = "."): Promise<{
    files: Array<{ name: string; type: "file" | "directory"; size: number }>;
    totalCount: number;
    truncated?: boolean;
  }> {
    // Validate and normalize input (use default if null/undefined)
    const pathToUse = relativePath && typeof relativePath === "string" ? relativePath : ".";

    this.checkPermission("read");
    const fullPath = this.resolvePath(pathToUse, "read");
    await this.enforceProjectAccess(fullPath);
    await this.enforceSymlinkSafeAccess(fullPath, "read");

    try {
      const entries = await fs.readdir(fullPath, { withFileTypes: true });
      const totalCount = entries.length;

      // Limit entries to prevent large responses
      const limitedEntries = entries.slice(0, MAX_DIR_ENTRIES);

      const files = await Promise.all(
        limitedEntries.map(async (entry) => {
          const entryPath = path.join(fullPath, entry.name);
          try {
            const stats = await fs.stat(entryPath);
            return {
              name: entry.name,
              type: entry.isDirectory() ? ("directory" as const) : ("file" as const),
              size: stats.size,
            };
          } catch {
            return {
              name: entry.name,
              type: "file" as const,
              size: 0,
            };
          }
        }),
      );

      return {
        files,
        totalCount,
        truncated: totalCount > MAX_DIR_ENTRIES,
      };
    } catch (error: Any) {
      throw new Error(`Failed to list directory: ${error.message}`);
    }
  }

  /**
   * List directory contents in a compact, size-aware format
   * Mirrors MCP filesystem output for easier agent consumption.
   */
  async listDirectoryWithSizes(relativePath: string = "."): Promise<{
    output: string;
    files: Array<{ name: string; type: "file" | "directory"; size: number }>;
    totalCount: number;
    truncated?: boolean;
    combinedSize: number;
  }> {
    const pathToUse = relativePath && typeof relativePath === "string" ? relativePath : ".";

    this.checkPermission("read");
    const fullPath = this.resolvePath(pathToUse, "read");
    await this.enforceProjectAccess(fullPath);
    await this.enforceSymlinkSafeAccess(fullPath, "read");

    try {
      const entries = await fs.readdir(fullPath, { withFileTypes: true });
      const totalCount = entries.length;
      const limitedEntries = entries.slice(0, MAX_DIR_ENTRIES);

      const files = await Promise.all(
        limitedEntries.map(async (entry) => {
          const entryPath = path.join(fullPath, entry.name);
          try {
            const stats = await fs.stat(entryPath);
            return {
              name: entry.name,
              type: entry.isDirectory() ? ("directory" as const) : ("file" as const),
              size: stats.size,
            };
          } catch {
            return {
              name: entry.name,
              type: entry.isDirectory() ? ("directory" as const) : ("file" as const),
              size: 0,
            };
          }
        }),
      );

      const combinedSize = files.reduce(
        (sum, entry) => sum + (entry.type === "file" ? entry.size : 0),
        0,
      );
      const output = this.formatDirectoryListing(files, combinedSize);

      return {
        output,
        files,
        totalCount,
        truncated: totalCount > MAX_DIR_ENTRIES,
        combinedSize,
      };
    } catch (error: Any) {
      throw new Error(`Failed to list directory: ${error.message}`);
    }
  }

  /**
   * Get file or directory metadata
   */
  async getFileInfo(relativePath: string): Promise<{
    size: number;
    created: string;
    modified: string;
    accessed: string;
    isDirectory: boolean;
    isFile: boolean;
    permissions: string;
  }> {
    if (!relativePath || typeof relativePath !== "string") {
      throw new Error("Invalid path: path must be a non-empty string");
    }

    this.checkPermission("read");
    const fullPath = this.resolvePath(relativePath, "read");
    await this.enforceProjectAccess(fullPath);
    await this.enforceSymlinkSafeAccess(fullPath, "read");

    try {
      const stats = await fs.stat(fullPath);
      const permissions = (stats.mode & 0o777).toString(8);
      return {
        size: stats.size,
        created: stats.birthtime.toISOString(),
        modified: stats.mtime.toISOString(),
        accessed: stats.atime.toISOString(),
        isDirectory: stats.isDirectory(),
        isFile: stats.isFile(),
        permissions,
      };
    } catch (error: Any) {
      throw new Error(`Failed to get file info: ${error.message}`);
    }
  }

  /**
   * Rename or move file
   */
  async renameFile(oldPath: string, newPath: string): Promise<{ success: boolean }> {
    // Validate inputs
    if (!oldPath || typeof oldPath !== "string") {
      throw new Error("Invalid oldPath: must be a non-empty string");
    }
    if (!newPath || typeof newPath !== "string") {
      throw new Error("Invalid newPath: must be a non-empty string");
    }

    this.checkPermission("write");
    const oldFullPath = this.resolvePath(oldPath, "write");
    const newFullPath = this.resolvePath(newPath, "write");
    await this.enforceProjectAccess(oldFullPath);
    await this.enforceProjectAccess(newFullPath);
    await this.enforceSymlinkSafeAccess(oldFullPath, "write");
    await this.enforceSymlinkSafeAccess(newFullPath, "write");

    try {
      // Ensure target directory exists
      await fs.mkdir(path.dirname(newFullPath), { recursive: true });

      await fs.rename(oldFullPath, newFullPath);

      this.daemon.logEvent(this.taskId, "file_modified", {
        action: "rename",
        from: oldPath,
        to: newPath,
      });

      return { success: true };
    } catch (error: Any) {
      throw new Error(`Failed to rename file: ${error.message}`);
    }
  }

  /**
   * Copy file (supports binary files like DOCX, PDF, images, etc.)
   */
  async copyFile(
    sourcePath: string,
    destPath: string,
  ): Promise<{ success: boolean; path: string }> {
    // Validate inputs
    if (!sourcePath || typeof sourcePath !== "string") {
      throw new Error("Invalid sourcePath: must be a non-empty string");
    }
    if (!destPath || typeof destPath !== "string") {
      throw new Error("Invalid destPath: must be a non-empty string");
    }

    this.checkPermission("read");
    this.checkPermission("write");
    const sourceFullPath = this.resolvePath(sourcePath, "read");
    const destFullPath = this.resolvePath(destPath, "write");
    await this.enforceProjectAccess(sourceFullPath);
    await this.enforceProjectAccess(destFullPath);
    await this.enforceSymlinkSafeAccess(sourceFullPath, "read");
    await this.enforceSymlinkSafeAccess(destFullPath, "write");

    try {
      // Ensure target directory exists
      await fs.mkdir(path.dirname(destFullPath), { recursive: true });

      // Copy file using binary buffer (preserves exact content)
      await fs.copyFile(sourceFullPath, destFullPath);

      this.daemon.logEvent(this.taskId, "file_created", {
        path: destPath,
        copiedFrom: sourcePath,
      });

      return {
        success: true,
        path: destPath,
      };
    } catch (error: Any) {
      throw new Error(`Failed to copy file: ${error.message}`);
    }
  }

  /**
   * Delete file (requires approval)
   * Uses shell.trashItem() for protected locations like /Applications
   * Note: We don't check workspace.permissions.delete here because
   * delete operations always require explicit user approval via requestApproval()
   */
  async deleteFile(relativePath: string): Promise<{ success: boolean; movedToTrash?: boolean }> {
    // Validate input
    if (!relativePath || typeof relativePath !== "string") {
      throw new Error("Invalid path: path must be a non-empty string");
    }

    const fullPath = this.resolvePath(relativePath, "delete");
    await this.enforceProjectAccess(fullPath);

    // Request user approval
    const approved = await this.daemon.requestApproval(
      this.taskId,
      "delete_file",
      `Delete file: ${relativePath}`,
      { path: relativePath },
    );

    if (!approved) {
      throw new Error("User denied file deletion");
    }

    try {
      // For .app bundles on macOS, use shell.trashItem directly (safer and expected behavior)
      if (fullPath.endsWith(".app")) {
        const shell = getElectronShell();
        if (shell?.trashItem) {
          await shell.trashItem(fullPath);
        } else {
          await fs.rm(fullPath, { recursive: true, force: true });
        }

        this.daemon.logEvent(this.taskId, "file_deleted", {
          path: relativePath,
          movedToTrash: true,
        });

        return { success: true, movedToTrash: true };
      }

      // For other files/directories, try direct deletion
      const stats = await fs.stat(fullPath);
      if (stats.isDirectory()) {
        // Use force: true to handle read-only files and special cases
        await fs.rm(fullPath, { recursive: true, force: true });
      } else {
        await fs.unlink(fullPath);
      }

      this.daemon.logEvent(this.taskId, "file_deleted", {
        path: relativePath,
      });

      return { success: true };
    } catch (error: Any) {
      // If deletion fails, try moving to Trash as fallback
      // This handles EPERM, EACCES, ENOTEMPTY and other filesystem errors
      if (
        error.code === "EPERM" ||
        error.code === "EACCES" ||
        error.code === "ENOTEMPTY" ||
        error.code === "EBUSY"
      ) {
        try {
          const shell = getElectronShell();
          if (!shell?.trashItem) {
            throw new Error("trashItem not available (Electron shell unavailable)");
          }
          await shell.trashItem(fullPath);

          this.daemon.logEvent(this.taskId, "file_deleted", {
            path: relativePath,
            movedToTrash: true,
          });

          return { success: true, movedToTrash: true };
        } catch (trashError: Any) {
          throw new Error(
            `Failed to delete file: ${error.code}. Could not move to Trash: ${trashError.message}`,
          );
        }
      }
      throw new Error(`Failed to delete file: ${error.message}`);
    }
  }

  /**
   * Create directory
   */
  async createDirectory(relativePath: string): Promise<{ success: boolean }> {
    // Validate input
    if (!relativePath || typeof relativePath !== "string") {
      throw new Error("Invalid path: path must be a non-empty string");
    }

    this.checkPermission("write");
    const fullPath = this.resolvePath(relativePath, "write");
    await this.enforceProjectAccess(fullPath);
    await this.enforceSymlinkSafeAccess(fullPath, "write");

    try {
      await fs.mkdir(fullPath, { recursive: true });

      this.daemon.logEvent(this.taskId, "file_created", {
        path: relativePath,
        type: "directory",
      });

      return { success: true };
    } catch (error: Any) {
      throw new Error(`Failed to create directory: ${error.message}`);
    }
  }

  /**
   * Search files by name or content (limited to prevent context overflow)
   */
  async searchFiles(
    query: string,
    relativePath: string = ".",
  ): Promise<{
    matches: Array<{ path: string; type: "filename" | "content" }>;
    totalFound: number;
    truncated?: boolean;
  }> {
    // Validate input
    if (!query || typeof query !== "string") {
      throw new Error("Invalid query: query must be a non-empty string");
    }

    this.checkPermission("read");
    const fullPath = this.resolvePath(relativePath, "read");
    await this.enforceProjectAccess(fullPath);
    await this.enforceSymlinkSafeAccess(fullPath, "read");
    const matches: Array<{ path: string; type: "filename" | "content" }> = [];
    let filesSearched = 0;
    const maxFilesToSearch = 500; // Limit files to search for performance

    const searchRecursive = async (dir: string) => {
      if (matches.length >= MAX_SEARCH_RESULTS || filesSearched >= maxFilesToSearch) {
        return;
      }

      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return; // Skip directories we can't read
      }

      for (const entry of entries) {
        if (matches.length >= MAX_SEARCH_RESULTS || filesSearched >= maxFilesToSearch) {
          break;
        }

        const entryPath = path.join(dir, entry.name);
        const relPath = path.relative(this.workspace.path, entryPath);

        // Skip hidden files/directories and node_modules
        if (entry.name.startsWith(".") || entry.name === "node_modules") {
          continue;
        }

        // Enforce per-project access (skip denied projects entirely).
        try {
          await this.enforceProjectAccess(entryPath);
        } catch {
          continue;
        }

        // Check filename match
        if (entry.name.toLowerCase().includes(query.toLowerCase())) {
          matches.push({
            path: relPath,
            type: "filename",
          });
        }

        // Search content for small files only
        if (entry.isFile()) {
          filesSearched++;
          try {
            const stats = await fs.stat(entryPath);
            // Only search small text files
            if (stats.size < 50 * 1024) {
              const content = await fs.readFile(entryPath, "utf-8");
              if (content.toLowerCase().includes(query.toLowerCase())) {
                if (!matches.some((m) => m.path === relPath)) {
                  matches.push({
                    path: relPath,
                    type: "content",
                  });
                }
              }
            }
          } catch {
            // Skip binary files or files that can't be read
          }
        } else if (entry.isDirectory()) {
          await searchRecursive(entryPath);
        }
      }
    };

    try {
      await searchRecursive(fullPath);
      return {
        matches: matches.slice(0, MAX_SEARCH_RESULTS),
        totalFound: matches.length,
        truncated: matches.length >= MAX_SEARCH_RESULTS,
      };
    } catch (error: Any) {
      throw new Error(`Search failed: ${error.message}`);
    }
  }

  /**
   * Format directory listing to match MCP-style output
   */
  private formatDirectoryListing(
    entries: Array<{ name: string; type: "file" | "directory"; size: number }>,
    combinedSize: number,
  ): string {
    const maxNameLength = entries.reduce((max, entry) => Math.max(max, entry.name.length), 0);
    const namePad = Math.min(Math.max(maxNameLength + 2, 16), MAX_NAME_PAD);

    const lines = entries.map((entry) => {
      const label = entry.type === "directory" ? "[DIR]" : "[FILE]";
      const name = entry.name.padEnd(namePad, " ");
      const size = entry.type === "file" ? this.formatBytes(entry.size) : "";
      return `${label} ${name}${size}`.trimEnd();
    });

    const fileCount = entries.filter((entry) => entry.type === "file").length;
    const dirCount = entries.filter((entry) => entry.type === "directory").length;
    lines.push("");
    lines.push(`Total: ${fileCount} files, ${dirCount} directories`);
    lines.push(`Combined size: ${this.formatBytes(combinedSize)}`);

    return lines.join("\n");
  }

  /**
   * Human-readable byte formatting
   */
  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(2)} KB`;
    const mb = kb / 1024;
    if (mb < 1024) return `${mb.toFixed(2)} MB`;
    const gb = mb / 1024;
    return `${gb.toFixed(2)} GB`;
  }
}
