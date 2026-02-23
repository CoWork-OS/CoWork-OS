import { Workspace } from "../../../shared/types";
import { AgentDaemon } from "../daemon";
import { GitService } from "../../git/GitService";
import { LLMTool } from "../llm/types";

/**
 * Git tools that agents can use for version control operations.
 * git_status and git_diff are always available in git repos.
 * git_commit and git_merge_to_base require an active worktree.
 */
export class GitTools {
  constructor(
    private workspace: Workspace,
    private daemon: AgentDaemon,
    private taskId: string,
  ) {}

  setWorkspace(workspace: Workspace): void {
    this.workspace = workspace;
  }

  /**
   * Get git status of the working directory.
   */
  async gitStatus(): Promise<string> {
    const isRepo = await GitService.isGitRepo(this.workspace.path);
    if (!isRepo) {
      return "This workspace is not a git repository.";
    }
    const status = await GitService.getStatus(this.workspace.path);
    if (!status.trim()) {
      return "Working tree clean — no changes.";
    }
    const branch = await GitService.getCurrentBranch(this.workspace.path);
    return `On branch: ${branch}\n\n${status}`;
  }

  /**
   * Get diff of changes.
   */
  async gitDiff(input: { staged?: boolean; file?: string }): Promise<string> {
    const isRepo = await GitService.isGitRepo(this.workspace.path);
    if (!isRepo) {
      return "This workspace is not a git repository.";
    }
    const diff = await GitService.getDiff(this.workspace.path, {
      staged: input.staged,
      file: input.file,
    });
    if (!diff.trim()) {
      return input.staged ? "No staged changes." : "No unstaged changes.";
    }
    // Truncate very large diffs
    const maxLen = 50_000;
    if (diff.length > maxLen) {
      return diff.slice(0, maxLen) + "\n\n... (diff truncated, too large to display)";
    }
    return diff;
  }

  /**
   * Commit current changes. Only available in worktree-isolated tasks.
   */
  async gitCommit(input: { message: string; add_all?: boolean }): Promise<string> {
    const task = await this.daemon.getTaskById(this.taskId);
    if (!task?.worktreeBranch) {
      return "git_commit requires an active worktree. Enable worktree isolation in Settings > Git to use this tool.";
    }

    const isRepo = await GitService.isGitRepo(this.workspace.path);
    if (!isRepo) {
      return "This workspace is not a git repository.";
    }

    const addAll = input.add_all !== false; // default true
    const result = await GitService.commitAll(this.workspace.path, input.message, { addAll });
    if (!result) {
      return addAll
        ? "Nothing to commit — working tree clean."
        : "Nothing to commit — no staged changes.";
    }

    this.daemon.logEvent(this.taskId, "worktree_committed", {
      sha: result.sha,
      filesChanged: result.filesChanged,
      message: `Committed ${result.filesChanged} file(s): ${input.message} (${result.sha.slice(0, 7)})`,
    });

    return `Committed successfully.\nSHA: ${result.sha.slice(0, 7)}\nFiles changed: ${result.filesChanged}\nMessage: ${input.message}`;
  }

  /**
   * Request merge of worktree branch back to base branch.
   */
  async gitMergeToBase(): Promise<string> {
    const task = await this.daemon.getTaskById(this.taskId);
    if (!task?.worktreeBranch) {
      return "git_merge_to_base requires an active worktree. This tool is only available for tasks running in worktree isolation mode.";
    }

    const worktreeManager = this.daemon.getWorktreeManager();
    const info = worktreeManager.getWorktreeInfo(this.taskId);
    if (!info) {
      return "No worktree info found for this task.";
    }

    this.daemon.logEvent(this.taskId, "worktree_merge_start", {
      branch: info.branchName,
      baseBranch: info.baseBranch,
      message: `Merging "${info.branchName}" into "${info.baseBranch}"...`,
    });

    const result = await worktreeManager.mergeToBase(this.taskId);

    if (result.success) {
      this.daemon.logEvent(this.taskId, "worktree_merged", {
        sha: result.mergeSha,
        message: `Successfully merged "${info.branchName}" into "${info.baseBranch}" (${result.mergeSha?.slice(0, 7)}).`,
      });
      return `Merge successful!\nMerge commit: ${result.mergeSha?.slice(0, 7)}\nBranch "${info.branchName}" merged into "${info.baseBranch}".`;
    } else {
      this.daemon.logEvent(this.taskId, "worktree_conflict", {
        conflictFiles: result.conflictFiles,
        error: result.error,
        message: `Merge conflict: ${result.error}`,
      });
      let msg = `Merge failed: ${result.error}`;
      if (result.conflictFiles && result.conflictFiles.length > 0) {
        msg += `\nConflicting files:\n${result.conflictFiles.map((f) => `  - ${f}`).join("\n")}`;
      }
      return msg;
    }
  }

  static getToolDefinitions(): LLMTool[] {
    return [
      {
        name: "git_status",
        description:
          "Show the current git status of the workspace (changed files, staged files, branch info). Use this to understand what files have been modified before committing.",
        input_schema: {
          type: "object" as const,
          properties: {},
        },
      },
      {
        name: "git_diff",
        description:
          "Show the diff of changes in the workspace. Can show unstaged changes, staged changes, or changes to a specific file. Useful for reviewing what has changed.",
        input_schema: {
          type: "object" as const,
          properties: {
            staged: {
              type: "boolean",
              description: "Show only staged changes. Default: false (shows unstaged changes).",
            },
            file: {
              type: "string",
              description: "Path to a specific file to diff. If omitted, shows all changes.",
            },
          },
        },
      },
      {
        name: "git_commit",
        description:
          "Commit changes in the workspace. Only available when working in an isolated worktree branch. Stages all changes and commits with the given message.",
        input_schema: {
          type: "object" as const,
          properties: {
            message: {
              type: "string",
              description: "Commit message describing the changes.",
            },
            add_all: {
              type: "boolean",
              description: "Stage all changes before committing. Default: true.",
            },
          },
          required: ["message"],
        },
      },
      {
        name: "git_merge_to_base",
        description:
          "Merge the current worktree branch back to the base branch. Only available in worktree isolation mode. Use when your work is complete and ready to be integrated.",
        input_schema: {
          type: "object" as const,
          properties: {},
        },
      },
    ];
  }
}
