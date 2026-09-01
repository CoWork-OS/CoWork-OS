import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import type {
  PermissionEffect,
  PermissionRuleScope,
  RecurringApprovalRuleSummary,
} from "../../shared/types";
import { redactAgentSecurityRecord } from "./numbat/NumbatRedaction";

export const RECURRING_APPROVAL_POLICY_VERSION = "permission-operation-v1";
export const DEFAULT_RECURRING_APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const SENSITIVE_KEY =
  /(?:api[_-]?key|authorization|cookie|credential|password|private[_-]?key|secret|token)/i;

function safeCanonicalize(value: unknown, key?: string, hashSensitiveValues = false): unknown {
  if (key && SENSITIVE_KEY.test(key)) {
    return hashSensitiveValues
      ? `[REDACTED_HASH:${createHash("sha256")
          .update(JSON.stringify(value) ?? "undefined")
          .digest("hex")}]`
      : "[REDACTED]";
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return typeof value === "string" ? redactAgentSecurityRecord(value.trim()) : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => safeCanonicalize(item, undefined, hashSensitiveValues));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([entryKey, entryValue]) => [
          entryKey,
          safeCanonicalize(entryValue, entryKey, hashSensitiveValues),
        ]),
    );
  }
  return String(value);
}

export interface RecurringApprovalFingerprintInput {
  workspaceId: string;
  toolName: string;
  toolInput?: unknown;
  approvalType?: string;
  command?: string | null;
  path?: string | null;
  serverName?: string | null;
  scope: PermissionRuleScope;
  policyVersion?: string;
}

export interface RecurringApprovalCreateInput extends RecurringApprovalFingerprintInput {
  effect: Extract<PermissionEffect, "allow" | "deny">;
  scopePreview: string;
  expiresAt?: number;
  createdByApprovalId?: string;
  fingerprint?: string;
  operationJson?: string;
}

export interface RecurringApprovalMatch {
  summary: RecurringApprovalRuleSummary;
  operationJson: string;
}

export function canonicalizeRecurringApprovalOperation(
  input: RecurringApprovalFingerprintInput,
): string {
  return JSON.stringify(
    safeCanonicalize({
      approvalType: input.approvalType || null,
      command: input.command || null,
      path: input.path || null,
      scope: input.scope,
      serverName: input.serverName || null,
      toolInput: input.toolInput ?? null,
      toolName: input.toolName.trim(),
      workspaceId: input.workspaceId.trim(),
      policyVersion: input.policyVersion || RECURRING_APPROVAL_POLICY_VERSION,
    }),
  );
}

export function fingerprintRecurringApprovalOperation(
  input: RecurringApprovalFingerprintInput,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        safeCanonicalize(
          {
            approvalType: input.approvalType || null,
            command: input.command || null,
            path: input.path || null,
            scope: input.scope,
            serverName: input.serverName || null,
            toolInput: input.toolInput ?? null,
            toolName: input.toolName.trim(),
            workspaceId: input.workspaceId.trim(),
            policyVersion: input.policyVersion || RECURRING_APPROVAL_POLICY_VERSION,
          },
          undefined,
          true,
        ),
      ),
    )
    .digest("hex");
}

export class RecurringApprovalService {
  constructor(private readonly db: Database.Database) {}

  fingerprint(input: RecurringApprovalFingerprintInput): {
    fingerprint: string;
    operationJson: string;
    policyVersion: string;
  } {
    const policyVersion = input.policyVersion || RECURRING_APPROVAL_POLICY_VERSION;
    const normalizedInput = { ...input, policyVersion };
    return {
      fingerprint: fingerprintRecurringApprovalOperation(normalizedInput),
      operationJson: canonicalizeRecurringApprovalOperation(normalizedInput),
      policyVersion,
    };
  }

  findActive(
    input: RecurringApprovalFingerprintInput,
    now = Date.now(),
  ): RecurringApprovalMatch | null {
    const { fingerprint } = this.fingerprint(input);
    const row = this.db
      .prepare(
        `SELECT * FROM recurring_approval_rules
         WHERE fingerprint = ? AND revoked_at IS NULL AND expires_at > ?
         LIMIT 1`,
      )
      .get(fingerprint, now) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  create(input: RecurringApprovalCreateInput, now = Date.now()): RecurringApprovalRuleSummary {
    const computedIdentity = this.fingerprint(input);
    const identity = {
      fingerprint: input.fingerprint || computedIdentity.fingerprint,
      operationJson: input.operationJson || computedIdentity.operationJson,
      policyVersion: computedIdentity.policyVersion,
    };
    const id = uuidv4();
    const expiresAt =
      Number.isFinite(input.expiresAt) && Number(input.expiresAt) > now
        ? Number(input.expiresAt)
        : now + DEFAULT_RECURRING_APPROVAL_TTL_MS;
    this.db
      .prepare(
        `INSERT INTO recurring_approval_rules
          (id, fingerprint, tool_name, workspace_id, policy_version, effect, scope_preview,
           operation_json, created_at, expires_at, revoked_at, created_by_approval_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
         ON CONFLICT(fingerprint) DO UPDATE SET
           effect = excluded.effect,
           scope_preview = excluded.scope_preview,
           operation_json = excluded.operation_json,
           expires_at = excluded.expires_at,
           revoked_at = NULL,
           created_by_approval_id = excluded.created_by_approval_id`,
      )
      .run(
        id,
        identity.fingerprint,
        input.toolName.trim(),
        input.workspaceId.trim(),
        identity.policyVersion,
        input.effect,
        input.scopePreview.trim().slice(0, 500),
        identity.operationJson,
        now,
        expiresAt,
        input.createdByApprovalId || null,
      );
    const row = this.db
      .prepare("SELECT * FROM recurring_approval_rules WHERE fingerprint = ?")
      .get(identity.fingerprint) as Record<string, unknown>;
    return this.mapSummary(row);
  }

  list(
    options: { workspaceId?: string; includeRevoked?: boolean } = {},
  ): RecurringApprovalRuleSummary[] {
    const predicates = options.includeRevoked ? ["1 = 1"] : ["revoked_at IS NULL"];
    const values: unknown[] = [];
    if (options.workspaceId?.trim()) {
      predicates.push("workspace_id = ?");
      values.push(options.workspaceId.trim());
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM recurring_approval_rules
         WHERE ${predicates.join(" AND ")}
         ORDER BY created_at DESC
         LIMIT 500`,
      )
      .all(...values) as Record<string, unknown>[];
    return rows.map((row) => this.mapSummary(row));
  }

  revoke(id: string, now = Date.now()): boolean {
    const result = this.db
      .prepare(
        "UPDATE recurring_approval_rules SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
      )
      .run(now, id);
    return result.changes > 0;
  }

  private mapRow(row: Record<string, unknown>): RecurringApprovalMatch {
    return {
      summary: this.mapSummary(row),
      operationJson: String(row.operation_json || "{}"),
    };
  }

  private mapSummary(row: Record<string, unknown>): RecurringApprovalRuleSummary {
    return {
      id: String(row.id),
      fingerprint: String(row.fingerprint),
      toolName: String(row.tool_name),
      workspaceId: String(row.workspace_id),
      policyVersion: String(row.policy_version),
      effect: row.effect === "deny" ? "deny" : "allow",
      scopePreview: String(row.scope_preview),
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at),
      ...(row.revoked_at ? { revokedAt: Number(row.revoked_at) } : {}),
      ...(row.created_by_approval_id
        ? { createdByApprovalId: String(row.created_by_approval_id) }
        : {}),
    };
  }
}
