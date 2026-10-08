import type Database from "better-sqlite3";

/**
 * PACT tables (plan §8). Idempotent like the rest of the schema: added tables do not need a
 * CURRENT_SCHEMA_VERSION bump. Later column additions belong in `ensurePactSchema` as guarded
 * ALTERs, the same way `ensurePulseSchema` adds columns.
 *
 * Public tables hold descriptors, state and secret references only. Tokens, device codes, signer
 * credentials and raw receipts live in SecureSettingsRepository categories (secret-store.ts).
 */
export const PACT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS pact_providers (
    id TEXT PRIMARY KEY,
    origin TEXT NOT NULL UNIQUE,
    audience TEXT,
    issuer TEXT,
    metadata_url TEXT,
    registration_status TEXT NOT NULL DEFAULT 'unknown',
    readiness TEXT NOT NULL DEFAULT 'not_ready',
    readiness_reason TEXT,
    config_revision INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS pact_businesses (
    id TEXT PRIMARY KEY,
    card_url TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    origin_chain_json TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    interface_url TEXT NOT NULL,
    profile TEXT NOT NULL,
    support_status TEXT NOT NULL,
    unsupported_reason TEXT,
    card_fingerprint TEXT NOT NULL,
    security_fingerprint TEXT NOT NULL,
    descriptor_json TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    fetched_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_pact_businesses_provider ON pact_businesses(provider_id);

  CREATE TABLE IF NOT EXISTS pact_subject_bindings (
    id TEXT PRIMARY KEY,
    principal_id TEXT NOT NULL,
    deployment TEXT NOT NULL,
    issuer TEXT NOT NULL,
    subject TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (principal_id, deployment, issuer)
  );

  CREATE TABLE IF NOT EXISTS pact_grants (
    id TEXT PRIMARY KEY,
    principal_id TEXT NOT NULL,
    subject_binding_id TEXT NOT NULL,
    business_id TEXT NOT NULL,
    interface_url TEXT NOT NULL,
    authorization_server TEXT NOT NULL,
    account_binding TEXT,
    remote_grant_id TEXT,
    scopes_json TEXT NOT NULL,
    state TEXT NOT NULL,
    state_reason TEXT,
    secret_ref TEXT NOT NULL,
    access_expires_at INTEGER,
    grant_expires_at INTEGER,
    secret_revision INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_used_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_pact_grants_owner
    ON pact_grants(principal_id, business_id, state);

  CREATE TABLE IF NOT EXISTS pact_conversations (
    id TEXT PRIMARY KEY,
    principal_id TEXT NOT NULL,
    subject_binding_id TEXT NOT NULL,
    business_id TEXT NOT NULL,
    account_binding TEXT,
    context_id TEXT,
    task_id TEXT,
    session_id TEXT,
    workspace_id TEXT,
    state TEXT NOT NULL,
    state_reason TEXT,
    context_attempts INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_pact_conversations_owner
    ON pact_conversations(principal_id, business_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_pact_conversations_task ON pact_conversations(task_id);

  CREATE TABLE IF NOT EXISTS pact_messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    wire_message_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    body_text TEXT NOT NULL,
    body_digest TEXT NOT NULL,
    effect_class TEXT NOT NULL,
    required_scopes_json TEXT NOT NULL,
    authority_fingerprint TEXT NOT NULL,
    card_revision INTEGER NOT NULL,
    provider_revision INTEGER NOT NULL,
    grant_id TEXT,
    attempt INTEGER NOT NULL DEFAULT 0,
    lease_owner TEXT,
    lease_expires_at INTEGER,
    state TEXT NOT NULL,
    state_reason TEXT,
    reply_text TEXT,
    reply_message_id TEXT,
    evidence TEXT NOT NULL DEFAULT 'not_applicable',
    receipt_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (conversation_id, wire_message_id)
  );
  CREATE INDEX IF NOT EXISTS idx_pact_messages_conversation ON pact_messages(conversation_id, seq);
  CREATE INDEX IF NOT EXISTS idx_pact_messages_state ON pact_messages(state);

  CREATE TABLE IF NOT EXISTS pact_authorization_requests (
    id TEXT PRIMARY KEY,
    input_request_id TEXT UNIQUE,
    task_id TEXT,
    workspace_id TEXT,
    principal_id TEXT NOT NULL,
    subject_binding_id TEXT NOT NULL,
    business_id TEXT NOT NULL,
    conversation_id TEXT,
    operation_id TEXT,
    purpose TEXT NOT NULL,
    requested_scopes_json TEXT NOT NULL,
    granted_scopes_json TEXT,
    state TEXT NOT NULL,
    state_reason TEXT,
    expires_at INTEGER NOT NULL,
    interval_seconds INTEGER NOT NULL,
    secret_ref TEXT NOT NULL,
    lease_owner TEXT,
    lease_expires_at INTEGER,
    grant_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_pact_authorization_state ON pact_authorization_requests(state);

  CREATE TABLE IF NOT EXISTS pact_receipts (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    context_id TEXT,
    jws_digest TEXT NOT NULL,
    secret_ref TEXT NOT NULL,
    verification_state TEXT NOT NULL,
    verification_reason TEXT,
    grant_id_claim TEXT,
    pa_claim TEXT,
    brand_claim TEXT,
    scopes_used_json TEXT NOT NULL,
    actions_json TEXT NOT NULL,
    receipt_ts TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_pact_receipts_digest ON pact_receipts(jws_digest);
  CREATE INDEX IF NOT EXISTS idx_pact_receipts_conversation ON pact_receipts(conversation_id);
`;

export function ensurePactSchema(db: Database.Database): void {
  db.exec(PACT_SCHEMA);
}
