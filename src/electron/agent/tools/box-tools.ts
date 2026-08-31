import * as fs from "fs";
import * as path from "path";
import { Workspace } from "../../../shared/types";
import { AgentDaemon } from "../daemon";
import { BoxSettingsManager } from "../../settings/box-manager";
import { boxRequest, boxUploadFile } from "../../utils/box-api";
import {
  assertWorkspaceReadableFileAccessWithApproval,
  createWorkspaceFilesystemApprovalHandlers,
} from "../../security/access-profile-paths";

type BoxAction =
  | "get_current_user"
  | "search"
  | "get_file"
  | "get_folder"
  | "list_folder_items"
  | "create_folder"
  | "delete_file"
  | "delete_folder"
  | "upload_file";

interface BoxActionInput {
  action: BoxAction;
  query?: string;
  limit?: number;
  maxResults?: number;
  offset?: number;
  use_marker?: boolean;
  marker?: string;
  fields?: string;
  type?: "file" | "folder" | "web_link";
  ancestor_folder_ids?: string;
  file_extensions?: string;
  content_types?: string;
  scope?: string;
  folder_id?: string;
  file_id?: string;
  parent_id?: string;
  name?: string;
  file_path?: string;
  include_raw?: boolean;
}

const DEFAULT_FOLDER_ID = "0";

export class BoxTools {
  constructor(
    private workspace: Workspace,
    private daemon: AgentDaemon,
    private taskId: string,
  ) {}

  setWorkspace(workspace: Workspace): void {
    this.workspace = workspace;
  }

  static isEnabled(): boolean {
    return BoxSettingsManager.loadSettings().enabled;
  }

  private async requireApproval(summary: string, details: Record<string, unknown>): Promise<void> {
    const approved = await this.daemon.requestApproval(
      this.taskId,
      "external_service",
      summary,
      details,
    );

    if (!approved) {
      throw new Error("User denied Box action");
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
        "Box upload input",
        createWorkspaceFilesystemApprovalHandlers(this.daemon, this.taskId, "box"),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("profile_filesystem_denied")) {
        throw new Error(`Path is denied by the active access profile: ${inputPath}`);
      }
      throw error;
    }
  }

  async executeAction(input: BoxActionInput): Promise<Any> {
    const settings = BoxSettingsManager.loadSettings();
    if (!settings.enabled) {
      throw new Error("Box integration is disabled. Enable it in Settings > Integrations > Box.");
    }

    const action = input.action;
    if (!action) {
      throw new Error('Missing required "action" parameter');
    }

    let result;

    switch (action) {
      case "get_current_user": {
        result = await boxRequest(settings, { method: "GET", path: "/users/me" });
        break;
      }
      case "search": {
        if (!input.query) throw new Error("Missing query for search");
        result = await boxRequest(settings, {
          method: "GET",
          path: "/search",
          query: {
            query: input.query,
            limit: input.limit ?? input.maxResults,
            offset: input.offset,
            fields: input.fields,
            type: input.type,
            ancestor_folder_ids: input.ancestor_folder_ids,
            file_extensions: input.file_extensions,
            content_types: input.content_types,
            scope: input.scope,
          },
        });
        break;
      }
      case "get_file": {
        if (!input.file_id) throw new Error("Missing file_id for get_file");
        result = await boxRequest(settings, {
          method: "GET",
          path: `/files/${input.file_id}`,
          query: input.fields ? { fields: input.fields } : undefined,
        });
        break;
      }
      case "get_folder": {
        if (!input.folder_id) throw new Error("Missing folder_id for get_folder");
        result = await boxRequest(settings, {
          method: "GET",
          path: `/folders/${input.folder_id}`,
          query: input.fields ? { fields: input.fields } : undefined,
        });
        break;
      }
      case "list_folder_items": {
        const folderId = input.folder_id || DEFAULT_FOLDER_ID;
        result = await boxRequest(settings, {
          method: "GET",
          path: `/folders/${folderId}/items`,
          query: {
            limit: input.limit ?? input.maxResults,
            offset: input.offset,
            usemarker: input.use_marker,
            marker: input.marker,
            fields: input.fields,
          },
        });
        break;
      }
      case "create_folder": {
        if (!input.name) throw new Error("Missing name for create_folder");
        const parentId = input.parent_id || DEFAULT_FOLDER_ID;
        await this.requireApproval("Create a Box folder", {
          action: "create_folder",
          parent_id: parentId,
          name: input.name,
        });
        result = await boxRequest(settings, {
          method: "POST",
          path: "/folders",
          body: {
            name: input.name,
            parent: { id: parentId },
          },
        });
        break;
      }
      case "delete_file": {
        if (!input.file_id) throw new Error("Missing file_id for delete_file");
        await this.requireApproval("Delete a Box file", {
          action: "delete_file",
          file_id: input.file_id,
        });
        result = await boxRequest(settings, { method: "DELETE", path: `/files/${input.file_id}` });
        break;
      }
      case "delete_folder": {
        if (!input.folder_id) throw new Error("Missing folder_id for delete_folder");
        await this.requireApproval("Delete a Box folder", {
          action: "delete_folder",
          folder_id: input.folder_id,
        });
        result = await boxRequest(settings, {
          method: "DELETE",
          path: `/folders/${input.folder_id}`,
        });
        break;
      }
      case "upload_file": {
        if (!input.file_path) throw new Error("Missing file_path for upload_file");
        const parentId = input.parent_id || DEFAULT_FOLDER_ID;
        const resolved = await this.resolveFilePath(input.file_path);
        const data = fs.readFileSync(resolved);
        const fileName = input.name || path.basename(resolved);
        await this.requireApproval(`Upload file to Box: ${fileName}`, {
          action: "upload_file",
          parent_id: parentId,
          file: fileName,
        });
        result = await boxUploadFile(settings, {
          fileName,
          parentId,
          data,
        });
        break;
      }
      default:
        throw new Error(`Unsupported action: ${action}`);
    }

    this.daemon.logEvent(this.taskId, "tool_result", {
      tool: "box_action",
      action,
      status: result?.status,
      hasData: result?.data ? true : false,
    });

    return {
      success: true,
      action,
      status: result?.status,
      data: result?.data,
      raw: input.include_raw ? result?.raw : undefined,
    };
  }
}
