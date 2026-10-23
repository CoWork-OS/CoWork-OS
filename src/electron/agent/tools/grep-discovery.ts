import { execFile } from "child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Workspace } from "../../../shared/types";
import {
  evaluateWorkspaceFilesystemAccess,
  isAccessPathWithin,
} from "../../security/access-profile-paths";
import {
  checkProjectAccess,
  getProjectIdFromWorkspaceRelPath,
  getWorkspaceRelativePosixPath,
} from "../../security/project-access";
const MAX_GREP_FILE_BYTES = 1024 * 1024;
class FileDiscoveryLimitError extends Error {}
interface CandidateEvaluator {
  evaluate(pattern: string, flags: string, texts: string[], mode: "test"): Promise<number[]>;
}
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

export class GrepDiscovery {
  private startedAt = 0;
  private entriesVisited = 0;
  constructor(private workspace: Workspace) {}
  async findFilesToSearch(
    basePath: string,
    globPattern: string | undefined,
    agentRoleId: string | null,
    projectAccessCache: Map<string, boolean>,
    evaluator: CandidateEvaluator,
  ): Promise<{ files: string[]; gitIgnoredSkipped: number }> {
    this.startedAt = Date.now();
    this.entriesVisited = 0;
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
    evaluator: CandidateEvaluator,
    gitIgnored: { paths: ReadonlySet<string>; skipped: number },
    depth: number = 0,
  ): Promise<void> {
    if (Date.now() - this.startedAt > 25_000 || ++this.entriesVisited > 60_000) {
      throw new FileDiscoveryLimitError(
        "File discovery exceeded its scan budget; narrow path or glob",
      );
    }
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

    // Glob candidates are tested in batches inside this worker; flush before
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
        if (++this.entriesVisited > 60_000 || Date.now() - this.startedAt > 25_000) {
          throw new FileDiscoveryLimitError(
            "File discovery exceeded its scan budget; narrow path or glob",
          );
        }
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
      if (error instanceof FileDiscoveryLimitError) throw error;
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
