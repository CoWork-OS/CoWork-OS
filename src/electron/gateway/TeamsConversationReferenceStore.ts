import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import {
  normalizeTeamsDecisionReference,
  type TeamsDecisionReference,
} from "./channels/teams-conversation-reference";
export const TEAMS_CONVERSATION_REFERENCE_SCHEMA = `CREATE TABLE IF NOT EXISTS teams_conversation_references (
 channel_id TEXT NOT NULL, chat_id TEXT NOT NULL, app_id TEXT NOT NULL, tenant_id TEXT NOT NULL,
 policy_hash TEXT NOT NULL, reference_json TEXT NOT NULL, updated_at INTEGER NOT NULL,
 PRIMARY KEY (channel_id, chat_id), FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);`;
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
function bounded(value: string, max = 200) {
  if (typeof value !== "string" || !value || value.length > max)
    throw new Error("Invalid Teams reference identity");
}
export class TeamsConversationReferenceStore {
  constructor(private db: Database.Database) {}
  initialize(): void {
    this.db.exec(TEAMS_CONVERSATION_REFERENCE_SCHEMA);
  }
  /** Sealed configuration stays sealed across the worker boundary. */
  policy(channelId: string): string | undefined {
    bounded(channelId);
    const row = this.db
      .prepare("SELECT id, type, config, security_config FROM channels WHERE id = ?")
      .get(channelId) as
      | { id: string; type: string; config: string; security_config: string }
      | undefined;
    if (!row || row.type !== "teams") return undefined;
    return createHash("sha256").update(JSON.stringify(row)).digest("hex");
  }
  private authorize(channelId: string, policyHash: string) {
    const row = this.db.prepare("SELECT enabled FROM channels WHERE id = ?").get(channelId) as
      | { enabled: number }
      | undefined;
    if (
      row?.enabled !== 1 ||
      typeof policyHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(policyHash) ||
      this.policy(channelId) !== policyHash
    )
      throw new Error("Teams reference configuration changed");
  }
  put(
    input: {
      channelId: string;
      appId: string;
      tenantId: string;
      policyHash: string;
      reference: TeamsDecisionReference;
    },
    now = Date.now(),
  ): void {
    bounded(input.channelId);
    bounded(input.appId);
    bounded(input.tenantId);
    const reference = normalizeTeamsDecisionReference(input.reference, input.tenantId),
      payload = JSON.stringify(reference);
    if (payload.length > 8192 || !Number.isSafeInteger(now))
      throw new Error("Invalid Teams reference payload");
    this.db
      .transaction(() => {
        this.authorize(input.channelId, input.policyHash);
        this.db
          .prepare(
            `INSERT INTO teams_conversation_references (channel_id,chat_id,app_id,tenant_id,policy_hash,reference_json,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(channel_id,chat_id) DO UPDATE SET app_id=excluded.app_id,tenant_id=excluded.tenant_id,policy_hash=excluded.policy_hash,reference_json=excluded.reference_json,updated_at=excluded.updated_at`,
          )
          .run(
            input.channelId,
            reference.conversation.id,
            input.appId,
            input.tenantId,
            input.policyHash,
            payload,
            now,
          );
        this.db
          .prepare(
            "DELETE FROM teams_conversation_references WHERE channel_id = ? AND (updated_at < ? OR chat_id NOT IN (SELECT chat_id FROM teams_conversation_references WHERE channel_id = ? ORDER BY updated_at DESC, chat_id LIMIT 1000))",
          )
          .run(input.channelId, now - RETENTION_MS, input.channelId);
      })
      .immediate();
  }
  get(
    input: {
      channelId: string;
      chatId: string;
      appId: string;
      tenantId: string;
      policyHash: string;
    },
    now = Date.now(),
  ): TeamsDecisionReference | undefined {
    bounded(input.channelId);
    bounded(input.chatId, 2048);
    bounded(input.appId);
    bounded(input.tenantId);
    if (!Number.isSafeInteger(now)) throw new Error("Invalid Teams reference time");
    this.authorize(input.channelId, input.policyHash);
    const row = this.db
      .prepare("SELECT * FROM teams_conversation_references WHERE channel_id = ? AND chat_id = ?")
      .get(input.channelId, input.chatId) as
      | {
          app_id: string;
          tenant_id: string;
          policy_hash: string;
          reference_json: string;
          updated_at: number;
        }
      | undefined;
    if (
      !row ||
      row.app_id !== input.appId ||
      row.tenant_id !== input.tenantId ||
      row.policy_hash !== input.policyHash ||
      !Number.isSafeInteger(row.updated_at) ||
      row.updated_at > now ||
      row.updated_at < now - RETENTION_MS
    )
      return undefined;
    if (row.reference_json.length > 8192) throw new Error("Invalid persisted Teams reference");
    return normalizeTeamsDecisionReference(
      JSON.parse(row.reference_json),
      input.tenantId,
      input.chatId,
    );
  }
}
