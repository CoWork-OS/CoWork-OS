import type { Workspace } from "../../../shared/types";
import type { AgentDaemon } from "../daemon";
import { SupermemoryService } from "../../memory/SupermemoryService";
import { explicitMemoryWriteBlocked, NO_MEMORY_WRITE_ERROR } from "./memory-tools";

/**
 * Supermemory writes behind the deprecated `supermemory_remember` / `supermemory_forget`
 * aliases. Reads go through `memory_recall` (scope `external`), and forgetting by id through
 * `memory_forget`; these remain for one release so saved prompts keep working.
 */
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

    if (explicitMemoryWriteBlocked(this.daemon, this.taskId, input.content)) {
      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: "supermemory_remember",
        success: false,
        blocked: true,
        reason: "no_memory_directive",
      });
      return {
        success: false,
        containerTag: input.containerTag || "",
        memoryIds: [],
        blocked: true,
        error: NO_MEMORY_WRITE_ERROR,
        message: NO_MEMORY_WRITE_ERROR,
      };
    }

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
