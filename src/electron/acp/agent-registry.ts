/**
 * ACP Agent Registry
 *
 * Manages the registry of ACP-capable agents, including both local
 * CoWork agent roles and remotely registered external agents.
 *
 * Local agents are derived from AgentRoleRepository entries.
 * Remote agents register via the acp.agent.register method.
 */

import { serviceStatements } from "../database/service-statements";
import { createLogger } from "../utils/logger";
import { randomUUID } from "crypto";
import type Database from "better-sqlite3";
import type {
  ACPAgentCard,
  ACPCapability,
  ACPDiscoverParams,
  ACPAgentRegisterParams,
} from "./types";
import { validateRemoteAgentEndpoint } from "./remote-invoker";
import { botIconText } from "../../shared/bot-mascots";

const logger = createLogger("ACPAgentRegistry");

/**
 * Minimal interface for the AgentRoleRepository dependency.
 * Avoids importing the full repository, keeping ACP loosely coupled.
 */
interface AgentRoleLike {
  id: string;
  name: string;
  displayName: string;
  description?: string;
  icon: string;
  capabilities: string[];
  isActive: boolean;
}

/**
 * ACP Agent Registry
 */
export class ACPAgentRegistry {
  /** Remote agents registered via the protocol */
  private remoteAgents = new Map<string, ACPAgentCard>();

  /** Inbox: messages keyed by recipient agent ID */
  private messageInboxes = new Map<string, Array<import("./types").ACPMessage>>();

  /** Maximum messages per inbox before oldest are dropped */
  private maxInboxSize = 100;

  /** Resolves once persisted remote agents are loaded (DB6). */
  readonly ready: Promise<void>;

  constructor(private db?: Database.Database) {
    this.ready = this.loadRemoteAgents();
  }

  private async loadRemoteAgents(): Promise<void> {
    if (!this.db) return;
    const rows = await serviceStatements(this.db).unit("acp_remoteAgentRows", []);
    for (const row of rows) {
      try {
        const card = JSON.parse(row.card_json) as ACPAgentCard;
        // A registration made while loading is newer than the persisted one.
        if (!this.remoteAgents.has(card.id)) this.remoteAgents.set(card.id, card);
      } catch {
        // Ignore malformed persisted registrations.
      }
    }
  }

  /** Persist without holding up the caller; the registration stays in memory either way. */
  private persistRemoteAgent(card: ACPAgentCard): void {
    if (!this.db) return;
    void serviceStatements(this.db)
      .unit("acp_persistRemoteAgent", [card, Date.now()])
      .catch((error: unknown) => logger.warn("Failed to persist ACP agent:", error));
  }

  private deleteRemoteAgentFromDb(agentId: string): void {
    if (!this.db) return;
    void serviceStatements(this.db)
      .unit("acp_deleteRemoteAgent", [agentId])
      .catch((error: unknown) => logger.warn("Failed to delete ACP agent:", error));
  }

  /**
   * Build an ACPAgentCard from a local AgentRole
   */
  private roleToCard(role: AgentRoleLike): ACPAgentCard {
    const capabilities: ACPCapability[] = role.capabilities.map((cap) => ({
      id: cap,
      name: cap.charAt(0).toUpperCase() + cap.slice(1),
    }));

    return {
      id: `local:${role.name}`,
      name: role.displayName,
      description: role.description || `${role.displayName} agent`,
      version: "1.0.0",
      provider: "CoWork OS",
      // ACP clients render the icon as text, so mascots go out as their emoji.
      icon: botIconText(role.icon),
      capabilities,
      origin: "local",
      localRoleId: role.id,
      registeredAt: Date.now(),
      lastActiveAt: Date.now(),
      status: role.isActive ? "available" : "offline",
    };
  }

  /**
   * Get all local agent cards from the provided roles
   */
  getLocalAgents(roles: AgentRoleLike[]): ACPAgentCard[] {
    return roles.filter((r) => r.isActive).map((r) => this.roleToCard(r));
  }

  /**
   * Get all remote agents
   */
  getRemoteAgents(): ACPAgentCard[] {
    return Array.from(this.remoteAgents.values());
  }

  /**
   * Get all agents (local + remote)
   */
  getAllAgents(roles: AgentRoleLike[]): ACPAgentCard[] {
    return [...this.getLocalAgents(roles), ...this.getRemoteAgents()];
  }

  /**
   * Get a specific agent by ID
   */
  getAgent(agentId: string, roles: AgentRoleLike[]): ACPAgentCard | undefined {
    // Check remote agents first
    const remote = this.remoteAgents.get(agentId);
    if (remote) return remote;

    // Check local agents
    if (agentId.startsWith("local:")) {
      const roleName = agentId.slice(6); // Remove 'local:' prefix
      const role = roles.find((r) => r.name === roleName && r.isActive);
      if (role) return this.roleToCard(role);
    }

    return undefined;
  }

  /**
   * Discover agents matching filter criteria
   */
  discover(params: ACPDiscoverParams, roles: AgentRoleLike[]): ACPAgentCard[] {
    let agents = this.getAllAgents(roles);

    if (params.capability) {
      const cap = params.capability.toLowerCase();
      agents = agents.filter((a) => a.capabilities.some((c) => c.id.toLowerCase() === cap));
    }

    if (params.status) {
      agents = agents.filter((a) => a.status === params.status);
    }

    if (params.origin) {
      agents = agents.filter((a) => a.origin === params.origin);
    }

    if (params.query) {
      const q = params.query.toLowerCase();
      agents = agents.filter(
        (a) =>
          a.name.toLowerCase().includes(q) ||
          a.description.toLowerCase().includes(q) ||
          a.skills?.some((s) => s.toLowerCase().includes(q)) ||
          a.capabilities.some((c) => c.id.toLowerCase().includes(q)),
      );
    }

    return agents;
  }

  /**
   * Register a remote agent
   */
  registerRemoteAgent(params: ACPAgentRegisterParams): ACPAgentCard {
    if (params.endpoint) {
      validateRemoteAgentEndpoint(params.endpoint);
    }
    const id = `remote:${randomUUID().slice(0, 8)}-${params.name.toLowerCase().replace(/\s+/g, "-")}`;

    const card: ACPAgentCard = {
      id,
      name: params.name,
      description: params.description,
      version: params.version || "1.0.0",
      provider: params.provider,
      icon: params.icon,
      capabilities: (params.capabilities || []).map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description,
      })),
      skills: params.skills,
      inputContentTypes: params.inputContentTypes,
      outputContentTypes: params.outputContentTypes,
      supportsStreaming: params.supportsStreaming,
      endpoint: params.endpoint,
      origin: "remote",
      registeredAt: Date.now(),
      lastActiveAt: Date.now(),
      status: "available",
      metadata: params.metadata,
    };

    this.remoteAgents.set(id, card);
    this.persistRemoteAgent(card);
    return card;
  }

  /**
   * Unregister a remote agent
   */
  unregisterRemoteAgent(agentId: string): boolean {
    const deleted = this.remoteAgents.delete(agentId);
    if (deleted) {
      this.deleteRemoteAgentFromDb(agentId);
    }
    return deleted;
  }

  /**
   * Update a remote agent's status
   */
  updateAgentStatus(agentId: string, status: ACPAgentCard["status"]): boolean {
    const agent = this.remoteAgents.get(agentId);
    if (!agent) return false;
    agent.status = status;
    agent.lastActiveAt = Date.now();
    this.persistRemoteAgent(agent);
    return true;
  }

  /**
   * Push a message into an agent's inbox
   */
  pushMessage(agentId: string, message: import("./types").ACPMessage): void {
    let inbox = this.messageInboxes.get(agentId);
    if (!inbox) {
      inbox = [];
      this.messageInboxes.set(agentId, inbox);
    }
    inbox.push(message);
    // Evict oldest messages if inbox is full
    while (inbox.length > this.maxInboxSize) {
      inbox.shift();
    }
  }

  /**
   * Get and optionally drain messages from an agent's inbox
   */
  getMessages(agentId: string, drain = false): import("./types").ACPMessage[] {
    const inbox = this.messageInboxes.get(agentId) || [];
    if (drain) {
      this.messageInboxes.delete(agentId);
    }
    return [...inbox];
  }

  /**
   * Get remote agent count
   */
  get remoteAgentCount(): number {
    return this.remoteAgents.size;
  }

  /**
   * Clear all remote agents (e.g., on shutdown)
   */
  clear(): void {
    this.remoteAgents.clear();
    this.messageInboxes.clear();
  }
}
