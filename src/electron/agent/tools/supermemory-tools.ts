import type { LLMTool } from "../llm/types";
import type { Workspace } from "../../../shared/types";
import type { AgentDaemon } from "../daemon";
import { SupermemoryService } from "../../memory/SupermemoryService";

export class SupermemoryTools {
  constructor(
    private workspace: Workspace,
    private daemon: AgentDaemon,
    private taskId: string,
  ) {}

  setWorkspace(workspace: Workspace): void {
    this.workspace = workspace;
  }

  static isEnabled(): boolean {
    return SupermemoryService.isConfigured();
  }

  static getToolDefinitions(): LLMTool[] {
    return [
      {
        name: "supermemory_profile",
        description:
          "Fetch the current external Supermemory profile for this workspace or container. " +
          "Use this when you need durable user/project context before answering.",
        input_schema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description:
                "Optional search query to also return relevant memories for the current task.",
            },
            containerTag: {
              type: "string",
              description: "Optional explicit Supermemory container tag override.",
            },
            threshold: {
              type: "number",
              description: "Optional search threshold from 0 to 1 when query is provided.",
            },
          },
          required: [],
        },
      },
      {
        name: "supermemory_search",
        description:
          "Search Supermemory for relevant external memories and indexed chunks. " +
          "Use this for targeted recall from the configured external memory namespace.",
        input_schema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search query.",
            },
            containerTag: {
              type: "string",
              description: "Optional explicit Supermemory container tag override.",
            },
            limit: {
              type: "number",
              description: "Maximum number of results to return (default 8, max 25).",
            },
            threshold: {
              type: "number",
              description: "Optional search threshold from 0 to 1.",
            },
            rerank: {
              type: "boolean",
              description: "Whether to rerank results for better relevance.",
            },
            searchMode: {
              type: "string",
              enum: ["hybrid", "memories"],
              description:
                "Use 'hybrid' for memories plus document chunks, or 'memories' for memories only.",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "supermemory_remember",
        description:
          "Create a durable memory directly in Supermemory for this workspace/container. " +
          "Use this for high-value facts, preferences, or decisions that should persist externally.",
        input_schema: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description: "Memory text to store.",
            },
            containerTag: {
              type: "string",
              description: "Optional explicit Supermemory container tag override.",
            },
          },
          required: ["content"],
        },
      },
      {
        name: "supermemory_forget",
        description:
          "Forget a Supermemory entry by ID or exact content. Use this when an external memory is outdated or wrong.",
        input_schema: {
          type: "object",
          properties: {
            memoryId: {
              type: "string",
              description: "Exact memory ID to forget.",
            },
            content: {
              type: "string",
              description: "Exact memory content to forget when the ID is unavailable.",
            },
            containerTag: {
              type: "string",
              description: "Optional explicit Supermemory container tag override.",
            },
            reason: {
              type: "string",
              description: "Optional reason for forgetting the memory.",
            },
          },
          required: [],
        },
      },
    ];
  }

  async profile(input: { query?: string; containerTag?: string; threshold?: number }): Promise<{
    containerTag: string;
    staticFacts: string[];
    dynamicFacts: string[];
    results: Array<{
      id?: string;
      text: string;
      similarity?: number;
      updatedAt?: string;
      metadata?: Record<string, unknown>;
    }>;
    total: number;
  }> {
    this.daemon.logEvent(this.taskId, "tool_call", {
      tool: "supermemory_profile",
      hasQuery: Boolean(input.query),
      hasContainerTag: Boolean(input.containerTag),
    });

    const result = await SupermemoryService.getProfile({
      workspace: this.workspace,
      query: input.query,
      containerTag: input.containerTag,
      threshold: input.threshold,
    });

    this.daemon.logEvent(this.taskId, "tool_result", {
      tool: "supermemory_profile",
      success: true,
      resultCount: result.results.length,
      containerTag: result.containerTag,
    });
    return result;
  }

  async search(input: {
    query: string;
    containerTag?: string;
    limit?: number;
    threshold?: number;
    rerank?: boolean;
    searchMode?: "hybrid" | "memories";
  }): Promise<{
    containerTag: string;
    results: Array<{
      id?: string;
      text: string;
      similarity?: number;
      updatedAt?: string;
      metadata?: Record<string, unknown>;
    }>;
    total: number;
    timingMs?: number;
  }> {
    this.daemon.logEvent(this.taskId, "tool_call", {
      tool: "supermemory_search",
      query: input.query,
      hasContainerTag: Boolean(input.containerTag),
    });

    const result = await SupermemoryService.search({
      workspace: this.workspace,
      query: input.query,
      containerTag: input.containerTag,
      limit: input.limit,
      threshold: input.threshold,
      rerank: input.rerank,
      searchMode: input.searchMode,
    });

    this.daemon.logEvent(this.taskId, "tool_result", {
      tool: "supermemory_search",
      success: true,
      resultCount: result.results.length,
      containerTag: result.containerTag,
    });
    return result;
  }

  async remember(input: { content: string; containerTag?: string }): Promise<{
    success: boolean;
    containerTag: string;
    memoryIds: string[];
    staged?: boolean;
    pendingId?: string;
    blocked?: boolean;
    error?: string;
    message?: string;
  }> {
    this.daemon.logEvent(this.taskId, "tool_call", {
      tool: "supermemory_remember",
      hasContainerTag: Boolean(input.containerTag),
      contentLength: input.content.length,
    });

    const result = await SupermemoryService.remember({
      workspace: this.workspace,
      content: input.content,
      containerTag: input.containerTag,
      metadata: {
        source: "cowork_tool",
        taskId: this.taskId,
        workspaceId: this.workspace.id,
      },
      taskId: this.taskId,
      origin: "agent_tool",
    });

    if (result.blocked) {
      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: "supermemory_remember",
        success: false,
        blocked: true,
        containerTag: result.containerTag,
      });
      return {
        success: false,
        containerTag: result.containerTag,
        memoryIds: [],
        blocked: true,
        error: result.error,
        message: result.error,
      };
    }

    if (result.staged) {
      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: "supermemory_remember",
        success: true,
        staged: true,
        pendingId: result.pendingId,
        containerTag: result.containerTag,
      });
      return {
        success: true,
        containerTag: result.containerTag,
        memoryIds: [],
        staged: true,
        pendingId: result.pendingId,
        message: "External memory write is pending user approval.",
      };
    }

    this.daemon.logEvent(this.taskId, "tool_result", {
      tool: "supermemory_remember",
      success: true,
      memoryIds: result.memoryIds,
      containerTag: result.containerTag,
    });
    return { success: true, ...result };
  }

  async forget(input: {
    memoryId?: string;
    content?: string;
    containerTag?: string;
    reason?: string;
  }): Promise<{ success: boolean; containerTag: string; id?: string; forgotten: boolean }> {
    if (!input.memoryId && !input.content) {
      throw new Error("Provide either memoryId or content to forget a Supermemory entry.");
    }

    this.daemon.logEvent(this.taskId, "tool_call", {
      tool: "supermemory_forget",
      hasMemoryId: Boolean(input.memoryId),
      hasContent: Boolean(input.content),
      hasContainerTag: Boolean(input.containerTag),
    });

    const result = await SupermemoryService.forget({
      workspace: this.workspace,
      memoryId: input.memoryId,
      content: input.content,
      containerTag: input.containerTag,
      reason: input.reason,
    });

    this.daemon.logEvent(this.taskId, "tool_result", {
      tool: "supermemory_forget",
      success: result.forgotten,
      memoryId: result.id,
      containerTag: result.containerTag,
    });
    return { success: result.forgotten, ...result };
  }
}
