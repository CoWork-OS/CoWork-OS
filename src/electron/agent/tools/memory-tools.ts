import type { LLMTool } from "../llm/types";
import type { Workspace } from "../../../shared/types";
import type { AgentDaemon } from "../daemon";
import { MemoryService } from "../../memory/MemoryService";
import type { MemoryType } from "../../database/repositories";

/**
 * MemoryTools provides explicit memory save operations for agents.
 * Allows agents to consciously persist insights, decisions, observations,
 * and errors during task execution for recall in future sessions.
 */
export class MemoryTools {
  constructor(
    private workspace: Workspace,
    private daemon: AgentDaemon,
    private taskId: string,
  ) {}

  setWorkspace(workspace: Workspace): void {
    this.workspace = workspace;
  }

  static getToolDefinitions(): LLMTool[] {
    return [
      {
        name: "memory_save",
        description:
          "Save an insight, decision, observation, or error to the workspace memory database. " +
          "Use this to persist important findings, decisions you made, patterns you noticed, " +
          "or errors you encountered so they can be recalled in future tasks and sessions. " +
          "Do NOT save trivial or transient information — only things worth remembering long-term.",
        input_schema: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description:
                "The memory content to save. Be concise but include enough context " +
                "to be useful when recalled later (e.g., 'Decided to use Redis for session storage " +
                "because PostgreSQL was creating too many connections under load').",
            },
            type: {
              type: "string",
              enum: ["observation", "decision", "error", "insight"],
              description:
                "The type of memory: 'observation' for factual findings, " +
                "'decision' for choices made and their rationale, " +
                "'error' for problems encountered and how they were resolved, " +
                "'insight' for patterns, best practices, or lessons learned.",
            },
          },
          required: ["content", "type"],
        },
      },
    ];
  }

  async save(input: {
    content: string;
    type: "observation" | "decision" | "error" | "insight";
  }): Promise<{
    success: boolean;
    memoryId?: string;
    error?: string;
  }> {
    this.daemon.logEvent(this.taskId, "tool_call", {
      tool: "memory_save",
      type: input.type,
      contentLength: input.content.length,
    });

    try {
      const memory = await MemoryService.capture(
        this.workspace.id,
        this.taskId,
        input.type as MemoryType,
        input.content,
        false,
      );

      if (!memory) {
        this.daemon.logEvent(this.taskId, "tool_result", {
          tool: "memory_save",
          success: false,
          reason: "Memory capture is disabled or content was filtered",
        });
        return {
          success: false,
          error:
            "Memory capture is currently disabled for this workspace or the content was filtered. " +
            "The user can enable it in Settings > Memory.",
        };
      }

      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: "memory_save",
        success: true,
        memoryId: memory.id,
      });

      return { success: true, memoryId: memory.id };
    } catch (error) {
      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: "memory_save",
        success: false,
        error: String(error),
      });
      return { success: false, error: String(error) };
    }
  }
}
