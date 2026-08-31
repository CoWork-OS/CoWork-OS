import * as fs from "fs";
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
  resolveAccessControlledPath,
} from "../../security/access-profile-paths";
import { LLMTool } from "../llm/types";

/**
 * EditTools provides surgical file editing capabilities
 * Similar to Claude Code's Edit tool for precise string replacements
 */
export class EditTools {
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
   * Get tool definitions for Edit tools
   */
  static getToolDefinitions(): LLMTool[] {
    return [
      {
        name: "edit_file",
        description:
          "Perform surgical text replacements in files. " +
          "Replaces exact matches of old_string with new_string. " +
          "PREFERRED over write_file when making targeted changes - safer and preserves file structure. " +
          "The edit will FAIL if old_string is not found or is not unique (unless replace_all is true).",
        input_schema: {
          type: "object",
          properties: {
            file_path: {
              type: "string",
              description: "Path to the file to edit (relative to workspace)",
            },
            old_string: {
              type: "string",
              description:
                "The exact text to find and replace (must be unique in file unless replace_all)",
            },
            new_string: {
              type: "string",
              description: "The text to replace it with (can be empty to delete)",
            },
            replace_all: {
              type: "boolean",
              description:
                "Replace all occurrences instead of requiring unique match (default: false)",
            },
          },
          required: ["file_path", "old_string", "new_string"],
        },
      },
    ];
  }

  /**
   * Execute surgical file edit
   */
  async editFile(input: {
    file_path: string;
    old_string: string;
    new_string: string;
    replace_all?: boolean;
  }): Promise<{
    success: boolean;
    file_path: string;
    replacements: number;
    error?: string;
  }> {
    const { file_path, old_string, new_string, replace_all = false } = input;

    this.daemon.logEvent(this.taskId, "log", {
      message: `Editing file: ${file_path}`,
    });

    try {
      // Validate inputs
      if (!old_string) {
        throw new Error("old_string cannot be empty");
      }

      if (old_string === new_string) {
        throw new Error("old_string and new_string are identical - no change needed");
      }

      // Resolve path
      const workspaceRoot = path.resolve(this.workspace.path);
      const requestedFullPath = path.resolve(workspaceRoot, file_path);
      const candidatePath = resolveAccessControlledPath(this.workspace.path, requestedFullPath);
      let externalApprovalGranted =
        typeof (this.daemon as Any)?.consumeExternalFileApproval === "function" &&
        (this.daemon as Any).consumeExternalFileApproval(this.taskId, candidatePath, "write") ===
          true;
      let access = evaluateWorkspaceFilesystemAccess(this.workspace, requestedFullPath, "write", {
        externalApprovalGranted,
      });
      if (access.decision !== "allow") {
        if (access.reason === "profile_filesystem_denied") {
          throw new Error(`Path is denied by the active access profile: ${requestedFullPath}`);
        }
        if (access.reason === "outside_workspace") {
          const requester = (this.daemon as Any)?.requestApproval;
          if (typeof requester !== "function") {
            throw new Error(
              "External file access requires the approval system; the path must remain within workspace.",
            );
          }
          const approved =
            (await requester.call(
              this.daemon,
              this.taskId,
              "external_file_access",
              `Allow write access to external file: ${candidatePath}`,
              {
                path: candidatePath,
                operation: "write",
                tool: "edit_file",
              },
            )) === true;
          if (!approved) throw new Error("External file access was not approved.");
          externalApprovalGranted =
            typeof (this.daemon as Any)?.consumeExternalFileApproval === "function"
              ? (this.daemon as Any).consumeExternalFileApproval(
                  this.taskId,
                  candidatePath,
                  "write",
                ) === true
              : true;
          access = evaluateWorkspaceFilesystemAccess(this.workspace, requestedFullPath, "write", {
            externalApprovalGranted: true,
          });
        }
        if (access.decision !== "allow") {
          const detail =
            access.reason === "protected_path"
              ? " (the target must remain within workspace and cannot be an OS-protected path)"
              : "";
          throw new Error(`Write permission not granted: ${access.reason}${detail}`);
        }
      }
      const fullPath = access.path;

      // Enforce per-project access for `.cowork/projects/*`
      const relPosix = getWorkspaceRelativePosixPath(workspaceRoot, fullPath);
      if (relPosix !== null) {
        const projectId = getProjectIdFromWorkspaceRelPath(relPosix);
        if (projectId) {
          const taskGetter = (this.daemon as Any)?.getTask;
          const task =
            typeof taskGetter === "function" ? taskGetter.call(this.daemon, this.taskId) : null;
          const agentRoleId = task?.assignedAgentRoleId || null;
          const res = await checkProjectAccess({
            workspacePath: workspaceRoot,
            projectId,
            agentRoleId,
          });
          if (!res.allowed) {
            throw new Error(res.reason || `Access denied for project "${projectId}"`);
          }
        }
      }

      // Check file exists
      if (!fs.existsSync(fullPath)) {
        throw new Error(`File not found: ${file_path}`);
      }

      // Apply the same profile rule to the resolved symlink target. This
      // prevents an in-workspace link from bypassing an external deny rule.
      const realPath = fs.realpathSync(fullPath);
      const realAccess = evaluateWorkspaceFilesystemAccess(this.workspace, realPath, "write", {
        externalApprovalGranted,
      });
      if (realAccess.decision !== "allow") {
        if (realAccess.reason !== "profile_filesystem_denied") {
          throw new Error("File path resolves outside workspace");
        }
        throw new Error(`Path is denied by the active access profile: ${realPath}`);
      }

      // Read file
      const content = fs.readFileSync(fullPath, "utf-8");

      // Count occurrences
      const occurrences = this.countOccurrences(content, old_string);

      if (occurrences === 0) {
        throw new Error(
          `old_string not found in file. Make sure the string matches exactly (including whitespace and indentation).`,
        );
      }

      if (occurrences > 1 && !replace_all) {
        throw new Error(
          `old_string found ${occurrences} times in file. ` +
            `Use replace_all: true to replace all occurrences, or provide more context to make it unique.`,
        );
      }

      // Perform replacement
      let newContent: string;
      let replacements: number;

      if (replace_all) {
        newContent = content.split(old_string).join(new_string);
        replacements = occurrences;
      } else {
        // Replace only first occurrence (we already verified it's unique)
        const index = content.indexOf(old_string);
        newContent =
          content.substring(0, index) + new_string + content.substring(index + old_string.length);
        replacements = 1;
      }

      // Write file
      fs.writeFileSync(fullPath, newContent, "utf-8");

      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: "edit_file",
        result: {
          file_path,
          replacements,
          oldLength: old_string.length,
          newLength: new_string.length,
        },
      });

      // Emit file modified event with edit preview
      const oldPreview = old_string.length > 80 ? old_string.slice(0, 80) + "..." : old_string;
      const newPreview = new_string.length > 80 ? new_string.slice(0, 80) + "..." : new_string;
      const oldLineCount = old_string.split("\n").length;
      const newLineCount = new_string.split("\n").length;
      const netLines = newLineCount - oldLineCount;

      this.daemon.logEvent(this.taskId, "file_modified", {
        path: file_path,
        type: "edit",
        replacements,
        oldPreview,
        newPreview,
        netLines,
      });

      return {
        success: true,
        file_path,
        replacements,
      };
    } catch (error: Any) {
      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: "edit_file",
        error: error.message,
      });

      return {
        success: false,
        file_path,
        replacements: 0,
        error: error.message,
      };
    }
  }

  /**
   * Count occurrences of a string in content
   */
  private countOccurrences(content: string, searchString: string): number {
    let count = 0;
    let position = 0;

    while (true) {
      const index = content.indexOf(searchString, position);
      if (index === -1) break;
      count++;
      position = index + 1;
    }

    return count;
  }
}
