import { execFile } from "child_process";
import { MergeResult } from "../../shared/types";

/**
 * Low-level git command wrapper. All git operations in the app go through this service.
 * Uses child_process.execFile for safety (no shell injection).
 */
export class GitService {
  /**
   * Check if a directory is inside a git repository.
   */
  static async isGitRepo(dirPath: string): Promise<boolean> {
    try {
      await GitService.exec(["rev-parse", "--is-inside-work-tree"], dirPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the current branch name.
   */
  static async getCurrentBranch(repoPath: string): Promise<string> {
    const { stdout } = await GitService.exec(["rev-parse", "--abbrev-ref", "HEAD"], repoPath);
    return stdout.trim();
  }

  /**
   * Resolve the git repository root for any path inside the repo.
   */
  static async getRepoRoot(anyRepoPath: string): Promise<string> {
    const { stdout } = await GitService.exec(["rev-parse", "--show-toplevel"], anyRepoPath);
    return stdout.trim();
  }

  /**
   * Get the current HEAD commit SHA.
   */
  static async getHeadCommit(repoPath: string): Promise<string> {
    const { stdout } = await GitService.exec(["rev-parse", "HEAD"], repoPath);
    return stdout.trim();
  }

  /**
   * Create a new worktree at the specified path on a new branch.
   * Runs: git worktree add -b <branch> <path>
   */
  static async createWorktree(
    repoPath: string,
    worktreePath: string,
    branchName: string,
  ): Promise<void> {
    await GitService.exec(["worktree", "add", "-b", branchName, worktreePath], repoPath);
  }

  /**
   * Remove a worktree.
   * Runs: git worktree remove <path> --force
   */
  static async removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
    try {
      await GitService.exec(["worktree", "remove", worktreePath, "--force"], repoPath);
    } catch {
      // If worktree was already removed or doesn't exist, prune instead
      await GitService.exec(["worktree", "prune"], repoPath);
    }
  }

  /**
   * List all worktrees for a repository.
   * Runs: git worktree list --porcelain
   */
  static async listWorktrees(
    repoPath: string,
  ): Promise<Array<{ path: string; branch: string; head: string }>> {
    const { stdout } = await GitService.exec(["worktree", "list", "--porcelain"], repoPath);
    const worktrees: Array<{ path: string; branch: string; head: string }> = [];
    let current: { path: string; branch: string; head: string } = {
      path: "",
      branch: "",
      head: "",
    };

    for (const line of stdout.split("\n")) {
      if (line.startsWith("worktree ")) {
        if (current.path) worktrees.push(current);
        current = { path: line.slice(9), branch: "", head: "" };
      } else if (line.startsWith("HEAD ")) {
        current.head = line.slice(5);
      } else if (line.startsWith("branch ")) {
        current.branch = line.slice(7).replace("refs/heads/", "");
      }
    }
    if (current.path) worktrees.push(current);

    return worktrees;
  }

  /**
   * Commit changes.
   * Returns null if there are no changes to commit.
   */
  static async commitAll(
    worktreePath: string,
    message: string,
    options?: { addAll?: boolean },
  ): Promise<{ sha: string; filesChanged: number } | null> {
    const addAll = options?.addAll !== false;

    if (addAll) {
      // Stage-all mode: commit any tracked/untracked changes.
      const hasChanges = await GitService.hasUncommittedChanges(worktreePath);
      if (!hasChanges) return null;
      await GitService.exec(["add", "-A"], worktreePath);
    } else {
      // Staged-only mode: commit only what is already staged.
      const { stdout: status } = await GitService.exec(["status", "--porcelain"], worktreePath);
      const hasStagedChanges = status
        .split("\n")
        .some((line) => line.length >= 2 && line[0] !== " " && line[0] !== "?");
      if (!hasStagedChanges) return null;
    }

    // Commit
    await GitService.exec(["commit", "-m", message], worktreePath);

    // Get the commit SHA
    const sha = await GitService.getHeadCommit(worktreePath);

    // Get files changed count
    const { stdout: diffStat } = await GitService.exec(
      ["diff", "--stat", "HEAD~1..HEAD", "--numstat"],
      worktreePath,
    );
    const filesChanged = diffStat
      .trim()
      .split("\n")
      .filter((l) => l.trim()).length;

    return { sha, filesChanged };
  }

  /**
   * Get diff stats (files changed, lines added/removed).
   */
  static async getDiffStats(
    worktreePath: string,
    baseBranch: string,
  ): Promise<{
    filesChanged: number;
    linesAdded: number;
    linesRemoved: number;
    diffOutput: string;
  }> {
    const { stdout } = await GitService.exec(
      ["diff", "--stat", `${baseBranch}..HEAD`],
      worktreePath,
    );

    const { stdout: numstat } = await GitService.exec(
      ["diff", "--numstat", `${baseBranch}..HEAD`],
      worktreePath,
    );

    let linesAdded = 0;
    let linesRemoved = 0;
    let filesChanged = 0;

    for (const line of numstat.trim().split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split("\t");
      if (parts.length >= 3) {
        const added = parseInt(parts[0], 10);
        const removed = parseInt(parts[1], 10);
        if (!isNaN(added)) linesAdded += added;
        if (!isNaN(removed)) linesRemoved += removed;
        filesChanged++;
      }
    }

    return { filesChanged, linesAdded, linesRemoved, diffOutput: stdout };
  }

  /**
   * Get full diff output for review.
   */
  static async getFullDiff(worktreePath: string, baseBranch: string): Promise<string> {
    const { stdout } = await GitService.exec(["diff", `${baseBranch}..HEAD`], worktreePath);
    return stdout;
  }

  /**
   * Merge branch into base branch. Returns merge result.
   * Operates in the main repo (not the worktree).
   */
  static async mergeToBase(
    repoPath: string,
    branchName: string,
    baseBranch: string,
    commitMessage: string,
  ): Promise<MergeResult> {
    try {
      // Save current branch to restore later
      const currentBranch = await GitService.getCurrentBranch(repoPath);

      // Do not mutate a dirty primary repository state.
      const repoDirty = await GitService.hasUncommittedChanges(repoPath);
      if (repoDirty) {
        return {
          success: false,
          error:
            `Cannot merge into "${baseBranch}" because the repository has uncommitted changes ` +
            `on "${currentBranch}". Commit or stash them first.`,
        };
      }

      // Checkout base branch
      await GitService.exec(["checkout", baseBranch], repoPath);

      try {
        // Merge with no-ff for a clean merge commit
        await GitService.exec(["merge", branchName, "--no-ff", "-m", commitMessage], repoPath);

        // Get merge commit SHA
        const mergeSha = await GitService.getHeadCommit(repoPath);

        // Restore original branch if different
        if (currentBranch !== baseBranch) {
          try {
            await GitService.exec(["checkout", currentBranch], repoPath);
          } catch {
            // Best effort to restore
          }
        }

        return { success: true, mergeSha };
      } catch (error: Any) {
        // Merge failed — likely a conflict
        // Abort the merge
        try {
          await GitService.exec(["merge", "--abort"], repoPath);
        } catch {
          // Merge abort might fail if there's nothing to abort
        }

        // Restore original branch
        try {
          await GitService.exec(["checkout", currentBranch], repoPath);
        } catch {
          // Best effort
        }

        // Try to get conflict file list
        let conflictFiles: string[] = [];
        try {
          const { stdout } = await GitService.exec(
            ["diff", "--name-only", "--diff-filter=U"],
            repoPath,
          );
          conflictFiles = stdout
            .trim()
            .split("\n")
            .filter((f) => f.trim());
        } catch {
          // Couldn't get conflict files
        }

        return {
          success: false,
          conflictFiles: conflictFiles.length > 0 ? conflictFiles : undefined,
          error: error.message || "Merge conflict detected",
        };
      }
    } catch (error: Any) {
      return {
        success: false,
        error: error.message || "Failed to merge",
      };
    }
  }

  /**
   * Check for uncommitted changes.
   */
  static async hasUncommittedChanges(worktreePath: string): Promise<boolean> {
    const { stdout } = await GitService.exec(["status", "--porcelain"], worktreePath);
    return stdout.trim().length > 0;
  }

  /**
   * Delete a local branch.
   */
  static async deleteBranch(repoPath: string, branchName: string): Promise<void> {
    await GitService.exec(["branch", "-D", branchName], repoPath);
  }

  /**
   * Get short status output for display.
   */
  static async getStatus(worktreePath: string): Promise<string> {
    const { stdout } = await GitService.exec(["status", "--short"], worktreePath);
    return stdout;
  }

  /**
   * Get diff output (staged or unstaged).
   */
  static async getDiff(
    worktreePath: string,
    options?: { staged?: boolean; file?: string },
  ): Promise<string> {
    const args = ["diff"];
    if (options?.staged) args.push("--cached");
    if (options?.file) args.push("--", options.file);
    const { stdout } = await GitService.exec(args, worktreePath);
    return stdout;
  }

  /**
   * Generate a branch name from a task title.
   * e.g., "Fix login bug" -> "cowork/fix-login-bug-a1b2c3"
   */
  static generateBranchName(title: string, prefix: string, taskId: string): string {
    const slug =
      title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 40) || "task";
    const suffix = taskId.slice(0, 6);
    return `${prefix}${slug}-${suffix}`;
  }

  /**
   * Internal helper: execute a git command.
   */
  private static exec(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      execFile(
        "git",
        args,
        { cwd, maxBuffer: 10 * 1024 * 1024, timeout: 30_000 },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(`git ${args[0]} failed: ${stderr || error.message}`));
          } else {
            resolve({ stdout: stdout || "", stderr: stderr || "" });
          }
        },
      );
    });
  }
}
