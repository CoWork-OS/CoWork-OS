import * as fs from "fs";
import * as path from "path";
import { Workspace } from "../../../shared/types";
import { AgentDaemon } from "../daemon";
import { SharePointSettingsManager } from "../../settings/sharepoint-manager";
import { sharepointRequest } from "../../utils/sharepoint-api";

type SharePointAction =
  | "get_current_user"
  | "search_sites"
  | "get_site"
  | "list_site_drives"
  | "list_drive_items"
  | "get_item"
  | "create_folder"
  | "upload_file"
  | "delete_item";

interface SharePointActionInput {
  action: SharePointAction;
  site_id?: string;
  drive_id?: string;
  item_id?: string;
  query?: string;
  parent_id?: string;
  name?: string;
  conflict_behavior?: "rename" | "fail" | "replace";
  file_path?: string;
  remote_path?: string;
}

export class SharePointTools {
  constructor(
    private workspace: Workspace,
    private daemon: AgentDaemon,
    private taskId: string,
  ) {}

  setWorkspace(workspace: Workspace): void {
    this.workspace = workspace;
  }

  static isEnabled(): boolean {
    return SharePointSettingsManager.loadSettings().enabled;
  }

  private async requireApproval(summary: string, details: Record<string, unknown>): Promise<void> {
    const approved = await this.daemon.requestApproval(
      this.taskId,
      "external_service",
      summary,
      details,
    );

    if (!approved) {
      throw new Error("User denied SharePoint action");
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

  private getSiteId(inputSiteId?: string): string {
    const settings = SharePointSettingsManager.loadSettings();
    const siteId = inputSiteId || settings.siteId;
    if (!siteId) {
      throw new Error("Missing site_id. Provide it in settings or the tool input.");
    }
    return siteId;
  }

  private getDriveId(inputDriveId?: string): string {
    const settings = SharePointSettingsManager.loadSettings();
    const driveId = inputDriveId || settings.driveId;
    if (!driveId) {
      throw new Error("Missing drive_id. Provide it in settings or the tool input.");
    }
    return driveId;
  }

  async executeAction(input: SharePointActionInput): Promise<Any> {
    const settings = SharePointSettingsManager.loadSettings();
    if (!settings.enabled) {
      throw new Error(
        "SharePoint integration is disabled. Enable it in Settings > Integrations > SharePoint.",
      );
    }

    const action = input.action;
    if (!action) {
      throw new Error('Missing required "action" parameter');
    }

    let result;

    switch (action) {
      case "get_current_user": {
        result = await sharepointRequest(settings, { method: "GET", path: "/me" });
        break;
      }
      case "search_sites": {
        if (!input.query) throw new Error("Missing query for search_sites");
        result = await sharepointRequest(settings, {
          method: "GET",
          path: "/sites",
          query: { search: input.query },
        });
        break;
      }
      case "get_site": {
        const siteId = this.getSiteId(input.site_id);
        result = await sharepointRequest(settings, { method: "GET", path: `/sites/${siteId}` });
        break;
      }
      case "list_site_drives": {
        const siteId = this.getSiteId(input.site_id);
        result = await sharepointRequest(settings, {
          method: "GET",
          path: `/sites/${siteId}/drives`,
        });
        break;
      }
      case "list_drive_items": {
        const driveId = this.getDriveId(input.drive_id);
        const pathSuffix = input.item_id ? `/items/${input.item_id}/children` : "/root/children";
        result = await sharepointRequest(settings, {
          method: "GET",
          path: `/drives/${driveId}${pathSuffix}`,
        });
        break;
      }
      case "get_item": {
        if (!input.item_id) throw new Error("Missing item_id for get_item");
        const driveId = this.getDriveId(input.drive_id);
        result = await sharepointRequest(settings, {
          method: "GET",
          path: `/drives/${driveId}/items/${input.item_id}`,
        });
        break;
      }
      case "create_folder": {
        if (!input.name) throw new Error("Missing name for create_folder");
        const driveId = this.getDriveId(input.drive_id);
        const parentPath = input.parent_id
          ? `/items/${input.parent_id}/children`
          : "/root/children";
        await this.requireApproval("Create a SharePoint folder", {
          action: "create_folder",
          parent_id: input.parent_id || "root",
          name: input.name,
        });
        result = await sharepointRequest(settings, {
          method: "POST",
          path: `/drives/${driveId}${parentPath}`,
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
        const driveId = this.getDriveId(input.drive_id);
        const resolved = this.resolveFilePath(input.file_path);
        const data = fs.readFileSync(resolved);
        const fileName = input.name || path.basename(resolved);
        let uploadPath: string;
        if (input.remote_path) {
          const cleaned = input.remote_path.replace(/^\/+/, "");
          const encoded = cleaned
            .split("/")
            .map((segment) => encodeURIComponent(segment))
            .join("/");
          uploadPath = `/drives/${driveId}/root:/${encoded}:/content`;
        } else if (input.parent_id) {
          uploadPath = `/drives/${driveId}/items/${input.parent_id}:/${encodeURIComponent(fileName)}:/content`;
        } else {
          uploadPath = `/drives/${driveId}/root:/${encodeURIComponent(fileName)}:/content`;
        }
        await this.requireApproval(`Upload file to SharePoint: ${fileName}`, {
          action: "upload_file",
          destination: input.remote_path || input.parent_id || "root",
          file: fileName,
        });
        result = await sharepointRequest(settings, {
          method: "PUT",
          path: uploadPath,
          body: data,
          headers: { "Content-Type": "application/octet-stream" },
        });
        break;
      }
      case "delete_item": {
        if (!input.item_id) throw new Error("Missing item_id for delete_item");
        const driveId = this.getDriveId(input.drive_id);
        await this.requireApproval("Delete a SharePoint item", {
          action: "delete_item",
          item_id: input.item_id,
        });
        result = await sharepointRequest(settings, {
          method: "DELETE",
          path: `/drives/${driveId}/items/${input.item_id}`,
        });
        break;
      }
      default:
        throw new Error(`Unsupported action: ${action}`);
    }

    this.daemon.logEvent(this.taskId, "tool_result", {
      tool: "sharepoint_action",
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
