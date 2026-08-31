/**
 * Connector Service
 *
 * Thin adapter for external service integrations (GitHub, Notion).
 * Strategy: use the native/direct path first, then fall back to MCP only when
 * the direct path is unavailable or fails.
 *
 * This keeps the door open for MCP-based connectors while providing
 * a reliable direct fallback when MCP is unavailable.
 */

export interface ConnectorResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  /** Whether the result came from an MCP tool or a direct API call */
  source: "mcp" | "direct";
}

export interface GitHubRepoFileOptions {
  repo: string; // e.g. "owner/repo"
  path: string; // e.g. "src/index.ts"
  ref?: string; // branch/tag/commit (default: default branch)
  token?: string;
}

export interface NotionQueryOptions {
  databaseId: string;
  filter?: Record<string, unknown>;
  token?: string;
}

export interface MCPClientLike {
  callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<unknown>;
  isServerConnected(serverName: string): boolean;
}

export class ConnectorService {
  constructor(private mcpClient?: MCPClientLike) {}

  /**
   * Fetch a file from a GitHub repository.
   * Prefers the direct GitHub API path, falling back to MCP only when needed.
   */
  async githubFetchFile(options: GitHubRepoFileOptions): Promise<ConnectorResult<string>> {
    const { repo, path, ref, token } = options;

    // Direct GitHub API first
    try {
      const apiToken = token ?? process.env.GITHUB_TOKEN;
      if (!apiToken) {
        throw new Error("No GitHub API token found");
      }

      const refPart = ref ? `?ref=${encodeURIComponent(ref)}` : "";
      const url = `https://api.github.com/repos/${repo}/contents/${path}${refPart}`;
      const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        Authorization: `Bearer ${apiToken}`,
      };

      const response = await fetch(url, { headers });
      if (!response.ok) {
        throw new Error(`GitHub API returned ${response.status}: ${await response.text()}`);
      }

      const json = (await response.json()) as { content?: string; encoding?: string };
      if (json.encoding === "base64" && json.content) {
        const content = Buffer.from(json.content.replace(/\n/g, ""), "base64").toString("utf-8");
        return { success: true, data: content, source: "direct" };
      }

      return { success: true, data: JSON.stringify(json), source: "direct" };
    } catch (directError) {
      if (!this.mcpClient?.isServerConnected("github")) {
        return {
          success: false,
          error: directError instanceof Error ? directError.message : String(directError),
          source: "direct",
        };
      }
    }

    // MCP fallback
    if (this.mcpClient?.isServerConnected("github")) {
      try {
        const result = await this.mcpClient.callTool("github", "get_file_contents", {
          owner: repo.split("/")[0],
          repo: repo.split("/")[1],
          path,
          ...(ref ? { branch: ref } : {}),
        });
        return {
          success: true,
          data: typeof result === "string" ? result : JSON.stringify(result),
          source: "mcp",
        };
      } catch {
        // Fall through to error return below
      }
    }
    return {
      success: false,
      error: "GitHub file fetch failed via both direct API and MCP fallback.",
      source: "mcp",
    };
  }

  /**
   * Query a Notion database.
   * Prefers the direct Notion API path, falling back to MCP only when needed.
   */
  async notionQuery(options: NotionQueryOptions): Promise<ConnectorResult> {
    const { databaseId, filter, token } = options;

    // Direct Notion API first
    try {
      const apiToken = token ?? process.env.NOTION_TOKEN;
      if (!apiToken) {
        throw new Error("No Notion API token found");
      }

      const response = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
          "Notion-Version": "2022-06-28",
        },
        body: JSON.stringify(filter ? { filter } : {}),
      });

      if (!response.ok) {
        throw new Error(`Notion API returned ${response.status}: ${await response.text()}`);
      }

      return { success: true, data: await response.json(), source: "direct" };
    } catch (directError) {
      if (!this.mcpClient?.isServerConnected("notion")) {
        return {
          success: false,
          error:
            directError instanceof Error
              ? directError.message === "No Notion API token found"
                ? "No Notion API token found. Set NOTION_TOKEN or connect via MCP."
                : directError.message
              : String(directError),
          source: "direct",
        };
      }
    }

    // MCP fallback
    if (this.mcpClient?.isServerConnected("notion")) {
      try {
        const result = await this.mcpClient.callTool("notion", "query_database", {
          database_id: databaseId,
          ...(filter ? { filter } : {}),
        });
        return { success: true, data: result, source: "mcp" };
      } catch {
        // Fall through to error return below
      }
    }
    return {
      success: false,
      error: "Notion query failed via both direct API and MCP fallback.",
      source: "mcp",
    };
  }
}
