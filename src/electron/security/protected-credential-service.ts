import Database from "better-sqlite3";
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
    const vault = this.loadVault();
    const existing = request.credential_id
      ? vault.credentials.find((credential) => credential.id === request.credential_id)
      : undefined;
    const credential: ProtectedCredentialRecord = {
      id: existing?.id || uuidv4(),
      name: String(request.name),
      value,
      destinationAllowlist: this.parseAllowlist(request.destination_allowlist_json),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      ...(existing?.lastUsedAt ? { lastUsedAt: existing.lastUsedAt } : {}),
    };
    const nextCredentials = vault.credentials.filter((item) => item.id !== credential.id);
    nextCredentials.push(credential);
    this.saveVault({ version: 1, credentials: nextCredentials });
    this.db
      .prepare(
        "UPDATE protected_credential_requests SET status = 'fulfilled', resolved_at = ?, credential_id = ? WHERE id = ?",
      )
      .run(now, credential.id, requestId);
    this.recordAudit({ requestId, credentialId: credential.id, action: "fulfilled" }, now);
    return this.toSummary(credential);
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

  revokeCredential(credentialId: string, now = Date.now()): boolean {
    const vault = this.loadVault();
    const credential = vault.credentials.find((item) => item.id === credentialId);
    if (!credential || credential.revokedAt) return false;
    credential.revokedAt = now;
    credential.updatedAt = now;
    this.saveVault(vault);
    this.recordAudit({ credentialId, action: "revoked" }, now);
    return true;
  }

  /** Resolve only inside the main process immediately before a destination-bound request. */
  resolveForDestination(credentialId: string, destination: string, now = Date.now()): string {
    const host = destinationHost(destination);
    const vault = this.loadVault();
    const credential = vault.credentials.find((item) => item.id === credentialId);
    if (!credential || credential.revokedAt) throw new Error("Credential is unavailable.");
    if (!credential.destinationAllowlist.includes(host)) {
      this.recordAudit({ credentialId, destination: host, action: "blocked_destination" }, now);
      throw new Error("Credential is not authorized for this destination.");
    }
    credential.lastUsedAt = now;
    credential.updatedAt = now;
    this.saveVault(vault);
    this.recordAudit({ credentialId, destination: host, action: "resolved" }, now);
    return credential.value;
  }

  private loadVault(): ProtectedCredentialVault {
    const stored = this.secureStore.load<ProtectedCredentialVault>(CATEGORY);
    if (!stored || stored.version !== 1 || !Array.isArray(stored.credentials)) {
      return { version: 1, credentials: [] };
    }
    return stored;
  }

  private saveVault(vault: ProtectedCredentialVault): void {
    this.secureStore.save(CATEGORY, vault);
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
