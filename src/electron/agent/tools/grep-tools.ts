import * as fs from "fs";
import * as fsPromises from "fs/promises";
import * as path from "path";
import { Workspace } from "../../../shared/types";
import { AgentDaemon } from "../daemon";
import {
  checkProjectAccess,
  getProjectIdFromWorkspaceRelPath,
  getWorkspaceRelativePosixPath,
} from "../../security/project-access";
import { LLMTool } from "../llm/types";

/**
 * GrepTools provides powerful regex-based content search
 * Similar to Claude Code's Grep tool (ripgrep-based)
 */
export class GrepTools {
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
   * Get tool definitions for Grep tools
   */
  static getToolDefinitions(): LLMTool[] {
    return [
      {
        name: "grep",
        description:
          "Powerful regex-based content search across files. " +
          'Supports full regex syntax (e.g., "async function.*fetch", "class\\s+\\w+"). ' +
          "Searches text files only; binary formats like PDF/DOCX are skipped. " +
          "Use this to find code patterns, function definitions, imports, etc. " +
          "PREFERRED over search_files for content search.",
        input_schema: {
          type: "object",
          properties: {
            pattern: {
              type: "string",
              description: "Regular expression pattern to search for in file contents",
            },
            path: {
              type: "string",
              description:
                "Directory or file to search in (relative to workspace). Defaults to workspace root.",
            },
            glob: {
              type: "string",
              description: 'Glob pattern to filter files (e.g., "*.ts", "**/*.{js,jsx}")',
            },
            ignoreCase: {
              type: "boolean",
              description: "Case insensitive search (default: false)",
            },
            contextLines: {
              type: "number",
              description: "Number of context lines before and after match (default: 0)",
            },
            maxResults: {
              type: "number",
              description: "Maximum number of matches to return (default: 50)",
            },
            outputMode: {
              type: "string",
              enum: ["content", "files_only", "count"],
              description:
                'Output mode: "content" shows matching lines (default), "files_only" shows file paths, "count" shows match counts',
            },
          },
          required: ["pattern"],
        },
      },
    ];
  }

  /**
   * Execute grep search
   */
  async grep(input: {
    pattern: string;
    path?: string;
    glob?: string;
    ignoreCase?: boolean;
    contextLines?: number;
    maxResults?: number;
    outputMode?: "content" | "files_only" | "count";
  }): Promise<{
    success: boolean;
    pattern: string;
    matches: Array<{
      file: string;
      line?: number;
      content?: string;
      context?: { before: string[]; after: string[] };
      count?: number;
    }>;
    totalMatches: number;
    filesSearched: number;
    truncated: boolean;
    error?: string;
    warning?: string;
  }> {
    const {
      pattern,
      path: searchPath,
      glob: globPattern,
      ignoreCase = false,
      contextLines = 0,
      maxResults = 50,
      outputMode = "content",
    } = input;

    this.daemon.logEvent(this.taskId, "log", {
      message: `Grep search: "${pattern}"${searchPath ? ` in ${searchPath}` : ""}${globPattern ? ` (${globPattern})` : ""}`,
    });

    try {
      if (
        (await this.isDocumentHeavyWorkspace()) &&
        (!globPattern || /\.(pdf|docx)\b/i.test(globPattern))
      ) {
        return {
          success: true,
          pattern,
          matches: [],
          totalMatches: 0,
          filesSearched: 0,
          truncated: false,
          warning:
            "Workspace appears document-heavy (PDF/DOCX/PPTX). The grep tool only searches text files. Use read_file for those documents.",
        };
      }

      // Compile regex
      let regex: RegExp;
      try {
        regex = new RegExp(pattern, ignoreCase ? "gi" : "g");
      } catch (e: Any) {
        throw new Error(`Invalid regex pattern: ${e.message}`);
      }

      const basePath = searchPath
        ? path.resolve(this.workspace.path, searchPath)
        : this.workspace.path;

      // Validate path is within workspace
      if (!basePath.startsWith(this.workspace.path)) {
        throw new Error("Search path must be within workspace");
      }

      if (!fs.existsSync(basePath)) {
        throw new Error(`Path does not exist: ${searchPath || "."}`);
      }

      const taskGetter = (this.daemon as Any)?.getTask;
      const task =
        typeof taskGetter === "function" ? taskGetter.call(this.daemon, this.taskId) : null;
      const agentRoleId = task?.assignedAgentRoleId || null;
      const projectAccessCache = new Map<string, boolean>();

      // If the user tries to search directly within a denied project, block early.
      if (await this.isDeniedByProjectAccess(basePath, agentRoleId, projectAccessCache)) {
        throw new Error("Access denied by project access rules");
      }

      // Find files to search
      const files = await this.findFilesToSearch(
        basePath,
        globPattern,
        agentRoleId,
        projectAccessCache,
      );
      const matches: Array<{
        file: string;
        line?: number;
        content?: string;
        context?: { before: string[]; after: string[] };
        count?: number;
      }> = [];

      let totalMatches = 0;
      let truncated = false;

      // Search each file
      for (const file of files) {
        if (truncated) break;

        try {
          const content = fs.readFileSync(file, "utf-8");
          const lines = content.split("\n");
          const relativePath = path.relative(this.workspace.path, file);

          if (outputMode === "count") {
            // Count matches in file
            const fileMatches = (content.match(regex) || []).length;
            if (fileMatches > 0) {
              totalMatches += fileMatches;
              matches.push({
                file: relativePath,
                count: fileMatches,
              });
            }
          } else if (outputMode === "files_only") {
            // Just check if file has matches
            if (regex.test(content)) {
              totalMatches++;
              matches.push({ file: relativePath });
              if (matches.length >= maxResults) {
                truncated = true;
              }
            }
          } else {
            // Content mode - show matching lines
            for (let i = 0; i < lines.length; i++) {
              regex.lastIndex = 0; // Reset regex state
              if (regex.test(lines[i])) {
                totalMatches++;

                const match: {
                  file: string;
                  line: number;
                  content: string;
                  context?: { before: string[]; after: string[] };
                } = {
                  file: relativePath,
                  line: i + 1,
                  content: lines[i].trim(),
                };

                // Add context lines if requested
                if (contextLines > 0) {
                  const beforeStart = Math.max(0, i - contextLines);
                  const afterEnd = Math.min(lines.length - 1, i + contextLines);

                  match.context = {
                    before: lines.slice(beforeStart, i).map((l) => l.trim()),
                    after: lines.slice(i + 1, afterEnd + 1).map((l) => l.trim()),
                  };
                }

                matches.push(match);

                if (matches.length >= maxResults) {
                  truncated = true;
                  break;
                }
              }
            }
          }
        } catch {
          // Skip files we can't read (binary, permissions, etc.)
        }
      }

      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: "grep",
        result: {
          pattern,
          matchCount: matches.length,
          totalMatches,
          filesSearched: files.length,
          truncated,
        },
      });

      return {
        success: true,
        pattern,
        matches,
        totalMatches,
        filesSearched: files.length,
        truncated,
      };
    } catch (error: Any) {
      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: "grep",
        error: error.message,
      });

      return {
        success: false,
        pattern,
        matches: [],
        totalMatches: 0,
        filesSearched: 0,
        truncated: false,
        error: error.message,
      };
    }
  }

  /**
   * Find files to search based on path and glob pattern
   */
  private async findFilesToSearch(
    basePath: string,
    globPattern: string | undefined,
    agentRoleId: string | null,
    projectAccessCache: Map<string, boolean>,
  ): Promise<string[]> {
    const files: string[] = [];
    const globRegex = globPattern ? this.globToRegex(globPattern) : null;

    await this.walkDirectory(basePath, basePath, files, globRegex, agentRoleId, projectAccessCache);

    return files;
  }

  /**
   * Recursively walk directory and collect text files
   */
  private async walkDirectory(
    currentPath: string,
    basePath: string,
    files: string[],
    globRegex: RegExp | null,
    agentRoleId: string | null,
    projectAccessCache: Map<string, boolean>,
    depth: number = 0,
  ): Promise<void> {
    // Limit recursion depth
    if (depth > 50) return;

    // Enforce per-project access for `.cowork/projects/*`
    if (await this.isDeniedByProjectAccess(currentPath, agentRoleId, projectAccessCache)) {
      return;
    }

    // Skip common non-code directories
    const dirName = path.basename(currentPath);
    const skipDirs = [
      "node_modules",
      ".git",
      ".svn",
      ".hg",
      "dist",
      "build",
      "coverage",
      ".next",
      ".nuxt",
      "__pycache__",
      ".pytest_cache",
      "venv",
      ".venv",
    ];

    if (depth > 0 && skipDirs.includes(dirName)) {
      return;
    }

    try {
      const entries = fs.readdirSync(currentPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry.name);
        const relativePath = path.relative(basePath, fullPath);

        if (entry.isDirectory()) {
          await this.walkDirectory(
            fullPath,
            basePath,
            files,
            globRegex,
            agentRoleId,
            projectAccessCache,
            depth + 1,
          );
        } else if (entry.isFile()) {
          if (await this.isDeniedByProjectAccess(fullPath, agentRoleId, projectAccessCache)) {
            continue;
          }

          // Skip binary and large files
          if (this.isBinaryFile(entry.name)) continue;

          try {
            const stats = fs.statSync(fullPath);
            // Skip files larger than 1MB
            if (stats.size > 1024 * 1024) continue;
          } catch {
            continue;
          }

          // Apply glob filter if specified
          if (globRegex) {
            const normalizedRelative = relativePath.split(path.sep).join("/");
            if (!globRegex.test(normalizedRelative) && !globRegex.test(entry.name)) {
              continue;
            }
          }

          files.push(fullPath);
        }
      }
    } catch {
      // Skip directories we can't read
    }
  }

  private async isDeniedByProjectAccess(
    absolutePath: string,
    agentRoleId: string | null,
    cache: Map<string, boolean>,
  ): Promise<boolean> {
    if (!agentRoleId) return false;
    const relPosix = getWorkspaceRelativePosixPath(this.workspace.path, absolutePath);
    if (relPosix === null) return false;
    const projectId = getProjectIdFromWorkspaceRelPath(relPosix);
    if (!projectId) return false;

    const cached = cache.get(projectId);
    if (typeof cached === "boolean") return !cached;

    const res = await checkProjectAccess({
      workspacePath: this.workspace.path,
      projectId,
      agentRoleId,
    });
    cache.set(projectId, res.allowed);
    return !res.allowed;
  }

  /**
   * Check if file appears to be binary
   */
  private isBinaryFile(filename: string): boolean {
    const binaryExtensions = [
      ".png",
      ".jpg",
      ".jpeg",
      ".gif",
      ".bmp",
      ".ico",
      ".webp",
      ".svg",
      ".pdf",
      ".doc",
      ".docx",
      ".xls",
      ".xlsx",
      ".ppt",
      ".pptx",
      ".zip",
      ".tar",
      ".gz",
      ".rar",
      ".7z",
      ".exe",
      ".dll",
      ".so",
      ".dylib",
      ".bin",
      ".dat",
      ".db",
      ".sqlite",
      ".mp3",
      ".mp4",
      ".avi",
      ".mov",
      ".mkv",
      ".wav",
      ".flac",
      ".woff",
      ".woff2",
      ".ttf",
      ".eot",
      ".otf",
    ];

    const ext = path.extname(filename).toLowerCase();
    return binaryExtensions.includes(ext);
  }

  /**
   * Convert glob pattern to regex
   */
  private globToRegex(pattern: string): RegExp {
    const expandedPatterns = this.expandBraces(pattern);
    const regexParts = expandedPatterns.map((p) => this.globPatternToRegex(p));
    const combined = regexParts.length > 1 ? `(${regexParts.join("|")})` : regexParts[0];
    return new RegExp(`^${combined}$`, "i");
  }

  /**
   * Expand brace patterns
   */
  private expandBraces(pattern: string): string[] {
    const braceMatch = pattern.match(/\{([^}]+)\}/);
    if (!braceMatch) return [pattern];

    const [fullMatch, options] = braceMatch;
    const optionList = options.split(",");
    const results: string[] = [];

    for (const option of optionList) {
      const expanded = pattern.replace(fullMatch, option.trim());
      results.push(...this.expandBraces(expanded));
    }

    return results;
  }

  /**
   * Heuristic: detect workspaces dominated by PDF/DOCX files
   */
  private async isDocumentHeavyWorkspace(): Promise<boolean> {
    try {
      const entries = await fsPromises.readdir(this.workspace.path, { withFileTypes: true });
      let fileCount = 0;
      let docCount = 0;
      const maxEntries = 200;

      for (const entry of entries) {
        if (fileCount >= maxEntries) break;
        if (!entry.isFile()) continue;
        fileCount++;
        const ext = path.extname(entry.name).toLowerCase();
        if (ext === ".pdf" || ext === ".docx") {
          docCount++;
        }
      }

      if (fileCount < 5) return false;
      return docCount / fileCount >= 0.5;
    } catch {
      return false;
    }
  }

  /**
   * Convert a glob pattern to a regex string (without delimiters)
   */
  private globPatternToRegex(pattern: string): string {
    let regex = "";
    let i = 0;

    while (i < pattern.length) {
      const char = pattern[i];

      if (char === "*") {
        const isDoubleStar = pattern[i + 1] === "*";
        if (isDoubleStar) {
          i += 2;
          if (pattern[i] === "/") {
            regex += "(?:.*/)?";
            i += 1;
          } else {
            regex += ".*";
          }
        } else {
          regex += "[^/]*";
          i += 1;
        }
        continue;
      }

      if (char === "?") {
        regex += "[^/]";
        i += 1;
        continue;
      }

      if ("+^${}()|[]\\.".includes(char)) {
        regex += `\\${char}`;
        i += 1;
        continue;
      }

      if (char === "/") {
        regex += "/";
        i += 1;
        continue;
      }

      regex += char;
      i += 1;
    }

    return regex;
  }
}
