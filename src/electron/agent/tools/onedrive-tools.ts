import * as fs from "fs";
import * as path from "path";
import { Workspace } from "../../../shared/types";
import { AgentDaemon } from "../daemon";
import { OneDriveSettingsManager } from "../../settings/onedrive-manager";
import { onedriveRequest } from "../../utils/onedrive-api";
import {
  assertWorkspaceReadableFileAccessWithApproval,
  createWorkspaceFilesystemApprovalHandlers,
} from "../../security/access-profile-paths";

type OneDriveAction =
  | "get_drive"
  | "search"
  | "list_children"
  | "get_item"
  | "create_folder"
  | "upload_file"
  | "delete_item";

interface OneDriveActionInput {
  action: OneDriveAction;
  drive_id?: string;
  item_id?: string;
  query?: string;
  parent_id?: string;
  name?: string;
  conflict_behavior?: "rename" | "fail" | "replace";
  file_path?: string;
  remote_path?: string;
}

export class OneDriveTools {
  constructor(
    private workspace: Workspace,
    private daemon: AgentDaemon,
    private taskId: string,
  ) {}

  setWorkspace(workspace: Workspace): void {
    this.workspace = workspace;
  }

  static isEnabled(): boolean {
    return OneDriveSettingsManager.loadSettings().enabled;
  }

  private async requireApproval(summary: string, details: Record<string, unknown>): Promise<void> {
    const approved = await this.daemon.requestApproval(
      this.taskId,
      "external_service",
      summary,
      details,
    );

    if (!approved) {
      throw new Error("User denied OneDrive action");
    }
  }

  private async resolveFilePath(inputPath: string): Promise<string> {
    if (!this.workspace.permissions.read) {
      throw new Error("Read permission not granted for uploads");
    }
    try {
      return await assertWorkspaceReadableFileAccessWithApproval(
        this.workspace,
        inputPath,
        "OneDrive upload input",
        createWorkspaceFilesystemApprovalHandlers(this.daemon, this.taskId, "onedrive"),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("profile_filesystem_denied")) {
        throw new Error(`Path is denied by the active access profile: ${inputPath}`);
      }
      throw error;
    }
  }

  private getDrivePrefix(inputDriveId?: string): string {
    const settingsDriveId = OneDriveSettingsManager.loadSettings().driveId;
    const driveId = inputDriveId || settingsDriveId;
    return driveId ? `/drives/${driveId}` : "/me/drive";
  }

  async executeAction(input: OneDriveActionInput): Promise<Any> {
    const settings = OneDriveSettingsManager.loadSettings();
    if (!settings.enabled) {
      throw new Error(
        "OneDrive integration is disabled. Enable it in Settings > Integrations > OneDrive.",
      );
    }

    const action = input.action;
    if (!action) {
      throw new Error('Missing required "action" parameter');
    }

    let result;
    const drivePrefix = this.getDrivePrefix(input.drive_id);

    switch (action) {
      case "get_drive": {
        result = await onedriveRequest(settings, { method: "GET", path: drivePrefix });
        break;
      }
      case "search": {
        if (!input.query) throw new Error("Missing query for search");
        const escaped = input.query.replace(/'/g, "''");
        result = await onedriveRequest(settings, {
          method: "GET",
          path: `${drivePrefix}/root/search(q='${escaped}')`,
        });
        break;
      }
      case "list_children": {
        const pathSuffix = input.item_id ? `/items/${input.item_id}/children` : "/root/children";
        result = await onedriveRequest(settings, {
          method: "GET",
          path: `${drivePrefix}${pathSuffix}`,
        });
        break;
      }
      case "get_item": {
        if (!input.item_id) throw new Error("Missing item_id for get_item");
        result = await onedriveRequest(settings, {
          method: "GET",
          path: `${drivePrefix}/items/${input.item_id}`,
        });
        break;
      }
      case "create_folder": {
        if (!input.name) throw new Error("Missing name for create_folder");
        const parentPath = input.parent_id
          ? `/items/${input.parent_id}/children`
          : "/root/children";
        await this.requireApproval("Create a OneDrive folder", {
          action: "create_folder",
          parent_id: input.parent_id || "root",
          name: input.name,
        });
        result = await onedriveRequest(settings, {
          method: "POST",
          path: `${drivePrefix}${parentPath}`,
          body: {
            name: input.name,
            folder: {},
            "@microsoft.graph.conflictBehavior": input.conflict_behavior || "rename",
          },
        });
        break;
      }
      case "upload_file": {
        if (!input.file_path) throw new Error("Missing file_path for upload_file");
        const resolved = await this.resolveFilePath(input.file_path);
        const data = fs.readFileSync(resolved);
        const fileName = input.name || path.basename(resolved);
        let uploadPath: string;
        if (input.remote_path) {
          const cleaned = input.remote_path.replace(/^\/+/, "");
          const encoded = cleaned
            .split("/")
            .map((segment) => encodeURIComponent(segment))
            .join("/");
          uploadPath = `${drivePrefix}/root:/${encoded}:/content`;
        } else if (input.parent_id) {
          uploadPath = `${drivePrefix}/items/${input.parent_id}:/${encodeURIComponent(fileName)}:/content`;
        } else {
          uploadPath = `${drivePrefix}/root:/${encodeURIComponent(fileName)}:/content`;
        }
        await this.requireApproval(`Upload file to OneDrive: ${fileName}`, {
          action: "upload_file",
          destination: input.remote_path || input.parent_id || "root",
          file: fileName,
        });
        result = await onedriveRequest(settings, {
          method: "PUT",
          path: uploadPath,
          body: data,
          headers: { "Content-Type": "application/octet-stream" },
        });
        break;
      }
      case "delete_item": {
        if (!input.item_id) throw new Error("Missing item_id for delete_item");
        await this.requireApproval("Delete a OneDrive item", {
          action: "delete_item",
          item_id: input.item_id,
        });
        result = await onedriveRequest(settings, {
          method: "DELETE",
          path: `${drivePrefix}/items/${input.item_id}`,
        });
        break;
      }
      default:
        throw new Error(`Unsupported action: ${action}`);
    }

    this.daemon.logEvent(this.taskId, "tool_result", {
      tool: "onedrive_action",
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
