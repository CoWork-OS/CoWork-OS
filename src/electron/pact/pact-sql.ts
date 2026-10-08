import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  PactAuthorizationState,
  PactConversationState,
  PactEffectClass,
  PactEvidenceStatus,
  PactGrantState,
  PactProfile,
} from "../../shared/pact";
import type {
  PactAuthorizationRecord,
  PactBusinessDescriptor,
  PactBusinessRecord,
  PactConversationRecord,
  PactGrantRecord,
  PactMessageKind,
  PactMessageRecord,
  PactMessageState,
  PactProviderReadiness,
  PactProviderRecord,
  PactReceiptRecord,
  PactRegistrationStatus,
  PactSubjectBindingRecord,
} from "./types";

/**
 * PACT persistence (plan §8): a synchronous store whose methods run as services-domain units,
 * so each method's reads and writes share one transaction on either the host or the worker.
 * Every argument and result is JSON. Leases are compare-and-set updates so two runtimes on one
 * profile cannot send the same turn or poll the same device code.
 */

type Row = Record<string, unknown>;

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

const str = (value: unknown): string => String(value ?? "");
const strOrNull = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);
const numOrNull = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

function mapProvider(row: Row): PactProviderRecord {
  return {
    id: str(row.id),
    origin: str(row.origin),
    audience: strOrNull(row.audience),
    issuer: strOrNull(row.issuer),
    metadataUrl: strOrNull(row.metadata_url),
    registrationStatus: str(row.registration_status) as PactRegistrationStatus,
    readiness: str(row.readiness) as PactProviderReadiness,
    readinessReason: strOrNull(row.readiness_reason),
    configRevision: Number(row.config_revision),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapBusiness(row: Row): PactBusinessRecord {
  return {
    id: str(row.id),
    cardUrl: str(row.card_url),
    displayName: str(row.display_name),
    originChain: parseJson<string[]>(row.origin_chain_json, []),
    providerId: str(row.provider_id),
    interfaceUrl: str(row.interface_url),
    profile: str(row.profile) as PactProfile,
    supportStatus: str(row.support_status) as "supported" | "unsupported",
    unsupportedReason: strOrNull(row.unsupported_reason),
    cardFingerprint: str(row.card_fingerprint),
    securityFingerprint: str(row.security_fingerprint),
    descriptor: parseJson<PactBusinessDescriptor>(row.descriptor_json, {
      description: "",
      identitySchemeName: "",
      skills: [],
    }),
    revision: Number(row.revision),
    fetchedAt: Number(row.fetched_at),
    expiresAt: Number(row.expires_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapBinding(row: Row): PactSubjectBindingRecord {
  return {
    id: str(row.id),
    principalId: str(row.principal_id),
    deployment: str(row.deployment) as PactSubjectBindingRecord["deployment"],
    issuer: str(row.issuer),
    subject: str(row.subject),
    revision: Number(row.revision),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapGrant(row: Row): PactGrantRecord {
  return {
    id: str(row.id),
    principalId: str(row.principal_id),
    subjectBindingId: str(row.subject_binding_id),
    businessId: str(row.business_id),
    interfaceUrl: str(row.interface_url),
    authorizationServer: str(row.authorization_server),
    accountBinding: strOrNull(row.account_binding),
    remoteGrantId: strOrNull(row.remote_grant_id),
    scopes: parseJson<string[]>(row.scopes_json, []),
    state: str(row.state) as PactGrantState,
    stateReason: strOrNull(row.state_reason),
    secretRef: str(row.secret_ref),
    accessExpiresAt: numOrNull(row.access_expires_at),
    grantExpiresAt: numOrNull(row.grant_expires_at),
    secretRevision: Number(row.secret_revision),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    lastUsedAt: numOrNull(row.last_used_at),
  };
}

function mapConversation(row: Row): PactConversationRecord {
  return {
    id: str(row.id),
    principalId: str(row.principal_id),
    subjectBindingId: str(row.subject_binding_id),
    businessId: str(row.business_id),
    accountBinding: strOrNull(row.account_binding),
    contextId: strOrNull(row.context_id),
    taskId: strOrNull(row.task_id),
    sessionId: strOrNull(row.session_id),
    workspaceId: strOrNull(row.workspace_id),
    state: str(row.state) as PactConversationState,
    stateReason: strOrNull(row.state_reason),
    contextAttempts: Number(row.context_attempts),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapMessage(row: Row): PactMessageRecord {
  return {
    id: str(row.id),
    conversationId: str(row.conversation_id),
    operationId: str(row.operation_id),
    seq: Number(row.seq),
    wireMessageId: str(row.wire_message_id),
    kind: str(row.kind) as PactMessageKind,
    bodyText: str(row.body_text),
    bodyDigest: str(row.body_digest),
    effectClass: str(row.effect_class) as PactEffectClass,
    requiredScopes: parseJson<string[]>(row.required_scopes_json, []),
    authorityFingerprint: str(row.authority_fingerprint),
    cardRevision: Number(row.card_revision),
    providerRevision: Number(row.provider_revision),
    grantId: strOrNull(row.grant_id),
    attempt: Number(row.attempt),
    leaseOwner: strOrNull(row.lease_owner),
    leaseExpiresAt: numOrNull(row.lease_expires_at),
    state: str(row.state) as PactMessageState,
    stateReason: strOrNull(row.state_reason),
    replyText: strOrNull(row.reply_text),
    replyMessageId: strOrNull(row.reply_message_id),
    evidence: str(row.evidence) as PactEvidenceStatus,
    receiptId: strOrNull(row.receipt_id),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapAuthorization(row: Row): PactAuthorizationRecord {
  return {
    id: str(row.id),
    inputRequestId: strOrNull(row.input_request_id),
    taskId: strOrNull(row.task_id),
    workspaceId: strOrNull(row.workspace_id),
    principalId: str(row.principal_id),
    subjectBindingId: str(row.subject_binding_id),
    businessId: str(row.business_id),
    conversationId: strOrNull(row.conversation_id),
    operationId: strOrNull(row.operation_id),
    purpose: str(row.purpose),
    requestedScopes: parseJson<string[]>(row.requested_scopes_json, []),
    grantedScopes:
      row.granted_scopes_json === null || row.granted_scopes_json === undefined
        ? null
        : parseJson<string[]>(row.granted_scopes_json, []),
    state: str(row.state) as PactAuthorizationState,
    stateReason: strOrNull(row.state_reason),
    expiresAt: Number(row.expires_at),
    intervalSeconds: Number(row.interval_seconds),
    secretRef: str(row.secret_ref),
    leaseOwner: strOrNull(row.lease_owner),
    leaseExpiresAt: numOrNull(row.lease_expires_at),
    grantId: strOrNull(row.grant_id),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapReceipt(row: Row): PactReceiptRecord {
  return {
    id: str(row.id),
    messageId: str(row.message_id),
    conversationId: str(row.conversation_id),
    contextId: strOrNull(row.context_id),
    jwsDigest: str(row.jws_digest),
    secretRef: str(row.secret_ref),
    verificationState: str(row.verification_state) as PactEvidenceStatus,
    verificationReason: strOrNull(row.verification_reason),
    grantIdClaim: strOrNull(row.grant_id_claim),
    paClaim: strOrNull(row.pa_claim),
    brandClaim: strOrNull(row.brand_claim),
    scopesUsed: parseJson<string[]>(row.scopes_used_json, []),
    actions: parseJson<{ tool: string; argsHash?: string }[]>(row.actions_json, []),
    receiptTs: strOrNull(row.receipt_ts),
    createdAt: Number(row.created_at),
  };
}

/** Column patches: only listed keys change, and `updated_at` always moves. */
function buildPatch(
  patch: Record<string, unknown>,
  columns: Record<string, string>,
): { sql: string; values: unknown[] } {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, column] of Object.entries(columns)) {
    if (!(key in patch)) continue;
    const value = patch[key];
    sets.push(`${column} = ?`);
    values.push(
      Array.isArray(value) || (value && typeof value === "object") ? JSON.stringify(value) : value,
    );
  }
  return { sql: sets.join(", "), values };
}

const GRANT_PATCH_COLUMNS = {
  state: "state",
  stateReason: "state_reason",
  scopes: "scopes_json",
  accessExpiresAt: "access_expires_at",
  grantExpiresAt: "grant_expires_at",
  remoteGrantId: "remote_grant_id",
  accountBinding: "account_binding",
  secretRevision: "secret_revision",
  lastUsedAt: "last_used_at",
};

const CONVERSATION_PATCH_COLUMNS = {
  state: "state",
  stateReason: "state_reason",
  contextId: "context_id",
  accountBinding: "account_binding",
  taskId: "task_id",
  sessionId: "session_id",
  workspaceId: "workspace_id",
  contextAttempts: "context_attempts",
};

const MESSAGE_PATCH_COLUMNS = {
  state: "state",
  stateReason: "state_reason",
  replyText: "reply_text",
  replyMessageId: "reply_message_id",
  evidence: "evidence",
  receiptId: "receipt_id",
  grantId: "grant_id",
  attempt: "attempt",
};

const AUTHORIZATION_PATCH_COLUMNS = {
  state: "state",
  stateReason: "state_reason",
  inputRequestId: "input_request_id",
  grantedScopes: "granted_scopes_json",
  intervalSeconds: "interval_seconds",
  grantId: "grant_id",
};

const OPEN_MESSAGE_STATES = ["prepared", "sending"];

export class PactStore {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number = Date.now,
  ) {}

  // ---------------------------------------------------------------- providers

  upsertProvider(input: {
    origin: string;
    audience: string | null;
    issuer: string | null;
    metadataUrl?: string | null;
    registrationStatus: PactRegistrationStatus;
    readiness: PactProviderReadiness;
    readinessReason: string | null;
  }): PactProviderRecord {
    const at = this.now();
    const existing = this.db
      .prepare("SELECT * FROM pact_providers WHERE origin = ?")
      .get(input.origin) as Row | undefined;
    if (!existing) {
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO pact_providers (id, origin, audience, issuer, metadata_url, registration_status,
             readiness, readiness_reason, config_revision, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          id,
          input.origin,
          input.audience,
          input.issuer,
          input.metadataUrl ?? null,
          input.registrationStatus,
          input.readiness,
          input.readinessReason,
          at,
          at,
        );
      return mapProvider(
        this.db.prepare("SELECT * FROM pact_providers WHERE id = ?").get(id) as Row,
      );
    }
    const previous = mapProvider(existing);
    // The audience and issuer decide what a signed JWT means; changing either is a new revision.
    const revisionChanged =
      previous.audience !== input.audience || previous.issuer !== input.issuer;
    this.db
      .prepare(
        `UPDATE pact_providers SET audience = ?, issuer = ?, metadata_url = COALESCE(?, metadata_url),
           registration_status = ?, readiness = ?, readiness_reason = ?,
           config_revision = config_revision + ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.audience,
        input.issuer,
        input.metadataUrl ?? null,
        input.registrationStatus,
        input.readiness,
        input.readinessReason,
        revisionChanged ? 1 : 0,
        at,
        previous.id,
      );
    return mapProvider(
      this.db.prepare("SELECT * FROM pact_providers WHERE id = ?").get(previous.id) as Row,
    );
  }

  getProvider(id: string): PactProviderRecord | null {
    const row = this.db.prepare("SELECT * FROM pact_providers WHERE id = ?").get(id) as
      | Row
      | undefined;
    return row ? mapProvider(row) : null;
  }

  getProviderByOrigin(origin: string): PactProviderRecord | null {
    const row = this.db.prepare("SELECT * FROM pact_providers WHERE origin = ?").get(origin) as
      | Row
      | undefined;
    return row ? mapProvider(row) : null;
  }

  listProviders(): PactProviderRecord[] {
    return (this.db.prepare("SELECT * FROM pact_providers ORDER BY origin").all() as Row[]).map(
      mapProvider,
    );
  }

  // --------------------------------------------------------------- businesses

  upsertBusiness(input: {
    cardUrl: string;
    displayName: string;
    originChain: string[];
    providerId: string;
    interfaceUrl: string;
    profile: PactProfile;
    supportStatus: "supported" | "unsupported";
    unsupportedReason: string | null;
    cardFingerprint: string;
    securityFingerprint: string;
    descriptor: PactBusinessDescriptor;
    expiresAt: number;
  }): { business: PactBusinessRecord; securityChanged: boolean } {
    const at = this.now();
    const existing = this.db
      .prepare("SELECT * FROM pact_businesses WHERE card_url = ?")
      .get(input.cardUrl) as Row | undefined;
    if (!existing) {
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO pact_businesses (id, card_url, display_name, origin_chain_json, provider_id,
             interface_url, profile, support_status, unsupported_reason, card_fingerprint,
             security_fingerprint, descriptor_json, revision, fetched_at, expires_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.cardUrl,
          input.displayName,
          JSON.stringify(input.originChain),
          input.providerId,
          input.interfaceUrl,
          input.profile,
          input.supportStatus,
          input.unsupportedReason,
          input.cardFingerprint,
          input.securityFingerprint,
          JSON.stringify(input.descriptor),
          at,
          input.expiresAt,
          at,
          at,
        );
      return { business: this.getBusiness(id)!, securityChanged: false };
    }
    const previous = mapBusiness(existing);
    const securityChanged =
      previous.securityFingerprint !== input.securityFingerprint ||
      previous.providerId !== input.providerId ||
      previous.interfaceUrl !== input.interfaceUrl;
    this.db
      .prepare(
        `UPDATE pact_businesses SET display_name = ?, origin_chain_json = ?, provider_id = ?,
           interface_url = ?, profile = ?, support_status = ?, unsupported_reason = ?,
           card_fingerprint = ?, security_fingerprint = ?, descriptor_json = ?,
           revision = revision + ?, fetched_at = ?, expires_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.displayName,
        JSON.stringify(input.originChain),
        input.providerId,
        input.interfaceUrl,
        input.profile,
        input.supportStatus,
        input.unsupportedReason,
        input.cardFingerprint,
        input.securityFingerprint,
        JSON.stringify(input.descriptor),
        securityChanged ? 1 : 0,
        at,
        input.expiresAt,
        at,
        previous.id,
      );
    return { business: this.getBusiness(previous.id)!, securityChanged };
  }

  getBusiness(id: string): PactBusinessRecord | null {
    const row = this.db.prepare("SELECT * FROM pact_businesses WHERE id = ?").get(id) as
      | Row
      | undefined;
    return row ? mapBusiness(row) : null;
  }

  getBusinessByCardUrl(cardUrl: string): PactBusinessRecord | null {
    const row = this.db.prepare("SELECT * FROM pact_businesses WHERE card_url = ?").get(cardUrl) as
      | Row
      | undefined;
    return row ? mapBusiness(row) : null;
  }

  listBusinesses(): PactBusinessRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM pact_businesses ORDER BY updated_at DESC LIMIT 500")
        .all() as Row[]
    ).map(mapBusiness);
  }

  // ---------------------------------------------------------- subject bindings

  ensureSubjectBinding(input: {
    principalId: string;
    deployment: PactSubjectBindingRecord["deployment"];
    issuer: string;
    subject: string;
  }): { binding: PactSubjectBindingRecord; subjectChanged: boolean } {
    const at = this.now();
    const existing = this.db
      .prepare(
        "SELECT * FROM pact_subject_bindings WHERE principal_id = ? AND deployment = ? AND issuer = ?",
      )
      .get(input.principalId, input.deployment, input.issuer) as Row | undefined;
    if (!existing) {
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO pact_subject_bindings (id, principal_id, deployment, issuer, subject, revision, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(id, input.principalId, input.deployment, input.issuer, input.subject, at, at);
      return {
        binding: mapBinding(
          this.db.prepare("SELECT * FROM pact_subject_bindings WHERE id = ?").get(id) as Row,
        ),
        subjectChanged: false,
      };
    }
    const previous = mapBinding(existing);
    if (previous.subject === input.subject) return { binding: previous, subjectChanged: false };
    // A new subject is a different PACT user: grants and contexts of the old one stop applying.
    this.db
      .prepare(
        "UPDATE pact_subject_bindings SET subject = ?, revision = revision + 1, updated_at = ? WHERE id = ?",
      )
      .run(input.subject, at, previous.id);
    this.db
      .prepare(
        `UPDATE pact_grants SET state = 'invalid', state_reason = 'subject_changed', updated_at = ?
         WHERE subject_binding_id = ? AND state = 'active'`,
      )
      .run(at, previous.id);
    this.db
      .prepare(
        `UPDATE pact_conversations SET state = 'closed', state_reason = 'subject_changed', updated_at = ?
         WHERE subject_binding_id = ? AND state NOT IN ('closed', 'unsupported')`,
      )
      .run(at, previous.id);
    return {
      binding: mapBinding(
        this.db.prepare("SELECT * FROM pact_subject_bindings WHERE id = ?").get(previous.id) as Row,
      ),
      subjectChanged: true,
    };
  }

  getSubjectBinding(id: string): PactSubjectBindingRecord | null {
    const row = this.db.prepare("SELECT * FROM pact_subject_bindings WHERE id = ?").get(id) as
      | Row
      | undefined;
    return row ? mapBinding(row) : null;
  }

  // -------------------------------------------------------------------- grants

  insertGrant(input: {
    principalId: string;
    subjectBindingId: string;
    businessId: string;
    interfaceUrl: string;
    authorizationServer: string;
    accountBinding: string | null;
    remoteGrantId: string | null;
    scopes: string[];
    secretRef: string;
    accessExpiresAt: number | null;
    grantExpiresAt: number | null;
  }): PactGrantRecord {
    const at = this.now();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO pact_grants (id, principal_id, subject_binding_id, business_id, interface_url,
           authorization_server, account_binding, remote_grant_id, scopes_json, state, secret_ref,
           access_expires_at, grant_expires_at, secret_revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        id,
        input.principalId,
        input.subjectBindingId,
        input.businessId,
        input.interfaceUrl,
        input.authorizationServer,
        input.accountBinding,
        input.remoteGrantId,
        JSON.stringify([...new Set(input.scopes)].sort()),
        input.secretRef,
        input.accessExpiresAt,
        input.grantExpiresAt,
        at,
        at,
      );
    return this.getGrant(id)!;
  }

  getGrant(id: string): PactGrantRecord | null {
    const row = this.db.prepare("SELECT * FROM pact_grants WHERE id = ?").get(id) as
      | Row
      | undefined;
    return row ? mapGrant(row) : null;
  }

  listGrants(filter: {
    principalId?: string;
    businessId?: string;
    subjectBindingId?: string;
    states?: PactGrantState[];
  }): PactGrantRecord[] {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (filter.principalId) {
      clauses.push("principal_id = ?");
      values.push(filter.principalId);
    }
    if (filter.businessId) {
      clauses.push("business_id = ?");
      values.push(filter.businessId);
    }
    if (filter.subjectBindingId) {
      clauses.push("subject_binding_id = ?");
      values.push(filter.subjectBindingId);
    }
    if (filter.states && filter.states.length > 0) {
      clauses.push(`state IN (${filter.states.map(() => "?").join(", ")})`);
      values.push(...filter.states);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return (
      this.db
        .prepare(`SELECT * FROM pact_grants ${where} ORDER BY created_at DESC LIMIT 500`)
        .all(...values) as Row[]
    ).map(mapGrant);
  }

  /**
   * Patch a grant. With `expectedSecretRevision`, the patch applies only if no other writer has
   * rotated the grant's tokens since the caller read it (refresh serialisation).
   */
  updateGrant(
    id: string,
    patch: Partial<
      Pick<
        PactGrantRecord,
        | "state"
        | "stateReason"
        | "scopes"
        | "accessExpiresAt"
        | "grantExpiresAt"
        | "remoteGrantId"
        | "accountBinding"
        | "secretRevision"
        | "lastUsedAt"
      >
    >,
    expectedSecretRevision?: number,
  ): PactGrantRecord | null {
    const built = buildPatch(patch, GRANT_PATCH_COLUMNS);
    const sets = [built.sql, "updated_at = ?"].filter(Boolean).join(", ");
    const values = [...built.values, this.now(), id];
    const guard = expectedSecretRevision === undefined ? "" : " AND secret_revision = ?";
    if (expectedSecretRevision !== undefined) values.push(expectedSecretRevision);
    const result = this.db
      .prepare(`UPDATE pact_grants SET ${sets} WHERE id = ?${guard}`)
      .run(...values);
    if (result.changes === 0) return null;
    return this.getGrant(id);
  }

  // ------------------------------------------------------------- conversations

  createConversation(input: {
    principalId: string;
    subjectBindingId: string;
    businessId: string;
    taskId: string | null;
    sessionId: string | null;
    workspaceId: string | null;
    state: PactConversationState;
  }): PactConversationRecord {
    const at = this.now();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO pact_conversations (id, principal_id, subject_binding_id, business_id, task_id,
           session_id, workspace_id, state, context_attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        id,
        input.principalId,
        input.subjectBindingId,
        input.businessId,
        input.taskId,
        input.sessionId,
        input.workspaceId,
        input.state,
        at,
        at,
      );
    return this.getConversation(id)!;
  }

  getConversation(id: string): PactConversationRecord | null {
    const row = this.db.prepare("SELECT * FROM pact_conversations WHERE id = ?").get(id) as
      | Row
      | undefined;
    return row ? mapConversation(row) : null;
  }

  /** The newest conversation this principal and subject can continue with the business. */
  findUsableConversation(input: {
    principalId: string;
    subjectBindingId: string;
    businessId: string;
  }): PactConversationRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM pact_conversations
         WHERE principal_id = ? AND subject_binding_id = ? AND business_id = ?
           AND state NOT IN ('closed', 'unsupported', 'cancelled')
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(input.principalId, input.subjectBindingId, input.businessId) as Row | undefined;
    return row ? mapConversation(row) : null;
  }

  updateConversation(
    id: string,
    patch: Partial<
      Pick<
        PactConversationRecord,
        | "state"
        | "stateReason"
        | "contextId"
        | "accountBinding"
        | "taskId"
        | "sessionId"
        | "workspaceId"
        | "contextAttempts"
      >
    >,
  ): PactConversationRecord | null {
    const built = buildPatch(patch, CONVERSATION_PATCH_COLUMNS);
    const sets = [built.sql, "updated_at = ?"].filter(Boolean).join(", ");
    this.db
      .prepare(`UPDATE pact_conversations SET ${sets} WHERE id = ?`)
      .run(...built.values, this.now(), id);
    return this.getConversation(id);
  }

  listConversations(filter: {
    principalId: string;
    businessId?: string;
    taskId?: string;
    limit?: number;
  }): PactConversationRecord[] {
    const clauses = ["principal_id = ?"];
    const values: unknown[] = [filter.principalId];
    if (filter.businessId) {
      clauses.push("business_id = ?");
      values.push(filter.businessId);
    }
    if (filter.taskId) {
      clauses.push("task_id = ?");
      values.push(filter.taskId);
    }
    const limit = Math.max(1, Math.min(200, filter.limit ?? 50));
    return (
      this.db
        .prepare(
          `SELECT * FROM pact_conversations WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC LIMIT ${limit}`,
        )
        .all(...values) as Row[]
    ).map(mapConversation);
  }

  // ------------------------------------------------------------------ messages

  /**
   * Persist an attempt before any network effect. Returns null when the conversation already has
   * an open attempt held by someone else, which serialises turns per conversation.
   */
  prepareMessage(input: {
    conversationId: string;
    operationId: string;
    wireMessageId: string;
    kind: PactMessageKind;
    bodyText: string;
    bodyDigest: string;
    effectClass: PactEffectClass;
    requiredScopes: string[];
    authorityFingerprint: string;
    cardRevision: number;
    providerRevision: number;
    grantId: string | null;
    leaseOwner: string;
    leaseMs: number;
  }): PactMessageRecord | null {
    const at = this.now();
    const blocking = this.db
      .prepare(
        `SELECT id FROM pact_messages WHERE conversation_id = ? AND state IN (${OPEN_MESSAGE_STATES.map(() => "?").join(", ")})
           AND lease_owner IS NOT NULL AND lease_owner != ? AND lease_expires_at > ? LIMIT 1`,
      )
      .get(input.conversationId, ...OPEN_MESSAGE_STATES, input.leaseOwner, at) as Row | undefined;
    if (blocking) return null;
    // An effectful turn with an unknown outcome blocks further operations until reconciled;
    // lost introductions and inspections do not.
    const unresolved = this.db
      .prepare(
        `SELECT id FROM pact_messages WHERE conversation_id = ? AND state = 'outcome_unknown'
           AND kind = 'operation' AND effect_class != 'inspect' AND operation_id != ? LIMIT 1`,
      )
      .get(input.conversationId, input.operationId) as Row | undefined;
    if (unresolved && input.kind === "operation") return null;
    const seqRow = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM pact_messages WHERE conversation_id = ?")
      .get(input.conversationId) as { seq: number };
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO pact_messages (id, conversation_id, operation_id, seq, wire_message_id, kind,
           body_text, body_digest, effect_class, required_scopes_json, authority_fingerprint,
           card_revision, provider_revision, grant_id, attempt, lease_owner, lease_expires_at,
           state, evidence, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'prepared', 'not_applicable', ?, ?)`,
      )
      .run(
        id,
        input.conversationId,
        input.operationId,
        Number(seqRow.seq) + 1,
        input.wireMessageId,
        input.kind,
        input.bodyText,
        input.bodyDigest,
        input.effectClass,
        JSON.stringify(input.requiredScopes),
        input.authorityFingerprint,
        input.cardRevision,
        input.providerRevision,
        input.grantId,
        input.leaseOwner,
        at + input.leaseMs,
        at,
        at,
      );
    return this.getMessage(id);
  }

  getMessage(id: string): PactMessageRecord | null {
    const row = this.db.prepare("SELECT * FROM pact_messages WHERE id = ?").get(id) as
      | Row
      | undefined;
    return row ? mapMessage(row) : null;
  }

  listMessages(conversationId: string): PactMessageRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM pact_messages WHERE conversation_id = ? ORDER BY seq ASC LIMIT 500")
        .all(conversationId) as Row[]
    ).map(mapMessage);
  }

  /** Take (or renew) the send lease and count the attempt; only the lease holder may send. */
  beginAttempt(id: string, owner: string, leaseMs: number): PactMessageRecord | null {
    const at = this.now();
    const result = this.db
      .prepare(
        `UPDATE pact_messages SET state = 'sending', attempt = attempt + 1, lease_owner = ?,
           lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND state IN ('prepared', 'sending')
           AND (lease_owner IS NULL OR lease_owner = ? OR lease_expires_at <= ?)`,
      )
      .run(owner, at + leaseMs, at, id, owner, at);
    return result.changes === 0 ? null : this.getMessage(id);
  }

  /**
   * Reconcile an unknown outcome by resending the identical attempt (same wire messageId and
   * body). Only valid inside an established context, where the provider deduplicates by id.
   */
  beginReconcile(id: string, owner: string, leaseMs: number): PactMessageRecord | null {
    const at = this.now();
    const result = this.db
      .prepare(
        `UPDATE pact_messages SET state = 'sending', attempt = attempt + 1, lease_owner = ?,
           lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND state = 'outcome_unknown'
           AND EXISTS (SELECT 1 FROM pact_conversations c WHERE c.id = pact_messages.conversation_id
                         AND c.context_id IS NOT NULL)`,
      )
      .run(owner, at + leaseMs, at, id);
    return result.changes === 0 ? null : this.getMessage(id);
  }

  /** Finish an attempt held by `owner`; a lost lease means another runtime owns the outcome. */
  finishAttempt(
    id: string,
    owner: string,
    patch: Partial<
      Pick<
        PactMessageRecord,
        | "state"
        | "stateReason"
        | "replyText"
        | "replyMessageId"
        | "evidence"
        | "receiptId"
        | "grantId"
      >
    >,
  ): PactMessageRecord | null {
    const built = buildPatch(patch, MESSAGE_PATCH_COLUMNS);
    const release =
      patch.state && !OPEN_MESSAGE_STATES.includes(patch.state)
        ? ", lease_owner = NULL, lease_expires_at = NULL"
        : "";
    const sets = [built.sql, "updated_at = ?"].filter(Boolean).join(", ");
    const result = this.db
      .prepare(`UPDATE pact_messages SET ${sets}${release} WHERE id = ? AND lease_owner = ?`)
      .run(...built.values, this.now(), id, owner);
    return result.changes === 0 ? null : this.getMessage(id);
  }

  /** Review outcome changes made outside an attempt (evidence review, startup reconciliation). */
  updateMessage(
    id: string,
    patch: Partial<Pick<PactMessageRecord, "state" | "stateReason" | "evidence" | "receiptId">>,
  ): PactMessageRecord | null {
    const built = buildPatch(patch, MESSAGE_PATCH_COLUMNS);
    const sets = [built.sql, "updated_at = ?"].filter(Boolean).join(", ");
    this.db
      .prepare(`UPDATE pact_messages SET ${sets} WHERE id = ?`)
      .run(...built.values, this.now(), id);
    return this.getMessage(id);
  }

  /**
   * Startup reconciliation: an attempt left `sending` with an expired lease may or may not have
   * reached the business. It becomes `outcome_unknown`; it is never retried automatically.
   */
  markAbandonedAttempts(): PactMessageRecord[] {
    const at = this.now();
    const rows = this.db
      .prepare(
        `SELECT * FROM pact_messages WHERE state = 'sending' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
      )
      .all(at) as Row[];
    for (const row of rows) {
      this.db
        .prepare(
          `UPDATE pact_messages SET state = 'outcome_unknown', state_reason = 'interrupted_during_send',
             lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?`,
        )
        .run(at, row.id);
      this.db
        .prepare(
          `UPDATE pact_conversations SET state = 'outcome_unknown', state_reason = 'interrupted_during_send', updated_at = ?
           WHERE id = ? AND state NOT IN ('closed', 'unsupported')`,
        )
        .run(at, row.conversation_id);
    }
    // Prepared attempts that never took a lease were never sent.
    this.db
      .prepare(
        `UPDATE pact_messages SET state = 'cancelled', state_reason = 'never_sent', lease_owner = NULL,
           lease_expires_at = NULL, updated_at = ?
         WHERE state = 'prepared' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
      )
      .run(at, at);
    return rows.map((row) => mapMessage({ ...row, state: "outcome_unknown" }));
  }

  // ---------------------------------------------------------- authorizations

  insertAuthorization(input: {
    taskId: string | null;
    workspaceId: string | null;
    principalId: string;
    subjectBindingId: string;
    businessId: string;
    conversationId: string | null;
    operationId: string | null;
    purpose: string;
    requestedScopes: string[];
    expiresAt: number;
    intervalSeconds: number;
    secretRef: string;
    leaseOwner: string;
    leaseMs: number;
  }): PactAuthorizationRecord {
    const at = this.now();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO pact_authorization_requests (id, task_id, workspace_id, principal_id,
           subject_binding_id, business_id, conversation_id, operation_id, purpose,
           requested_scopes_json, state, expires_at, interval_seconds, secret_ref, lease_owner,
           lease_expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.taskId,
        input.workspaceId,
        input.principalId,
        input.subjectBindingId,
        input.businessId,
        input.conversationId,
        input.operationId,
        input.purpose,
        JSON.stringify(input.requestedScopes),
        input.expiresAt,
        input.intervalSeconds,
        input.secretRef,
        input.leaseOwner,
        at + input.leaseMs,
        at,
        at,
      );
    return this.getAuthorization(id)!;
  }

  getAuthorization(id: string): PactAuthorizationRecord | null {
    const row = this.db
      .prepare("SELECT * FROM pact_authorization_requests WHERE id = ?")
      .get(id) as Row | undefined;
    return row ? mapAuthorization(row) : null;
  }

  getAuthorizationByInputRequest(inputRequestId: string): PactAuthorizationRecord | null {
    const row = this.db
      .prepare("SELECT * FROM pact_authorization_requests WHERE input_request_id = ?")
      .get(inputRequestId) as Row | undefined;
    return row ? mapAuthorization(row) : null;
  }

  listAuthorizations(filter: {
    principalId?: string;
    states?: PactAuthorizationRecord["state"][];
    taskId?: string;
  }): PactAuthorizationRecord[] {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (filter.principalId) {
      clauses.push("principal_id = ?");
      values.push(filter.principalId);
    }
    if (filter.taskId) {
      clauses.push("task_id = ?");
      values.push(filter.taskId);
    }
    if (filter.states && filter.states.length > 0) {
      clauses.push(`state IN (${filter.states.map(() => "?").join(", ")})`);
      values.push(...filter.states);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return (
      this.db
        .prepare(
          `SELECT * FROM pact_authorization_requests ${where} ORDER BY created_at DESC LIMIT 200`,
        )
        .all(...values) as Row[]
    ).map(mapAuthorization);
  }

  /** Single-owner polling: the lease moves only when free, expired, or already ours. */
  acquireAuthorizationLease(id: string, owner: string, leaseMs: number): boolean {
    const at = this.now();
    const result = this.db
      .prepare(
        `UPDATE pact_authorization_requests SET lease_owner = ?, lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND state = 'pending'
           AND (lease_owner IS NULL OR lease_owner = ? OR lease_expires_at <= ?)`,
      )
      .run(owner, at + leaseMs, at, id, owner, at);
    return result.changes > 0;
  }

  /** Attach the task input request that shows this wait. */
  linkAuthorizationInput(id: string, inputRequestId: string): PactAuthorizationRecord | null {
    this.db
      .prepare(
        "UPDATE pact_authorization_requests SET input_request_id = ?, updated_at = ? WHERE id = ? AND input_request_id IS NULL",
      )
      .run(inputRequestId, this.now(), id);
    return this.getAuthorization(id);
  }

  /** Move a pending request to a final state; only once, and only by the lease holder if given. */
  settleAuthorization(
    id: string,
    patch: Partial<
      Pick<
        PactAuthorizationRecord,
        "state" | "stateReason" | "grantedScopes" | "grantId" | "inputRequestId" | "intervalSeconds"
      >
    >,
    owner?: string,
  ): PactAuthorizationRecord | null {
    const built = buildPatch(patch, AUTHORIZATION_PATCH_COLUMNS);
    const release =
      patch.state && patch.state !== "pending"
        ? ", lease_owner = NULL, lease_expires_at = NULL"
        : "";
    const sets = [built.sql, "updated_at = ?"].filter(Boolean).join(", ");
    const ownerGuard = owner === undefined ? "" : " AND lease_owner = ?";
    const values = [...built.values, this.now(), id];
    if (owner !== undefined) values.push(owner);
    const result = this.db
      .prepare(
        `UPDATE pact_authorization_requests SET ${sets}${release} WHERE id = ? AND state = 'pending'${ownerGuard}`,
      )
      .run(...values);
    return result.changes === 0 ? null : this.getAuthorization(id);
  }

  // ------------------------------------------------------------------ receipts

  insertReceipt(input: {
    messageId: string;
    conversationId: string;
    contextId: string | null;
    jwsDigest: string;
    secretRef: string;
    verificationState: PactEvidenceStatus;
    verificationReason: string | null;
    grantIdClaim: string | null;
    paClaim: string | null;
    brandClaim: string | null;
    scopesUsed: string[];
    actions: { tool: string; argsHash?: string }[];
    receiptTs: string | null;
  }): { receipt: PactReceiptRecord; duplicateOf: string | null } {
    const at = this.now();
    const duplicate = this.db
      .prepare("SELECT id, message_id FROM pact_receipts WHERE jws_digest = ? LIMIT 1")
      .get(input.jwsDigest) as { id: string; message_id: string } | undefined;
    // The same JWS presented for a different turn is replayed evidence, not a second receipt.
    const replayed = duplicate && duplicate.message_id !== input.messageId;
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO pact_receipts (id, message_id, conversation_id, context_id, jws_digest, secret_ref,
           verification_state, verification_reason, grant_id_claim, pa_claim, brand_claim,
           scopes_used_json, actions_json, receipt_ts, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.messageId,
        input.conversationId,
        input.contextId,
        input.jwsDigest,
        input.secretRef,
        replayed ? "invalid" : input.verificationState,
        replayed ? "replayed_receipt" : input.verificationReason,
        input.grantIdClaim,
        input.paClaim,
        input.brandClaim,
        JSON.stringify(input.scopesUsed),
        JSON.stringify(input.actions),
        input.receiptTs,
        at,
      );
    return { receipt: this.getReceipt(id)!, duplicateOf: replayed ? duplicate!.id : null };
  }

  getReceipt(id: string): PactReceiptRecord | null {
    const row = this.db.prepare("SELECT * FROM pact_receipts WHERE id = ?").get(id) as
      | Row
      | undefined;
    return row ? mapReceipt(row) : null;
  }

  listReceipts(conversationId: string): PactReceiptRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM pact_receipts WHERE conversation_id = ? ORDER BY created_at ASC")
        .all(conversationId) as Row[]
    ).map(mapReceipt);
  }

  counts(principalId: string): { pendingAuthorizations: number; activeGrants: number } {
    const pending = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM pact_authorization_requests WHERE principal_id = ? AND state = 'pending'",
      )
      .get(principalId) as { n: number };
    const grants = this.db
      .prepare("SELECT COUNT(*) AS n FROM pact_grants WHERE principal_id = ? AND state = 'active'")
      .get(principalId) as { n: number };
    return { pendingAuthorizations: Number(pending.n), activeGrants: Number(grants.n) };
  }
}
