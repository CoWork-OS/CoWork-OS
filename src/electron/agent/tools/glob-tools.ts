import * as fs from "fs";
import * as path from "path";
import { Workspace } from "../../../shared/types";
import { AgentDaemon } from "../daemon";
import { LLMTool } from "../llm/types";
import { evaluateWorkspaceFilesystemAccess } from "../../security/access-profile-paths";

/**
 * GlobTools provides fast pattern-based file search
 * Similar to Claude Code's Glob tool for finding files by pattern
 */
export class GlobTools {
  private static readonly MAX_SCAN_DURATION_MS = 25_000;
  private static readonly SKIP_DIRS = new Set([
    "node_modules",
    ".git",
    ".svn",
    ".hg",
    "dist",
    "build",
    ".build",
    "release",
    "out",
    ".cowork",
    ".cache",
    ".parcel-cache",
    ".turbo",
    "coverage",
    ".next",
    ".nuxt",
    "__pycache__",
    ".pytest_cache",
    "venv",
    ".venv",
    "env",
    ".env",
  ]);
  private static readonly SKIP_RELATIVE_PREFIXES = [".claude/worktrees/"];

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
   * Get tool definitions for Glob tools
   */
  static getToolDefinitions(): LLMTool[] {
    return [
      {
        name: "glob",
        description:
          'Fast file pattern matching tool. Use glob patterns like "**/*.ts" or "src/**/*.tsx" to find files. ' +
          "Returns matching file paths sorted by modification time (newest first). " +
          "PREFERRED over search_files when you know the file pattern you want.",
        input_schema: {
          type: "object",
          properties: {
            pattern: {
              type: "string",
              description:
                'Glob pattern to match files (e.g., "**/*.ts", "src/**/*.test.ts", "*.{js,jsx,ts,tsx}")',
            },
            path: {
              type: "string",
              description:
                "Directory to search in (relative to workspace unless absolute path is allowed). Defaults to workspace root if not specified.",
            },
            maxResults: {
              type: "number",
              description: "Maximum number of results to return (default: 100)",
            },
          },
          required: ["pattern"],
        },
      },
    ];
  }

  /**
   * Execute glob pattern search
   */
  async glob(input: { pattern: string; path?: string; maxResults?: number }): Promise<{
    success: boolean;
    pattern: string;
    matches: Array<{ path: string; size: number; modified: string }>;
    totalMatches: number;
    truncated: boolean;
    error?: string;
  }> {
    const { pattern, path: searchPath, maxResults = 100 } = input;

    this.daemon.logEvent(this.taskId, "log", {
      message: `Glob search: ${pattern}${searchPath ? ` in ${searchPath}` : ""}`,
    });

    try {
      const normalizedWorkspace = path.resolve(this.workspace.path);
      const basePath = searchPath
        ? path.isAbsolute(searchPath)
          ? path.normalize(searchPath)
          : path.resolve(normalizedWorkspace, searchPath)
        : normalizedWorkspace;

      const baseAccess = evaluateWorkspaceFilesystemAccess(this.workspace, basePath, "read");
      if (baseAccess.decision !== "allow") {
        throw new Error("Search path must be within workspace");
      }
      const checkedBasePath = baseAccess.path;
      const isInsideWorkspace = this.isWithinWorkspace(checkedBasePath, normalizedWorkspace);

      if (!fs.existsSync(checkedBasePath)) {
        throw new Error(`Path does not exist: ${searchPath || "."}`);
      }
      if (
        checkedBasePath !== normalizedWorkspace &&
        this.isGeneratedSearchRoot(checkedBasePath, normalizedWorkspace)
      ) {
        throw new Error(`Search path is a generated or dependency directory: ${searchPath || "."}`);
      }

      // Parse the glob pattern
      const { matches, scanTruncated } = await this.findMatches(
        checkedBasePath,
        pattern,
        maxResults,
      );

      // Sort by modification time (newest first)
      matches.sort((a, b) => b.mtime - a.mtime);

      // Truncate if needed
      const truncated = scanTruncated || matches.length > maxResults;
      const limitedMatches = matches.slice(0, maxResults);

      // Format results
      const results = limitedMatches.map((m) => ({
        path: isInsideWorkspace ? path.relative(normalizedWorkspace, m.path) : m.path,
        size: m.size,
        modified: new Date(m.mtime).toISOString(),
      }));

      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: "glob",
        result: {
          pattern,
          matchCount: results.length,
          totalMatches: matches.length,
          truncated,
          scanTruncated,
        },
      });

      return {
        success: true,
        pattern,
        matches: results,
        totalMatches: matches.length,
        truncated,
      };
    } catch (error: Any) {
      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: "glob",
        error: error.message,
      });

      return {
        success: false,
        pattern,
        matches: [],
        totalMatches: 0,
        truncated: false,
        error: error.message,
      };
    }
  }

  private isWithinWorkspace(basePath: string, workspacePath: string): boolean {
    const relative = path.relative(workspacePath, basePath);
    return !relative.startsWith("..") && !path.isAbsolute(relative);
  }

  /**
   * Find files matching the glob pattern
   */
  private async findMatches(
    basePath: string,
    pattern: string,
    maxResults: number,
  ): Promise<{
    matches: Array<{ path: string; size: number; mtime: number }>;
    scanTruncated: boolean;
  }> {
    const matches: Array<{ path: string; size: number; mtime: number }> = [];
    const regex = this.globToRegex(pattern);
    const limits = this.getTraversalLimits(maxResults);
    const maxMatchBuffer = Math.min(Math.max(maxResults * 5, 500), 5000);
    const scanState = {
      filesScanned: 0,
      directoriesScanned: 0,
      maxFilesScanned: limits.maxFiles,
      maxDirectoriesScanned: limits.maxDirectories,
      startedAtMs: Date.now(),
      scanTruncated: false,
    };

    await this.walkDirectory(basePath, basePath, regex, matches, maxMatchBuffer, scanState);

    return {
      matches,
      scanTruncated: scanState.scanTruncated,
    };
  }

  /**
   * Recursively walk directory and collect matches
   */
  private async walkDirectory(
    currentPath: string,
    basePath: string,
    regex: RegExp,
    matches: Array<{ path: string; size: number; mtime: number }>,
    maxMatchBuffer: number,
    scanState: {
      filesScanned: number;
      directoriesScanned: number;
      maxFilesScanned: number;
      maxDirectoriesScanned: number;
      startedAtMs: number;
      scanTruncated: boolean;
    },
    depth: number = 0,
  ): Promise<void> {
    if (scanState.scanTruncated) return;
    if (Date.now() - scanState.startedAtMs > GlobTools.MAX_SCAN_DURATION_MS) {
      scanState.scanTruncated = true;
      return;
    }

    // Limit recursion depth to prevent infinite loops
    if (depth > 50) return;

    if (scanState.directoriesScanned >= scanState.maxDirectoriesScanned) {
      scanState.scanTruncated = true;
      return;
    }
    scanState.directoriesScanned += 1;

    if (this.shouldSkipDirectory(currentPath, basePath, depth)) {
      return;
    }

    try {
      const entries = fs.readdirSync(currentPath, { withFileTypes: true });

      for (const entry of entries) {
        if (scanState.scanTruncated) break;

        const fullPath = path.join(currentPath, entry.name);
        const relativePath = path.relative(basePath, fullPath);

        if (
          evaluateWorkspaceFilesystemAccess(this.workspace, fullPath, "read").decision !== "allow"
        ) {
          continue;
        }

        if (entry.isDirectory()) {
          await this.walkDirectory(
            fullPath,
            basePath,
            regex,
            matches,
            maxMatchBuffer,
            scanState,
            depth + 1,
          );
        } else if (entry.isFile()) {
          scanState.filesScanned += 1;
          if (scanState.filesScanned > scanState.maxFilesScanned) {
            scanState.scanTruncated = true;
            break;
          }

          if (matches.length >= maxMatchBuffer) {
            scanState.scanTruncated = true;
            break;
          }

          // Test against the pattern
          if (regex.test(relativePath) || regex.test(entry.name)) {
            try {
              const stats = fs.statSync(fullPath);
              matches.push({
                path: fullPath,
                size: stats.size,
                mtime: stats.mtimeMs,
              });
            } catch {
              // Skip files we can't stat
            }
          }
        }
      }
    } catch {
      // Skip directories we can't read
    }
  }

  private getTraversalLimits(maxResults: number): { maxFiles: number; maxDirectories: number } {
    const safeMaxResults = Number.isFinite(maxResults) ? Math.max(1, Math.floor(maxResults)) : 100;
    return {
      maxFiles: Math.min(Math.max(safeMaxResults * 300, 5000), 50000),
      maxDirectories: Math.min(Math.max(safeMaxResults * 50, 1000), 10000),
    };
  }

  private shouldSkipDirectory(currentPath: string, basePath: string, depth: number): boolean {
    if (depth <= 0) return false;
    const dirName = path.basename(currentPath).toLowerCase();
    if (GlobTools.SKIP_DIRS.has(dirName)) return true;

    const relativePath = path.relative(basePath, currentPath).split(path.sep).join("/");
    const normalizedRelative = relativePath.endsWith("/")
      ? relativePath.toLowerCase()
      : `${relativePath.toLowerCase()}/`;
    return GlobTools.SKIP_RELATIVE_PREFIXES.some((prefix) => normalizedRelative.startsWith(prefix));
  }

  private isGeneratedSearchRoot(basePath: string, workspacePath: string): boolean {
    const relative = this.isWithinWorkspace(basePath, workspacePath)
      ? path.relative(workspacePath, basePath)
      : basePath;
    const normalized = relative.split(path.sep).join("/").toLowerCase();
    if (!normalized || normalized === ".") return false;
    const segments = normalized.split("/").filter(Boolean);
    if (segments.some((segment) => GlobTools.SKIP_DIRS.has(segment))) {
      return true;
    }
    const normalizedWithSlash = normalized.endsWith("/") ? normalized : `${normalized}/`;
    return GlobTools.SKIP_RELATIVE_PREFIXES.some((prefix) =>
      normalizedWithSlash.startsWith(prefix),
    );
  }

  /**
   * Convert glob pattern to regex
   */
  private globToRegex(pattern: string): RegExp {
    // Handle brace expansion {a,b,c}
    const expandedPatterns = this.expandBraces(pattern);

    // Convert each pattern to regex
    const regexParts = expandedPatterns.map((p) => {
      // Use a placeholder so "*" replacement doesn't accidentally rewrite the globstar expansion.
      const GLOBSTAR = "__COWORK_GLOBSTAR__";
      const GLOBSTAR_SLASH = "__COWORK_GLOBSTAR_SLASH__";
      let regex = p
        // Escape special regex characters (except glob chars * and ?)
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        // **/ matches zero or more path segments (including none)
        .replace(/\*\*\//g, GLOBSTAR_SLASH)
        // ** matches any path (including /) - must be before single * replacement
        .replace(/\*\*/g, GLOBSTAR)
        // * matches anything except /
        .replace(/\*/g, "[^/]*")
        // ? matches single character except /
        .replace(/\?/g, "[^/]")
        // Expand globstar placeholder after single-star replacement
        .replace(new RegExp(GLOBSTAR_SLASH, "g"), "(?:.*/)?")
        .replace(new RegExp(GLOBSTAR, "g"), ".*");

      return regex;
    });

    // Combine patterns with OR
    const combined = regexParts.length > 1 ? `(${regexParts.join("|")})` : regexParts[0];

    return new RegExp(`^${combined}$`, "i");
  }

  /**
   * Expand brace patterns like {a,b,c}
   */
  private expandBraces(pattern: string): string[] {
    const braceMatch = pattern.match(/\{([^}]+)\}/);

    if (!braceMatch) {
      return [pattern];
    }

    const [fullMatch, options] = braceMatch;
    const optionList = options.split(",");
    const results: string[] = [];

    for (const option of optionList) {
      const expanded = pattern.replace(fullMatch, option.trim());
      // Recursively expand nested braces
      results.push(...this.expandBraces(expanded));
    }

    return results;
  }
}
