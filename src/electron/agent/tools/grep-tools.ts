import { execFile } from "child_process";
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
import {
  evaluateWorkspaceFilesystemAccess,
  isAccessPathWithin,
} from "../../security/access-profile-paths";
import { LLMTool } from "../llm/types";
import { BoundedRegex, RegexDeadlineError } from "./bounded-regex";

const MAX_GREP_OUTPUT_BYTES = 50_000;
// Larger files are skipped; their lines would be copied wholesale into the regex worker.
const MAX_GREP_FILE_BYTES = 1024 * 1024;
// Listing gitignored paths is an optimization; past these limits grep walks without it.
const GIT_IGNORE_LIST_TIMEOUT_MS = 5_000;
const GIT_IGNORE_LIST_MAX_BYTES = 8 * 1024 * 1024;
// Git pointer files (`.git` files, `commondir`, a worktree's `gitdir`) hold one path; anything
// larger is not one.
const MAX_GIT_POINTER_FILE_BYTES = 4096;

/** Explicit --git-dir skips git's own "dubious ownership" check, so it is repeated here. */
function isOwnedByCurrentUser(stats: fs.Stats): boolean {
  return typeof process.getuid !== "function" || stats.uid === process.getuid();
}

/**
 * The real path a git pointer file names (a `.git` file's "gitdir: <path>", a git directory's
 * `commondir`, a linked worktree's `gitdir`), resolved against `baseDir` as git does. Null
 * unless the pointer is a small regular file and its target is owned by the current user.
 */
function readGitPointer(file: string, prefix: string, baseDir: string): string | null {
  const stats = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stats?.isFile() || stats.size > MAX_GIT_POINTER_FILE_BYTES) return null;
  const content = fs.readFileSync(file, "utf8").replace(/[\r\n]+$/, "");
  if (!content.startsWith(prefix) || content.length === prefix.length) return null;
  const target = fs.realpathSync(path.resolve(baseDir, content.slice(prefix.length)));
  return isOwnedByCurrentUser(fs.statSync(target)) ? target : null;
}

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
        throw new Error("Search path must be within workspace");
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
        : await this.findFilesToSearch(
            checkedBasePath,
            globPattern,
            agentRoleId,
            projectAccessCache,
            evaluator,
          );
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
          const relativePath = path.relative(this.workspace.path, file);

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

  /**
   * Find files to search based on path and glob pattern
   */
  private async findFilesToSearch(
    basePath: string,
    globPattern: string | undefined,
    agentRoleId: string | null,
    projectAccessCache: Map<string, boolean>,
    evaluator: BoundedRegex,
  ): Promise<{ files: string[]; gitIgnoredSkipped: number }> {
    const files: string[] = [];
    const globRegex = globPattern ? this.globToRegex(globPattern) : null;
    const gitIgnored = { paths: await this.listGitIgnoredPaths(basePath), skipped: 0 };

    await this.walkDirectory(
      basePath,
      basePath,
      files,
      globRegex,
      agentRoleId,
      projectAccessCache,
      evaluator,
      gitIgnored,
    );

    return { files, gitIgnoredSkipped: gitIgnored.skipped };
  }

  /**
   * Untracked paths git ignores under `directory` (.gitignore, .git/info/exclude, global
   * excludes), "/"-separated relative to it, with a trailing "/" for whole directories. Only a
   * repository found between `directory` and the workspace root counts, so an enclosing repo
   * (such as a dotfiles repo in the home directory) cannot hide workspace files. A requested
   * directory that is itself ignored is searched as asked. Any failure means "nothing ignored".
   */
  private async listGitIgnoredPaths(directory: string): Promise<Set<string>> {
    const ignored = new Set<string>();
    const repository = this.findWorkspaceGitRepository(directory);
    if (!repository) return ignored;
    // Read-only and hardened against repository config: no fsmonitor hook, no optional locks,
    // no inherited GIT_* overrides, no prompts. The repository is named explicitly (git does no
    // discovery, and --work-tree overrides core.worktree), so it cannot be redirected outside
    // the workspace.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
    );
    const stdout = await new Promise<string | null>((resolve) => {
      execFile(
        "git",
        [
          `--git-dir=${repository.gitDir}`,
          `--work-tree=${repository.workTree}`,
          "--no-optional-locks",
          "--no-pager",
          "-c",
          "core.fsmonitor=false",
          "ls-files",
          "--others",
          "--ignored",
          "--exclude-standard",
          "--directory",
          "-z",
        ],
        {
          cwd: repository.searchDir,
          encoding: "utf8",
          timeout: GIT_IGNORE_LIST_TIMEOUT_MS,
          maxBuffer: GIT_IGNORE_LIST_MAX_BYTES,
          windowsHide: true,
          env: {
            ...env,
            // The validated common directory, so git does not re-read the commondir file.
            GIT_COMMON_DIR: repository.commonDir,
            GIT_OPTIONAL_LOCKS: "0",
            GIT_TERMINAL_PROMPT: "0",
          },
        },
        (error, output) => resolve(error ? null : output),
      );
    });
    const entries = stdout ? stdout.split("\0").filter(Boolean) : [];
    if (entries.includes("./")) return ignored;
    for (const entry of entries) ignored.add(entry);
    return ignored;
  }

  /**
   * The repository nearest to `directory` between it and the workspace root, with real paths.
   * Its `.git` must be a directory or a `.git` file ("gitdir: <path>"), owned by the current
   * user, and its git directory and any `commondir` must resolve inside the workspace, except
   * for a linked worktree checked out here: its git directory, in a repository outside the
   * workspace, names this `.git` file back (git worktree add writes that), which a file planted
   * in the workspace cannot arrange. Otherwise a planted `.git` file, symlink or `commondir`
   * would make git read config, index and excludes from elsewhere, so the grep runs without
   * .gitignore filtering instead.
   */
  private findWorkspaceGitRepository(
    directory: string,
  ): { gitDir: string; commonDir: string; workTree: string; searchDir: string } | null {
    try {
      const workspaceRoot = fs.realpathSync(this.workspace.path);
      const searchDir = fs.realpathSync(directory);
      let current = searchDir;
      const relative = path.relative(workspaceRoot, current);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        return null;
      }
      for (;;) {
        const dotGit = path.join(current, ".git");
        const dotGitStats = fs.lstatSync(dotGit, { throwIfNoEntry: false });
        if (dotGitStats) {
          if (!isOwnedByCurrentUser(dotGitStats)) return null;
          const gitDir = dotGitStats.isDirectory()
            ? dotGit
            : dotGitStats.isFile()
              ? readGitPointer(dotGit, "gitdir: ", current)
              : null;
          if (!gitDir || !fs.statSync(gitDir).isDirectory()) return null;
          const inWorkspace = isAccessPathWithin(workspaceRoot, gitDir);
          if (!inWorkspace && readGitPointer(path.join(gitDir, "gitdir"), "", gitDir) !== dotGit) {
            return null;
          }
          const commonDirFile = path.join(gitDir, "commondir");
          const commonDir = fs.lstatSync(commonDirFile, { throwIfNoEntry: false })
            ? readGitPointer(commonDirFile, "", gitDir)
            : gitDir;
          if (!commonDir || !fs.statSync(commonDir).isDirectory()) return null;
          // A git directory in the workspace is workspace content: its commondir must stay there.
          if (inWorkspace && !isAccessPathWithin(workspaceRoot, commonDir)) return null;
          return { gitDir, commonDir, workTree: current, searchDir };
        }
        const parent = path.dirname(current);
        if (current === workspaceRoot || parent === current) return null;
        current = parent;
      }
    } catch {
      return null;
    }
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
    evaluator: BoundedRegex,
    gitIgnored: { paths: ReadonlySet<string>; skipped: number },
    depth: number = 0,
  ): Promise<void> {
    // Limit recursion depth
    if (depth > 50) return;

    // Enforce per-project access for `.cowork/projects/*`
    if (await this.isDeniedByProjectAccess(currentPath, agentRoleId, projectAccessCache)) {
      return;
    }

    if (
      evaluateWorkspaceFilesystemAccess(this.workspace, currentPath, "read").decision !== "allow"
    ) {
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
      "release",
      ".cowork",
      "out",
      ".cache",
      ".parcel-cache",
      ".turbo",
    ];

    if (depth > 0 && skipDirs.includes(dirName)) {
      return;
    }

    // Glob candidates are tested in one worker round trip per batch; flush before
    // recursing so files keep their directory-walk order.
    const globCandidates: Array<{
      fullPath: string;
      relative: string;
      name: string;
      ignored: boolean;
    }> = [];
    const flushGlobCandidates = async () => {
      if (!globRegex || globCandidates.length === 0) return;
      const batch = globCandidates.splice(0);
      const matched = new Set(
        await evaluator.evaluate(
          globRegex.source,
          globRegex.flags,
          batch.flatMap((candidate) => [candidate.relative, candidate.name]),
          "test",
        ),
      );
      batch.forEach((candidate, index) => {
        if (!matched.has(2 * index) && !matched.has(2 * index + 1)) return;
        if (candidate.ignored) gitIgnored.skipped += 1;
        else files.push(candidate.fullPath);
      });
    };

    try {
      const entries = fs.readdirSync(currentPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry.name);
        const relativePath = path.relative(basePath, fullPath).split(path.sep).join("/");

        if (
          evaluateWorkspaceFilesystemAccess(this.workspace, fullPath, "read").decision !== "allow"
        ) {
          continue;
        }

        if (entry.isDirectory()) {
          if (!skipDirs.includes(entry.name) && gitIgnored.paths.has(`${relativePath}/`)) {
            gitIgnored.skipped += 1;
            continue;
          }
          await flushGlobCandidates();
          await this.walkDirectory(
            fullPath,
            basePath,
            files,
            globRegex,
            agentRoleId,
            projectAccessCache,
            evaluator,
            gitIgnored,
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
            if (stats.size > MAX_GREP_FILE_BYTES) continue;
          } catch {
            continue;
          }

          // Apply glob filter if specified; ignored files only count as skipped if they match it.
          const ignored = gitIgnored.paths.has(relativePath);
          if (globRegex) {
            globCandidates.push({ fullPath, relative: relativePath, name: entry.name, ignored });
            continue;
          }
          if (ignored) {
            gitIgnored.skipped += 1;
            continue;
          }

          files.push(fullPath);
        }
      }
      await flushGlobCandidates();
    } catch (error) {
      if (error instanceof RegexDeadlineError) throw error;
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
    if (pattern.length > 1024) throw new Error("Glob pattern exceeds the 1024-character limit");
    const expandedPatterns = this.expandBraces(pattern);
    const regexParts = expandedPatterns.map((p) => this.globPatternToRegex(p));
    const combined = regexParts.length > 1 ? `(${regexParts.join("|")})` : regexParts[0];
    return new RegExp(`^${combined}$`, "i");
  }

  /**
   * Expand brace patterns
   */
  private expandBraces(pattern: string, budget = { remaining: 128 }): string[] {
    const braceMatch = pattern.match(/\{([^}]+)\}/);
    if (!braceMatch) {
      if (--budget.remaining < 0) throw new Error("Glob pattern exceeds the 128-expansion limit");
      return [pattern];
    }

    const [fullMatch, options] = braceMatch;
    const optionList = options.split(",");
    const results: string[] = [];

    for (const option of optionList) {
      const expanded = pattern.replace(fullMatch, option.trim());
      results.push(...this.expandBraces(expanded, budget));
    }

    return results;
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
