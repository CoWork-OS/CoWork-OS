import * as fs from "fs";
import * as path from "path";
import mime from "mime-types";
import { Workspace } from "../../../shared/types";
import { AgentDaemon } from "../daemon";
import { GoogleWorkspaceSettingsManager } from "../../settings/google-workspace-manager";
import { googleDriveRequest, googleDriveUpload } from "../../utils/google-workspace-api";

type GoogleDriveAction =
  | "get_current_user"
  | "list_files"
  | "get_file"
  | "create_folder"
  | "upload_file"
  | "delete_file";

interface GoogleDriveActionInput {
  action: GoogleDriveAction;
  query?: string;
  page_size?: number;
  page_token?: string;
  fields?: string;
  file_id?: string;
  parent_id?: string;
  name?: string;
  file_path?: string;
}

const DEFAULT_LIST_FIELDS =
  "nextPageToken, files(id,name,mimeType,modifiedTime,parents,webViewLink,size)";
const DEFAULT_FILE_FIELDS = "id,name,mimeType,modifiedTime,parents,webViewLink,size";

export class GoogleDriveTools {
  constructor(
    private workspace: Workspace,
    private daemon: AgentDaemon,
    private taskId: string,
  ) {}

  setWorkspace(workspace: Workspace): void {
    this.workspace = workspace;
  }

  static isEnabled(): boolean {
    return GoogleWorkspaceSettingsManager.loadSettings().enabled;
  }

  private async requireApproval(summary: string, details: Record<string, unknown>): Promise<void> {
    const approved = await this.daemon.requestApproval(
      this.taskId,
      "external_service",
      summary,
      details,
    );

    if (!approved) {
      throw new Error("User denied Google Drive action");
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

  async executeAction(input: GoogleDriveActionInput): Promise<Any> {
    const settings = GoogleWorkspaceSettingsManager.loadSettings();
    if (!settings.enabled) {
      throw new Error(
        "Google Workspace integration is disabled. Enable it in Settings > Integrations > Google Workspace.",
      );
    }

    const action = input.action;
    if (!action) {
      throw new Error('Missing required "action" parameter');
    }

    let result;

    switch (action) {
      case "get_current_user": {
        result = await googleDriveRequest(settings, {
          method: "GET",
          path: "/about",
          query: { fields: "user" },
        });
        break;
      }
      case "list_files": {
        const query = input.query || "trashed = false";
        result = await googleDriveRequest(settings, {
          method: "GET",
          path: "/files",
          query: {
            q: query,
            pageSize: input.page_size,
            pageToken: input.page_token,
            fields: input.fields || DEFAULT_LIST_FIELDS,
          },
        });
        break;
      }
      case "get_file": {
        if (!input.file_id) throw new Error("Missing file_id for get_file");
        result = await googleDriveRequest(settings, {
          method: "GET",
          path: `/files/${input.file_id}`,
          query: {
            fields: input.fields || DEFAULT_FILE_FIELDS,
          },
        });
        break;
      }
      case "create_folder": {
        if (!input.name) throw new Error("Missing name for create_folder");
        await this.requireApproval("Create a Google Drive folder", {
          action: "create_folder",
          parent_id: input.parent_id || "root",
          name: input.name,
        });
        result = await googleDriveRequest(settings, {
          method: "POST",
          path: "/files",
          query: { fields: DEFAULT_FILE_FIELDS },
          body: {
            name: input.name,
            mimeType: "application/vnd.google-apps.folder",
            parents: input.parent_id ? [input.parent_id] : undefined,
          },
        });
        break;
      }
      case "upload_file": {
        if (!input.file_path) throw new Error("Missing file_path for upload_file");
        const resolved = this.resolveFilePath(input.file_path);
        const data = fs.readFileSync(resolved);
        const fileName = input.name || path.basename(resolved);
        const contentType = (mime.lookup(fileName) || "application/octet-stream") as string;
        await this.requireApproval(`Upload file to Google Drive: ${fileName}`, {
          action: "upload_file",
          parent_id: input.parent_id || "root",
          file: fileName,
        });
        const created = await googleDriveRequest(settings, {
          method: "POST",
          path: "/files",
          query: { fields: DEFAULT_FILE_FIELDS },
          body: {
            name: fileName,
            parents: input.parent_id ? [input.parent_id] : undefined,
          },
        });
        const fileId = created.data?.id;
        if (!fileId) {
          throw new Error("Failed to create Google Drive file record");
        }
        const uploaded = await googleDriveUpload(settings, fileId, data, contentType);
        result = {
          status: uploaded.status,
          data: uploaded.data || created.data,
          raw: uploaded.raw,
        };
        break;
      }
      case "delete_file": {
        if (!input.file_id) throw new Error("Missing file_id for delete_file");
        await this.requireApproval("Delete a Google Drive file", {
          action: "delete_file",
          file_id: input.file_id,
        });
        result = await googleDriveRequest(settings, {
          method: "DELETE",
          path: `/files/${input.file_id}`,
        });
        break;
      }
      default:
        throw new Error(`Unsupported action: ${action}`);
    }

    this.daemon.logEvent(this.taskId, "tool_result", {
      tool: "google_drive_action",
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
