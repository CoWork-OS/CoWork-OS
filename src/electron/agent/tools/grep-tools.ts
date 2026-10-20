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
import { evaluateWorkspaceFilesystemAccess } from "../../security/access-profile-paths";
import { LLMTool } from "../llm/types";
import { BoundedRegex, RegexDeadlineError } from "./bounded-regex";
import { fileDiscoveryService } from "./file-discovery-client";

const MAX_GREP_OUTPUT_BYTES = 50_000;
// Larger files are skipped; their lines would be copied wholesale into the regex worker.
const MAX_GREP_FILE_BYTES = 1024 * 1024;
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
          "In a git repository, files ignored by .gitignore are skipped unless path names them. " +
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
    truncationReason?: string;
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

    const evaluator = this.createRegexEvaluator();
    try {
      // Compile regex
      if (pattern.length > 4096) throw new Error("Regex pattern exceeds the 4096-character limit");
      let regex: RegExp;
      try {
        regex = new RegExp(pattern, ignoreCase ? "gi" : "g");
      } catch (e: Any) {
        throw new Error(`Invalid regex pattern: ${e.message}`);
      }

      const workspaceRoot = path.resolve(this.workspace.path);
      const basePath = searchPath ? path.resolve(workspaceRoot, searchPath) : workspaceRoot;
      const baseAccess = evaluateWorkspaceFilesystemAccess(this.workspace, basePath, "read");
      if (baseAccess.decision !== "allow") {
        if (baseAccess.reason === "profile_filesystem_denied") {
          throw new Error(`Path is denied by the active access profile: ${basePath}`);
        }
        if (baseAccess.reason === "memory_repo_unavailable") {
          throw new Error("The memory folder is not readable in this task");
        }
        throw new Error("Search path must be within workspace (or the memory folder)");
      }
      const checkedBasePath = baseAccess.path;

      if (!fs.existsSync(checkedBasePath)) {
        throw new Error(`Path does not exist: ${searchPath || "."}`);
      }

      const taskGetter = (this.daemon as Any)?.getTask;
      const task =
        typeof taskGetter === "function" ? taskGetter.call(this.daemon, this.taskId) : null;
      const agentRoleId = task?.assignedAgentRoleId || null;
      const projectAccessCache = new Map<string, boolean>();

      // If the user tries to search directly within a denied project, block early.
      if (await this.isDeniedByProjectAccess(checkedBasePath, agentRoleId, projectAccessCache)) {
        throw new Error("Access denied by project access rules");
      }

      // A path naming one file searches just that file, under the same limits as a directory walk.
      const baseStats = fs.statSync(checkedBasePath);
      if (baseStats.isFile()) {
        const unsearchable = this.isBinaryFile(checkedBasePath)
          ? "is a binary or document file and the grep tool only searches text files"
          : baseStats.size > MAX_GREP_FILE_BYTES
            ? "is larger than 1 MB, which the grep tool does not search"
            : null;
        if (unsearchable) {
          return {
            success: true,
            pattern,
            matches: [],
            totalMatches: 0,
            filesSearched: 0,
            truncated: false,
            warning: `${searchPath} ${unsearchable}. Use read_file to read it.`,
          };
        }
      }

      // Judge the directory actually being searched. Its text files are still searched; the
      // warning only explains why PDF/DOCX content cannot match.
      let warning: string | undefined;
      if (baseStats.isDirectory() && (await this.isDocumentHeavyWorkspace(checkedBasePath))) {
        if (globPattern && /\.(pdf|docx)\b/i.test(globPattern)) {
          return {
            success: true,
            pattern,
            matches: [],
            totalMatches: 0,
            filesSearched: 0,
            truncated: false,
            warning:
              "The grep tool only searches text files, so PDF/DOCX documents cannot match. Use read_file for those documents.",
          };
        }
        warning =
          "Search path appears document-heavy (PDF/DOCX/PPTX). The grep tool only searched its text files; use read_file for those documents.";
      }

      // Find files to search
      const found = baseStats.isFile()
        ? { files: [checkedBasePath], gitIgnoredSkipped: 0 }
        : await fileDiscoveryService.discoverGrep(this.workspace, {
            basePath: checkedBasePath,
            globPattern,
            agentRoleId,
          });
      const files = found.files;
      const matches: Array<{
        file: string;
        line?: number;
        content?: string;
        context?: { before: string[]; after: string[] };
        count?: number;
      }> = [];

      let totalMatches = 0;
      let truncated = false;
      let truncationReason: string | undefined;

      // Search each file
      for (const [fileIndex, file] of files.entries()) {
        if (truncated) break;

        if (evaluateWorkspaceFilesystemAccess(this.workspace, file, "read").decision !== "allow") {
          continue;
        }

        try {
          const content = fs.readFileSync(file, "utf-8");
          const lines = content.split("\n");
          // Files outside the workspace (the memory folder) are reported by absolute path.
          const fromWorkspace = path.relative(this.workspace.path, file);
          const relativePath =
            fromWorkspace.startsWith("..") || path.isAbsolute(fromWorkspace) ? file : fromWorkspace;

          if (outputMode === "count") {
            // Count matches in file
            const [fileMatches] = await evaluator.evaluate(
              regex.source,
              regex.flags,
              [content],
              "count",
            );
            if (fileMatches > 0) {
              totalMatches += fileMatches;
              matches.push({
                file: relativePath,
                count: fileMatches,
              });
            }
          } else if (outputMode === "files_only") {
            // Just check if file has matches
            if ((await evaluator.evaluate(regex.source, regex.flags, [content], "test")).length) {
              totalMatches++;
              matches.push({ file: relativePath });
              if (matches.length >= maxResults) {
                truncated = true;
              }
            }
          } else {
            // Content mode - show matching lines
            const indices = await evaluator.evaluate(
              regex.source,
              regex.flags,
              lines,
              "test",
              Math.max(1, maxResults - matches.length),
            );
            for (const i of indices) {
              {
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
        } catch (error) {
          if (error instanceof RegexDeadlineError) {
            const progress = `after searching ${fileIndex} of ${files.length} files`;
            // Matches found before the time budget ran out stay useful; only an empty search fails.
            if (matches.length === 0) {
              throw new RegexDeadlineError(
                `${error.message} ${progress} (no matches so far). Narrow path or glob, or simplify the pattern.`,
              );
            }
            truncated = true;
            truncationReason = `${error.message} ${progress}, so these results are partial. Narrow path or glob to search the remaining files.`;
            break;
          }
          // Skip files we can't read (binary, permissions, etc.)
        }
      }

      if (matches.length === 0 && found.gitIgnoredSkipped > 0) {
        const note = `${found.gitIgnoredSkipped} files or directories ignored by .gitignore were not searched; pass one as path to search it.`;
        warning = warning ? `${warning} ${note}` : note;
      }

      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: "grep",
        result: {
          pattern,
          matchCount: matches.length,
          totalMatches,
          filesSearched: files.length,
          truncated,
          ...(truncationReason ? { truncationReason } : {}),
        },
      });
      const budgeted = this.applyOutputBudget(matches);

      return {
        success: true,
        pattern,
        matches: budgeted.matches,
        totalMatches,
        filesSearched: files.length,
        truncated: truncated || budgeted.truncated,
        ...(truncationReason ? { truncationReason } : {}),
        ...(warning ? { warning } : {}),
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
    } finally {
      await evaluator.close();
    }
  }

  /** Regex evaluator for one grep call (its time budget spans the whole search). */
  protected createRegexEvaluator(): BoundedRegex {
    return new BoundedRegex();
  }

  private applyOutputBudget<
    T extends Array<{
      file: string;
      line?: number;
      content?: string;
      context?: { before: string[]; after: string[] };
      count?: number;
    }>,
  >(matches: T): { matches: T; truncated: boolean } {
    const outputBytes = Buffer.byteLength(JSON.stringify(matches), "utf8");
    if (outputBytes <= MAX_GREP_OUTPUT_BYTES) {
      return { matches, truncated: false };
    }

    const itemSizes = matches.map((m) => Buffer.byteLength(JSON.stringify(m), "utf8"));
    let total = outputBytes;
    let keepCount = matches.length;
    while (keepCount > 1 && total > MAX_GREP_OUTPUT_BYTES) {
      keepCount--;
      total -= itemSizes[keepCount];
    }
    const next = matches.slice(0, keepCount) as T;

    if (next.length > 0 && outputBytes > MAX_GREP_OUTPUT_BYTES) {
      const first = { ...next[0] };
      if (typeof first.content === "string") {
        first.content = `${first.content.slice(0, 2_000)}\n[... truncated grep match ...]`;
      }
      if (first.context) {
        first.context = {
          before: first.context.before.slice(-2),
          after: first.context.after.slice(0, 2),
        };
      }
      next[0] = first as T[number];
    }

    return { matches: next, truncated: true };
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
   * Heuristic: detect directories (the workspace root by default) dominated by PDF/DOCX files
   */
  private async isDocumentHeavyWorkspace(
    directory: string = this.workspace.path,
  ): Promise<boolean> {
    try {
      const entries = await fsPromises.readdir(directory, { withFileTypes: true });
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
}
