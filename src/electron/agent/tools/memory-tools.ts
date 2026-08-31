import type { LLMTool } from "../llm/types";
import type { Workspace } from "../../../shared/types";
import type { AgentDaemon } from "../daemon";
import { MemoryService } from "../../memory/MemoryService";
import { CuratedMemoryService } from "../../memory/CuratedMemoryService";
import { MemoryWriteGate } from "../../memory/MemoryWriteGate";
import type { MemoryType } from "../../database/repositories";
import { evaluateWorkspaceFilesystemAccess } from "../../security/access-profile-paths";

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
      {
        name: "memory_curate",
        description:
          "Manage the small curated hot-memory layer that is injected by default. " +
          "Use this for durable user/workspace facts that should stay front-and-center. " +
          "Prefer this over memory_save when you are adding or editing a stable preference, constraint, workflow rule, or project fact.",
        input_schema: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["add", "replace", "remove"],
              description:
                "Whether to add a new curated memory, replace a matching one, or remove one",
            },
            target: {
              type: "string",
              enum: ["user", "workspace"],
              description: "Whether the memory belongs in the user profile lane or workspace lane",
            },
            id: {
              type: "string",
              description:
                "Preferred stable identifier for replace/remove operations. Obtain it from memory_curated_read.",
            },
            kind: {
              type: "string",
              enum: [
                "identity",
                "preference",
                "constraint",
                "workflow_rule",
                "project_fact",
                "active_commitment",
              ],
              description: "Curated memory category",
            },
            content: {
              type: "string",
              description: "Curated memory text to add or replace with",
            },
            match: {
              type: "string",
              description:
                "Substring used to find an existing curated memory when replacing or removing",
            },
            reason: {
              type: "string",
              description: "Optional reason for the curated memory change",
            },
          },
          required: ["action", "target"],
        },
      },
      {
        name: "memory_curated_read",
        description:
          "Read the current curated hot-memory layer. Use this when you need to inspect what will be injected by default.",
        input_schema: {
          type: "object",
          properties: {
            target: {
              type: "string",
              enum: ["user", "workspace", "all"],
              description: "Restrict results to user, workspace, or both",
            },
            kind: {
              type: "string",
              enum: [
                "identity",
                "preference",
                "constraint",
                "workflow_rule",
                "project_fact",
                "active_commitment",
              ],
              description: "Optional curated memory category filter",
            },
            limit: {
              type: "number",
              description: "Maximum number of curated entries to return (default: 20)",
            },
          },
          required: [],
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
    staged?: boolean;
    pendingId?: string;
    message?: string;
    error?: string;
  }> {
    this.daemon.logEvent(this.taskId, "tool_call", {
      tool: "memory_save",
      type: input.type,
      contentLength: input.content.length,
    });

    try {
      const gate = MemoryWriteGate.evaluate({
        workspaceId: this.workspace.id,
        taskId: this.taskId,
        target: "archive",
        action: "add",
        origin: "agent_tool",
        summary: `Save ${input.type} memory`,
        payload: {
          type: input.type,
          content: input.content,
        },
        proposedValue: input.content,
      });
      if (!gate.allowed) {
        if ("blocked" in gate) {
          this.daemon.logEvent(this.taskId, "tool_result", {
            tool: "memory_save",
            success: false,
            blocked: true,
          });
          return {
            success: false,
            error: gate.error,
          };
        }
        this.daemon.logEvent(this.taskId, "tool_result", {
          tool: "memory_save",
          success: true,
          staged: true,
          pendingId: gate.pendingId,
        });
        return {
          success: true,
          staged: true,
          pendingId: gate.pendingId,
          message: "Memory write is pending user approval.",
        };
      }

      const memory = await MemoryService.capture(
        this.workspace.id,
        this.taskId,
        input.type as MemoryType,
        input.content,
        false,
        {
          origin: "tool",
          skipMemoryWriteGate: true,
          allowExternalMirror: this.isExternalMemoryMirrorAllowed(),
        },
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

  async curate(input: {
    action: "add" | "replace" | "remove";
    target: "user" | "workspace";
    id?: string;
    kind?:
      | "identity"
      | "preference"
      | "constraint"
      | "workflow_rule"
      | "project_fact"
      | "active_commitment";
    content?: string;
    match?: string;
    reason?: string;
  }): Promise<{
    success: boolean;
    entryId?: string;
    updatedFile?: ".cowork/USER.md" | ".cowork/MEMORY.md";
    staged?: boolean;
    pendingId?: string;
    message?: string;
    error?: string;
  }> {
    this.daemon.logEvent(this.taskId, "tool_call", {
      tool: "memory_curate",
      action: input.action,
      target: input.target,
      kind: input.kind,
    });

    try {
      const filesystemReadGuard = (candidatePath: string): boolean =>
        evaluateWorkspaceFilesystemAccess(this.workspace, candidatePath, "read").decision ===
        "allow";
      const filesystemWriteGuard = (candidatePath: string): boolean =>
        evaluateWorkspaceFilesystemAccess(this.workspace, candidatePath, "write").decision ===
        "allow";
      const result = await CuratedMemoryService.curate({
        workspaceId: this.workspace.id,
        taskId: this.taskId,
        origin: "agent_tool",
        ...input,
        filesystemReadGuard,
        filesystemWriteGuard,
      });
      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: "memory_curate",
        success: result.success,
        entryId: result.entry?.id,
        updatedFile: result.updatedFile,
        staged: result.staged,
        pendingId: result.pendingId,
        error: result.error,
      });
      return {
        success: result.success,
        ...(result.entry?.id ? { entryId: result.entry.id } : {}),
        ...(result.updatedFile ? { updatedFile: result.updatedFile } : {}),
        ...(result.staged ? { staged: true } : {}),
        ...(result.pendingId ? { pendingId: result.pendingId } : {}),
        ...(result.staged ? { message: "Memory write is pending user approval." } : {}),
        ...(result.error ? { error: result.error } : {}),
      };
    } catch (error) {
      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: "memory_curate",
        success: false,
        error: String(error),
      });
      return { success: false, error: String(error) };
    }
  }

  private isExternalMemoryMirrorAllowed(): boolean {
    const permissions = this.workspace.permissions;
    return (
      permissions.network === true &&
      permissions.accessNetworkMode !== "disabled" &&
      permissions.accessNetworkMode !== "on-request"
    );
  }

  async readCurated(input: {
    target?: "user" | "workspace" | "all";
    kind?:
      | "identity"
      | "preference"
      | "constraint"
      | "workflow_rule"
      | "project_fact"
      | "active_commitment";
    limit?: number;
  }): Promise<{
    entries: Array<{
      id: string;
      target: string;
      kind: string;
      content: string;
      confidence: number;
      updatedAt: string;
    }>;
    totalFound: number;
  }> {
    this.daemon.logEvent(this.taskId, "tool_call", {
      tool: "memory_curated_read",
      target: input.target,
      kind: input.kind,
    });

    const targets =
      !input.target || input.target === "all" ? (["user", "workspace"] as const) : [input.target];
    const limit = Math.max(1, input.limit ?? 20);
    const entriesByTarget = targets.map((target) =>
      CuratedMemoryService.list(this.workspace.id, {
        target,
        kind: input.kind,
        status: "active",
        limit,
      }),
    );
    const entries: ReturnType<typeof CuratedMemoryService.list> = [];
    for (let index = 0; entries.length < limit; index += 1) {
      let added = false;
      for (const bucket of entriesByTarget) {
        const entry = bucket[index];
        if (!entry) continue;
        entries.push(entry);
        added = true;
        if (entries.length >= limit) break;
      }
      if (!added) break;
    }
    const mapped = entries.map((entry) => ({
      id: entry.id,
      target: entry.target,
      kind: entry.kind,
      content: entry.content,
      confidence: entry.confidence,
      updatedAt: new Date(entry.updatedAt).toISOString(),
    }));
    this.daemon.logEvent(this.taskId, "tool_result", {
      tool: "memory_curated_read",
      success: true,
      resultCount: mapped.length,
    });
    return { entries: mapped, totalFound: mapped.length };
  }
}
