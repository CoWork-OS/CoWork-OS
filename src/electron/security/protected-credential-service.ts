import type Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import type {
  ProtectedCredentialRequestSummary,
  ProtectedCredentialSummary,
} from "../../shared/types";
import {
  SecureSettingsRepository,
  type SettingsCategory,
} from "../database/SecureSettingsRepository";

const CATEGORY: SettingsCategory = "protected-credentials";
const DEFAULT_REQUEST_TTL_MS = 10 * 60 * 1000;
const MAX_SECRET_LENGTH = 16_384;

interface ProtectedCredentialRecord {
  id: string;
  name: string;
  value: string;
  destinationAllowlist: string[];
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
  revokedAt?: number;
}

interface ProtectedCredentialVault {
  version: 1;
  credentials: ProtectedCredentialRecord[];
}

export interface ProtectedCredentialRequestInput {
  taskId?: string;
  name: string;
  destinationAllowlist: string[];
  expiresAt?: number;
}

export interface ProtectedCredentialStoreLike {
  load<T extends object>(category: SettingsCategory): T | undefined;
  save<T extends object>(category: SettingsCategory, settings: T): void;
  /**
   * Revision-checked read-modify-write, optionally together with one SQL change
   * (`SecureSettingsRepository.updateWithin`, DB5). Stores without it fall back to
   * load and save, which a concurrent writer can overwrite.
   */
  updateWithin?<T extends object>(
    category: SettingsCategory,
    mutate: (current: T | undefined) => T | undefined,
    alsoApply: (db: Database.Database) => boolean,
  ): { value: T | undefined; revision: number | null } | null;
}

function normalizeDestination(value: string): string {
  const raw = value.trim();
  if (!raw || raw === "*") throw new Error("Credential destinations must name a specific host.");
  const candidate = raw.includes("://") ? raw : `https://${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`Invalid credential destination: ${raw}`);
  }
  if (!parsed.hostname || !["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`Credential destination must be an HTTP(S) host: ${raw}`);
  }
  return parsed.hostname.toLowerCase();
}

function normalizeAllowlist(values: string[]): string[] {
  const unique = new Set(values.map(normalizeDestination));
  if (unique.size === 0 || unique.size > 20) {
    throw new Error("Credential destination allowlist must contain 1 to 20 hosts.");
  }
  return [...unique].sort();
}

function normalizeVault(stored: ProtectedCredentialVault | undefined): ProtectedCredentialVault {
  if (!stored || stored.version !== 1 || !Array.isArray(stored.credentials)) {
    return { version: 1, credentials: [] };
  }
  return stored;
}

function destinationHost(value: string): string {
  return normalizeDestination(value);
}

export class ProtectedCredentialService {
  private readonly secureStore: ProtectedCredentialStoreLike;

  constructor(
    private readonly db: Database.Database,
    secureStore?: ProtectedCredentialStoreLike,
  ) {
    this.secureStore =
      secureStore ||
      (SecureSettingsRepository.isInitialized()
        ? SecureSettingsRepository.getInstance()
        : new SecureSettingsRepository(db));
  }

  createRequest(
    input: ProtectedCredentialRequestInput,
    now = Date.now(),
  ): ProtectedCredentialRequestSummary {
    const name = input.name.trim();
    if (!name || name.length > 200) throw new Error("Credential name must be 1 to 200 characters.");
    const expiresAt =
      Number.isFinite(input.expiresAt) && Number(input.expiresAt) > now
        ? Number(input.expiresAt)
        : now + DEFAULT_REQUEST_TTL_MS;
    const id = uuidv4();
    this.db
      .prepare(
        `INSERT INTO protected_credential_requests
          (id, task_id, name, destination_allowlist_json, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        id,
        input.taskId?.trim() || null,
        name,
        JSON.stringify(normalizeAllowlist(input.destinationAllowlist)),
        now,
        expiresAt,
      );
    this.recordAudit({ requestId: id, action: "requested" }, now);
    return this.getRequest(id, now) as ProtectedCredentialRequestSummary;
  }

  fulfillRequest(requestId: string, value: string, now = Date.now()): ProtectedCredentialSummary {
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_SECRET_LENGTH) {
      throw new Error(`Credential value must be 1 to ${MAX_SECRET_LENGTH} characters.`);
    }
    const request = this.getRequestRow(requestId);
    if (!request) throw new Error("Credential request not found.");
    if (request.status !== "pending") throw new Error("Credential request is no longer pending.");
    if (Number(request.expires_at) <= now) {
      this.db
        .prepare(
          "UPDATE protected_credential_requests SET status = 'expired', resolved_at = ? WHERE id = ?",
        )
        .run(now, requestId);
      throw new Error("Credential request has expired.");
    }
    const newCredentialId = uuidv4();
    let credential: ProtectedCredentialRecord | null = null;
    // The vault and the request change together (DB5): the credential lands only
    // while the request is still pending, and a concurrent vault edit is kept.
    const applied = this.updateVault(
      (vault) => {
        const existing = request.credential_id
          ? vault.credentials.find((item) => item.id === request.credential_id)
          : undefined;
        credential = {
          id: existing?.id || newCredentialId,
          name: String(request.name),
          value,
          destinationAllowlist: this.parseAllowlist(request.destination_allowlist_json),
          createdAt: existing?.createdAt || now,
          updatedAt: now,
          ...(existing?.lastUsedAt ? { lastUsedAt: existing.lastUsedAt } : {}),
        };
        const fulfilled = credential;
        return {
          version: 1,
          credentials: [...vault.credentials.filter((item) => item.id !== fulfilled.id), fulfilled],
        };
      },
      (db) =>
        db
          .prepare(
            `UPDATE protected_credential_requests SET status = 'fulfilled', resolved_at = ?, credential_id = ?
             WHERE id = ? AND status = 'pending'`,
          )
          .run(now, credential!.id, requestId).changes > 0,
    );
    if (!applied || !credential) throw new Error("Credential request is no longer pending.");
    const stored: ProtectedCredentialRecord = credential;
    this.recordAudit({ requestId, credentialId: stored.id, action: "fulfilled" }, now);
    return this.toSummary(stored);
  }

  denyRequest(requestId: string, now = Date.now()): boolean {
    const result = this.db
      .prepare(
        "UPDATE protected_credential_requests SET status = 'denied', resolved_at = ? WHERE id = ? AND status = 'pending'",
      )
      .run(now, requestId);
    if (result.changes > 0) this.recordAudit({ requestId, action: "denied" }, now);
    return result.changes > 0;
  }

  listRequests(
    options: { taskId?: string; includeResolved?: boolean } = {},
    now = Date.now(),
  ): ProtectedCredentialRequestSummary[] {
    this.expirePending(now);
    const predicates = options.includeResolved ? ["1 = 1"] : ["status = 'pending'"];
    const values: unknown[] = [];
    if (options.taskId?.trim()) {
      predicates.push("task_id = ?");
      values.push(options.taskId.trim());
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM protected_credential_requests
         WHERE ${predicates.join(" AND ")}
         ORDER BY created_at DESC LIMIT 200`,
      )
      .all(...values) as Record<string, unknown>[];
    return rows.map((row) => this.mapRequest(row));
  }

  listCredentials(): ProtectedCredentialSummary[] {
    return this.loadVault().credentials.map((credential) => this.toSummary(credential));
  }

  /** Revoke under a revision check; throws when the write is refused (never a silent true). */
  revokeCredential(credentialId: string, now = Date.now()): boolean {
    let revoked = false;
    this.updateVault((vault) => {
      revoked = false;
      const credential = vault.credentials.find((item) => item.id === credentialId);
      if (!credential || credential.revokedAt) return undefined;
      credential.revokedAt = now;
      credential.updatedAt = now;
      revoked = true;
      return vault;
    });
    if (revoked) this.recordAudit({ credentialId, action: "revoked" }, now);
    return revoked;
  }

  /** Resolve only inside the main process immediately before a destination-bound request. */
  resolveForDestination(credentialId: string, destination: string, now = Date.now()): string {
    const host = destinationHost(destination);
    // Decided on the latest stored vault (DB5): a revocation by any writer applies
    // here, and recording lastUsedAt can never write an older vault over it.
    let outcome: { value: string } | "unavailable" | "blocked" = "unavailable";
    const record = (vault: ProtectedCredentialVault) => {
      const credential = vault.credentials.find((item) => item.id === credentialId);
      if (!credential || credential.revokedAt) {
        outcome = "unavailable";
        return undefined;
      }
      if (!credential.destinationAllowlist.includes(host)) {
        outcome = "blocked";
        return undefined;
      }
      outcome = { value: credential.value };
      credential.lastUsedAt = now;
      credential.updatedAt = now;
      return vault;
    };
    try {
      this.updateVault(record);
    } catch (error) {
      // Usage bookkeeping cannot be written (the keychain key changed): the decision
      // still comes from the current stored vault, read fresh.
      if ((error as { code?: string })?.code !== "settings_write_refused") throw error;
      record(this.loadVault());
    }
    const resolved = outcome as { value: string } | "unavailable" | "blocked";
    if (resolved === "unavailable") throw new Error("Credential is unavailable.");
    if (resolved === "blocked") {
      this.recordAudit({ credentialId, destination: host, action: "blocked_destination" }, now);
      throw new Error("Credential is not authorized for this destination.");
    }
    this.recordAudit({ credentialId, destination: host, action: "resolved" }, now);
    return resolved.value;
  }

  private loadVault(): ProtectedCredentialVault {
    return normalizeVault(this.secureStore.load<ProtectedCredentialVault>(CATEGORY));
  }

  /**
   * Apply `mutate` to the latest vault (it may run more than once on a conflict, so it
   * must derive everything from its argument); `undefined` leaves the vault unchanged.
   * With `alsoApply`, that SQL change commits in the same transaction and a false
   * result aborts both (returns false).
   */
  private updateVault(
    mutate: (vault: ProtectedCredentialVault) => ProtectedCredentialVault | undefined,
    alsoApply: (db: Database.Database) => boolean = () => true,
  ): boolean {
    if (this.secureStore.updateWithin) {
      return (
        this.secureStore.updateWithin<ProtectedCredentialVault>(
          CATEGORY,
          (current) => mutate(normalizeVault(current)),
          alsoApply,
        ) !== null
      );
    }
    const next = mutate(this.loadVault());
    if (!alsoApply(this.db)) return false;
    if (next) this.secureStore.save(CATEGORY, next);
    return true;
  }

  /** The task a credential request belongs to, for authorizing actions on it. */
  requestTaskId(requestId: string): string | undefined {
    const row = this.getRequestRow(requestId);
    return typeof row?.task_id === "string" && row.task_id ? row.task_id : undefined;
  }

  private getRequestRow(id: string): Record<string, unknown> | undefined {
    return this.db.prepare("SELECT * FROM protected_credential_requests WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
  }

  private getRequest(id: string, now = Date.now()): ProtectedCredentialRequestSummary | null {
    const row = this.getRequestRow(id);
    if (!row) return null;
    if (row.status === "pending" && Number(row.expires_at) <= now) {
      this.expirePending(now);
      return this.getRequest(id, now);
    }
    return this.mapRequest(row);
  }

  private expirePending(now: number): void {
    const expired = this.db
      .prepare(
        "UPDATE protected_credential_requests SET status = 'expired', resolved_at = ? WHERE status = 'pending' AND expires_at <= ?",
      )
      .run(now, now);
    if (expired.changes > 0) {
      const rows = this.db
        .prepare(
          "SELECT id FROM protected_credential_requests WHERE status = 'expired' AND resolved_at = ?",
        )
        .all(now) as Array<{ id: string }>;
      for (const row of rows) this.recordAudit({ requestId: row.id, action: "expired" }, now);
    }
  }

  private recordAudit(
    input: { requestId?: string; credentialId?: string; action: string; destination?: string },
    now: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO protected_credential_audit
          (id, request_id, credential_id, action, destination, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        uuidv4(),
        input.requestId || null,
        input.credentialId || null,
        input.action,
        input.destination || null,
        now,
      );
  }

  private parseAllowlist(value: unknown): string[] {
    try {
      const parsed = JSON.parse(String(value || "[]"));
      return normalizeAllowlist(Array.isArray(parsed) ? parsed.map(String) : []);
    } catch {
      throw new Error("Stored credential destination policy is invalid.");
    }
  }

  private mapRequest(row: Record<string, unknown>): ProtectedCredentialRequestSummary {
    return {
      id: String(row.id),
      ...(row.task_id ? { taskId: String(row.task_id) } : {}),
      name: String(row.name),
      destinationAllowlist: this.parseAllowlist(row.destination_allowlist_json),
      status: ["pending", "fulfilled", "denied", "expired"].includes(String(row.status))
        ? (String(row.status) as ProtectedCredentialRequestSummary["status"])
        : "expired",
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at),
      ...(row.resolved_at ? { resolvedAt: Number(row.resolved_at) } : {}),
      ...(row.credential_id ? { credentialId: String(row.credential_id) } : {}),
    };
  }

  private toSummary(credential: ProtectedCredentialRecord): ProtectedCredentialSummary {
    return {
      id: credential.id,
      name: credential.name,
      destinationAllowlist: [...credential.destinationAllowlist],
      createdAt: credential.createdAt,
      updatedAt: credential.updatedAt,
      ...(credential.lastUsedAt ? { lastUsedAt: credential.lastUsedAt } : {}),
      ...(credential.revokedAt ? { revokedAt: credential.revokedAt } : {}),
    };
  }
}
