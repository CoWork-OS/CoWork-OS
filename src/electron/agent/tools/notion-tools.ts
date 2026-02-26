import { Workspace } from "../../../shared/types";
import { AgentDaemon } from "../daemon";
import { NotionSettingsManager } from "../../settings/notion-manager";
import { notionRequest } from "../../utils/notion-api";

type NotionAction =
  | "search"
  | "list_users"
  | "get_user"
  | "get_page"
  | "get_page_property"
  | "get_database"
  | "get_block"
  | "get_block_children"
  | "update_block"
  | "delete_block"
  | "create_page"
  | "update_page"
  | "append_blocks"
  | "query_data_source"
  | "get_data_source"
  | "create_data_source"
  | "update_data_source";

interface NotionActionInput {
  action: NotionAction;
  query?: string;
  user_id?: string;
  page_id?: string;
  property_id?: string;
  block_id?: string;
  block_type?: string;
  block?: Record<string, Any>;
  data_source_id?: string;
  database_id?: string;
  parent_page_id?: string;
  properties?: Record<string, Any>;
  children?: Any[];
  filter?: Any;
  sort?: Any;
  sorts?: Any[];
  start_cursor?: string;
  page_size?: number;
  archived?: boolean;
  icon?: Any;
  cover?: Any;
  title?: string;
  is_inline?: boolean;
  payload?: Record<string, Any>;
}

export class NotionTools {
  constructor(
    private workspace: Workspace,
    private daemon: AgentDaemon,
    private taskId: string,
  ) {}

  setWorkspace(workspace: Workspace): void {
    this.workspace = workspace;
  }

  static isEnabled(): boolean {
    return NotionSettingsManager.loadSettings().enabled;
  }

  private async requireApproval(summary: string, details: Record<string, unknown>): Promise<void> {
    const approved = await this.daemon.requestApproval(
      this.taskId,
      "external_service",
      summary,
      details,
    );

    if (!approved) {
      throw new Error("User denied Notion action");
    }
  }

  private buildPagination(input: NotionActionInput): Record<string, Any> {
    const body: Record<string, Any> = {};
    if (input.start_cursor) body.start_cursor = input.start_cursor;
    if (typeof input.page_size === "number") body.page_size = input.page_size;
    return body;
  }

  private buildTitle(title?: string): Array<{ text: { content: string } }> | undefined {
    if (!title) return undefined;
    const trimmed = title.trim();
    if (!trimmed) return undefined;
    return [{ text: { content: trimmed } }];
  }

  private buildParent(input: NotionActionInput): Record<string, string> {
    if (input.database_id) {
      return { database_id: input.database_id };
    }
    if (input.parent_page_id) {
      return { page_id: input.parent_page_id };
    }
    throw new Error("Missing parent identifier (database_id or parent_page_id)");
  }

  async executeAction(input: NotionActionInput): Promise<Any> {
    const settings = NotionSettingsManager.loadSettings();
    if (!settings.enabled) {
      throw new Error(
        "Notion integration is disabled. Enable it in Settings > Integrations > Notion.",
      );
    }

    const action = input.action;
    if (!action) {
      throw new Error('Missing required "action" parameter');
    }

    let result;

    switch (action) {
      case "search": {
        const body = input.payload ? { ...input.payload } : {};
        if (!input.payload) {
          if (input.query) body.query = input.query;
          if (input.filter) body.filter = input.filter;
          if (input.sort) body.sort = input.sort;
          else if (input.sorts) body.sort = input.sorts;
          Object.assign(body, this.buildPagination(input));
        }
        result = await notionRequest(settings, { method: "POST", path: "/search", body });
        break;
      }
      case "list_users": {
        const params = new URLSearchParams();
        if (input.start_cursor) params.set("start_cursor", input.start_cursor);
        if (typeof input.page_size === "number") params.set("page_size", String(input.page_size));
        const suffix = params.toString() ? `?${params.toString()}` : "";
        result = await notionRequest(settings, { method: "GET", path: `/users${suffix}` });
        break;
      }
      case "get_user": {
        if (!input.user_id) throw new Error("Missing user_id for get_user");
        result = await notionRequest(settings, { method: "GET", path: `/users/${input.user_id}` });
        break;
      }
      case "get_page": {
        if (!input.page_id) throw new Error("Missing page_id for get_page");
        result = await notionRequest(settings, { method: "GET", path: `/pages/${input.page_id}` });
        break;
      }
      case "get_page_property": {
        if (!input.page_id) throw new Error("Missing page_id for get_page_property");
        if (!input.property_id) throw new Error("Missing property_id for get_page_property");
        const params = new URLSearchParams();
        if (input.start_cursor) params.set("start_cursor", input.start_cursor);
        if (typeof input.page_size === "number") params.set("page_size", String(input.page_size));
        const suffix = params.toString() ? `?${params.toString()}` : "";
        result = await notionRequest(settings, {
          method: "GET",
          path: `/pages/${input.page_id}/properties/${input.property_id}${suffix}`,
        });
        break;
      }
      case "get_database": {
        if (!input.database_id) throw new Error("Missing database_id for get_database");
        result = await notionRequest(settings, {
          method: "GET",
          path: `/databases/${input.database_id}`,
        });
        break;
      }
      case "get_block": {
        if (!input.block_id) throw new Error("Missing block_id for get_block");
        result = await notionRequest(settings, {
          method: "GET",
          path: `/blocks/${input.block_id}`,
        });
        break;
      }
      case "get_block_children": {
        if (!input.block_id) throw new Error("Missing block_id for get_block_children");
        const params = new URLSearchParams();
        if (input.start_cursor) params.set("start_cursor", input.start_cursor);
        if (typeof input.page_size === "number") params.set("page_size", String(input.page_size));
        const suffix = params.toString() ? `?${params.toString()}` : "";
        result = await notionRequest(settings, {
          method: "GET",
          path: `/blocks/${input.block_id}/children${suffix}`,
        });
        break;
      }
      case "update_block": {
        if (!input.block_id) throw new Error("Missing block_id for update_block");
        const body = input.payload ? { ...input.payload } : {};
        if (!input.payload) {
          if (typeof input.archived === "boolean") body.archived = input.archived;
          if (input.block_type && input.block) {
            body[input.block_type] = input.block;
          }
          if (Object.keys(body).length === 0) {
            throw new Error("Missing update payload (archived or block content)");
          }
        }
        await this.requireApproval("Update a Notion block", {
          action: "update_block",
          block_id: input.block_id,
        });
        result = await notionRequest(settings, {
          method: "PATCH",
          path: `/blocks/${input.block_id}`,
          body,
        });
        break;
      }
      case "delete_block": {
        if (!input.block_id) throw new Error("Missing block_id for delete_block");
        await this.requireApproval("Delete a Notion block", {
          action: "delete_block",
          block_id: input.block_id,
        });
        result = await notionRequest(settings, {
          method: "DELETE",
          path: `/blocks/${input.block_id}`,
        });
        break;
      }
      case "get_data_source": {
        if (!input.data_source_id) throw new Error("Missing data_source_id for get_data_source");
        result = await notionRequest(settings, {
          method: "GET",
          path: `/data_sources/${input.data_source_id}`,
        });
        break;
      }
      case "query_data_source": {
        if (!input.data_source_id) throw new Error("Missing data_source_id for query_data_source");
        const body = input.payload ? { ...input.payload } : {};
        if (!input.payload) {
          if (input.filter) body.filter = input.filter;
          if (input.sorts) body.sorts = input.sorts;
          Object.assign(body, this.buildPagination(input));
        }
        result = await notionRequest(settings, {
          method: "POST",
          path: `/data_sources/${input.data_source_id}/query`,
          body,
        });
        break;
      }
      case "create_page": {
        const body = input.payload ? { ...input.payload } : {};
        if (!input.payload) {
          body.parent = this.buildParent(input);
          if (!input.properties) throw new Error("Missing properties for create_page");
          body.properties = input.properties;
          if (input.children) body.children = input.children;
          if (input.icon) body.icon = input.icon;
          if (input.cover) body.cover = input.cover;
        }
        await this.requireApproval("Create a Notion page", {
          action: "create_page",
          parent: body.parent,
        });
        result = await notionRequest(settings, { method: "POST", path: "/pages", body });
        break;
      }
      case "update_page": {
        if (!input.page_id) throw new Error("Missing page_id for update_page");
        const body = input.payload ? { ...input.payload } : {};
        if (!input.payload) {
          if (input.properties) body.properties = input.properties;
          if (typeof input.archived === "boolean") body.archived = input.archived;
          if (input.icon) body.icon = input.icon;
          if (input.cover) body.cover = input.cover;
          if (Object.keys(body).length === 0) {
            throw new Error("Missing update payload (properties, archived, icon, or cover)");
          }
        }
        await this.requireApproval("Update a Notion page", {
          action: "update_page",
          page_id: input.page_id,
        });
        result = await notionRequest(settings, {
          method: "PATCH",
          path: `/pages/${input.page_id}`,
          body,
        });
        break;
      }
      case "append_blocks": {
        if (!input.block_id) throw new Error("Missing block_id for append_blocks");
        const body = input.payload ? { ...input.payload } : {};
        if (!input.payload) {
          if (!input.children || input.children.length === 0) {
            throw new Error("Missing children for append_blocks");
          }
          body.children = input.children;
        }
        await this.requireApproval("Append blocks in Notion", {
          action: "append_blocks",
          block_id: input.block_id,
          count: Array.isArray(body.children) ? body.children.length : undefined,
        });
        result = await notionRequest(settings, {
          method: "PATCH",
          path: `/blocks/${input.block_id}/children`,
          body,
        });
        break;
      }
      case "create_data_source": {
        const body = input.payload ? { ...input.payload } : {};
        if (!input.payload) {
          if (!input.parent_page_id)
            throw new Error("Missing parent_page_id for create_data_source");
          if (!input.properties) throw new Error("Missing properties for create_data_source");
          const title = this.buildTitle(input.title);
          if (!title) throw new Error("Missing title for create_data_source");
          body.parent = { page_id: input.parent_page_id };
          body.title = title;
          body.properties = input.properties;
          if (typeof input.is_inline === "boolean") body.is_inline = input.is_inline;
        }
        await this.requireApproval("Create a Notion data source", {
          action: "create_data_source",
          parent: body.parent,
        });
        result = await notionRequest(settings, { method: "POST", path: "/data_sources", body });
        break;
      }
      case "update_data_source": {
        if (!input.data_source_id) throw new Error("Missing data_source_id for update_data_source");
        const body = input.payload ? { ...input.payload } : {};
        if (!input.payload) {
          if (input.properties) body.properties = input.properties;
          const title = this.buildTitle(input.title);
          if (title) body.title = title;
          if (Object.keys(body).length === 0) {
            throw new Error("Missing update payload (properties or title)");
          }
        }
        await this.requireApproval("Update a Notion data source", {
          action: "update_data_source",
          data_source_id: input.data_source_id,
        });
        result = await notionRequest(settings, {
          method: "PATCH",
          path: `/data_sources/${input.data_source_id}`,
          body,
        });
        break;
      }
      default:
        throw new Error(`Unsupported action: ${action}`);
    }

    this.daemon.logEvent(this.taskId, "tool_result", {
      tool: "notion_action",
      action,
      status: result?.status,
      hasData: !!result?.data,
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
