/**
 * Admin policy enforcement for MCP connectors (`connectors.blocked`).
 *
 * An administrator lists connector IDs in `connectors.blocked`. A configured MCP server is
 * blocked when any of its identities matches an entry: its server ID, its registry entry ID,
 * its known connector capability ID (e.g. "jira"), or its exact display name. The check is
 * applied when a server connects and again on every tool call, so a block takes effect even
 * for a server that was already connected when the policy changed.
 */

import { isConnectorBlocked, loadPolicies, type AdminPolicies } from "../admin/policies";
import { detectConnectorCapabilityId } from "./connectors/capabilities";
import type { MCPServerConfig } from "./types";

export const CONNECTOR_BLOCKED_ERROR_CODE = "CONNECTOR_BLOCKED_BY_POLICY";

type ConnectorIdentity = Pick<MCPServerConfig, "id" | "name"> &
  Partial<Pick<MCPServerConfig, "args" | "registryId">>;

/** Identifiers an administrator can list in `connectors.blocked` to block this server. */
export function getMcpServerConnectorIds(server: ConnectorIdentity): string[] {
  const ids = [
    server.id,
    server.registryId,
    detectConnectorCapabilityId({ name: server.name, args: server.args }),
    server.name,
  ];
  return Array.from(
    new Set(ids.map((id) => String(id || "").trim()).filter((id) => id.length > 0)),
  );
}

/** Returns the identifier that blocks this server, or null when the policy allows it. */
export function findBlockedConnectorId(
  server: ConnectorIdentity,
  policies?: AdminPolicies,
): string | null {
  const p = policies || loadPolicies();
  if (p.connectors.blocked.length === 0) return null;
  return getMcpServerConnectorIds(server).find((id) => isConnectorBlocked(id, p)) ?? null;
}

export function connectorBlockedMessage(
  server: Pick<MCPServerConfig, "name">,
  blockedId: string,
): string {
  const label = String(server.name || "").trim() || blockedId;
  return `Connector "${label}" is blocked by your administrator (admin policy connectors.blocked includes "${blockedId}").`;
}

export class ConnectorBlockedError extends Error {
  readonly code = CONNECTOR_BLOCKED_ERROR_CODE;

  constructor(
    readonly serverId: string,
    readonly connectorId: string,
    message: string,
  ) {
    super(message);
    this.name = "ConnectorBlockedError";
  }
}

export function isConnectorBlockedError(error: unknown): error is ConnectorBlockedError {
  return (
    error instanceof ConnectorBlockedError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === CONNECTOR_BLOCKED_ERROR_CODE)
  );
}

/** Throws a ConnectorBlockedError when admin policy blocks this server. */
export function assertMcpServerNotBlocked(
  server: ConnectorIdentity,
  policies?: AdminPolicies,
): void {
  const blockedId = findBlockedConnectorId(server, policies);
  if (blockedId) {
    throw new ConnectorBlockedError(
      server.id,
      blockedId,
      connectorBlockedMessage(server, blockedId),
    );
  }
}

/** Generic wording for surfaces that must not echo server names or policy contents. */
export const CONNECTOR_BLOCKED_PUBLIC_MESSAGE = "This connector is blocked by your administrator.";

/**
 * Refuses turning a blocked server on. Turning it off, or editing a server that is already
 * enabled, stays allowed so users can still tidy up their configuration.
 */
export function assertMcpServerEnableAllowed(
  current: { enabled?: boolean } | undefined,
  next: ConnectorIdentity & { enabled?: boolean },
  policies?: AdminPolicies,
): void {
  if (next.enabled !== true || current?.enabled === true) return;
  assertMcpServerNotBlocked(next, policies);
}
