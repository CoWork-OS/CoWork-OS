/**
 * Channel decision tables, apart from the store so schema initialization (and its
 * bootstrap worker) can create them without loading the approval modules.
 */
export const CHANNEL_DECISION_SCHEMA = `
CREATE TABLE IF NOT EXISTS channel_decision_routes (
 id TEXT PRIMARY KEY, approval_id TEXT NOT NULL UNIQUE, payload_json TEXT NOT NULL,
 state TEXT NOT NULL, message_id TEXT, callback_id TEXT, action TEXT,
 claim_id TEXT, delivery_claim_id TEXT, outcome TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_channel_decision_state ON channel_decision_routes(state, updated_at);
CREATE TABLE IF NOT EXISTS channel_approval_consumption (
 approval_id TEXT PRIMARY KEY, route_id TEXT NOT NULL UNIQUE, claim_id TEXT NOT NULL, revision_hash TEXT NOT NULL,
 FOREIGN KEY (approval_id) REFERENCES approvals(id) ON DELETE CASCADE,
 FOREIGN KEY (route_id) REFERENCES channel_decision_routes(id)
);
`;
