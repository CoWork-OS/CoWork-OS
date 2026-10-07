import { WorkspaceArtifactEvidenceInspector } from "../../sessions/WorkspaceArtifactEvidenceInspector";
import { enforceResponsibilityToolPolicy } from "../../automation/responsibility-task-policy";
import { credentialFingerprint, isProvenOAuthRefresh } from "../../security/oauth-refresh-proof";
import { snapshotToolInput } from "./tool-input-snapshot";
import type { MCPAuthConfig } from "../../mcp/types";
import * as path from "path";
import { BoxSettingsData, Workspace } from "../../../shared/types";
import { AgentDaemon } from "../daemon";
import { BoxSettingsManager } from "../../settings/box-manager";
import { boxRequest, boxUploadFile } from "../../utils/box-api";
import {
  assertWorkspaceReadableFileAccessWithApproval,
  createWorkspaceFilesystemApprovalHandlers,
} from "../../security/access-profile-paths";
import { createIntegrationEffectGuard, integrationEffectReview } from "./integration-effect-guard";

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

  private createActionEffectGuard(
    initialSettings: BoxSettingsData,
    input: BoxActionInput,
    details: Record<string, unknown>,
  ) {
    const credential = (settings: BoxSettingsData): MCPAuthConfig => ({
      type: "bearer",
      token: settings.accessToken,
      refreshToken: settings.refreshToken,
      clientId: settings.clientId,
      clientSecret: settings.clientSecret,
      tokenUrl: settings.refreshToken ? "https://api.box.com/oauth2/token" : undefined,
      expiresAt: settings.tokenExpiresAt,
    });
    return createIntegrationEffectGuard({
      daemon: this.daemon,
      taskId: this.taskId,
      workspace: this.workspace,
      getWorkspace: () => this.workspace,
      toolName: "box_action",
      toolInput: input,
      approvalDetails: details,
      initialSettings,
      loadSettings: () => BoxSettingsManager.loadSettings(),
      settingsEnabled: (current) =>
        current.enabled && Boolean(current.accessToken || current.refreshToken),
      settingsFingerprint: (current) =>
        JSON.stringify({
          enabled: current.enabled,
          scopes: current.scopes ? [...current.scopes].sort() : undefined,
          mcpEnabled: current.mcpEnabled,
          timeoutMs: current.timeoutMs,
        }),
      authConfig: credential,
      errorPrefix: "Box action",
    });
  }

  async executeAction(input: BoxActionInput): Promise<Any> {
    input = snapshotToolInput(input);
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
        const details = integrationEffectReview("box_action", input, "create_folder", {
          parent_id: parentId,
          name: input.name,
        });
        const beforeSend = await this.createActionEffectGuard(settings, input, details);
        await this.requireApproval("Create a Box folder", details);
        result = await boxRequest(settings, {
          method: "POST",
          path: "/folders",
          beforeSend,
          body: {
            name: input.name,
            parent: { id: parentId },
          },
        });
        break;
      }
      case "delete_file": {
        if (!input.file_id) throw new Error("Missing file_id for delete_file");
        const details = integrationEffectReview("box_action", input, "delete_file", {
          file_id: input.file_id,
        });
        const beforeSend = await this.createActionEffectGuard(settings, input, details);
        await this.requireApproval("Delete a Box file", details);
        result = await boxRequest(settings, {
          method: "DELETE",
          path: `/files/${input.file_id}`,
          beforeSend,
        });
        break;
      }
      case "delete_folder": {
        if (!input.folder_id) throw new Error("Missing folder_id for delete_folder");
        const details = integrationEffectReview("box_action", input, "delete_folder", {
          folder_id: input.folder_id,
        });
        const beforeSend = await this.createActionEffectGuard(settings, input, details);
        await this.requireApproval("Delete a Box folder", details);
        result = await boxRequest(settings, {
          method: "DELETE",
          path: `/folders/${input.folder_id}`,
          beforeSend,
        });
        break;
      }
      case "upload_file": {
        if (!input.file_path) throw new Error("Missing file_path for upload_file");
        const parentId = input.parent_id || DEFAULT_FOLDER_ID;
        const resolved = await this.resolveFilePath(input.file_path);
        const snapshot = new WorkspaceArtifactEvidenceInspector({
          maxBytes: 4 * 1024 * 1024,
        }).snapshot(this.workspace, resolved);
        if (snapshot.status !== "present" || !snapshot.data)
          throw new Error("Box upload draft cannot be captured for review");
        const data = snapshot.data;
        const details = {
          tool: "box_action",
          params: input,
          action: "upload_file",
          parent_id: parentId,
          reviewFiles: [resolved],
          expectedDraftRevisions: [
            { reference: resolved, sha256: snapshot.sha256, size: snapshot.size },
          ],
        };
        const scope = (workspace: Workspace) =>
          JSON.stringify({
            id: workspace.id,
            path: workspace.path,
            permissions: workspace.permissions,
          });
        const admittedScope = scope(this.workspace);
        const authority = await this.daemon.getToolEffectAuthority(this.taskId, details);
        if (!authority) throw new Error("Box upload authority unavailable");
        const credential = (value: typeof settings): MCPAuthConfig => ({
          type: "bearer",
          token: value.accessToken,
          refreshToken: value.refreshToken,
          clientId: value.clientId,
          clientSecret: value.clientSecret,
          tokenUrl: value.refreshToken ? "https://api.box.com/oauth2/token" : undefined,
          expiresAt: value.tokenExpiresAt,
        });
        const admittedCredential = credential(settings);
        const beforeSend = async () => {
          const check = () => {
            const effective = this.daemon.getEffectiveWorkspaceForTask(this.taskId);
            const current = BoxSettingsManager.loadSettings();
            const auth = credential(current);
            if (
              !effective ||
              scope(effective) !== admittedScope ||
              scope(this.workspace) !== admittedScope ||
              !current.enabled ||
              (credentialFingerprint(auth) !== credentialFingerprint(admittedCredential) &&
                !isProvenOAuthRefresh(admittedCredential, auth))
            )
              throw new Error("Box upload authority changed before send");
          };
          check();
          await enforceResponsibilityToolPolicy(
            this.daemon.getDatabase(),
            this.taskId,
            this.workspace.id,
            this.workspace.path,
            "box_action",
            input,
          );
          check();
          if ((await this.daemon.getToolEffectAuthority(this.taskId, details)) !== authority)
            throw new Error("Box upload task authority changed before send");
          check();
        };
        const fileName = input.name || path.basename(resolved);
        await this.requireApproval(`Upload file to Box: ${fileName}`, {
          ...details,
          file: fileName,
        });
        result = await boxUploadFile(settings, {
          fileName,
          parentId,
          data,
          beforeSend,
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
