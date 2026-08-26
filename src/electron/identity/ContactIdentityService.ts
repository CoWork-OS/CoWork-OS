import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import { KnowledgeGraphService } from "../knowledge-graph/KnowledgeGraphService";
import type {
  ChannelPreferenceSummary,
  ContactIdentity,
  ContactIdentityCandidate,
  ContactIdentityCoverageStats,
  ContactIdentityHandle,
  ContactIdentityHandleType,
  ContactIdentityResolution,
  ContactIdentityReplyTarget,
  ContactIdentitySearchResult,
  RelationshipTimelineEvent,
  RelationshipTimelineQuery,
  RelationshipTimelineSource,
} from "../../shared/mailbox";

type ContactIdentityRow = {
  id: string;
  workspace_id: string;
  display_name: string;
  primary_email: string | null;
  company_hint: string | null;
  kg_entity_id: string | null;
  confidence: number;
  created_at: number;
  updated_at: number;
};

type ContactIdentityHandleRow = {
  id: string;
  contact_identity_id: string;
  workspace_id: string;
  handle_type: ContactIdentityHandleType;
  normalized_value: string;
  display_value: string;
  source: ContactIdentityHandle["source"];
  channel_id: string | null;
  channel_type: string | null;
  channel_user_id: string | null;
  created_at: number;
  updated_at: number;
};

type ContactIdentitySuggestionRow = {
  id: string;
  workspace_id: string;
  contact_identity_id: string;
  handle_type: ContactIdentityHandleType;
  normalized_value: string;
  display_value: string;
  source: ContactIdentityCandidate["source"];
  source_label: string;
  channel_id: string | null;
  channel_type: string | null;
  channel_user_id: string | null;
  confidence: number;
  status: ContactIdentityCandidate["status"];
  reason_codes_json: string;
  created_at: number;
  updated_at: number;
};

type ChannelUserCandidateRow = {
  channel_id: string;
  channel_type: string;
  channel_name: string;
  channel_user_id: string;
  display_name: string;
  username: string | null;
  allowed: number;
  created_at: number;
  last_seen_at: number;
};

type ChannelMessageRow = {
  id: string;
  channel_id: string;
  chat_id: string;
  user_id: string | null;
  direction: "incoming" | "outgoing" | "outgoing_user";
  content: string;
  timestamp: number;
  channel_type: string;
  channel_name: string;
};

type ContactIdentitySearchRow = {
  id: string;
  workspace_id: string;
  handle_type: ContactIdentityHandleType;
  normalized_value: string;
  display_value: string;
  source: ContactIdentitySearchResult["source"];
  source_label: string;
  channel_id: string | null;
  channel_type: string | null;
  channel_user_id: string | null;
  linked_identity_id: string | null;
  linked_identity_name: string | null;
  confidence: number;
  reason_codes_json: string;
};

type TimelineAccumulator = {
  events: RelationshipTimelineEvent[];
  responseSamplesByChannel: Map<string, number[]>;
  lastInboundAtByChannel: Map<string, number>;
  lastOutboundAtByChannel: Map<string, number>;
  messageCountByChannel: Map<string, number>;
};

function parseJsonArray<T>(value: string | null | undefined): T[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function compactText(value: string | null | undefined, max = 180): string {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function normalizeEmail(value?: string | null): string | null {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized && normalized.includes("@") ? normalized : null;
}

function normalizePhone(value?: string | null): string | null {
  const digits = String(value || "").replace(/[^\d]/g, "");
  if (digits.length < 8) return null;
  return digits;
}

function normalizeName(value?: string | null): string {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const value of values) {
    const next = String(value || "").trim();
    if (next) out.add(next);
  }
  return [...out];
}

function scoreNameSimilarity(a?: string | null, b?: string | null): number {
  const left = normalizeName(a);
  const right = normalizeName(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) return 0.75;
  const leftTokens = new Set(left.split(" ").filter(Boolean));
  const rightTokens = new Set(right.split(" ").filter(Boolean));
  if (!leftTokens.size || !rightTokens.size) return 0;
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1;
  }
  return overlap / Math.max(leftTokens.size, rightTokens.size);
}

function mapChannelTypeToHandleType(channelType?: string | null): ContactIdentityHandleType | null {
  switch (channelType) {
    case "slack":
      return "slack_user_id";
    case "teams":
      return "teams_user_id";
    case "whatsapp":
      return "whatsapp_e164";
    case "signal":
      return "signal_e164";
    case "imessage":
      return "imessage_handle";
    default:
      return null;
  }
}

function normalizeHandleValue(handleType: ContactIdentityHandleType, value?: string | null): string | null {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (handleType === "email") {
    return normalizeEmail(raw);
  }
  if (handleType === "whatsapp_e164" || handleType === "signal_e164") {
    return normalizePhone(raw);
  }
  if (handleType === "imessage_handle") {
    const email = normalizeEmail(raw);
    if (email) return email;
    const phone = normalizePhone(raw);
    return phone || raw.toLowerCase();
  }
  return raw.toLowerCase();
}

function toChannelLabel(source: RelationshipTimelineSource): string {
  switch (source) {
    case "email":
      return "Email";
    case "slack":
      return "Slack";
    case "teams":
      return "Teams";
    case "whatsapp":
      return "WhatsApp";
    case "signal":
      return "Signal";
    case "imessage":
      return "iMessage";
    case "crm":
      return "CRM";
    case "commitment":
      return "Commitment";
    case "automation":
      return "Automation";
    case "handoff":
      return "Mission Control";
    default:
      return "Timeline";
  }
}

function stableTimelineSort(a: RelationshipTimelineEvent, b: RelationshipTimelineEvent): number {
  if (b.timestamp !== a.timestamp) return b.timestamp - a.timestamp;
  if (a.source !== b.source) return a.source.localeCompare(b.source);
  return a.id.localeCompare(b.id);
}

export class ContactIdentityService {
  constructor(private db: Database.Database) {}

  resolveMailboxContact(input: {
    workspaceId: string;
    email?: string | null;
    displayName?: string | null;
    companyHint?: string | null;
    phoneHints?: string[];
    crmHints?: string[];
    learnedFacts?: string[];
  }): ContactIdentityResolution {
    const workspaceId = String(input.workspaceId || "").trim();
    const email = normalizeEmail(input.email);
    const displayName = compactText(input.displayName, 120) || email || "Mailbox contact";
    const companyHint = compactText(input.companyHint, 120) || undefined;
    const phoneHints = uniqueStrings((input.phoneHints || []).map((value) => normalizePhone(value))).filter(Boolean);
    const reasonCodes: string[] = [];

    if (!workspaceId || !email) {
      return { identity: null, confidence: 0, reasonCodes: ["missing_primary_email"], candidates: [] };
    }

    let identity = this.findIdentityByHandle(workspaceId, "email", email);
    if (!identity) {
      identity = this.createIdentity({
        workspaceId,
        displayName,
        primaryEmail: email,
        companyHint,
        confidence: 0.78,
      });
      this.insertAudit({
        workspaceId,
        contactIdentityId: identity.id,
        action: "identity_created",
        detail: { reason: "mailbox_primary_contact", email, displayName, companyHint },
      });
    } else {
      this.touchIdentity(identity.id, {
        displayName: identity.displayName === identity.primaryEmail && displayName ? displayName : undefined,
        primaryEmail: email,
        companyHint: companyHint || identity.companyHint,
      });
    }

    const emailHandle = this.ensureHandle({
      workspaceId,
      contactIdentityId: identity.id,
      handleType: "email",
      normalizedValue: email,
      displayValue: input.email || email,
      source: "mailbox",
    });
    if (emailHandle) {
      reasonCodes.push("exact_email_match");
    }

    for (const crmHint of uniqueStrings(input.crmHints || [])) {
      const normalizedCrm = normalizeHandleValue("crm_contact_id", crmHint);
      if (!normalizedCrm) continue;
      this.ensureHandle({
        workspaceId,
        contactIdentityId: identity.id,
        handleType: "crm_contact_id",
        normalizedValue: normalizedCrm,
        displayValue: crmHint,
        source: "crm",
      });
      reasonCodes.push("crm_hint_match");
    }

    const kgEntityId = this.findPersonEntityId({
      workspaceId,
      email,
      displayName,
      companyHint,
    });
    if (kgEntityId && !identity.kgEntityId) {
      this.touchIdentity(identity.id, { kgEntityId });
      identity = this.getIdentity(identity.id) || identity;
      reasonCodes.push("kg_person_match");
    }

    const candidates = this.upsertMailboxCandidates({
      identity,
      email,
      displayName,
      companyHint,
      phoneHints,
      crmHints: input.crmHints || [],
      learnedFacts: input.learnedFacts || [],
    });

    const nextIdentity = this.getIdentity(identity.id) || identity;
    const linkedNonEmailHandles = nextIdentity.handles.filter((handle) => handle.handleType !== "email");
    const confidence = linkedNonEmailHandles.length > 0 ? 0.9 : 0.8;
    return {
      identity: nextIdentity,
      confidence,
      reasonCodes,
      candidates,
    };
  }

  getIdentity(identityId: string): ContactIdentity | null {
    const row = this.db
      .prepare(
        `SELECT id, workspace_id, display_name, primary_email, company_hint, kg_entity_id, confidence, created_at, updated_at
         FROM contact_identities
         WHERE id = ?`,
      )
      .get(identityId) as ContactIdentityRow | undefined;
    if (!row) return null;
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      displayName: row.display_name,
      primaryEmail: row.primary_email || undefined,
      companyHint: row.company_hint || undefined,
      kgEntityId: row.kg_entity_id || undefined,
      confidence: row.confidence,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      handles: this.listHandles(row.id),
    };
  }

  listIdentities(workspaceId?: string): ContactIdentity[] {
    const rows = this.db
      .prepare(
        `SELECT id
         FROM contact_identities
         ${workspaceId ? "WHERE workspace_id = ?" : ""}
         ORDER BY updated_at DESC, created_at DESC`,
      )
      .all(...(workspaceId ? [workspaceId] : [])) as Array<{ id: string }>;
    return rows.map((row) => this.getIdentity(row.id)).filter((identity): identity is ContactIdentity => Boolean(identity));
  }

  findIdentityByCompanyHint(workspaceId: string, companyHint: string): ContactIdentity | null {
    const row = this.db
      .prepare(
        `SELECT id
         FROM contact_identities
         WHERE workspace_id = ?
           AND LOWER(COALESCE(company_hint, '')) = LOWER(?)
         ORDER BY updated_at DESC
         LIMIT 1`,
      )
      .get(workspaceId, companyHint) as { id: string } | undefined;
    return row ? this.getIdentity(row.id) : null;
  }

  listCandidates(workspaceId?: string, status?: ContactIdentityCandidate["status"]): ContactIdentityCandidate[] {
    const params: unknown[] = [];
    const where: string[] = [];
    if (workspaceId) {
      where.push("workspace_id = ?");
      params.push(workspaceId);
    }
    if (status) {
      where.push("status = ?");
      params.push(status);
    }
    const rows = this.db
      .prepare(
        `SELECT id, workspace_id, contact_identity_id, handle_type, normalized_value, display_value, source, source_label, channel_id, channel_type, channel_user_id, confidence, status, reason_codes_json, created_at, updated_at
         FROM contact_identity_suggestions
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY updated_at DESC, confidence DESC`,
      )
      .all(...params) as ContactIdentitySuggestionRow[];
    return rows.map((row) => this.mapSuggestionRow(row));
  }

  searchLinkTargets(workspaceId: string, query: string, limit = 20): ContactIdentitySearchResult[] {
    const normalizedQuery = String(query || "").trim().toLowerCase();
    if (!workspaceId || !normalizedQuery) return [];

    const max = Math.min(Math.max(limit, 1), 50);
    const results: ContactIdentitySearchResult[] = [];
    const seen = new Set<string>();

    const addResult = (row: ContactIdentitySearchRow): void => {
      const key = `${row.handle_type}:${row.normalized_value}:${row.channel_id || ""}:${row.channel_user_id || ""}`;
      if (seen.has(key)) return;
      seen.add(key);
      results.push({
        id: row.id,
        workspaceId: row.workspace_id,
        handleType: row.handle_type,
        normalizedValue: row.normalized_value,
        displayValue: row.display_value,
        source: row.source,
        sourceLabel: row.source_label,
        channelId: row.channel_id || undefined,
        channelType: row.channel_type || undefined,
        channelUserId: row.channel_user_id || undefined,
        linkedIdentityId: row.linked_identity_id || undefined,
        linkedIdentityName: row.linked_identity_name || undefined,
        confidence: row.confidence,
        reasonCodes: parseJsonArray<string>(row.reason_codes_json),
      });
    };

    const channelRows = this.db
      .prepare(
        `SELECT DISTINCT cu.id, cu.channel_id, c.type AS channel_type, cu.channel_user_id, cu.display_name, cu.username, cu.allowed
         FROM channel_users cu
         JOIN channels c ON c.id = cu.channel_id
         JOIN channel_sessions cs
           ON cs.channel_id = cu.channel_id
          AND cs.user_id = cu.id
          AND cs.workspace_id = ?
         WHERE cu.channel_id IN (SELECT id FROM channels WHERE type IN ('slack', 'teams', 'whatsapp', 'signal', 'imessage'))`,
      )
      .all(workspaceId) as Array<{
      id: string;
      channel_id: string;
      channel_type: string;
      channel_user_id: string;
      display_name: string;
      username: string | null;
      allowed: number;
    }>;

    for (const row of channelRows) {
      const handleType = mapChannelTypeToHandleType(row.channel_type);
      if (!handleType) continue;
      const normalizedValue = normalizeHandleValue(handleType, row.channel_user_id || row.username || row.display_name);
      if (!normalizedValue) continue;
      const haystack = [
        row.display_name,
        row.username,
        row.channel_user_id,
        row.channel_type,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(normalizedQuery) && !normalizedValue.includes(normalizedQuery)) continue;
      const linkedIdentity = this.findIdentityByHandle(workspaceId, handleType, normalizedValue);
      addResult({
        id: row.id,
        workspace_id: workspaceId,
        handle_type: handleType,
        normalized_value: normalizedValue,
        display_value: row.display_name || row.username || row.channel_user_id,
        source: "gateway",
        source_label: toChannelLabel(row.channel_type as RelationshipTimelineSource),
        channel_id: row.channel_id,
        channel_type: row.channel_type,
        channel_user_id: row.channel_user_id,
        linked_identity_id: linkedIdentity?.id || null,
        linked_identity_name: linkedIdentity?.displayName || null,
        confidence: linkedIdentity ? 0.96 : 0.62,
        reason_codes_json: JSON.stringify([
          linkedIdentity ? "linked_identity" : "unlinked_channel_user",
          row.allowed ? "allowed" : "not_allowed",
        ]),
      });
    }

    const identities = this.listIdentities(workspaceId);
    for (const identity of identities) {
      const haystack = [
        identity.displayName,
        identity.primaryEmail,
        identity.companyHint,
        identity.kgEntityId,
        ...identity.handles.map((handle) => handle.displayValue),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(normalizedQuery)) continue;
      for (const handle of identity.handles) {
        addResult({
          id: handle.id,
          workspace_id: workspaceId,
          handle_type: handle.handleType,
          normalized_value: handle.normalizedValue,
          display_value: handle.displayValue,
          source: handle.source,
          source_label: handle.channelType ? toChannelLabel(handle.channelType as RelationshipTimelineSource) : "Manual",
          channel_id: handle.channelId || null,
          channel_type: handle.channelType || null,
          channel_user_id: handle.channelUserId || null,
          linked_identity_id: identity.id,
          linked_identity_name: identity.displayName,
          confidence: 0.9,
          reason_codes_json: JSON.stringify(["existing_identity", handle.handleType]),
        });
      }
    }

    return results.sort((a, b) => b.confidence - a.confidence || a.displayValue.localeCompare(b.displayValue)).slice(0, max);
  }

  linkManualHandle(input: {
    workspaceId: string;
    contactIdentityId: string;
    handleType: ContactIdentityHandleType;
    normalizedValue: string;
    displayValue: string;
    source?: ContactIdentityHandle["source"];
    channelId?: string;
    channelType?: string;
    channelUserId?: string;
  }): ContactIdentityHandle | null {
    const normalizedValue = normalizeHandleValue(input.handleType, input.normalizedValue) || normalizeHandleValue(input.handleType, input.displayValue);
    if (!normalizedValue) return null;
    const handle = this.ensureHandle({
      workspaceId: input.workspaceId,
      contactIdentityId: input.contactIdentityId,
      handleType: input.handleType,
      normalizedValue,
      displayValue: input.displayValue,
      source: input.source || "manual",
      channelId: input.channelId,
      channelType: input.channelType,
      channelUserId: input.channelUserId,
    });
    if (handle) {
      this.insertAudit({
        workspaceId: input.workspaceId,
        contactIdentityId: input.contactIdentityId,
        handleId: handle.id,
        action: "handle_manually_linked",
        detail: {
          handleType: input.handleType,
          normalizedValue,
          channelType: input.channelType,
          channelUserId: input.channelUserId,
        },
      });
    }
    return handle;
  }

  getReplyTargets(contactIdentityId: string): ContactIdentityReplyTarget[] {
    const identity = this.getIdentity(contactIdentityId);
    if (!identity) return [];

    const targets: ContactIdentityReplyTarget[] = [];
    for (const handle of identity.handles) {
      if (!handle.channelType || !handle.channelId || !handle.channelUserId) continue;
      if (!["slack", "teams", "whatsapp", "signal", "imessage"].includes(handle.channelType)) continue;
      const handleType = handle.handleType;
      const userRow = this.db
        .prepare(
          `SELECT id
           FROM channel_users
           WHERE channel_id = ? AND channel_user_id = ?`,
        )
        .get(handle.channelId, handle.channelUserId) as { id: string } | undefined;
      if (!userRow) continue;
      const latestSession = this.db
        .prepare(
          `SELECT chat_id, last_activity_at
           FROM channel_sessions
           WHERE channel_id = ? AND user_id = ? AND workspace_id = ?
           ORDER BY last_activity_at DESC
           LIMIT 1`,
        )
        .get(handle.channelId, userRow.id, identity.workspaceId) as { chat_id: string; last_activity_at: number } | undefined;
      const latestMessage = this.db
        .prepare(
          `SELECT chat_id, timestamp
           FROM channel_messages
           WHERE channel_id = ? AND user_id = ?
           ORDER BY timestamp DESC
           LIMIT 1`,
        )
        .get(handle.channelId, userRow.id) as { chat_id: string; timestamp: number } | undefined;
      const chatId = latestSession?.chat_id || latestMessage?.chat_id;
      if (!chatId) continue;
      targets.push({
        handleId: handle.id,
        contactIdentityId: identity.id,
        workspaceId: identity.workspaceId,
        channelType: handle.channelType as ContactIdentityReplyTarget["channelType"],
        channelId: handle.channelId,
        chatId,
        handleType,
        label: `${handle.channelType === "imessage" ? "iMessage" : toChannelLabel(handle.channelType as RelationshipTimelineSource)} reply`,
        displayValue: handle.displayValue,
        lastMessageAt: latestMessage?.timestamp || latestSession?.last_activity_at,
      });
    }

    const deduped = new Map<string, ContactIdentityReplyTarget>();
    for (const target of targets.sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0))) {
      const key = `${target.channelType}:${target.chatId}`;
      if (!deduped.has(key)) deduped.set(key, target);
    }
    return [...deduped.values()];
  }

  confirmCandidate(candidateId: string): ContactIdentityCandidate | null {
    const candidate = this.getCandidateRow(candidateId);
    if (!candidate) return null;
    this.ensureHandle({
      workspaceId: candidate.workspace_id,
      contactIdentityId: candidate.contact_identity_id,
      handleType: candidate.handle_type,
      normalizedValue: candidate.normalized_value,
      displayValue: candidate.display_value,
      source: candidate.source,
      channelId: candidate.channel_id || undefined,
      channelType: candidate.channel_type || undefined,
      channelUserId: candidate.channel_user_id || undefined,
    });
    this.db
      .prepare("UPDATE contact_identity_suggestions SET status = 'confirmed', updated_at = ? WHERE id = ?")
      .run(Date.now(), candidateId);
    this.insertAudit({
      workspaceId: candidate.workspace_id,
      contactIdentityId: candidate.contact_identity_id,
      suggestionId: candidate.id,
      action: "candidate_confirmed",
      detail: { handleType: candidate.handle_type, normalizedValue: candidate.normalized_value },
    });
    return this.mapSuggestionRow(this.getCandidateRow(candidateId)!);
  }

  rejectCandidate(candidateId: string): ContactIdentityCandidate | null {
    const candidate = this.getCandidateRow(candidateId);
    if (!candidate) return null;
    this.db
      .prepare("UPDATE contact_identity_suggestions SET status = 'rejected', updated_at = ? WHERE id = ?")
      .run(Date.now(), candidateId);
    this.insertAudit({
      workspaceId: candidate.workspace_id,
      contactIdentityId: candidate.contact_identity_id,
      suggestionId: candidate.id,
      action: "candidate_rejected",
      detail: { handleType: candidate.handle_type, normalizedValue: candidate.normalized_value },
    });
    return this.mapSuggestionRow(this.getCandidateRow(candidateId)!);
  }

  unlinkHandle(handleId: string): boolean {
    const handle = this.db
      .prepare(
        `SELECT id, contact_identity_id, workspace_id, handle_type, normalized_value, display_value, source, channel_id, channel_type, channel_user_id, created_at, updated_at
         FROM contact_identity_handles
         WHERE id = ?`,
      )
      .get(handleId) as ContactIdentityHandleRow | undefined;
    if (!handle) return false;
    this.db.transaction(() => {
      // Legacy schemas use a restrictive FK from audit rows to handles. Clear
      // those references before deletion and retain the removed id in the
      // durable unlink audit payload instead.
      this.db
        .prepare("UPDATE contact_identity_audit SET handle_id = NULL WHERE handle_id = ?")
        .run(handleId);
      this.db.prepare("DELETE FROM contact_identity_handles WHERE id = ?").run(handleId);
      this.insertAudit({
        workspaceId: handle.workspace_id,
        contactIdentityId: handle.contact_identity_id,
        action: "handle_unlinked",
        detail: {
          handleId: handle.id,
          handleType: handle.handle_type,
          normalizedValue: handle.normalized_value,
        },
      });
    })();
    return true;
  }

  getCoverageStats(workspaceId?: string): ContactIdentityCoverageStats {
    const resolvedMailboxContacts =
      (this.db
        .prepare(
          `SELECT COUNT(DISTINCT mc.email) AS count
           FROM mailbox_contacts mc
           JOIN contact_identity_handles h
             ON h.handle_type = 'email'
            AND h.normalized_value = LOWER(mc.email)
           ${workspaceId ? "WHERE h.workspace_id = ?" : ""}`,
        )
        .get(...(workspaceId ? [workspaceId] : [])) as { count?: number } | undefined)?.count || 0;

    const unresolvedByType = (channelType: "slack" | "teams" | "whatsapp" | "signal" | "imessage") =>
      (this.db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM channel_users cu
           JOIN channels c ON c.id = cu.channel_id
           LEFT JOIN contact_identity_handles h
             ON h.channel_type = c.type
            AND h.channel_user_id = cu.channel_user_id
            ${workspaceId ? "AND h.workspace_id = ?" : ""}
           WHERE c.type = ?
             AND h.id IS NULL`,
        )
        .get(...(workspaceId ? [workspaceId, channelType] : [channelType])) as {
        count?: number;
      } | undefined)?.count || 0;

    const resolvedCrmContacts = (this.db
      .prepare(
        `SELECT COUNT(DISTINCT contact_identity_id) AS count
         FROM contact_identity_handles
         WHERE handle_type = 'crm_contact_id'
           ${workspaceId ? "AND workspace_id = ?" : ""}`,
      )
      .get(...(workspaceId ? [workspaceId] : [])) as { count?: number } | undefined)?.count || 0;

    const suggestionCounts = this.db
      .prepare(
        `SELECT status, COUNT(*) AS count
         FROM contact_identity_suggestions
         ${workspaceId ? "WHERE workspace_id = ?" : ""}
         GROUP BY status`,
      )
      .all(...(workspaceId ? [workspaceId] : [])) as Array<{ status: string; count: number }>;

    const countFor = (status: string) => suggestionCounts.find((row) => row.status === status)?.count || 0;

    return {
      resolvedMailboxContacts,
      unresolvedSlackUsers: unresolvedByType("slack"),
      unresolvedTeamsUsers: unresolvedByType("teams"),
      unresolvedWhatsAppUsers: unresolvedByType("whatsapp"),
      unresolvedSignalUsers: unresolvedByType("signal"),
      unresolvedImessageUsers: unresolvedByType("imessage"),
      resolvedCrmContacts,
      suggestedLinks: countFor("suggested"),
      confirmedLinks: countFor("confirmed") + countFor("auto_linked"),
      rejectedLinks: countFor("rejected"),
    };
  }

  getChannelPreferenceSummary(contactIdentityId: string): ChannelPreferenceSummary {
    const acc = this.buildTimelineAccumulator({ contactIdentityId, limit: 200 });
    const channels: Array<"email" | "slack" | "teams" | "whatsapp" | "signal" | "imessage"> = [
      "email",
      "slack",
      "teams",
      "whatsapp",
      "signal",
      "imessage",
    ];
    const responseLatencyHours: ChannelPreferenceSummary["responseLatencyHours"] = {};
    const messageCountByChannel: ChannelPreferenceSummary["messageCountByChannel"] = {};
    const lastInboundAtByChannel: ChannelPreferenceSummary["lastInboundAtByChannel"] = {};
    const lastOutboundAtByChannel: ChannelPreferenceSummary["lastOutboundAtByChannel"] = {};

    let preferredChannel: ChannelPreferenceSummary["preferredChannel"];
    let preferredScore = Number.NEGATIVE_INFINITY;

    for (const channel of channels) {
      const samples = acc.responseSamplesByChannel.get(channel) || [];
      const messageCount = acc.messageCountByChannel.get(channel) || 0;
      const lastInboundAt = acc.lastInboundAtByChannel.get(channel);
      const lastOutboundAt = acc.lastOutboundAtByChannel.get(channel);
      const latency = samples.length ? samples.reduce((sum, value) => sum + value, 0) / samples.length : undefined;

      if (typeof latency === "number") {
        responseLatencyHours[channel] = Number(latency.toFixed(2));
      }
      if (messageCount > 0) {
        messageCountByChannel[channel] = messageCount;
      }
      if (typeof lastInboundAt === "number") {
        lastInboundAtByChannel[channel] = lastInboundAt;
      }
      if (typeof lastOutboundAt === "number") {
        lastOutboundAtByChannel[channel] = lastOutboundAt;
      }

      const score =
        (messageCount > 0 ? Math.min(messageCount, 8) : 0) +
        (typeof latency === "number" ? Math.max(0, 10 - latency) : 0) +
        (typeof lastInboundAt === "number" ? lastInboundAt / 1_000_000_000_000 : 0);
      if (score > preferredScore && channel !== "email") {
        preferredScore = score;
        preferredChannel = channel;
      }
    }

    let recommendedReason: string | undefined;
    if (preferredChannel && preferredChannel !== "email") {
      const latency = responseLatencyHours[preferredChannel];
      const messageCount = messageCountByChannel[preferredChannel];
      if (typeof latency === "number" && messageCount && messageCount >= 2) {
        recommendedReason = `Recent ${toChannelLabel(preferredChannel)} exchanges suggest faster responses there.`;
      } else if (messageCount && messageCount >= 3) {
        recommendedReason = `${toChannelLabel(preferredChannel)} is the most active recent channel for this contact.`;
      }
    }

    return {
      preferredChannel,
      recommendedReason,
      responseLatencyHours,
      messageCountByChannel,
      lastInboundAtByChannel,
      lastOutboundAtByChannel,
    };
  }

  getTimeline(query: RelationshipTimelineQuery): RelationshipTimelineEvent[] {
    return this.buildTimelineAccumulator(query).events;
  }

  private buildTimelineAccumulator(query: RelationshipTimelineQuery): TimelineAccumulator {
    const contactIdentityId = String(query.contactIdentityId || "").trim();
    if (!contactIdentityId) {
      return {
        events: [],
        responseSamplesByChannel: new Map(),
        lastInboundAtByChannel: new Map(),
        lastOutboundAtByChannel: new Map(),
        messageCountByChannel: new Map(),
      };
    }
    const identity = this.getIdentity(contactIdentityId);
    if (!identity) {
      return {
        events: [],
        responseSamplesByChannel: new Map(),
        lastInboundAtByChannel: new Map(),
        lastOutboundAtByChannel: new Map(),
        messageCountByChannel: new Map(),
      };
    }

    const limit = Math.min(Math.max(query.limit || 40, 1), 200);
    const startAt = typeof query.startAt === "number" ? query.startAt : undefined;
    const endAt = typeof query.endAt === "number" ? query.endAt : undefined;

    const acc: TimelineAccumulator = {
      events: [],
      responseSamplesByChannel: new Map(),
      lastInboundAtByChannel: new Map(),
      lastOutboundAtByChannel: new Map(),
      messageCountByChannel: new Map(),
    };

    const emailHandles = identity.handles.filter((handle) => handle.handleType === "email");
    const threadIds = new Set<string>();

    for (const handle of emailHandles) {
      const rows = this.db
        .prepare(
          `SELECT id, subject, sensitive_content_json
           FROM mailbox_threads
           WHERE participants_json LIKE ?`,
        )
        .all(`%${handle.displayValue}%`) as Array<{
        id: string;
        subject: string;
        sensitive_content_json: string | null;
      }>;
      for (const row of rows) {
        threadIds.add(row.id);
      }
    }

    if (query.threadId) {
      threadIds.add(query.threadId);
    }

    if (threadIds.size > 0) {
      const threadIdList = [...threadIds];
      const placeholders = threadIdList.map(() => "?").join(", ");
      const timeClauses: string[] = [];
      const timeParams: unknown[] = [];
      if (typeof startAt === "number") {
        timeClauses.push("m.received_at >= ?");
        timeParams.push(startAt);
      }
      if (typeof endAt === "number") {
        timeClauses.push("m.received_at <= ?");
        timeParams.push(endAt);
      }
      const mailboxMessages = this.db
        .prepare(
          `SELECT m.id, m.thread_id, m.direction, m.subject, m.body_text, m.received_at, t.sensitive_content_json
           FROM mailbox_messages m
           JOIN mailbox_threads t ON t.id = m.thread_id
           WHERE m.thread_id IN (${placeholders})
             ${timeClauses.length ? `AND ${timeClauses.join(" AND ")}` : ""}
           ORDER BY m.received_at DESC`,
        )
        .all(...threadIdList, ...timeParams) as Array<{
        id: string;
        thread_id: string;
        direction: "incoming" | "outgoing";
        subject: string;
        body_text: string;
        received_at: number;
        sensitive_content_json: string | null;
      }>;

      this.pushMailboxEvents(acc, contactIdentityId, mailboxMessages);

      const commitments = this.db
        .prepare(
          `SELECT id, thread_id, title, due_at, state
           FROM mailbox_commitments
           WHERE thread_id IN (${placeholders})`,
        )
        .all(...threadIdList) as Array<{
        id: string;
        thread_id: string;
        title: string;
        due_at: number | null;
        state: string;
      }>;
      for (const commitment of commitments) {
        acc.events.push({
          id: `commitment:${commitment.id}`,
          contactIdentityId,
          source: "commitment",
          sourceLabel: "Commitment",
          direction: "outgoing",
          timestamp: commitment.due_at || Date.now(),
          title: commitment.title,
          summary: compactText(`Commitment ${commitment.state}${commitment.due_at ? ` due ${new Date(commitment.due_at).toLocaleString()}` : ""}`, 160),
          rawRef: `mailbox_commitment:${commitment.id}`,
          threadId: commitment.thread_id,
          sensitive: false,
        });
      }

      const mailboxEvents = this.db
        .prepare(
          `SELECT id, thread_id, event_type, summary_text, created_at
           FROM mailbox_events
           WHERE thread_id IN (${placeholders})`,
        )
        .all(...threadIdList) as Array<{
        id: string;
        thread_id: string | null;
        event_type: string;
        summary_text: string | null;
        created_at: number;
      }>;
      for (const event of mailboxEvents) {
        const source: RelationshipTimelineSource =
          event.event_type === "mission_control_handoff_created" ? "handoff" : "automation";
        acc.events.push({
          id: `mailbox_event:${event.id}`,
          contactIdentityId,
          source,
          sourceLabel: source === "handoff" ? "Mission Control" : "Automation",
          direction: "outgoing",
          timestamp: event.created_at,
          title: source === "handoff" ? "Mission Control handoff" : event.event_type.replace(/_/g, " "),
          summary: compactText(event.summary_text || event.event_type, 180),
          rawRef: `mailbox_event:${event.id}`,
          threadId: event.thread_id || undefined,
          sensitive: false,
        });
      }

      for (const crmHandle of identity.handles.filter((handle) => handle.handleType === "crm_contact_id")) {
        acc.events.push({
          id: `crm_handle:${crmHandle.id}`,
          contactIdentityId,
          source: "crm",
          sourceLabel: "CRM",
          direction: "outgoing",
          timestamp: crmHandle.createdAt,
          title: "CRM contact linked",
          summary: compactText(`CRM record ${crmHandle.displayValue} is linked to this identity.`, 180),
          rawRef: `contact_identity_handle:${crmHandle.id}`,
          sensitive: false,
        });
      }
    }

    this.pushChannelEvents(acc, identity, startAt, endAt);
    acc.events.sort(stableTimelineSort);
    acc.events = acc.events.slice(0, limit);
    return acc;
  }

  private pushMailboxEvents(
    acc: TimelineAccumulator,
    contactIdentityId: string,
    rows: Array<{
      id: string;
      thread_id: string;
      direction: "incoming" | "outgoing";
      subject: string;
      body_text: string;
      received_at: number;
      sensitive_content_json: string | null;
    }>,
  ): void {
    const lastIncomingByThread = new Map<string, number>();
    for (const row of [...rows].sort((a, b) => a.received_at - b.received_at)) {
      if (row.direction === "incoming") {
        lastIncomingByThread.set(row.thread_id, row.received_at);
      } else {
        const priorIncoming = lastIncomingByThread.get(row.thread_id);
        if (priorIncoming) {
          const samples = acc.responseSamplesByChannel.get("email") || [];
          samples.push((row.received_at - priorIncoming) / (60 * 60 * 1000));
          acc.responseSamplesByChannel.set("email", samples);
          lastIncomingByThread.delete(row.thread_id);
        }
      }
    }

    for (const row of rows) {
      const sensitive = Boolean(parseJsonArray(row.sensitive_content_json).length || row.sensitive_content_json);
      acc.events.push({
        id: `mailbox_message:${row.id}`,
        contactIdentityId,
        source: "email",
        sourceLabel: "Email",
        direction: row.direction,
        timestamp: row.received_at,
        title: row.subject || "Email",
        summary: compactText(row.body_text, 180),
        rawRef: `mailbox_message:${row.id}`,
        threadId: row.thread_id,
        sensitive,
      });
      this.recordChannelStats(acc, "email", row.direction, row.received_at);
    }
  }

  private pushChannelEvents(
    acc: TimelineAccumulator,
    identity: ContactIdentity,
    startAt?: number,
    endAt?: number,
  ): void {
    const groupedHandles = new Map<string, ContactIdentityHandle[]>();
    for (const handle of identity.handles) {
      if (!handle.channelType || !handle.channelId) continue;
      const key = `${handle.channelType}:${handle.channelId}:${handle.channelUserId || ""}`;
      const bucket = groupedHandles.get(key);
      if (bucket) bucket.push(handle);
      else groupedHandles.set(key, [handle]);
    }

    for (const handles of groupedHandles.values()) {
      const primary = handles[0];
      const channelSource = (primary.channelType || "") as RelationshipTimelineSource;
      if (!["slack", "teams", "whatsapp", "signal", "imessage"].includes(channelSource)) continue;
      const userDbRow = primary.channelUserId
        ? (this.db
            .prepare(
              `SELECT id
               FROM channel_users
               WHERE channel_id = ? AND channel_user_id = ?`,
            )
            .get(primary.channelId, primary.channelUserId) as { id: string } | undefined)
        : undefined;
      if (!userDbRow) continue;

      const chatIds = this.db
        .prepare(
          `SELECT DISTINCT chat_id
           FROM channel_messages
           WHERE channel_id = ?
             AND user_id = ?
           ORDER BY timestamp DESC
           LIMIT 10`,
        )
        .all(primary.channelId, userDbRow.id) as Array<{ chat_id: string }>;
      if (!chatIds.length) continue;
      const placeholders = chatIds.map(() => "?").join(", ");
      const timeClauses: string[] = [];
      const params: unknown[] = [primary.channelId, ...chatIds.map((row) => row.chat_id)];
      if (typeof startAt === "number") {
        timeClauses.push("m.timestamp >= ?");
        params.push(startAt);
      }
      if (typeof endAt === "number") {
        timeClauses.push("m.timestamp <= ?");
        params.push(endAt);
      }

      const rows = this.db
        .prepare(
          `SELECT m.id, m.channel_id, m.chat_id, m.user_id, m.direction, m.content, m.timestamp, c.type AS channel_type, c.name AS channel_name
           FROM channel_messages m
           JOIN channels c ON c.id = m.channel_id
           WHERE m.channel_id = ?
             AND m.chat_id IN (${placeholders})
             ${timeClauses.length ? `AND ${timeClauses.join(" AND ")}` : ""}
           ORDER BY m.timestamp DESC`,
        )
        .all(...params) as ChannelMessageRow[];

      const lastIncomingByChat = new Map<string, number>();
      for (const row of [...rows].sort((a, b) => a.timestamp - b.timestamp)) {
        const normalizedDirection = row.direction === "incoming" ? "incoming" : "outgoing";
        if (normalizedDirection === "incoming") {
          lastIncomingByChat.set(row.chat_id, row.timestamp);
        } else {
          const priorIncoming = lastIncomingByChat.get(row.chat_id);
          if (priorIncoming) {
            const samples = acc.responseSamplesByChannel.get(channelSource) || [];
            samples.push((row.timestamp - priorIncoming) / (60 * 60 * 1000));
            acc.responseSamplesByChannel.set(channelSource, samples);
            lastIncomingByChat.delete(row.chat_id);
          }
        }
      }

      for (const row of rows) {
        const direction = row.direction === "incoming" ? "incoming" : "outgoing";
        acc.events.push({
          id: `channel_message:${row.id}`,
          contactIdentityId: identity.id,
          source: channelSource,
          sourceLabel: row.channel_name || toChannelLabel(channelSource),
          direction,
          timestamp: row.timestamp,
          title: `${toChannelLabel(channelSource)} message`,
          summary: compactText(row.content, 180),
          rawRef: `channel_message:${row.id}`,
          chatId: row.chat_id,
          sensitive: false,
        });
        this.recordChannelStats(
          acc,
          channelSource as "slack" | "teams" | "whatsapp" | "signal" | "imessage",
          direction,
          row.timestamp,
        );
      }
    }
  }

  private recordChannelStats(
    acc: TimelineAccumulator,
    channel: "email" | "slack" | "teams" | "whatsapp" | "signal" | "imessage",
    direction: "incoming" | "outgoing",
    timestamp: number,
  ): void {
    acc.messageCountByChannel.set(channel, (acc.messageCountByChannel.get(channel) || 0) + 1);
    if (direction === "incoming") {
      if ((acc.lastInboundAtByChannel.get(channel) || 0) < timestamp) {
        acc.lastInboundAtByChannel.set(channel, timestamp);
      }
    } else if ((acc.lastOutboundAtByChannel.get(channel) || 0) < timestamp) {
      acc.lastOutboundAtByChannel.set(channel, timestamp);
    }
  }

  private upsertMailboxCandidates(input: {
    identity: ContactIdentity;
    email: string;
    displayName: string;
    companyHint?: string;
    phoneHints: string[];
    crmHints: string[];
    learnedFacts: string[];
  }): ContactIdentityCandidate[] {
    const rows = this.db
      .prepare(
      `SELECT cu.channel_id, c.type AS channel_type, c.name AS channel_name, cu.channel_user_id, cu.display_name, cu.username, cu.allowed, cu.created_at, cu.last_seen_at
         FROM channel_users cu
         JOIN channels c ON c.id = cu.channel_id
         WHERE c.type IN ('slack', 'teams', 'whatsapp', 'signal', 'imessage')`,
      )
      .all() as ChannelUserCandidateRow[];

    const results: ContactIdentityCandidate[] = [];
    for (const row of rows) {
      const candidate = this.evaluateCandidate(input, row);
      if (!candidate) continue;
      results.push(this.upsertSuggestion(candidate));
    }
    return results.sort((a, b) => b.confidence - a.confidence || b.updatedAt - a.updatedAt);
  }

  private evaluateCandidate(
    input: {
      identity: ContactIdentity;
      email: string;
      displayName: string;
      companyHint?: string;
      phoneHints: string[];
      crmHints: string[];
      learnedFacts: string[];
    },
    row: ChannelUserCandidateRow,
  ): Omit<ContactIdentityCandidate, "id" | "createdAt" | "updatedAt"> | null {
    const handleType = mapChannelTypeToHandleType(row.channel_type);
    if (!handleType) return null;

    const reasonCodes: string[] = [];
    let confidence = 0;
    let normalizedValue: string | null = null;
    let displayValue = row.display_name || row.channel_user_id;

    if (row.channel_type === "whatsapp" || row.channel_type === "signal") {
      normalizedValue = normalizePhone(row.channel_user_id) || normalizePhone(row.username);
      if (!normalizedValue) return null;
      if (input.phoneHints.includes(normalizedValue)) {
        confidence = 0.97;
        reasonCodes.push("exact_phone_match");
      }
    } else if (row.channel_type === "imessage") {
      normalizedValue =
        normalizeHandleValue("imessage_handle", row.channel_user_id) ||
        normalizeHandleValue("imessage_handle", row.username) ||
        normalizeHandleValue("imessage_handle", row.display_name);
      if (!normalizedValue) return null;
      if (
        normalizeHandleValue("imessage_handle", input.email) === normalizedValue ||
        input.phoneHints.includes(normalizedValue)
      ) {
        confidence = 0.95;
        reasonCodes.push("exact_imessage_match");
      }
    } else {
      normalizedValue = row.channel_user_id;
      const usernameEmail = normalizeEmail(row.username);
      if (usernameEmail && usernameEmail === input.email) {
        confidence = 0.95;
        reasonCodes.push("exact_email_match");
      }
    }

    const nameScore = scoreNameSimilarity(input.displayName, row.display_name);
    if (nameScore >= 0.74) {
      confidence = Math.max(confidence, 0.61 + nameScore * 0.14);
      reasonCodes.push("display_name_similarity");
    }

    const emailDomain = input.email.split("@")[1] || "";
    const username = String(row.username || "").toLowerCase();
    const companyToken = normalizeName(input.companyHint);
    if (emailDomain && username.includes(emailDomain)) {
      confidence = Math.max(confidence, 0.66);
      reasonCodes.push("domain_agreement");
    }
    if (
      companyToken &&
      (normalizeName(row.display_name).includes(companyToken) || normalizeName(row.username).includes(companyToken))
    ) {
      confidence = Math.max(confidence, 0.64);
      reasonCodes.push("company_hint_match");
    }

    if (confidence < 0.58) return null;

    const status: ContactIdentityCandidate["status"] =
      reasonCodes.includes("exact_email_match") ||
      reasonCodes.includes("exact_phone_match") ||
      reasonCodes.includes("exact_imessage_match")
        ? "auto_linked"
        : "suggested";

    if (status === "auto_linked") {
      this.ensureHandle({
        workspaceId: input.identity.workspaceId,
        contactIdentityId: input.identity.id,
        handleType,
        normalizedValue,
        displayValue,
        source: "gateway",
        channelId: row.channel_id,
        channelType: row.channel_type,
        channelUserId: row.channel_user_id,
      });
    }

    return {
      workspaceId: input.identity.workspaceId,
      contactIdentityId: input.identity.id,
      handleType,
      normalizedValue,
      displayValue,
      source: "gateway",
      sourceLabel: row.channel_name || toChannelLabel(row.channel_type as RelationshipTimelineSource),
      channelId: row.channel_id,
      channelType: row.channel_type,
      channelUserId: row.channel_user_id,
      confidence: Number(Math.min(confidence, 0.99).toFixed(2)),
      status,
      reasonCodes,
    };
  }

  private upsertSuggestion(
    input: Omit<ContactIdentityCandidate, "id" | "createdAt" | "updatedAt">,
  ): ContactIdentityCandidate {
    const existing = this.db
      .prepare(
        `SELECT id, workspace_id, contact_identity_id, handle_type, normalized_value, display_value, source, source_label, channel_id, channel_type, channel_user_id, confidence, status, reason_codes_json, created_at, updated_at
         FROM contact_identity_suggestions
         WHERE workspace_id = ?
           AND contact_identity_id = ?
           AND handle_type = ?
           AND normalized_value = ?
           AND COALESCE(channel_type, '') = COALESCE(?, '')
           AND COALESCE(channel_user_id, '') = COALESCE(?, '')`,
      )
      .get(
        input.workspaceId,
        input.contactIdentityId,
        input.handleType,
        input.normalizedValue,
        input.channelType || null,
        input.channelUserId || null,
      ) as ContactIdentitySuggestionRow | undefined;

    const now = Date.now();
    if (existing) {
      this.db
        .prepare(
          `UPDATE contact_identity_suggestions
           SET display_value = ?, source = ?, source_label = ?, channel_id = ?, channel_type = ?, channel_user_id = ?, confidence = ?, status = ?, reason_codes_json = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          input.displayValue,
          input.source,
          input.sourceLabel,
          input.channelId || null,
          input.channelType || null,
          input.channelUserId || null,
          input.confidence,
          input.status,
          JSON.stringify(input.reasonCodes),
          now,
          existing.id,
        );
      return this.mapSuggestionRow(this.getCandidateRow(existing.id)!);
    }

    const id = uuidv4();
    this.db
      .prepare(
        `INSERT INTO contact_identity_suggestions
         (id, workspace_id, contact_identity_id, handle_type, normalized_value, display_value, source, source_label, channel_id, channel_type, channel_user_id, confidence, status, reason_codes_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.workspaceId,
        input.contactIdentityId,
        input.handleType,
        input.normalizedValue,
        input.displayValue,
        input.source,
        input.sourceLabel,
        input.channelId || null,
        input.channelType || null,
        input.channelUserId || null,
        input.confidence,
        input.status,
        JSON.stringify(input.reasonCodes),
        now,
        now,
      );
    this.insertAudit({
      workspaceId: input.workspaceId,
      contactIdentityId: input.contactIdentityId,
      suggestionId: id,
      action: input.status === "auto_linked" ? "candidate_auto_linked" : "candidate_suggested",
      detail: { handleType: input.handleType, normalizedValue: input.normalizedValue, reasonCodes: input.reasonCodes },
    });
    return this.mapSuggestionRow(this.getCandidateRow(id)!);
  }

  private createIdentity(input: {
    workspaceId: string;
    displayName: string;
    primaryEmail?: string | null;
    companyHint?: string;
    confidence: number;
  }): ContactIdentity {
    const now = Date.now();
    const id = uuidv4();
    this.db
      .prepare(
        `INSERT INTO contact_identities
         (id, workspace_id, display_name, primary_email, company_hint, confidence, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.workspaceId,
        input.displayName,
        input.primaryEmail || null,
        input.companyHint || null,
        input.confidence,
        now,
        now,
      );
    return this.getIdentity(id)!;
  }

  private touchIdentity(
    identityId: string,
    patch: {
      displayName?: string;
      primaryEmail?: string | null;
      companyHint?: string;
      kgEntityId?: string;
    },
  ): void {
    const fields: string[] = [];
    const values: unknown[] = [];
    if (patch.displayName) {
      fields.push("display_name = ?");
      values.push(patch.displayName);
    }
    if (patch.primaryEmail) {
      fields.push("primary_email = ?");
      values.push(patch.primaryEmail);
    }
    if (patch.companyHint) {
      fields.push("company_hint = ?");
      values.push(patch.companyHint);
    }
    if (patch.kgEntityId) {
      fields.push("kg_entity_id = ?");
      values.push(patch.kgEntityId);
    }
    if (!fields.length) return;
    fields.push("updated_at = ?");
    values.push(Date.now(), identityId);
    this.db.prepare(`UPDATE contact_identities SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  }

  private ensureHandle(input: {
    workspaceId: string;
    contactIdentityId: string;
    handleType: ContactIdentityHandleType;
    normalizedValue: string;
    displayValue: string;
    source: ContactIdentityHandle["source"];
    channelId?: string;
    channelType?: string;
    channelUserId?: string;
  }): ContactIdentityHandle | null {
    if (!input.normalizedValue) return null;
    const existing = this.db
      .prepare(
        `SELECT id, contact_identity_id, workspace_id, handle_type, normalized_value, display_value, source, channel_id, channel_type, channel_user_id, created_at, updated_at
         FROM contact_identity_handles
         WHERE workspace_id = ? AND handle_type = ? AND normalized_value = ?`,
      )
      .get(input.workspaceId, input.handleType, input.normalizedValue) as ContactIdentityHandleRow | undefined;
    const now = Date.now();
    if (existing) {
      this.db
        .prepare(
          `UPDATE contact_identity_handles
           SET contact_identity_id = ?, display_value = ?, source = ?, channel_id = ?, channel_type = ?, channel_user_id = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          input.contactIdentityId,
          input.displayValue,
          input.source,
          input.channelId || null,
          input.channelType || null,
          input.channelUserId || null,
          now,
          existing.id,
        );
      return this.mapHandleRow({
        ...existing,
        contact_identity_id: input.contactIdentityId,
        display_value: input.displayValue,
        source: input.source,
        channel_id: input.channelId || null,
        channel_type: input.channelType || null,
        channel_user_id: input.channelUserId || null,
        updated_at: now,
      });
    }

    const id = uuidv4();
    this.db
      .prepare(
        `INSERT INTO contact_identity_handles
         (id, contact_identity_id, workspace_id, handle_type, normalized_value, display_value, source, channel_id, channel_type, channel_user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.contactIdentityId,
        input.workspaceId,
        input.handleType,
        input.normalizedValue,
        input.displayValue,
        input.source,
        input.channelId || null,
        input.channelType || null,
        input.channelUserId || null,
        now,
        now,
      );
    this.insertAudit({
      workspaceId: input.workspaceId,
      contactIdentityId: input.contactIdentityId,
      handleId: id,
      action: "handle_linked",
      detail: {
        handleType: input.handleType,
        normalizedValue: input.normalizedValue,
        channelType: input.channelType,
        channelUserId: input.channelUserId,
      },
    });
    return this.mapHandleRow({
      id,
      contact_identity_id: input.contactIdentityId,
      workspace_id: input.workspaceId,
      handle_type: input.handleType,
      normalized_value: input.normalizedValue,
      display_value: input.displayValue,
      source: input.source,
      channel_id: input.channelId || null,
      channel_type: input.channelType || null,
      channel_user_id: input.channelUserId || null,
      created_at: now,
      updated_at: now,
    });
  }

  private findIdentityByHandle(
    workspaceId: string,
    handleType: ContactIdentityHandleType,
    normalizedValue: string,
  ): ContactIdentity | null {
    const row = this.db
      .prepare(
        `SELECT contact_identity_id
         FROM contact_identity_handles
         WHERE workspace_id = ? AND handle_type = ? AND normalized_value = ?`,
      )
      .get(workspaceId, handleType, normalizedValue) as { contact_identity_id: string } | undefined;
    return row ? this.getIdentity(row.contact_identity_id) : null;
  }

  private listHandles(contactIdentityId: string): ContactIdentityHandle[] {
    const rows = this.db
      .prepare(
        `SELECT id, contact_identity_id, workspace_id, handle_type, normalized_value, display_value, source, channel_id, channel_type, channel_user_id, created_at, updated_at
         FROM contact_identity_handles
         WHERE contact_identity_id = ?
         ORDER BY created_at ASC`,
      )
      .all(contactIdentityId) as ContactIdentityHandleRow[];
    return rows.map((row) => this.mapHandleRow(row));
  }

  private getCandidateRow(candidateId: string): ContactIdentitySuggestionRow | undefined {
    return this.db
      .prepare(
        `SELECT id, workspace_id, contact_identity_id, handle_type, normalized_value, display_value, source, source_label, channel_id, channel_type, channel_user_id, confidence, status, reason_codes_json, created_at, updated_at
         FROM contact_identity_suggestions
         WHERE id = ?`,
      )
      .get(candidateId) as ContactIdentitySuggestionRow | undefined;
  }

  private mapHandleRow(row: ContactIdentityHandleRow): ContactIdentityHandle {
    return {
      id: row.id,
      contactIdentityId: row.contact_identity_id,
      workspaceId: row.workspace_id,
      handleType: row.handle_type,
      normalizedValue: row.normalized_value,
      displayValue: row.display_value,
      source: row.source,
      channelId: row.channel_id || undefined,
      channelType: row.channel_type || undefined,
      channelUserId: row.channel_user_id || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapSuggestionRow(row: ContactIdentitySuggestionRow): ContactIdentityCandidate {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      contactIdentityId: row.contact_identity_id,
      handleType: row.handle_type,
      normalizedValue: row.normalized_value,
      displayValue: row.display_value,
      source: row.source,
      sourceLabel: row.source_label,
      channelId: row.channel_id || undefined,
      channelType: row.channel_type || undefined,
      channelUserId: row.channel_user_id || undefined,
      confidence: row.confidence,
      status: row.status,
      reasonCodes: parseJsonArray<string>(row.reason_codes_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private insertAudit(input: {
    workspaceId: string;
    contactIdentityId?: string;
    handleId?: string;
    suggestionId?: string;
    action: string;
    detail?: Record<string, unknown>;
  }): void {
    this.db
      .prepare(
        `INSERT INTO contact_identity_audit
         (id, workspace_id, contact_identity_id, handle_id, suggestion_id, action, detail_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        uuidv4(),
        input.workspaceId,
        input.contactIdentityId || null,
        input.handleId || null,
        input.suggestionId || null,
        input.action,
        input.detail ? JSON.stringify(input.detail) : null,
        Date.now(),
      );
  }

  private findPersonEntityId(input: {
    workspaceId: string;
    email: string;
    displayName: string;
    companyHint?: string;
  }): string | undefined {
    if (!KnowledgeGraphService.isInitialized()) return undefined;
    const queries = uniqueStrings([input.email, input.displayName, input.companyHint]);
    for (const query of queries) {
      const result = KnowledgeGraphService.search(input.workspaceId, query, 8).find(({ entity }) => {
        if (entity.entityTypeName !== "person") return false;
        const entityEmail = normalizeEmail(String(entity.properties?.email || ""));
        if (entityEmail && entityEmail === input.email) return true;
        return normalizeName(entity.name) === normalizeName(input.displayName);
      });
      if (result?.entity?.id) return result.entity.id;
    }
    return undefined;
  }
}
