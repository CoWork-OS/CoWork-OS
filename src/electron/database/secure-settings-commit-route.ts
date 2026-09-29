import path from "path";
import type { SecureSettingsCommitResult, SecureSettingsWrite } from "./secure-settings-sql";
import type {
  PulseClaimRequest,
  PulseClaimResult,
  PulseCommitRequest,
  PulseCommitResult,
} from "../telemetry/pulse-store-sql";

/**
 * The settings commands of the database worker client, as the settings domain uses
 * them. Structural on purpose: the repository and Pulse depend on this, not on the
 * worker client module and its whole command graph.
 */
export interface SettingsCommitClient {
  execute(
    name: "secureSettings.commit",
    args: { writes: SecureSettingsWrite[] },
  ): Promise<SecureSettingsCommitResult>;
  execute(name: "pulse.commit", args: PulseCommitRequest): Promise<PulseCommitResult>;
  execute(name: "pulse.claim", args: PulseClaimRequest): Promise<PulseClaimResult>;
}

/**
 * Where settings transactions commit for a database file (DB5): the database worker when
 * this run routes the settings domain there, otherwise the host connection. Keyed by
 * file, like deferred migrations, so the runtime can register the worker without the
 * repositories knowing about it.
 */
const clientsByPath = new Map<string, SettingsCommitClient>();

export function setSettingsCommitClient(
  dbPath: string | null,
  client: SettingsCommitClient | null,
): void {
  if (dbPath === null) clientsByPath.clear();
  else if (client) clientsByPath.set(path.resolve(dbPath), client);
  else clientsByPath.delete(path.resolve(dbPath));
}

export function settingsCommitClientFor(db: {
  name: string;
  memory: boolean;
}): SettingsCommitClient | null {
  if (clientsByPath.size === 0 || db.memory) return null;
  return clientsByPath.get(path.resolve(db.name)) ?? null;
}
