import * as fs from "fs";
import * as path from "path";
import { Workspace } from "../../../shared/types";
import { AgentDaemon } from "../daemon";
import { DropboxSettingsManager } from "../../settings/dropbox-manager";
import { dropboxRequest, dropboxContentUpload } from "../../utils/dropbox-api";

type DropboxAction =
  | "get_current_user"
  | "list_folder"
  | "list_folder_continue"
  | "search"
  | "get_metadata"
  | "create_folder"
  | "delete_item"
  | "upload_file";

interface DropboxActionInput {
  action: DropboxAction;
  path?: string;
  query?: string;
  limit?: number;
  cursor?: string;
  name?: string;
  parent_path?: string;
  file_path?: string;
}

export class DropboxTools {
  constructor(
    private workspace: Workspace,
    private daemon: AgentDaemon,
    private taskId: string,
  ) {}

  setWorkspace(workspace: Workspace): void {
    this.workspace = workspace;
  }

  static isEnabled(): boolean {
    return DropboxSettingsManager.loadSettings().enabled;
  }

  private async requireApproval(summary: string, details: Record<string, unknown>): Promise<void> {
    const approved = await this.daemon.requestApproval(
      this.taskId,
      "external_service",
      summary,
      details,
    );

    if (!approved) {
      throw new Error("User denied Dropbox action");
    }
  }

  private resolveFilePath(inputPath: string): string {
    if (!this.workspace.permissions.read) {
      throw new Error("Read permission not granted for uploads");
    }

    const workspaceRoot = path.resolve(this.workspace.path);
    const allowedPaths = this.workspace.permissions.allowedPaths || [];
    const canReadOutside =
      this.workspace.isTemp || this.workspace.permissions.unrestrictedFileAccess;

    const isPathAllowed = (absolutePath: string): boolean => {
      if (allowedPaths.length === 0) return false;
      const normalizedPath = path.normalize(absolutePath);
      return allowedPaths.some((allowed) => {
        const normalizedAllowed = path.normalize(allowed);
        return (
          normalizedPath === normalizedAllowed ||
          normalizedPath.startsWith(normalizedAllowed + path.sep)
        );
      });
    };

    const candidate = path.isAbsolute(inputPath)
      ? path.normalize(inputPath)
      : path.resolve(workspaceRoot, inputPath);

    const relative = path.relative(workspaceRoot, candidate);
    const isInsideWorkspace = !(relative.startsWith("..") || path.isAbsolute(relative));
    if (!isInsideWorkspace && !canReadOutside && !isPathAllowed(candidate)) {
      throw new Error("File path must be inside the workspace or in Allowed Paths");
    }
    if (!fs.existsSync(candidate)) {
      throw new Error(`File not found: ${inputPath}`);
    }
    const stats = fs.statSync(candidate);
    if (!stats.isFile()) {
      throw new Error(`Path is not a file: ${inputPath}`);
    }
    return candidate;
  }

  private normalizeDropboxPath(pathValue: string): string {
    const trimmed = pathValue.trim();
    if (!trimmed) return "";
    return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  }

  async executeAction(input: DropboxActionInput): Promise<Any> {
    const settings = DropboxSettingsManager.loadSettings();
    if (!settings.enabled) {
      throw new Error(
        "Dropbox integration is disabled. Enable it in Settings > Integrations > Dropbox.",
      );
    }

    const action = input.action;
    if (!action) {
      throw new Error('Missing required "action" parameter');
    }

    let result;

    switch (action) {
      case "get_current_user": {
        result = await dropboxRequest(settings, {
          method: "POST",
          path: "/users/get_current_account",
        });
        break;
      }
      case "list_folder": {
        const pathValue = input.path ? this.normalizeDropboxPath(input.path) : "";
        result = await dropboxRequest(settings, {
          method: "POST",
          path: "/files/list_folder",
          body: {
            path: pathValue,
            recursive: false,
            include_deleted: false,
            include_has_explicit_shared_members: false,
            include_mounted_folders: true,
            limit: input.limit,
          },
        });
        break;
      }
      case "list_folder_continue": {
        if (!input.cursor) throw new Error("Missing cursor for list_folder_continue");
        result = await dropboxRequest(settings, {
          method: "POST",
          path: "/files/list_folder/continue",
          body: { cursor: input.cursor },
        });
        break;
      }
      case "search": {
        if (!input.query) throw new Error("Missing query for search");
        result = await dropboxRequest(settings, {
          method: "POST",
          path: "/files/search_v2",
          body: {
            query: input.query,
            options: {
              path: input.path ? this.normalizeDropboxPath(input.path) : undefined,
              max_results: input.limit,
            },
          },
        });
        break;
      }
      case "get_metadata": {
        if (!input.path) throw new Error("Missing path for get_metadata");
        result = await dropboxRequest(settings, {
          method: "POST",
          path: "/files/get_metadata",
          body: {
            path: this.normalizeDropboxPath(input.path),
            include_media_info: false,
            include_deleted: false,
            include_has_explicit_shared_members: false,
          },
        });
        break;
      }
      case "create_folder": {
        if (!input.path) throw new Error("Missing path for create_folder");
        const folderPath = this.normalizeDropboxPath(input.path);
        await this.requireApproval("Create a Dropbox folder", {
          action: "create_folder",
          path: folderPath,
        });
        result = await dropboxRequest(settings, {
          method: "POST",
          path: "/files/create_folder_v2",
          body: {
            path: folderPath,
            autorename: true,
          },
        });
        break;
      }
      case "delete_item": {
        if (!input.path) throw new Error("Missing path for delete_item");
        const deletePath = this.normalizeDropboxPath(input.path);
        await this.requireApproval("Delete a Dropbox item", {
          action: "delete_item",
          path: deletePath,
        });
        result = await dropboxRequest(settings, {
          method: "POST",
          path: "/files/delete_v2",
          body: { path: deletePath },
        });
        break;
      }
      case "upload_file": {
        if (!input.file_path) throw new Error("Missing file_path for upload_file");
        const resolved = this.resolveFilePath(input.file_path);
        const data = fs.readFileSync(resolved);
        const fileName = input.name || path.basename(resolved);
        const targetPath = input.path
          ? this.normalizeDropboxPath(input.path)
          : this.normalizeDropboxPath(`${input.parent_path || ""}/${fileName}`);
        await this.requireApproval(`Upload file to Dropbox: ${fileName}`, {
          action: "upload_file",
          path: targetPath,
        });
        result = await dropboxContentUpload(settings, { path: targetPath, data });
        break;
      }
      default:
        throw new Error(`Unsupported action: ${action}`);
    }

    this.daemon.logEvent(this.taskId, "tool_result", {
      tool: "dropbox_action",
      action,
      status: result?.status,
      hasData: result?.data ? true : false,
    });

    return {
      success: true,
      action,
      status: result?.status,
      data: result?.data,
      raw: result?.raw,
    };
  }
}
