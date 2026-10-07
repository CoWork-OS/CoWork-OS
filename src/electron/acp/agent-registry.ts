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
import {
  extractRemoteAgentSecrets,
  getDefaultRemoteAgentSecretStore,
  getRemoteAgentSecretRef,
  hasPlaintextRemoteAgentSecrets,
  remoteAgentSecretFields,
  withRemoteAgentSecretRef,
  type RemoteAgentSecretStore,
} from "./remote-agent-secrets";
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

export interface ACPAgentRegistryOptions {
  /**
   * Where remote agent credentials (authorization header / bearer token) are kept.
   * Defaults to SecureSettingsRepository (safeStorage); cards only hold a reference.
   */
  secretStore?: RemoteAgentSecretStore;
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

  private readonly secretStore: RemoteAgentSecretStore;

  constructor(
    private db?: Database.Database,
    options: ACPAgentRegistryOptions = {},
  ) {
    this.secretStore = options.secretStore ?? getDefaultRemoteAgentSecretStore();
    this.ready = this.loadRemoteAgents();
  }

  private async loadRemoteAgents(): Promise<void> {
    if (!this.db) return;
    const rows = await serviceStatements(this.db).unit("acp_remoteAgentRows", []);
    let migrated = 0;
    for (const row of rows) {
      let card: ACPAgentCard;
      try {
        card = JSON.parse(row.card_json) as ACPAgentCard;
      } catch {
        // Ignore malformed persisted registrations.
        continue;
      }
      // A registration made while loading is newer than the persisted one.
      if (this.remoteAgents.has(card.id)) continue;
      if (hasPlaintextRemoteAgentSecrets(card)) {
        const next = await this.migratePlaintextSecrets(card);
        if (next !== card) migrated += 1;
        card = next;
        if (this.remoteAgents.has(card.id)) continue;
      }
      this.remoteAgents.set(card.id, card);
    }
    if (migrated > 0) {
      logger.info(`Moved credentials of ${migrated} ACP remote agent(s) into secure storage`);
    }
  }

  /**
   * One-time migration for registrations persisted before credentials moved to secure
   * storage: store the plaintext values under the agent id, then rewrite card_json with
   * only a reference. Idempotent, so a failed run is retried on the next start; until
   * then the card is left as it was (the values are never dropped).
   */
  private async migratePlaintextSecrets(card: ACPAgentCard): Promise<ACPAgentCard> {
    const { secrets, metadata } = extractRemoteAgentSecrets(card.metadata);
    const fields = remoteAgentSecretFields(secrets);
    if (fields.length > 0) {
      try {
        this.secretStore.set(card.id, secrets);
      } catch (error) {
        logger.warn(
          `Could not move credentials of ACP agent ${card.id} into secure storage; will retry on next start:`,
          error,
        );
        return card;
      }
    }
    const scrubbed: ACPAgentCard = {
      ...card,
      metadata: fields.length > 0 ? withRemoteAgentSecretRef(metadata, card.id, fields) : metadata,
    };
    if (this.db) {
      try {
        await serviceStatements(this.db).unit("acp_scrubRemoteAgentCard", [scrubbed, Date.now()]);
      } catch (error) {
        // The credentials are already in secure storage; the next start rewrites the row.
        logger.warn(`Failed to scrub persisted credentials of ACP agent ${card.id}:`, error);
      }
    }
    return scrubbed;
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

    // Credentials go to secure storage before the card exists anywhere, so a failed
    // write rejects the registration instead of persisting the token in card_json.
    const { secrets, metadata } = extractRemoteAgentSecrets(params.metadata);
    const secretFields = remoteAgentSecretFields(secrets);
    if (secretFields.length > 0) {
      this.secretStore.set(id, secrets);
    }

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
      metadata:
        secretFields.length > 0 ? withRemoteAgentSecretRef(metadata, id, secretFields) : metadata,
    };

    this.remoteAgents.set(id, card);
    this.persistRemoteAgent(card);
    return card;
  }

  /**
   * Unregister a remote agent
   */
  unregisterRemoteAgent(agentId: string): boolean {
    const agent = this.remoteAgents.get(agentId);
    const deleted = this.remoteAgents.delete(agentId);
    if (deleted) {
      this.deleteRemoteAgentFromDb(agentId);
      if (agent && getRemoteAgentSecretRef(agent)) {
        try {
          this.secretStore.delete(agentId);
        } catch (error) {
          logger.warn(`Failed to delete stored credentials of ACP agent ${agentId}:`, error);
        }
      }
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
