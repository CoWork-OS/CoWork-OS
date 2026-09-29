import { AgentRoleRepository, MentionRepository } from "../../agents/agent-repository-facades";
import { AgentDaemon } from "../daemon";
import { LLMTool } from "../llm/types";

import { DatabaseManager } from "../../database/schema";
import { MentionType, AgentRole } from "../../../shared/types";

/**
 * MentionTools provides tools for agents to @mention and communicate with other specialized agents
 * This enables multi-agent collaboration and task delegation
 */
export class MentionTools {
  private mentionRepo: MentionRepository;
  private agentRoleRepo: AgentRoleRepository;

  constructor(
    private workspaceId: string,
    private taskId: string,
    private daemon: AgentDaemon,
    private currentAgentRoleId?: string,
  ) {
    // Get repositories from the database manager
    const dbManager = DatabaseManager.getInstance();
    const db = dbManager.getDatabase();
    this.mentionRepo = new MentionRepository(db);
    this.agentRoleRepo = new AgentRoleRepository(db);
  }

  /**
   * Update workspace and task for this tool instance
   */
  setContext(workspaceId: string, taskId: string, agentRoleId?: string): void {
    this.workspaceId = workspaceId;
    this.taskId = taskId;
    this.currentAgentRoleId = agentRoleId;
  }

  /**
   * List available agent roles that can be mentioned
   */
  async listAgentRoles(): Promise<{
    agents: Array<{
      id: string;
      name: string;
      displayName: string;
      description?: string;
      capabilities: string[];
    }>;
  }> {
    this.daemon.logEvent(this.taskId, "tool_call", {
      tool: "list_agent_roles",
    });

    const roles = await this.agentRoleRepo.findAll(false); // false = only active roles

    const result = {
      agents: roles.map((role: AgentRole) => ({
        id: role.id,
        name: role.name,
        displayName: role.displayName,
        description: role.description,
        capabilities: role.capabilities,
      })),
    };

    this.daemon.logEvent(this.taskId, "tool_result", {
      tool: "list_agent_roles",
      success: true,
      count: result.agents.length,
    });

    return result;
  }

  /**
   * @mention another agent to request help or delegate work
   */
  async mentionAgent(params: {
    agentRole: string;
    mentionType: MentionType;
    context: string;
  }): Promise<{
    success: boolean;
    mentionId: string;
    toAgent: string;
    message: string;
  }> {
    const { agentRole, mentionType, context } = params;

    if (!agentRole || typeof agentRole !== "string") {
      throw new Error("Invalid agentRole: must be a non-empty string");
    }

    if (!["request", "handoff", "review", "fyi"].includes(mentionType)) {
      throw new Error("Invalid mentionType: must be one of request, handoff, review, fyi");
    }

    if (!context || typeof context !== "string") {
      throw new Error("Invalid context: must be a non-empty string");
    }

    this.daemon.logEvent(this.taskId, "tool_call", {
      tool: "mention_agent",
      agentRole,
      mentionType,
    });

    // Find the agent role by name or displayName
    const allRoles = await this.agentRoleRepo.findAll(false); // false = only active roles
    const targetRole = allRoles.find(
      (r: AgentRole) =>
        r.name.toLowerCase() === agentRole.toLowerCase() ||
        r.displayName.toLowerCase() === agentRole.toLowerCase(),
    );

    if (!targetRole) {
      const availableRoles = allRoles.map((r: AgentRole) => r.name).join(", ");
      throw new Error(`Agent role "${agentRole}" not found. Available roles: ${availableRoles}`);
    }

    // Don't allow self-mentions
    if (this.currentAgentRoleId && targetRole.id === this.currentAgentRoleId) {
      throw new Error("Cannot mention yourself. Please choose a different agent.");
    }

    // Create the mention
    const mention = await this.mentionRepo.create({
      workspaceId: this.workspaceId,
      taskId: this.taskId,
      fromAgentRoleId: this.currentAgentRoleId,
      toAgentRoleId: targetRole.id,
      mentionType,
      context,
    });

    const typeDescriptions: Record<MentionType, string> = {
      request: "requested help from",
      handoff: "handed off work to",
      review: "requested a review from",
      fyi: "shared information with",
    };

    this.daemon.logEvent(this.taskId, "tool_result", {
      tool: "mention_agent",
      success: true,
      mentionId: mention.id,
      toAgentRoleId: targetRole.id,
    });

    return {
      success: true,
      mentionId: mention.id,
      toAgent: targetRole.displayName,
      message: `Successfully ${typeDescriptions[mentionType]} @${targetRole.displayName}. They will be notified about this task.`,
    };
  }

  /**
   * Get pending mentions for this agent
   */
  async getPendingMentions(): Promise<{
    mentions: Array<{
      id: string;
      fromAgent: string | null;
      mentionType: MentionType;
      context?: string;
      createdAt: number;
    }>;
  }> {
    if (!this.currentAgentRoleId) {
      return { mentions: [] };
    }

    this.daemon.logEvent(this.taskId, "tool_call", {
      tool: "get_pending_mentions",
    });

    const pending = await this.mentionRepo.getPendingForAgent(
      this.currentAgentRoleId,
      this.workspaceId,
    );

    const mentions = await Promise.all(pending.map(async (m) => {
      let fromAgent: string | null = null;
      if (m.fromAgentRoleId) {
        const role = await this.agentRoleRepo.findById(m.fromAgentRoleId);
        fromAgent = role?.displayName || null;
      }

      return {
        id: m.id,
        fromAgent,
        mentionType: m.mentionType,
        context: m.context,
        createdAt: m.createdAt,
      };
    }));

    this.daemon.logEvent(this.taskId, "tool_result", {
      tool: "get_pending_mentions",
      success: true,
      count: mentions.length,
    });

    return { mentions };
  }

  /**
   * Acknowledge a mention directed to this agent
   */
  async acknowledgeMention(mentionId: string): Promise<{
    success: boolean;
    message: string;
  }> {
    if (!mentionId || typeof mentionId !== "string") {
      throw new Error("Invalid mentionId: must be a non-empty string");
    }

    this.daemon.logEvent(this.taskId, "tool_call", {
      tool: "acknowledge_mention",
      mentionId,
    });

    const mention = await this.mentionRepo.acknowledge(mentionId);

    if (!mention) {
      throw new Error(`Mention "${mentionId}" not found or already processed`);
    }

    this.daemon.logEvent(this.taskId, "tool_result", {
      tool: "acknowledge_mention",
      success: true,
    });

    return {
      success: true,
      message: "Mention acknowledged. You can now work on the requested task.",
    };
  }

  /**
   * Mark a mention as completed
   */
  async completeMention(mentionId: string): Promise<{
    success: boolean;
    message: string;
  }> {
    if (!mentionId || typeof mentionId !== "string") {
      throw new Error("Invalid mentionId: must be a non-empty string");
    }

    this.daemon.logEvent(this.taskId, "tool_call", {
      tool: "complete_mention",
      mentionId,
    });

    const mention = await this.mentionRepo.complete(mentionId);

    if (!mention) {
      throw new Error(`Mention "${mentionId}" not found`);
    }

    this.daemon.logEvent(this.taskId, "tool_result", {
      tool: "complete_mention",
      success: true,
    });

    return {
      success: true,
      message: "Mention completed successfully.",
    };
  }

  /**
   * Static method to get tool definitions
   */
  static getToolDefinitions(): LLMTool[] {
    return [
      {
        name: "list_agent_roles",
        description:
          "List all available specialized agent roles that can be mentioned. " +
          "Use this to see what experts are available for collaboration.",
        input_schema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        name: "mention_agent",
        description:
          "Mention another specialized agent to request help, delegate work, request a review, or share information. " +
          "This sends a notification to the specified agent role. " +
          "Example uses: ask the Reviewer to check your code, ask the Researcher to find information, " +
          "hand off a task to the Tester, or notify the Architect about a design decision.",
        input_schema: {
          type: "object",
          properties: {
            agentRole: {
              type: "string",
              description:
                'The name of the agent role to mention (e.g., "Reviewer", "Researcher", "Tester", "Architect"). ' +
                "Use list_agent_roles to see available options.",
            },
            mentionType: {
              type: "string",
              enum: ["request", "handoff", "review", "fyi"],
              description:
                "Type of mention: " +
                '"request" - ask for help with a specific task, ' +
                '"handoff" - fully delegate the task to another agent, ' +
                '"review" - request a review of completed work, ' +
                '"fyi" - informational, no action needed.',
            },
            context: {
              type: "string",
              description:
                "Detailed context for the mention. Explain what you need, what you have done so far, " +
                "and any relevant information the other agent needs to help.",
            },
          },
          required: ["agentRole", "mentionType", "context"],
        },
      },
      {
        name: "get_pending_mentions",
        description:
          "Get any pending mentions directed to this agent. " +
          "Use this to check if other agents have requested your help.",
        input_schema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        name: "acknowledge_mention",
        description: "Acknowledge a mention, indicating you have seen it and will work on it.",
        input_schema: {
          type: "object",
          properties: {
            mentionId: {
              type: "string",
              description: "The ID of the mention to acknowledge",
            },
          },
          required: ["mentionId"],
        },
      },
      {
        name: "complete_mention",
        description: "Mark a mention as completed after finishing the requested work.",
        input_schema: {
          type: "object",
          properties: {
            mentionId: {
              type: "string",
              description: "The ID of the mention to mark as completed",
            },
          },
          required: ["mentionId"],
        },
      },
    ];
  }
}
