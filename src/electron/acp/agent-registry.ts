/**
 * ACP Agent Registry
 *
 * Manages the registry of ACP-capable agents, including both local
 * CoWork agent roles and remotely registered external agents.
 *
 * Local agents are derived from AgentRoleRepository entries.
 * Remote agents register via the acp.agent.register method.
 */

import { randomUUID } from "crypto";
import type Database from "better-sqlite3";
import type {
  ACPAgentCard,
  ACPCapability,
  ACPDiscoverParams,
  ACPAgentRegisterParams,
} from "./types";
import { validateRemoteAgentEndpoint } from "./remote-invoker";
import { BotMessageRepository } from "../bots/repositories";

const SENSITIVE_METADATA_KEYS = new Set([
  "authorization",
  "authorizationheader",
  "bearertoken",
  "token",
  "apikey",
  "secret",
  "password",
  "cookie",
  "setcookie",
]);

function normalizedMetadataKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function hasInlineRemoteSecret(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasInlineRemoteSecret);
  return Object.entries(value as Record<string, unknown>).some(([key, nested]) => {
    if (key === "credentialRef") return false;
    return SENSITIVE_METADATA_KEYS.has(normalizedMetadataKey(key)) || hasInlineRemoteSecret(nested);
  });
}

function sanitizeRemoteValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeRemoteValue);
  if (!value || typeof value !== "object") return value;
  const sanitized: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (key !== "credentialRef" && SENSITIVE_METADATA_KEYS.has(normalizedMetadataKey(key))) {
      continue;
    }
    sanitized[key] = sanitizeRemoteValue(nested);
  }
  return sanitized;
}

function sanitizeRemoteMetadata(metadata?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  const sanitized = sanitizeRemoteValue(metadata) as Record<string, unknown>;
  return Object.keys(sanitized).length ? sanitized : undefined;
}

function sanitizePersistedEndpoint(endpoint?: string): string | undefined {
  if (!endpoint) return undefined;
  try {
    const parsed = new URL(endpoint);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return endpoint;
  }
}

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

  private readonly durableMessages?: BotMessageRepository;

  constructor(private db?: Database.Database) {
    this.durableMessages = db ? new BotMessageRepository(db) : undefined;
    this.loadRemoteAgents();
  }

  private loadRemoteAgents(): void {
    if (!this.db) return;
    const rows = this.db
      .prepare(
        "SELECT id, card_json FROM acp_agents WHERE origin = 'remote' ORDER BY registered_at DESC",
      )
      .all() as Array<{ id: string; card_json: string }>;
    for (const row of rows) {
      try {
        const card = JSON.parse(row.card_json) as ACPAgentCard;
        card.metadata = sanitizeRemoteMetadata(card.metadata);
        card.endpoint = sanitizePersistedEndpoint(card.endpoint);
        this.remoteAgents.set(card.id, card);
        this.persistRemoteAgent(card);
      } catch {
        // Ignore malformed persisted registrations.
      }
    }
  }

  private persistRemoteAgent(card: ACPAgentCard): void {
    if (!this.db) return;
    this.db
      .prepare(
        `INSERT INTO acp_agents (id, origin, endpoint, name, provider, status, registered_at, updated_at, card_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           endpoint = excluded.endpoint,
           name = excluded.name,
           provider = excluded.provider,
           status = excluded.status,
           updated_at = excluded.updated_at,
           card_json = excluded.card_json`,
      )
      .run(
        card.id,
        card.origin,
        card.endpoint || null,
        card.name,
        card.provider || null,
        card.status,
        card.registeredAt,
        Date.now(),
        JSON.stringify({ ...card, metadata: sanitizeRemoteMetadata(card.metadata) }),
      );
  }

  private deleteRemoteAgentFromDb(agentId: string): void {
    if (!this.db) return;
    this.db.prepare("DELETE FROM acp_agents WHERE id = ?").run(agentId);
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
      icon: role.icon,
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
    if (hasInlineRemoteSecret(params.metadata)) {
      throw new Error("Remote agent secrets must be stored securely and referenced with metadata.credentialRef");
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
      protocol: params.protocol || "cowork-legacy",
      endpoint: params.endpoint,
      origin: "remote",
      registeredAt: Date.now(),
      lastActiveAt: Date.now(),
      status: "available",
      metadata: sanitizeRemoteMetadata(params.metadata),
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
    if (this.durableMessages) {
      try {
        this.durableMessages.create({
          id: message.id,
          fromAgentId: message.from,
          toAgentId: message.to,
          kind: "fyi",
          contentType: message.contentType,
          body: message.body,
          data: message.data,
          correlationId: message.correlationId,
          replyTo: message.replyTo,
          sourceProtocol: "cowork-legacy",
          maxAttempts: 1,
          expiresAt: message.ttlMs && message.ttlMs > 0 ? message.timestamp + message.ttlMs : undefined,
        });
        this.durableMessages.capQueuedInbox(agentId, this.maxInboxSize, "cowork-legacy");
        return;
      } catch {
        // Lightweight ACP tests and old databases can fall back to the bounded in-memory inbox.
      }
    }
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
    if (this.durableMessages) {
      try {
        const durable = this.durableMessages.list({
          toAgentId: agentId,
          status: "queued",
          sourceProtocol: "cowork-legacy",
          order: "asc",
          limit: this.maxInboxSize,
        });
        if (drain) {
          for (const message of durable) this.durableMessages.complete(message.id);
        }
        return durable.map((message) => ({
          id: message.id,
          from: message.fromAgentId,
          to: message.toAgentId,
          contentType: message.contentType,
          body: message.body,
          data: message.data,
          correlationId: message.correlationId,
          replyTo: message.replyTo,
          timestamp: message.createdAt,
          ttlMs: message.expiresAt ? Math.max(0, message.expiresAt - message.createdAt) : undefined,
        }));
      } catch {
        // Fall through to the compatibility inbox when the durable schema is unavailable.
      }
    }
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
