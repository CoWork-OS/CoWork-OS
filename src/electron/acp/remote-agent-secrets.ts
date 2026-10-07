/**
 * Credentials for remote ACP agents.
 *
 * A registration may carry `metadata.authorizationHeader` or `metadata.bearerToken`,
 * which RemoteAgentInvoker turns into the Authorization header. Agent cards are
 * persisted as plaintext JSON (`acp_agents.card_json`) and returned to Control Plane
 * clients, so these values never stay on a card: they are kept in
 * SecureSettingsRepository (safeStorage-encrypted) keyed by agent id, and the card
 * carries only a non-secret reference. The invoker resolves the values at request time.
 */

import {
  DELETE_SECURE_SETTINGS,
  SecureSettingsRepository,
} from "../database/SecureSettingsRepository";
import { ACPEvents, ACPMethods, type ACPAgentCard } from "./types";

export const ACP_REMOTE_AGENT_SECRETS_CATEGORY = "acp-remote-agent-secrets" as const;

/** Card metadata fields the invoker turns into an Authorization header. */
export const REMOTE_AGENT_SECRET_FIELDS = ["authorizationHeader", "bearerToken"] as const;
export type RemoteAgentSecretField = (typeof REMOTE_AGENT_SECRET_FIELDS)[number];
export type RemoteAgentSecrets = Partial<Record<RemoteAgentSecretField, string>>;

/** Card metadata key holding the non-secret pointer to the stored credentials. */
export const REMOTE_AGENT_SECRET_REF_KEY = "credentialRef";

export interface RemoteAgentSecretRef {
  store: "secure-settings";
  category: typeof ACP_REMOTE_AGENT_SECRETS_CATEGORY;
  agentId: string;
  fields: RemoteAgentSecretField[];
}

export interface RemoteAgentSecretStore {
  get(agentId: string): RemoteAgentSecrets | undefined;
  set(agentId: string, secrets: RemoteAgentSecrets): void;
  delete(agentId: string): void;
}

/** Resolves an agent's credentials when a request is sent. */
export type RemoteAgentSecretResolver = (
  agent: ACPAgentCard,
) => RemoteAgentSecrets | undefined | Promise<RemoteAgentSecrets | undefined>;

interface SecretDocument {
  version: 1;
  agents: Record<string, RemoteAgentSecrets>;
}

function pickSecrets(value: unknown): RemoteAgentSecrets {
  const secrets: RemoteAgentSecrets = {};
  if (!value || typeof value !== "object") return secrets;
  for (const field of REMOTE_AGENT_SECRET_FIELDS) {
    const entry = (value as Record<string, unknown>)[field];
    if (typeof entry === "string" && entry.trim()) secrets[field] = entry.trim();
  }
  return secrets;
}

export function remoteAgentSecretFields(secrets: RemoteAgentSecrets): RemoteAgentSecretField[] {
  return REMOTE_AGENT_SECRET_FIELDS.filter((field) => Boolean(secrets[field]));
}

function requireSecureSettings(): SecureSettingsRepository {
  if (!SecureSettingsRepository.isInitialized()) {
    throw new Error(
      "Secure settings are not initialized; ACP remote agent credentials cannot be stored or read",
    );
  }
  return SecureSettingsRepository.getInstance();
}

/** safeStorage-backed store: one secure-settings category, keyed by agent id. */
export class SecureSettingsRemoteAgentSecretStore implements RemoteAgentSecretStore {
  constructor(
    private readonly repository: () => SecureSettingsRepository = requireSecureSettings,
  ) {}

  get(agentId: string): RemoteAgentSecrets | undefined {
    const result = this.repository().loadWithStatus<SecretDocument>(
      ACP_REMOTE_AGENT_SECRETS_CATEGORY,
    );
    if (result.status === "not_found") return undefined;
    if (result.status !== "success") {
      throw new Error(`ACP remote agent credentials are unreadable (${result.status})`);
    }
    const agents = result.data?.agents;
    if (!agents || !Object.prototype.hasOwnProperty.call(agents, agentId)) return undefined;
    const secrets = pickSecrets(agents[agentId]);
    return remoteAgentSecretFields(secrets).length > 0 ? secrets : undefined;
  }

  set(agentId: string, secrets: RemoteAgentSecrets): void {
    const stored = pickSecrets(secrets);
    if (remoteAgentSecretFields(stored).length === 0) {
      this.delete(agentId);
      return;
    }
    // `update` throws instead of reporting a refused write as saved, so a credential is
    // never silently dropped (and never falls back to plaintext).
    this.repository().update<SecretDocument>(ACP_REMOTE_AGENT_SECRETS_CATEGORY, (current) => ({
      version: 1,
      agents: { ...current?.agents, [agentId]: stored },
    }));
  }

  delete(agentId: string): void {
    this.repository().update<SecretDocument>(ACP_REMOTE_AGENT_SECRETS_CATEGORY, (current) => {
      if (!current?.agents || !Object.prototype.hasOwnProperty.call(current.agents, agentId)) {
        return undefined;
      }
      const { [agentId]: _removed, ...rest } = current.agents;
      return Object.keys(rest).length > 0 ? { version: 1, agents: rest } : DELETE_SECURE_SETTINGS;
    });
  }
}

let defaultStore: RemoteAgentSecretStore | null = null;

export function getDefaultRemoteAgentSecretStore(): RemoteAgentSecretStore {
  defaultStore ??= new SecureSettingsRemoteAgentSecretStore();
  return defaultStore;
}

/**
 * Split credential fields out of agent metadata. Any caller-supplied credential
 * reference is dropped too: only the registry writes one, for the agent's own id.
 */
export function extractRemoteAgentSecrets(metadata: Record<string, unknown> | undefined): {
  secrets: RemoteAgentSecrets;
  metadata: Record<string, unknown> | undefined;
} {
  if (!metadata || typeof metadata !== "object") return { secrets: {}, metadata };
  const secrets = pickSecrets(metadata);
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if ((REMOTE_AGENT_SECRET_FIELDS as readonly string[]).includes(key)) continue;
    if (key === REMOTE_AGENT_SECRET_REF_KEY) continue;
    rest[key] = value;
  }
  return { secrets, metadata: rest };
}

export function withRemoteAgentSecretRef(
  metadata: Record<string, unknown> | undefined,
  agentId: string,
  fields: RemoteAgentSecretField[],
): Record<string, unknown> {
  const ref: RemoteAgentSecretRef = {
    store: "secure-settings",
    category: ACP_REMOTE_AGENT_SECRETS_CATEGORY,
    agentId,
    fields: [...fields],
  };
  return { ...metadata, [REMOTE_AGENT_SECRET_REF_KEY]: ref };
}

/** The card's credential reference, when it is well formed and points at the card itself. */
export function getRemoteAgentSecretRef(agent: ACPAgentCard): RemoteAgentSecretRef | undefined {
  const raw = agent.metadata?.[REMOTE_AGENT_SECRET_REF_KEY];
  if (!raw || typeof raw !== "object") return undefined;
  const ref = raw as Record<string, unknown>;
  // A local keeps the array narrowing inside the filter callback.
  const refFields = ref.fields;
  if (
    ref.store !== "secure-settings" ||
    ref.category !== ACP_REMOTE_AGENT_SECRETS_CATEGORY ||
    ref.agentId !== agent.id ||
    !Array.isArray(refFields)
  ) {
    return undefined;
  }
  const fields = REMOTE_AGENT_SECRET_FIELDS.filter((field) => refFields.includes(field));
  if (fields.length === 0) return undefined;
  return {
    store: "secure-settings",
    category: ACP_REMOTE_AGENT_SECRETS_CATEGORY,
    agentId: agent.id,
    fields,
  };
}

/** True when a card still holds credential fields in its metadata (pre-migration data). */
export function hasPlaintextRemoteAgentSecrets(agent: ACPAgentCard): boolean {
  const metadata = agent.metadata;
  if (!metadata || typeof metadata !== "object") return false;
  return REMOTE_AGENT_SECRET_FIELDS.some((field) => field in metadata);
}

/**
 * Default resolver: reads the secure-settings store, by the card's own id, only for
 * remote cards that carry a credential reference. Never reads the card's metadata values.
 */
export function createRemoteAgentSecretResolver(
  store: RemoteAgentSecretStore = getDefaultRemoteAgentSecretStore(),
): RemoteAgentSecretResolver {
  return (agent) => {
    if (agent.origin !== "remote" || !getRemoteAgentSecretRef(agent)) return undefined;
    return store.get(agent.id);
  };
}

// ===== Public (Control Plane / renderer) projection =====

const SECRET_KEY_SUFFIXES = [
  "token",
  "secret",
  "password",
  "passwd",
  "apikey",
  "privatekey",
  "authorization",
  "authorizationheader",
  "cookie",
];
const MAX_PUBLIC_METADATA_DEPTH = 8;

function isSecretLikeKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return SECRET_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function sanitizePublicValue(value: unknown, depth: number): unknown {
  if (!value || typeof value !== "object") return value;
  if (depth >= MAX_PUBLIC_METADATA_DEPTH) return undefined;
  if (Array.isArray(value)) return value.map((entry) => sanitizePublicValue(entry, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isSecretLikeKey(key)) continue;
    out[key] = sanitizePublicValue(entry, depth + 1);
  }
  return out;
}

/**
 * The card as Control Plane clients and the renderer may see it: credential fields and
 * other secret-looking metadata keys removed, and the credential reference rebuilt from
 * its validated shape so it cannot carry anything else.
 */
export function toPublicAgentCard(agent: ACPAgentCard): ACPAgentCard {
  if (!agent.metadata || typeof agent.metadata !== "object") return { ...agent };
  const ref = getRemoteAgentSecretRef(agent);
  const { [REMOTE_AGENT_SECRET_REF_KEY]: _ref, ...rest } = agent.metadata;
  const metadata = sanitizePublicValue(rest, 0) as Record<string, unknown>;
  if (ref) metadata[REMOTE_AGENT_SECRET_REF_KEY] = ref;
  return { ...agent, metadata };
}

const ACP_AGENT_PAYLOAD_NAMES = new Set<string>([
  ...Object.values(ACPMethods),
  ...Object.values(ACPEvents),
]);

function isAgentCardLike(value: unknown): value is ACPAgentCard {
  return (
    Boolean(value) && typeof value === "object" && typeof (value as ACPAgentCard).id === "string"
  );
}

/**
 * Strip agent-card secrets from an ACP method result or event payload before it is
 * forwarded to the renderer (e.g. from a remote device that predates this redaction).
 * Payloads of other methods and events are returned unchanged.
 */
export function redactAcpControlPlanePayload(name: string, payload: unknown): unknown {
  if (!ACP_AGENT_PAYLOAD_NAMES.has(name) || !payload || typeof payload !== "object") {
    return payload;
  }
  const source = payload as Record<string, unknown>;
  let next: Record<string, unknown> | null = null;
  if (isAgentCardLike(source.agent)) {
    next = { ...source, agent: toPublicAgentCard(source.agent) };
  }
  if (Array.isArray(source.agents)) {
    next = {
      ...(next ?? source),
      agents: source.agents.map((agent) =>
        isAgentCardLike(agent) ? toPublicAgentCard(agent) : agent,
      ),
    };
  }
  return next ?? payload;
}
