import Database from "better-sqlite3";
import { createCipheriv, createDecipheriv, createHash, pbkdf2Sync, randomBytes, randomUUID } from "crypto";
import { createLogger } from "../utils/logger";
import fs from "fs";
import os from "os";
import path from "path";
import { ChannelRepository, TaskRepository, WorkspaceRepository } from "../database/repositories";
import { AgentRoleRepository } from "../agents/AgentRoleRepository";
import { LLMProviderFactory } from "../agent/llm/provider-factory";
import { recordLlmCallError, recordLlmCallSuccess } from "../agent/llm/usage-telemetry";
import type { LLMMessage } from "../agent/llm/types";
import { GoogleWorkspaceSettingsManager } from "../settings/google-workspace-manager";
import { AgentMailSettingsManager } from "../settings/agentmail-manager";
import { gmailRequest } from "../utils/gmail-api";
import { googleCalendarRequest } from "../utils/google-calendar-api";
import { EmailClient, type EmailMessage } from "../gateway/channels/email-client";
import { LoomEmailClient } from "../gateway/channels/loom-client";
import { assertSafeLoomMailboxFolder } from "../utils/loom";
import { refreshMicrosoftEmailAccessToken } from "../utils/microsoft-email-oauth";
import { getSafeStorage, type SafeStorageLike } from "../utils/safe-storage";
import { getUserDataDir } from "../utils/user-data-dir";
import { RelationshipMemoryService } from "../memory/RelationshipMemoryService";
import { PlaybookService } from "../memory/PlaybookService";
import { KnowledgeGraphService } from "../knowledge-graph/KnowledgeGraphService";
import { getHeartbeatService } from "../agents/HeartbeatService";
import { ControlPlaneCoreService } from "../control-plane/ControlPlaneCoreService";
import { ContactIdentityService } from "../identity/ContactIdentityService";
import { MailboxAutomationHub } from "./MailboxAutomationHub";
import { MailboxAutomationRegistry } from "./MailboxAutomationRegistry";
import { AgentMailClient } from "../agentmail/AgentMailClient";
import { AgentMailAdminService } from "../agentmail/AgentMailAdminService";
import { mailboxLlmQuickReplies, mailboxLlmSimilarThreadIds } from "./mailbox-inbox-product-llm";
import { mergeMailboxCapabilities, resolveMailboxProviderBackend } from "./MailboxProviderClient";
import { getMailboxForwardingServiceInstance } from "./mailbox-forwarding-singleton";
import { parsePdfBuffer } from "../utils/pdf-parser";
import {
  ChannelPreferenceSummary,
  ContactIdentity,
  ContactIdentityCandidate,
  ContactIdentityCoverageStats,
  ContactIdentityHandleType,
  ContactIdentityResolution,
  ContactIdentityReplyTarget,
  ContactIdentitySearchResult,
  MailboxAccount,
  MailboxActionProposal,
  MailboxApplyActionInput,
  MailboxBulkReviewInput,
  MailboxBulkReviewResult,
  MailboxAutomationStatus,
  MailboxCommitment,
  MailboxCommitmentState,
  MailboxContactMemory,
  MailboxAskInput,
  MailboxAskResult,
  MailboxAttachmentRecord,
  MailboxAttachmentSummary,
  MailboxClientState,
  MailboxComposeDraft,
  MailboxComposeDraftInput,
  MailboxComposeDraftPatch,
  MailboxDomainCategory,
  MailboxDigest,
  MailboxDigestSnapshot,
  MailboxDraftOptions,
  MailboxDraftSuggestion,
  MailboxEvent,
  MailboxEventType,
  MailboxAutomationRecord,
  MailboxForwardRecipe,
  MailboxCompanyCandidate,
  MailboxMissionControlHandoffPreview,
  MailboxMissionControlHandoffRecord,
  MailboxMissionControlHandoffRequest,
  MailboxOperatorRecommendation,
  MailboxRuleRecipe,
  MailboxScheduleRecipe,
  MailboxSensitiveContent,
  MailboxListThreadsInput,
  MailboxMessage,
  MailboxQuickReplySuggestionsResult,
  MailboxSavedViewPreviewResult,
  MailboxSavedViewRecord,
  MailboxSnippetInput,
  MailboxSnippetRecord,
  MailboxParticipant,
  MailboxPriorityBand,
  MailboxClassificationState,
  MailboxProposalStatus,
  MailboxProposalType,
  MailboxProvider,
  MailboxProviderBackend,
  MailboxProviderCapability,
  MailboxQueuedAction,
  MailboxResearchResult,
  MailboxFolder,
  MailboxIdentity,
  MailboxLabel,
  MailboxOutgoingMessage,
  MailboxReclassifyInput,
  MailboxReclassifyResult,
  MailboxRecipientInput,
  MailboxSignature,
  MailboxSummaryCard,
  MailboxSyncHealth,
  MailboxSyncResult,
  MailboxSyncStatus,
  MailboxSyncProgress,
  MailboxSenderCleanupDigest,
  MailboxThreadCategory,
  MailboxThreadDetail,
  MailboxThreadListItem,
  MailboxThreadSortOrder,
  MailboxThreadMailboxView,
  MailboxTodayBucket,
  MailboxTodayDigest,
  RelationshipTimelineEvent,
  RelationshipTimelineQuery,
  getMailboxNoReplySender,
  normalizeMailboxEmailAddress,
  stripMailboxSummaryHtmlArtifacts,
} from "../../shared/mailbox";
import { MICROSOFT_EMAIL_DEFAULT_TENANT } from "../../shared/microsoft-email";
import type { AgentRole, CompanyEvidenceRef, CompanyOutputContract, Issue, Task } from "../../shared/types";
import { isTempWorkspaceId } from "../../shared/types";

type MailboxAccountRow = {
  id: string;
  provider: MailboxProvider;
  address: string;
  display_name: string | null;
  status: "connected" | "degraded" | "disconnected";
  capabilities_json: string | null;
  sync_cursor?: string | null;
  last_synced_at: number | null;
  classification_initial_batch_at: number | null;
};

type MailboxFolderRow = {
  id: string;
  account_id: string;
  provider_folder_id: string;
  name: string;
  role: MailboxFolder["role"];
  unread_count: number | null;
  total_count: number | null;
  created_at: number;
  updated_at: number;
};

type MailboxLabelRow = {
  id: string;
  account_id: string;
  provider_label_id: string;
  name: string;
  color: string | null;
  unread_count: number | null;
  total_count: number | null;
  created_at: number;
  updated_at: number;
};

type MailboxIdentityRow = {
  id: string;
  account_id: string;
  provider_identity_id: string | null;
  email: string;
  display_name: string | null;
  signature_id: string | null;
  is_default: number;
  created_at: number;
  updated_at: number;
};

type MailboxSignatureRow = {
  id: string;
  account_id: string;
  name: string;
  body_html: string | null;
  body_text: string;
  is_default: number;
  created_at: number;
  updated_at: number;
};

type MailboxComposeDraftRow = {
  id: string;
  account_id: string;
  thread_id: string | null;
  provider_draft_id: string | null;
  mode: MailboxComposeDraft["mode"];
  status: MailboxComposeDraft["status"];
  subject: string;
  body_text: string;
  body_html: string | null;
  to_json: string | null;
  cc_json: string | null;
  bcc_json: string | null;
  identity_id: string | null;
  signature_id: string | null;
  attachments_json: string | null;
  scheduled_at: number | null;
  send_after: number | null;
  latest_error: string | null;
  created_at: number;
  updated_at: number;
};

type MailboxOutgoingMessageRow = {
  id: string;
  draft_id: string | null;
  account_id: string;
  status: MailboxOutgoingMessage["status"];
  provider_message_id: string | null;
  scheduled_at: number | null;
  send_after: number | null;
  latest_error: string | null;
  created_at: number;
  updated_at: number;
};

type MailboxQueuedActionRow = {
  id: string;
  account_id: string | null;
  thread_id: string | null;
  draft_id: string | null;
  action_type: MailboxQueuedAction["type"];
  status: MailboxQueuedAction["status"];
  payload_json: string | null;
  attempts: number;
  next_attempt_at: number | null;
  latest_error: string | null;
  undo_of_action_id: string | null;
  created_at: number;
  updated_at: number;
};

type MailboxThreadRow = {
  id: string;
  account_id: string;
  provider: MailboxProvider;
  provider_thread_id: string;
  subject: string;
  snippet: string;
  participants_json: string | null;
  labels_json: string | null;
  category: MailboxThreadCategory;
  today_bucket: MailboxTodayBucket;
  domain_category: MailboxDomainCategory;
  classification_rationale: string | null;
  priority_score: number;
  urgency_score: number;
  needs_reply: number;
  stale_followup: number;
  cleanup_candidate: number;
  handled: number;
  local_inbox_hidden: number;
  unread_count: number;
  message_count: number;
  last_message_at: number;
  classification_state: MailboxClassificationState;
  classification_fingerprint: string | null;
  classification_model_key: string | null;
  classification_prompt_version: string | null;
  classification_confidence: number;
  classification_updated_at: number | null;
  classification_error: string | null;
  sensitive_content_json: string | null;
};

type MailboxMessageRow = {
  id: string;
  thread_id: string;
  provider_message_id: string;
  direction: "incoming" | "outgoing";
  from_name: string | null;
  from_email: string | null;
  to_json: string | null;
  cc_json: string | null;
  bcc_json: string | null;
  subject: string;
  snippet: string;
  body_text: string;
  body_html: string | null;
  received_at: number;
  is_unread: number;
  metadata_json: string | null;
};

type MailboxMessageMetadata = {
  imapUid?: number;
  rfcMessageId?: string;
};

type MailboxAttachmentRow = {
  id: string;
  thread_id: string;
  message_id: string;
  provider: MailboxProvider;
  provider_message_id: string;
  provider_attachment_id: string | null;
  filename: string;
  mime_type: string | null;
  size: number | null;
  extraction_status: MailboxAttachmentSummary["extractionStatus"];
  extraction_error: string | null;
  text_content?: string | null;
  extraction_mode?: string | null;
  created_at: number;
  updated_at: number;
};

type MailboxSummaryRow = {
  thread_id: string;
  summary_text: string;
  key_asks_json: string | null;
  extracted_questions_json: string | null;
  suggested_next_action: string;
  updated_at: number;
};

type ThreadUpsertResult = {
  shouldClassify: boolean;
  isNewThread: boolean;
};

type MailboxDraftRow = {
  id: string;
  thread_id: string;
  subject: string;
  body_text: string;
  tone: string;
  rationale: string;
  schedule_notes: string | null;
  created_at: number;
  updated_at: number;
};

type MailboxProposalRow = {
  id: string;
  thread_id: string;
  proposal_type: MailboxProposalType;
  title: string;
  reasoning: string;
  preview_json: string | null;
  status: MailboxProposalStatus;
  created_at: number;
  updated_at: number;
};

type MailboxCommitmentRow = {
  id: string;
  thread_id: string;
  message_id: string | null;
  title: string;
  due_at: number | null;
  state: MailboxCommitmentState;
  owner_email: string | null;
  source_excerpt: string | null;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
};

type MailboxCommitmentMetadata = {
  source?: string;
  followUpTaskId?: string;
  followUpTaskCreatedAt?: number;
  followUpTaskWorkspaceId?: string;
};

type MailboxContactRow = {
  id: string;
  account_id: string;
  email: string;
  name: string | null;
  company: string | null;
  role: string | null;
  encryption_preference: "required" | "preferred" | "optional" | null;
  policy_flags_json: string | null;
  crm_links_json: string | null;
  learned_facts_json: string | null;
  response_tendency: string | null;
  last_interaction_at: number | null;
  open_commitments: number;
};

type MailboxEventRow = {
  id: string;
  fingerprint: string;
  workspace_id: string;
  event_type: MailboxEventType;
  account_id: string | null;
  thread_id: string | null;
  provider: MailboxProvider | null;
  subject: string | null;
  summary_text: string | null;
  evidence_refs_json: string | null;
  payload_json: string;
  duplicate_count: number;
  created_at: number;
  last_seen_at: number;
};

type MailboxMissionControlHandoffRow = {
  id: string;
  thread_id: string;
  workspace_id: string;
  company_id: string;
  company_name: string;
  operator_role_id: string;
  operator_display_name: string;
  issue_id: string;
  issue_title: string;
  source: "mailbox_handoff";
  latest_outcome: string | null;
  latest_wake_at: number | null;
  created_at: number;
  updated_at: number;
};

type MailboxEventRecordInput = {
  type: MailboxEventType;
  workspaceId?: string;
  accountId?: string;
  threadId?: string;
  provider?: MailboxProvider;
  subject?: string;
  summary?: string;
  evidenceRefs?: string[];
  payload?: Record<string, unknown>;
  timestamp?: number;
};

type MailboxEventRecordResult = {
  event: MailboxEvent;
  duplicateCount: number;
  isDuplicate: boolean;
};

type ScheduleOption = {
  label: string;
  start: string;
  end: string;
};

type ScheduleSuggestion = {
  options: ScheduleOption[];
  summary: string;
};

type MailboxClassificationResult = {
  category: MailboxThreadCategory;
  todayBucket: MailboxTodayBucket;
  domainCategory: MailboxDomainCategory;
  needsReply: boolean;
  priorityScore: number;
  urgencyScore: number;
  staleFollowup: boolean;
  cleanupCandidate: boolean;
  handled: boolean;
  confidence: number;
  rationale?: string;
  labels?: string[];
};

type MailboxClassificationSnapshot = {
  threadId: string;
  accountId: string;
  provider: MailboxProvider;
  subject: string;
  snippet: string;
  unreadCount: number;
  categoryHint?: MailboxThreadCategory;
  participants: MailboxParticipant[];
  labels: string[];
  lastMessageAt: number;
  messageCount: number;
  messages: Array<{
    direction: "incoming" | "outgoing";
    from?: MailboxParticipant;
    snippet: string;
    body: string;
    receivedAt: number;
    unread: boolean;
  }>;
};

type NormalizedMailboxAttachment = {
  id: string;
  providerAttachmentId?: string;
  filename: string;
  mimeType?: string;
  size?: number;
};

type DraftStyleProfile = {
  greeting?: string;
  signoff?: string;
  tone: MailboxDraftOptions["tone"];
  averageLength: number;
  averageResponseHours?: number;
  styleSignals: string[];
  recentOutboundExample?: string;
};

type MailboxCipherState = {
  safeStorage: SafeStorageLike | null;
  encryptionAvailable: boolean;
  machineId: string | null;
};

type MailboxServiceOptions = {
  autoSync?: boolean;
};

const MAILBOX_CIPHER_PREFIX = "mbox:";
const MAILBOX_CIPHER_SALT = "cowork-mailbox-content-v1";
const MAILBOX_MACHINE_ID_FILE = ".cowork-machine-id";
const MAILBOX_AUTO_SYNC_INTERVAL_MS = 2 * 60 * 1000;
const MAILBOX_AUTO_SYNC_INITIAL_DELAY_MS = 30 * 1000;
const MAILBOX_AUTO_SYNC_LIMIT = 25;

let mailboxCipherState: MailboxCipherState | null = null;

const mailboxLogger = createLogger("MailboxService");

function ensureMailboxCipherState(): MailboxCipherState {
  if (mailboxCipherState) return mailboxCipherState;

  const safeStorage = getSafeStorage();
  let encryptionAvailable = false;
  try {
    encryptionAvailable = safeStorage?.isEncryptionAvailable() ?? false;
  } catch {
    encryptionAvailable = false;
  }

  let machineId: string | null = null;
  try {
    const userDataDir = getUserDataDir();
    const machineIdPath = path.join(userDataDir, MAILBOX_MACHINE_ID_FILE);
    if (!fs.existsSync(userDataDir)) {
      fs.mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
    }
    if (fs.existsSync(machineIdPath)) {
      machineId = fs.readFileSync(machineIdPath, "utf-8").trim() || null;
      fs.chmodSync(machineIdPath, 0o600);
    } else {
      machineId = randomUUID();
      fs.writeFileSync(machineIdPath, machineId, { mode: 0o600 });
    }
  } catch (error) {
    mailboxLogger.warn("Failed to initialize mailbox encryption identity:", error);
    machineId = null;
  }

  mailboxCipherState = {
    safeStorage,
    encryptionAvailable,
    machineId,
  };
  return mailboxCipherState;
}

function deriveMailboxCipherKey(machineId: string): Buffer {
  // machineId is the secret (password); MAILBOX_CIPHER_SALT is the domain separator (salt).
  return pbkdf2Sync(machineId, MAILBOX_CIPHER_SALT, 100000, 32, "sha512");
}

function encryptMailboxValue(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;

  const state = ensureMailboxCipherState();
  if (state.encryptionAvailable && state.safeStorage) {
    try {
      return `${MAILBOX_CIPHER_PREFIX}os:${state.safeStorage.encryptString(value).toString("base64")}`;
    } catch (error) {
      mailboxLogger.warn("OS encryption failed, falling back to app-level encryption:", error);
    }
  }

  const key = deriveMailboxCipherKey(state.machineId || `${os.hostname()}:${os.homedir()}:${process.env.USER || process.env.USERNAME || "default-user"}`);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  let encrypted = cipher.update(value, "utf8", "base64");
  encrypted += cipher.final("base64");
  const authTag = cipher.getAuthTag();
  return `${MAILBOX_CIPHER_PREFIX}app:${iv.toString("base64")}:${authTag.toString("base64")}:${encrypted}`;
}

function decryptMailboxValue(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (!value.startsWith(MAILBOX_CIPHER_PREFIX)) return value;

  const state = ensureMailboxCipherState();

  if (value.startsWith(`${MAILBOX_CIPHER_PREFIX}os:`)) {
    if (!state.encryptionAvailable || !state.safeStorage) {
      mailboxLogger.warn("Mailbox value was encrypted with OS keychain but it is unavailable.");
      return "";
    }
    try {
      const encrypted = Buffer.from(value.slice(`${MAILBOX_CIPHER_PREFIX}os:`.length), "base64");
      return state.safeStorage.decryptString(encrypted);
    } catch (error) {
      mailboxLogger.warn("Failed to decrypt OS-encrypted mailbox value:", error);
      return "";
    }
  }

  if (value.startsWith(`${MAILBOX_CIPHER_PREFIX}app:`)) {
    try {
      const parts = value.slice(`${MAILBOX_CIPHER_PREFIX}app:`.length).split(":");
      if (parts.length !== 3) {
        throw new Error("Invalid mailbox ciphertext format");
      }
      const [ivBase64, authTagBase64, encrypted] = parts;
      const key = deriveMailboxCipherKey(
        state.machineId || `${os.hostname()}:${os.homedir()}:${process.env.USER || process.env.USERNAME || "default-user"}`,
      );
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivBase64, "base64"));
      decipher.setAuthTag(Buffer.from(authTagBase64, "base64"));
      let decrypted = decipher.update(encrypted, "base64", "utf8");
      decrypted += decipher.final("utf8");
      return decrypted;
    } catch (error) {
      mailboxLogger.warn("Failed to decrypt app-encrypted mailbox value:", error);
      return "";
    }
  }

  return value;
}

let activeMailboxService: MailboxService | null = null;

export function setMailboxServiceInstance(service: MailboxService | null): void {
  activeMailboxService = service;
}

export function getMailboxServiceInstance(): MailboxService | null {
  return activeMailboxService;
}

type NormalizedThreadInput = {
  id: string;
  accountId: string;
  provider: MailboxProvider;
  providerThreadId: string;
  subject: string;
  snippet: string;
  participants: MailboxParticipant[];
  labels: string[];
  category: MailboxThreadCategory;
  priorityScore: number;
  urgencyScore: number;
  needsReply: boolean;
  staleFollowup: boolean;
  cleanupCandidate: boolean;
  handled: boolean;
  unreadCount: number;
  lastMessageAt: number;
  messages: Array<{
    id: string;
    providerMessageId: string;
    metadata?: MailboxMessageMetadata;
    direction: "incoming" | "outgoing";
    from?: MailboxParticipant;
    to: MailboxParticipant[];
    cc: MailboxParticipant[];
    bcc: MailboxParticipant[];
    subject: string;
    snippet: string;
    body: string;
    bodyHtml?: string;
    attachments?: NormalizedMailboxAttachment[];
    receivedAt: number;
    unread: boolean;
  }>;
};

type NormalizedMailboxMessage = NormalizedThreadInput["messages"][number];

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseMailboxMessageMetadata(value: string | null | undefined): MailboxMessageMetadata {
  if (!value) return {};
  try {
    const parsed = asObject(JSON.parse(value));
    return {
      imapUid: asNumber(parsed?.imapUid) ?? undefined,
      rfcMessageId: asString(parsed?.rfcMessageId) ?? undefined,
    };
  } catch {
    return {};
  }
}

function parseJsonArray<T>(value: string | null | undefined): T[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function parseCommitmentMetadata(value: string | null | undefined): MailboxCommitmentMetadata {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return {};
    const record = parsed as Record<string, unknown>;
    return {
      source: asString(record.source) || undefined,
      followUpTaskId: asString(record.followUpTaskId) || undefined,
      followUpTaskCreatedAt: asNumber(record.followUpTaskCreatedAt) || undefined,
      followUpTaskWorkspaceId: asString(record.followUpTaskWorkspaceId) || undefined,
    };
  } catch {
    return {};
  }
}

function parseMailboxSensitiveContent(value: string | null | undefined): MailboxSensitiveContent {
  if (!value) {
    return { hasSensitiveContent: false, categories: [], reasons: [] };
  }
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const categories = Array.isArray(parsed.categories)
      ? parsed.categories.filter(
          (entry): entry is MailboxSensitiveContent["categories"][number] =>
            typeof entry === "string",
        )
      : [];
    const reasons = Array.isArray(parsed.reasons)
      ? parsed.reasons.filter((entry): entry is string => typeof entry === "string")
      : [];
    return {
      hasSensitiveContent: Boolean(parsed.hasSensitiveContent),
      categories,
      reasons,
    };
  } catch {
    return { hasSensitiveContent: false, categories: [], reasons: [] };
  }
}

function detectSensitiveContent(text: string): MailboxSensitiveContent {
  const lower = String(text || "").toLowerCase();
  const categories: MailboxSensitiveContent["categories"] = [];
  const reasons: string[] = [];

  const add = (category: MailboxSensitiveContent["categories"][number], reason: string) => {
    if (!categories.includes(category)) categories.push(category);
    reasons.push(reason);
  };

  if (/\b(password|passcode|otp|one[- ]time code|verification code|secret key|api key|token|credential|login)\b/.test(lower)) {
    add("credentials", "Credentials or authentication data detected");
  }
  if (/\b(invoice|payment|wire transfer|bank account|routing number|credit card|card number|ssn|tax id|salary|compensation)\b/.test(lower)) {
    add("financial", "Financial or payment details detected");
  }
  if (/\b(ssn|social security|date of birth|dob|home address|phone number|personal data|pii)\b/.test(lower)) {
    add("pii", "Potential personal information detected");
  }
  if (/\b(attorney|legal|agreement|contract|nda|non[- ]disclosure|litigation|settlement)\b/.test(lower)) {
    add("legal", "Potential legal content detected");
  }
  if (/\b(medical|health|diagnosis|patient|insurance claim)\b/.test(lower)) {
    add("health", "Potential health information detected");
  }

  return {
    hasSensitiveContent: categories.length > 0,
    categories,
    reasons,
  };
}

function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function normalizeMailboxEvidenceRefs(value: unknown): string[] {
  return Array.isArray(value)
    ? Array.from(
        new Set(
          value
            .map((entry) => asString(entry))
            .filter((entry): entry is string => Boolean(entry))
            .map((entry) => entry.trim())
            .filter(Boolean),
        ),
      )
    : [];
}

function buildMailboxEventFingerprint(type: MailboxEventType, workspaceId: string, payload: Record<string, unknown>): string {
  return sha256(
    JSON.stringify({
      type,
      workspaceId,
      threadId: asString(payload.threadId) || null,
      accountId: asString(payload.accountId) || null,
      actionType: asString(payload.actionType) || null,
      draftId: asString(payload.draftId) || null,
      commitmentId: asString(payload.commitmentId) || null,
      subject: normalizeWhitespace(asString(payload.subject) || "", 180),
      summary: normalizeWhitespace(asString(payload.summary) || "", 180),
      evidenceRefs: Array.isArray(payload.evidenceRefs)
        ? [...new Set((payload.evidenceRefs as unknown[]).map((item) => asString(item)).filter((item): item is string => Boolean(item)))].sort()
        : [],
    }),
  );
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function normalizeWhitespace(value: string, maxLength = 600): string {
  const text = String(value || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function normalizeEmailAddress(value?: unknown): string | null {
  const objectValue = asObject(value);
  if (objectValue) {
    const objectEmail = asString(objectValue.email) || asString(objectValue.address);
    if (objectEmail) return objectEmail.trim().toLowerCase();
  }

  const raw = asString(value);
  if (!raw) return null;
  const match = raw.match(/<([^>]+)>/);
  return (match?.[1] || raw).trim().toLowerCase();
}

function formatScheduleLabel(date: Date): string {
  return date.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatMailboxDateTime(timestamp?: number): string {
  if (!timestamp) return "unscheduled";
  return new Date(timestamp).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function buildScheduleOption(date: Date, durationMinutes = 30): ScheduleOption {
  const end = new Date(date.getTime() + durationMinutes * 60 * 1000);
  return {
    label: formatScheduleLabel(date),
    start: date.toISOString(),
    end: end.toISOString(),
  };
}

function average(values: number[]): number | undefined {
  if (!values.length) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function inferGreeting(messages: string[]): string | undefined {
  for (const text of messages) {
    const firstLine = excerptLines(text, 1)[0];
    if (/^(hi|hello|hey)\b/i.test(firstLine || "")) {
      return normalizeWhitespace(firstLine || "", 40);
    }
  }
  return undefined;
}

function inferSignoff(messages: string[]): string | undefined {
  for (const text of [...messages].reverse()) {
    const lines = String(text || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (/^(best|thanks|thank you|regards|cheers)[,!]?$/i.test(lines[index] || "")) {
        return lines[index];
      }
    }
  }
  return undefined;
}

function classifyTone(messages: string[]): DraftStyleProfile["tone"] {
  const combined = messages.join("\n");
  const averageChars = average(messages.map((message) => message.length)) || 0;
  if (/\bappreciate|thanks so much|glad|happy to\b/i.test(combined)) return "warm";
  if (/\bplease|kindly|attached|review|next steps|timeline\b/i.test(combined)) return "executive";
  if (averageChars < 180 || /\bquick update\b/i.test(combined)) return "concise";
  return "direct";
}

function extractDisplayName(value?: unknown): string | undefined {
  const objectValue = asObject(value);
  const structuredName = asString(objectValue?.name);
  if (structuredName) return structuredName;

  const raw = asString(value);
  if (!raw) return undefined;
  const match = raw.match(/^(.*?)\s*<[^>]+>$/);
  const name = (match?.[1] || "").replace(/^"|"$/g, "").trim();
  return name || undefined;
}

function parseAddressList(input: unknown): MailboxParticipant[] {
  if (Array.isArray(input)) {
    return input.flatMap((entry) => parseAddressList(entry));
  }

  const objectValue = asObject(input);
  if (objectValue) {
    const email = normalizeEmailAddress(objectValue);
    if (!email) return [];
    return [
      {
        email,
        name: extractDisplayName(objectValue),
      },
    ];
  }

  const raw = asString(input);
  if (!raw) return [];

  return raw
    .split(",")
    .map((part) => {
      const email = normalizeEmailAddress(part);
      if (!email) return null;
      return {
        email,
        name: extractDisplayName(part),
      } as MailboxParticipant;
    })
    .filter((entry): entry is MailboxParticipant => Boolean(entry));
}

function base64UrlDecode(data?: string): string {
  if (!data) return "";
  try {
    const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
    return Buffer.from(padded, "base64").toString("utf8");
  } catch {
    return "";
  }
}

function extractGmailHeader(
  headers: Array<{ name?: string; value?: string }> | undefined,
  name: string,
): string | null {
  if (!headers) return null;
  const lower = name.toLowerCase();
  const header = headers.find((entry) => entry?.name?.toLowerCase() === lower);
  return header?.value || null;
}

function extractGmailBody(payload: Any): string {
  const mimeType = asString(payload?.mimeType) || "";

  if (payload?.body?.data) {
    if (mimeType === "text/html") {
      return normalizeWhitespace(stripHtml(base64UrlDecode(payload.body.data)), 4000);
    }
    // text/plain or unknown — decode as-is
    return normalizeWhitespace(base64UrlDecode(payload.body.data), 4000);
  }

  const parts = Array.isArray(payload?.parts) ? payload.parts : [];
  if (parts.length === 0) return "";

  // For multipart/alternative prefer the HTML part (richer content, cleaner after
  // stripping) — RFC 2822 orders plain first and html last, so iterate in reverse.
  const orderedParts =
    mimeType === "multipart/alternative" ? [...parts].reverse() : parts;

  for (const part of orderedParts) {
    const text = extractGmailBody(part);
    if (text) return text;
  }

  return "";
}

/** Extract raw HTML body from a Gmail message payload for rendering in the UI. */
function extractGmailHtml(payload: Any): string {
  const mimeType = asString(payload?.mimeType) || "";

  if (payload?.body?.data && mimeType === "text/html") {
    return base64UrlDecode(payload.body.data);
  }

  const parts = Array.isArray(payload?.parts) ? payload.parts : [];
  for (const part of parts) {
    const html = extractGmailHtml(part);
    if (html) return html;
  }

  return "";
}

function extractGmailAttachments(payload: Any, messageId: string): NormalizedMailboxAttachment[] {
  const attachments: NormalizedMailboxAttachment[] = [];
  const visit = (part: Any): void => {
    if (!part || typeof part !== "object") return;
    const filename = asString(part.filename);
    const body = asObject(part.body);
    const attachmentId = asString(body?.attachmentId);
    if (filename && attachmentId) {
      const idSeed = `${messageId}:${attachmentId}:${filename}`;
      attachments.push({
        id: `gmail-attachment:${sha256(idSeed).slice(0, 24)}`,
        providerAttachmentId: attachmentId,
        filename,
        mimeType: asString(part.mimeType) || undefined,
        size: asNumber(body?.size) ?? undefined,
      });
    }
    const parts = Array.isArray(part.parts) ? part.parts : [];
    for (const child of parts) visit(child);
  };
  visit(payload);
  return attachments;
}

function uniqueParticipants(participants: MailboxParticipant[]): MailboxParticipant[] {
  const byEmail = new Map<string, MailboxParticipant>();
  for (const participant of participants) {
    const email = normalizeEmailAddress(participant.email);
    if (!email) continue;
    const current = byEmail.get(email);
    if (!current || (!current.name && participant.name)) {
      byEmail.set(email, { email, name: participant.name });
    }
  }
  return Array.from(byEmail.values());
}

function normalizeClassifierText(subject: string, body: string): string {
  return `${subject} ${body}`.toLowerCase().replace(/\s+/g, " ").trim();
}

function isAutomatedMailbox(subject: string, body: string, senderEmail?: string, labels: string[] = []): boolean {
  const text = normalizeClassifierText(subject, body);
  const labelSet = new Set(labels.map((label) => label.toUpperCase()));
  const sender = String(senderEmail || "").toLowerCase();
  return (
    labelSet.has("CATEGORY_UPDATES") ||
    /\b(no-?reply|noreply|do not reply|this inbox is not monitored|automated|system generated|unmonitored)\b/.test(
      `${text} ${sender}`,
    ) ||
    /\b(verification code|password reset|2-step verification|2fa|security alert|security code|privacy settings|verify your identity|password has been changed|sign-?in|login|one-time code|otp|account data access attempt)\b/.test(
      text,
    ) ||
    /\b(receipt|invoice|statement|billing|order update|order confirmation|shipment|delivery|tracking|return|refund|trial ending|free trial|new google account|passkey added|your account has been|your account was|recent update to your|revision to your|updated your mobile phone information|identity was successfully verified)\b/.test(
      text,
    )
  );
}

function isOnboardingMailbox(subject: string, body: string): boolean {
  const text = normalizeClassifierText(subject, body);
  return /\b(welcome to|get started|setup guide|onboarding|free trial|trial credits|information about your new)\b/.test(
    text,
  );
}

function hasDirectReplyRequest(text: string): boolean {
  return (
    /\b(can you|could you|would you|would you mind|do you mind|are you able to|can we|when can you|what time works|does that work|let me know if you|please let me know|please confirm|please review|please respond|please reply|please share|please provide|please send|please update|please schedule|please check|please take a look|i need you to|we need you to|i'd like you to|we'd like you to)\b/.test(
      text,
    ) ||
    /\b(?:can|could|would|will|are|is|do|does|did|what|when|where|why|how)\b[^?.!]{0,80}\?/i.test(text)
  );
}

function hasBoilerplateNotification(text: string): boolean {
  return (
    /\b(should you need to contact us|if you have any questions|if you have questions|if you need anything|please know that|you can always|contact us|thanks for shopping with us|thanks for visiting|per your request|we have successfully|we have updated|we have changed|we have enabled|your account has been|your account was|this inbox is not monitored|this is an automated message)\b/.test(
      text,
    ) || /\b(should you need|if you need to|for your reference|just letting you know)\b/.test(text)
  );
}

function likelyNeedsReply(params: {
  direction: "incoming" | "outgoing";
  subject: string;
  body: string;
  senderEmail?: string;
  labels?: string[];
  category?: MailboxThreadCategory;
}): boolean {
  if (params.direction !== "incoming") return false;
  const labels = params.labels || [];
  const text = normalizeClassifierText(params.subject, params.body);
  if (
    isAutomatedMailbox(params.subject, params.body, params.senderEmail, labels) ||
    isOnboardingMailbox(params.subject, params.body) ||
    params.category === "promotions" ||
    params.category === "updates"
  ) {
    return false;
  }
  if (hasBoilerplateNotification(text)) return false;
  return hasDirectReplyRequest(text);
}

function deriveCategory(
  subject: string,
  labels: string[],
  body: string,
  senderEmail?: string,
): MailboxThreadCategory {
  const lowerSubject = subject.toLowerCase();
  const lowerBody = body.toLowerCase();
  const text = normalizeClassifierText(subject, body);
  const labelSet = new Set(labels.map((label) => label.toUpperCase()));

  if (
    labelSet.has("CATEGORY_PROMOTIONS") ||
    /\bnewsletter|sale|discount|unsubscribe|free trial|upgrade offer|limited time\b/.test(lowerBody)
  ) {
    return "promotions";
  }
  if (
    isAutomatedMailbox(subject, body, senderEmail, labels) ||
    isOnboardingMailbox(subject, body) ||
    /\breceipt|invoice|notification|alert|verification|password|security|privacy|passkey|account update|account revision|account confirmation|identity verified\b/.test(text)
  ) {
    return "updates";
  }
  if (/\bmeet|schedule|calendar|availability|slot\b/.test(`${lowerSubject} ${lowerBody}`)) {
    return "calendar";
  }
  if (/\bfollow up|checking in|circling back|nudge\b/.test(`${lowerSubject} ${lowerBody}`)) {
    return "follow_up";
  }
  if (labelSet.has("IMPORTANT") || /\burgent|asap|deadline|today|blocking\b/.test(`${lowerSubject} ${lowerBody}`)) {
    return "priority";
  }
  if (/\b(family|friend|friends|personal|birthday|wedding|party|vacation|holiday|catch up|coffee|lunch|dinner|weekend|invitation|invite|rsvp|congratulations|condolences)\b/.test(text)) {
    return "personal";
  }
  return "other";
}

function computeScores(params: {
  subject: string;
  body: string;
  unreadCount: number;
  lastMessageAt: number;
  needsReply: boolean;
  cleanupCandidate: boolean;
  category: MailboxThreadCategory;
}): { priorityScore: number; urgencyScore: number; staleFollowup: boolean; handled: boolean } {
  const text = `${params.subject} ${params.body}`.toLowerCase();
  let priorityScore = 20;
  let urgencyScore = 10;

  if (params.unreadCount > 0) {
    priorityScore += 18;
    urgencyScore += 8;
  }
  if (params.needsReply) {
    priorityScore += 14;
    urgencyScore += 12;
  }
  if (/\burgent|asap|critical|today|deadline|immediately|eod\b/.test(text)) {
    priorityScore += 22;
    urgencyScore += 24;
  }
  if (params.category === "priority") {
    priorityScore += 16;
    urgencyScore += 12;
  }
  if (params.category === "calendar") {
    priorityScore += 10;
    urgencyScore += 18;
  }
  if (params.category === "updates") {
    priorityScore -= 8;
    urgencyScore -= 6;
  }
  if (params.category === "promotions") {
    priorityScore -= 16;
    urgencyScore -= 10;
  }
  if (params.cleanupCandidate) {
    priorityScore -= 10;
    urgencyScore -= 8;
  }

  const ageHours = Math.max(0, Date.now() - params.lastMessageAt) / (60 * 60 * 1000);
  const staleFollowup = params.needsReply && ageHours >= 36;
  if (staleFollowup) {
    urgencyScore += 18;
  }

  priorityScore = Math.max(0, Math.min(100, priorityScore));
  urgencyScore = Math.max(0, Math.min(100, urgencyScore));
  return {
    priorityScore,
    urgencyScore,
    staleFollowup,
    handled: !params.needsReply && params.unreadCount === 0,
  };
}

function priorityBandFromScore(score: number): MailboxPriorityBand {
  if (score >= 80) return "critical";
  if (score >= 60) return "high";
  if (score >= 35) return "medium";
  return "low";
}

const MAILBOX_CLASSIFIER_PROMPT_VERSION = "v3";
const MAILBOX_CLASSIFIER_MAX_BATCH = 50;
const MAILBOX_CLASSIFIER_MAX_MESSAGES = 6;
const MAILBOX_CLASSIFIER_MAX_TOKENS = 1400;
const MAILBOX_CLASSIFIER_MIN_CONFIDENCE = 0.45;
const MAILBOX_ATTACHMENT_TEXT_MAX_BYTES = 12 * 1024 * 1024;
const MAILBOX_ATTACHMENT_TEXT_MAX_CHARS = 24000;
const MAILBOX_ASK_MAX_TOKENS = 900;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function buildMailboxFtsQuery(query: string): string {
  return query
    .split(/\s+/)
    .map((token) => token.replace(/["']/g, "").trim())
    .filter((token) => token.length >= 2)
    .slice(0, 8)
    .map((token) => `"${token}"`)
    .join(" OR ");
}

function isSupportedMailboxAttachment(filename: string, mimeType?: string | null): boolean {
  const lower = filename.toLowerCase();
  const type = (mimeType || "").toLowerCase();
  return (
    type.startsWith("text/") ||
    type === "application/pdf" ||
    type === "text/html" ||
    type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    /\.(txt|md|markdown|csv|json|html|htm|pdf|docx)$/i.test(lower)
  );
}

const VALID_MAILBOX_TODAY_BUCKETS: MailboxTodayBucket[] = [
  "needs_action",
  "happening_today",
  "good_to_know",
  "more_to_browse",
];

const VALID_MAILBOX_DOMAIN_CATEGORIES: MailboxDomainCategory[] = [
  "travel",
  "packages",
  "receipts",
  "bills",
  "shopping",
  "newsletters",
  "events",
  "finance",
  "customer",
  "hiring",
  "approvals",
  "ops",
  "personal",
  "other",
];

function normalizeTodayBucket(value: unknown, fallback: MailboxTodayBucket): MailboxTodayBucket {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return VALID_MAILBOX_TODAY_BUCKETS.includes(normalized as MailboxTodayBucket)
    ? (normalized as MailboxTodayBucket)
    : fallback;
}

function normalizeDomainCategory(value: unknown, fallback: MailboxDomainCategory): MailboxDomainCategory {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return VALID_MAILBOX_DOMAIN_CATEGORIES.includes(normalized as MailboxDomainCategory)
    ? (normalized as MailboxDomainCategory)
    : fallback;
}

function deriveDomainCategoryFromText(text: string, category?: MailboxThreadCategory): MailboxDomainCategory {
  const haystack = text.toLowerCase();
  if (/\b(flight|boarding|hotel|airbnb|reservation|itinerary|train|rental car|trip)\b/.test(haystack)) return "travel";
  if (/\b(package|delivered|delivery|shipment|tracking|ups|fedex|usps|dhl)\b/.test(haystack)) return "packages";
  if (/\b(receipt|invoice|paid|payment confirmation|order confirmation|tax receipt)\b/.test(haystack)) return "receipts";
  if (/\b(bill|statement|due|autopay|utility|subscription renewal)\b/.test(haystack)) return "bills";
  if (/\b(order|cart|sale|discount|promo code|shop|purchase)\b/.test(haystack)) return "shopping";
  if (/\b(newsletter|digest|roundup|unsubscribe|weekly update)\b/.test(haystack)) return "newsletters";
  if (category === "calendar" || /\b(meeting|webinar|event|calendar|invite|rsvp|appointment)\b/.test(haystack)) return "events";
  if (/\b(bank|finance|portfolio|payroll|expense|reimbursement|stripe|quickbooks)\b/.test(haystack)) return "finance";
  if (/\b(customer|client|support|ticket|renewal|contract|account)\b/.test(haystack)) return "customer";
  if (/\b(candidate|interview|recruit|resume|offer|hiring)\b/.test(haystack)) return "hiring";
  if (/\b(approve|approval|sign off|review required|permission)\b/.test(haystack)) return "approvals";
  if (/\b(incident|deploy|ops|outage|status page|alert|server|production)\b/.test(haystack)) return "ops";
  if (category === "personal") return "personal";
  return "other";
}

function deriveTodayBucket(params: {
  category: MailboxThreadCategory;
  domainCategory: MailboxDomainCategory;
  needsReply: boolean;
  priorityScore: number;
  urgencyScore: number;
  cleanupCandidate: boolean;
  handled: boolean;
  text: string;
}): MailboxTodayBucket {
  if (params.needsReply || params.priorityScore >= 60 || params.urgencyScore >= 60) return "needs_action";
  const text = params.text.toLowerCase();
  if (
    params.category === "calendar" ||
    ["travel", "packages", "bills", "events"].includes(params.domainCategory) ||
    /\b(today|tomorrow|tonight|overdue|due|arriving|delivered|starts?|appointment)\b/.test(text)
  ) {
    return "happening_today";
  }
  if (params.cleanupCandidate || params.handled || ["newsletters", "shopping"].includes(params.domainCategory)) {
    return "more_to_browse";
  }
  return "good_to_know";
}

function mailboxClassificationFingerprint(snapshot: MailboxClassificationSnapshot): string {
  const payload = {
    threadId: snapshot.threadId,
    accountId: snapshot.accountId,
    provider: snapshot.provider,
    subject: normalizeWhitespace(snapshot.subject, 200),
    snippet: normalizeWhitespace(snapshot.snippet, 200),
    unreadCount: snapshot.unreadCount,
    categoryHint: snapshot.categoryHint || null,
    participants: snapshot.participants
      .map((participant) => ({
        email: participant.email.toLowerCase(),
        name: participant.name || "",
      }))
      .sort((a, b) => a.email.localeCompare(b.email)),
    labels: [...snapshot.labels].map((label) => label.toUpperCase()).sort(),
    lastMessageAt: snapshot.lastMessageAt,
    messages: snapshot.messages.map((message) => ({
      direction: message.direction,
      from: message.from?.email?.toLowerCase() || "",
      unread: message.unread,
      receivedAt: message.receivedAt,
      snippet: normalizeWhitespace(message.snippet, 240),
      body: normalizeWhitespace(message.body, 600),
    })),
  };
  return sha256(JSON.stringify(payload));
}

function summarizeMailboxBody(body: string): string {
  return normalizeWhitespace(body, 1000);
}

function mailboxClassificationFallback(
  snapshot: MailboxClassificationSnapshot,
): MailboxClassificationResult {
  return {
    category: "other",
    todayBucket: deriveTodayBucket({
      category: "other",
      domainCategory: deriveDomainCategoryFromText(
        `${snapshot.subject} ${snapshot.snippet} ${snapshot.messages.map((message) => message.body).join(" ")}`,
        "other",
      ),
      needsReply: false,
      priorityScore: clampScore(snapshot.unreadCount > 0 ? 25 : 5),
      urgencyScore: clampScore(snapshot.unreadCount > 0 ? 10 : 0),
      cleanupCandidate: false,
      handled: snapshot.unreadCount === 0,
      text: `${snapshot.subject} ${snapshot.snippet}`,
    }),
    domainCategory: deriveDomainCategoryFromText(
      `${snapshot.subject} ${snapshot.snippet} ${snapshot.messages.map((message) => message.body).join(" ")}`,
      "other",
    ),
    needsReply: false,
    priorityScore: clampScore(snapshot.unreadCount > 0 ? 25 : 5),
    urgencyScore: clampScore(snapshot.unreadCount > 0 ? 10 : 0),
    staleFollowup: false,
    cleanupCandidate: false,
    handled: snapshot.unreadCount === 0,
    confidence: 0.15,
    rationale: "Conservative fallback used because no LLM classification was available.",
  };
}

function companyFromEmail(email?: string): string | undefined {
  const normalized = normalizeEmailAddress(email || "");
  if (!normalized || normalized.endsWith("@gmail.com") || normalized.endsWith("@outlook.com")) {
    return undefined;
  }
  const domain = normalized.split("@")[1] || "";
  const label = domain.split(".")[0] || "";
  if (!label) return undefined;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function excerptLines(text: string, count = 2): string[] {
  return String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, count);
}

/**
 * After stripHtml(), tag attributes can become stray tokens (e.g. two width="96"
 * attributes → a first "line" like "96 96"). Skip those so the summary reads like prose.
 */
function isLikelyHtmlArtifactOrNoiseLine(line: string): boolean {
  const t = line.trim();
  if (!t) return true;
  if (t.length < 4) return true;
  const hasLetter = /[a-zA-Z]/.test(t);
  if (!hasLetter) {
    if (/^[\d\s.,\-–—_]+$/.test(t)) return true;
    if (t.length < 20) return true;
  }
  if (/^(\d{1,4})(\s+\1){1,}$/.test(t)) return true;
  return false;
}

function pickThreadSummaryLine(lines: string[], snippet: string, subject: string): string {
  for (const line of lines) {
    if (!isLikelyHtmlArtifactOrNoiseLine(line)) {
      return line;
    }
  }
  const s = (snippet || "").trim();
  if (s && !isLikelyHtmlArtifactOrNoiseLine(s)) {
    return s;
  }
  if (s) {
    for (const line of excerptLines(s, 8)) {
      if (!isLikelyHtmlArtifactOrNoiseLine(line)) {
        return line;
      }
    }
  }
  return `Recent email activity in ${subject || "this thread"}`;
}

function parseDueAt(text: string): number | undefined {
  const normalized = text.toLowerCase();
  if (/\btoday\b/.test(normalized)) {
    return Date.now() + 10 * 60 * 60 * 1000;
  }
  if (/\btomorrow\b/.test(normalized)) {
    return Date.now() + 34 * 60 * 60 * 1000;
  }
  const weekdayMatch = normalized.match(
    /\b(mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?)\b/,
  );
  if (weekdayMatch) {
    const weekdays = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
    const target = weekdays.findIndex((entry) => weekdayMatch[1].startsWith(entry));
    if (target >= 0) {
      const now = new Date();
      const result = new Date(now);
      let diff = target - now.getDay();
      if (diff <= 0) diff += 7;
      result.setDate(now.getDate() + diff);
      result.setHours(16, 0, 0, 0);
      return result.getTime();
    }
  }
  return undefined;
}

export class MailboxService {
  private channelRepo: ChannelRepository;
  private taskRepo: TaskRepository;
  private workspaceRepo: WorkspaceRepository;
  private agentRoleRepo: AgentRoleRepository;
  private controlPlaneCore: ControlPlaneCoreService;
  private contactIdentityService: ContactIdentityService;
  private syncInFlight = false;
  private syncProgress: MailboxSyncProgress | null = null;
  private autoSyncTimer: ReturnType<typeof setInterval> | null = null;
  private autoSyncInitialTimer: ReturnType<typeof setTimeout> | null = null;
  private lastAutoSyncAttemptAt = 0;
  private mailboxSearchIndexBackfillAttempted = false;

  constructor(private db: Database.Database, options: MailboxServiceOptions = {}) {
    this.channelRepo = new ChannelRepository(db);
    this.taskRepo = new TaskRepository(db);
    this.workspaceRepo = new WorkspaceRepository(db);
    this.agentRoleRepo = new AgentRoleRepository(db);
    this.controlPlaneCore = new ControlPlaneCoreService(db);
    this.contactIdentityService = new ContactIdentityService(db);
    setMailboxServiceInstance(this);
    if (options.autoSync === true && process.env.NODE_ENV !== "test") {
      this.startAutoSyncLoop();
    }
  }

  isAvailable(): boolean {
    const agentMailSettings = AgentMailSettingsManager.loadSettings();
    return (
      GoogleWorkspaceSettingsManager.loadSettings().enabled ||
      this.hasEmailChannel() ||
      Boolean(agentMailSettings.enabled && agentMailSettings.apiKey)
    );
  }

  private startAutoSyncLoop(): void {
    if (this.autoSyncTimer) return;
    const run = () => {
      void this.runAutoSyncIfDue();
    };
    this.autoSyncInitialTimer = setTimeout(run, MAILBOX_AUTO_SYNC_INITIAL_DELAY_MS);
    this.autoSyncInitialTimer.unref?.();
    this.autoSyncTimer = setInterval(run, MAILBOX_AUTO_SYNC_INTERVAL_MS);
    this.autoSyncTimer.unref?.();
  }

  private async runAutoSyncIfDue(): Promise<void> {
    const now = Date.now();
    if (this.syncInFlight) return;
    if (now - this.lastAutoSyncAttemptAt < MAILBOX_AUTO_SYNC_INTERVAL_MS - 1_000) return;
    if (!this.isAvailable()) return;

    const status = await this.getSyncStatus();
    if (
      status.connected &&
      status.lastSyncedAt &&
      now - status.lastSyncedAt < MAILBOX_AUTO_SYNC_INTERVAL_MS
    ) {
      return;
    }

    this.lastAutoSyncAttemptAt = now;
    try {
      mailboxLogger.info("Mailbox autosync starting", {
        accountCount: status.accounts.length,
        lastSyncedAt: status.lastSyncedAt || null,
      });
      const result = await this.sync(MAILBOX_AUTO_SYNC_LIMIT);
      mailboxLogger.info("Mailbox autosync complete", {
        accountCount: result.accounts.length,
        syncedThreads: result.syncedThreads,
        syncedMessages: result.syncedMessages,
      });
    } catch (error) {
      mailboxLogger.warn("Mailbox autosync failed:", error);
    }
  }

  private getAgentMailClient(): AgentMailClient {
    return new AgentMailClient(AgentMailSettingsManager.loadSettings());
  }

  private agentMailEnabled(): boolean {
    const settings = AgentMailSettingsManager.loadSettings();
    return Boolean(settings.enabled && settings.apiKey);
  }

  private isLoomEmailChannel(): boolean {
    const channel = this.channelRepo.findByType("email");
    const cfg = (channel?.config as Any) || {};
    return Boolean(channel?.enabled && asString(cfg.protocol) === "loom");
  }

  async getSyncStatus(): Promise<MailboxSyncStatus> {
    const accountRows = this.db
      .prepare(
        `SELECT id, provider, address, display_name, status, capabilities_json, sync_cursor, classification_initial_batch_at, last_synced_at
         FROM mailbox_accounts
         ORDER BY updated_at DESC`,
      )
      .all() as MailboxAccountRow[];

    const accounts = accountRows.map((row) => this.mapAccountRow(row));
    const inboxVisibleFilter = this.buildInboxVisibleThreadFilter();
    const joinedInboxVisibleFilter = this.buildInboxVisibleThreadFilter("mt");
    const countsRow = this.db
      .prepare(
        `SELECT
           COUNT(*) AS thread_count,
           COALESCE(SUM(unread_count), 0) AS unread_count,
           COALESCE(SUM(CASE WHEN needs_reply = 1 THEN 1 ELSE 0 END), 0) AS needs_reply_count,
           COALESCE(
             SUM(CASE WHEN classification_state IN ('pending', 'backfill_pending') THEN 1 ELSE 0 END),
             0
           ) AS classification_pending_count
         FROM mailbox_threads
         WHERE ${inboxVisibleFilter.sql}`,
      )
      .get(...inboxVisibleFilter.params) as {
      thread_count: number;
      unread_count: number;
      needs_reply_count: number;
      classification_pending_count: number;
    };
    const proposalCountRow = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM mailbox_action_proposals map
         JOIN mailbox_threads mt ON mt.id = map.thread_id
         WHERE map.status = 'suggested'
           AND ${joinedInboxVisibleFilter.sql}`,
      )
      .get(...joinedInboxVisibleFilter.params) as { count: number };
    const commitmentCountRow = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM mailbox_commitments mc
         JOIN mailbox_threads mt ON mt.id = mc.thread_id
         WHERE mc.state IN ('suggested', 'accepted')
           AND ${joinedInboxVisibleFilter.sql}`,
      )
      .get(...joinedInboxVisibleFilter.params) as { count: number };

    const lastSyncedAt =
      accounts
        .map((account) => account.lastSyncedAt || 0)
        .sort((a, b) => b - a)[0] || undefined;
    const primaryProvider = accounts[0]?.provider;

    return {
      connected: accounts.length > 0,
      primaryProvider,
      accounts,
      lastSyncedAt,
      syncInFlight: this.syncInFlight,
      syncProgress: this.syncProgress,
      threadCount: countsRow.thread_count || 0,
      unreadCount: countsRow.unread_count || 0,
      needsReplyCount: countsRow.needs_reply_count || 0,
      proposalCount: proposalCountRow.count || 0,
      commitmentCount: commitmentCountRow.count || 0,
      classificationPendingCount: countsRow.classification_pending_count || 0,
      statusLabel:
        accounts.length === 0
          ? "Connect AgentMail, Gmail, or the Email channel"
          : `${accounts.length} account${accounts.length === 1 ? "" : "s"} synced${
              this.syncInFlight && this.syncProgress?.label
                ? ` · ${this.syncProgress.label}`
                : countsRow.classification_pending_count
                  ? ` · ${countsRow.classification_pending_count} awaiting AI classification`
                  : ""
        }`,
    };
  }

  async getMailboxClientState(): Promise<MailboxClientState> {
    const status = await this.getSyncStatus();
    return {
      accounts: status.accounts,
      syncHealth: this.getMailboxSyncHealth(status.accounts),
      folders: this.listMailboxFolders(),
      labels: this.listMailboxLabels(),
      identities: this.listMailboxIdentities(),
      signatures: this.listMailboxSignatures(),
      composeDrafts: this.listMailboxComposeDrafts(),
      queuedActions: this.listMailboxQueuedActions(),
      outgoing: this.listMailboxOutgoingMessages(),
      settings: this.getMailboxClientSettings(),
    };
  }

  async createMailboxDraft(input: MailboxComposeDraftInput): Promise<MailboxComposeDraft> {
    const accountId = this.resolveComposeAccountId(input.accountId, input.threadId);
    const now = Date.now();
    const seedThread = input.threadId ? await this.getThread(input.threadId) : null;
    const recipients =
      input.to ||
      (input.mode === "new"
        ? []
        : this.buildReplyRecipients(seedThread, input.mode === "reply_all"));
    const subject =
      input.subject?.trim() ||
      (seedThread?.subject
        ? input.mode === "forward"
          ? this.prefixMailboxSubject(seedThread.subject, "Fwd:")
          : this.prefixMailboxSubject(seedThread.subject, "Re:")
        : "");
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO mailbox_compose_drafts
          (id, account_id, thread_id, provider_draft_id, mode, status, subject, body_text, body_html, to_json, cc_json, bcc_json, identity_id, signature_id, attachments_json, scheduled_at, send_after, latest_error, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, NULL, ?, 'local', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)`,
      )
      .run(
        id,
        accountId,
        input.threadId || null,
        input.mode,
        subject,
        input.bodyText || "",
        input.bodyHtml || null,
        JSON.stringify(this.normalizeRecipients(recipients)),
        JSON.stringify(this.normalizeRecipients(input.cc || [])),
        JSON.stringify(this.normalizeRecipients(input.bcc || [])),
        input.identityId || null,
        input.signatureId || null,
        JSON.stringify([]),
        JSON.stringify({ source: "mailbox_compose" }),
        now,
        now,
      );
    return this.getMailboxComposeDraft(id)!;
  }

  async updateMailboxDraft(draftId: string, patch: MailboxComposeDraftPatch): Promise<MailboxComposeDraft> {
    const draft = this.getMailboxComposeDraft(draftId);
    if (!draft) throw new Error("Mailbox compose draft not found");
    const next = {
      subject: patch.subject ?? draft.subject,
      bodyText: patch.bodyText ?? draft.bodyText,
      bodyHtml: patch.bodyHtml === undefined ? draft.bodyHtml : patch.bodyHtml || undefined,
      to: patch.to ?? draft.to,
      cc: patch.cc ?? draft.cc,
      bcc: patch.bcc ?? draft.bcc,
      identityId: patch.identityId === undefined ? draft.identityId : patch.identityId || undefined,
      signatureId: patch.signatureId === undefined ? draft.signatureId : patch.signatureId || undefined,
      scheduledAt: patch.scheduledAt === undefined ? draft.scheduledAt : patch.scheduledAt || undefined,
    };
    this.db
      .prepare(
        `UPDATE mailbox_compose_drafts
         SET subject = ?, body_text = ?, body_html = ?, to_json = ?, cc_json = ?, bcc_json = ?,
             identity_id = ?, signature_id = ?, scheduled_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        next.subject,
        next.bodyText,
        next.bodyHtml || null,
        JSON.stringify(this.normalizeRecipients(next.to)),
        JSON.stringify(this.normalizeRecipients(next.cc)),
        JSON.stringify(this.normalizeRecipients(next.bcc)),
        next.identityId || null,
        next.signatureId || null,
        next.scheduledAt || null,
        Date.now(),
        draftId,
      );
    return this.getMailboxComposeDraft(draftId)!;
  }

  async sendMailboxDraft(draftId: string): Promise<MailboxOutgoingMessage> {
    const draft = this.getMailboxComposeDraft(draftId);
    if (!draft) throw new Error("Mailbox compose draft not found");
    if (!draft.to.length && !draft.cc.length && !draft.bcc.length) {
      throw new Error("Add at least one recipient before sending.");
    }
    const settings = this.getMailboxClientSettings();
    const now = Date.now();
    const sendAfter = Math.max(draft.scheduledAt || 0, now + settings.sendDelaySeconds * 1000);
    const outgoingId = randomUUID();
    this.db
      .prepare(
        `INSERT INTO mailbox_outgoing_messages
          (id, draft_id, account_id, status, provider_message_id, scheduled_at, send_after, latest_error, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, 'queued', NULL, ?, ?, NULL, ?, ?, ?)`,
      )
      .run(outgoingId, draft.id, draft.accountId, draft.scheduledAt || null, sendAfter, JSON.stringify({ undoable: true }), now, now);
    this.db
      .prepare("UPDATE mailbox_compose_drafts SET status = ?, send_after = ?, updated_at = ? WHERE id = ?")
      .run(draft.scheduledAt ? "scheduled" : "queued", sendAfter, now, draft.id);
    this.enqueueMailboxAction({
      accountId: draft.accountId,
      threadId: draft.threadId,
      draftId: draft.id,
      type: "send",
      payload: { outgoingId, sendAfter },
      nextAttemptAt: sendAfter,
    });
    return this.getMailboxOutgoingMessage(outgoingId)!;
  }

  async scheduleMailboxSend(draftId: string, scheduledAt: number): Promise<MailboxComposeDraft> {
    if (!Number.isFinite(scheduledAt) || scheduledAt <= Date.now()) {
      throw new Error("Scheduled send time must be in the future.");
    }
    return this.updateMailboxDraft(draftId, { scheduledAt });
  }

  async discardMailboxDraft(draftId: string): Promise<boolean> {
    const now = Date.now();
    const result = this.db
      .prepare("UPDATE mailbox_compose_drafts SET status = 'discarded', updated_at = ? WHERE id = ? AND status != 'sent'")
      .run(now, draftId);
    this.db
      .prepare("UPDATE mailbox_queued_actions SET status = 'cancelled', updated_at = ? WHERE draft_id = ? AND status IN ('queued', 'failed')")
      .run(now, draftId);
    this.db
      .prepare("UPDATE mailbox_outgoing_messages SET status = 'cancelled', updated_at = ? WHERE draft_id = ? AND status IN ('queued', 'failed')")
      .run(now, draftId);
    return result.changes > 0;
  }

  async undoMailboxAction(actionId: string): Promise<MailboxQueuedAction> {
    const existing = this.getMailboxQueuedAction(actionId);
    if (!existing) throw new Error("Mailbox action not found");
    const now = Date.now();
    if (existing.type === "send" && existing.draftId) {
      await this.discardMailboxDraft(existing.draftId);
    }
    this.db
      .prepare("UPDATE mailbox_queued_actions SET status = 'cancelled', updated_at = ? WHERE id = ? AND status IN ('queued', 'failed')")
      .run(now, actionId);
    return this.enqueueMailboxAction({
      accountId: existing.accountId,
      threadId: existing.threadId,
      draftId: existing.draftId,
      type: "undo",
      payload: { actionId, actionType: existing.type },
      undoOfActionId: actionId,
    });
  }

  async listMailboxEvents(
    limit = 50,
    threadId?: string,
  ): Promise<MailboxEvent[]> {
    const workspaceId = this.resolveDefaultWorkspaceId();
    if (!workspaceId) return [];
    const rows = this.db
      .prepare(
        `SELECT
           id,
           fingerprint,
           workspace_id,
           event_type,
           account_id,
           thread_id,
           provider,
           subject,
           summary_text,
           evidence_refs_json,
           payload_json,
           duplicate_count,
           created_at,
           last_seen_at
         FROM mailbox_events
         WHERE workspace_id = ?
           AND (? IS NULL OR thread_id = ?)
         ORDER BY last_seen_at DESC
         LIMIT ?`,
      )
      .all(workspaceId, threadId || null, threadId || null, Math.min(Math.max(limit, 1), 200)) as MailboxEventRow[];
    return rows.map((row) => ({
      id: row.id,
      fingerprint: row.fingerprint,
      type: row.event_type,
      workspaceId: row.workspace_id,
      timestamp: row.last_seen_at,
      accountId: row.account_id || undefined,
      threadId: row.thread_id || undefined,
      provider: (row.provider as MailboxProvider | null) || undefined,
      subject: row.subject || undefined,
      summary: row.summary_text || undefined,
      evidenceRefs: normalizeMailboxEvidenceRefs(parseJsonArray<string>(row.evidence_refs_json)),
      payload: parseJsonObject(row.payload_json),
    }));
  }

  async listMailboxAutomations(input?: {
    workspaceId?: string;
    threadId?: string;
  }): Promise<MailboxAutomationRecord[]> {
    return MailboxAutomationRegistry.listAutomations({
      workspaceId: input?.workspaceId || this.resolveDefaultWorkspaceId(),
      threadId: input?.threadId,
    });
  }

  async listThreadAutomations(threadId: string): Promise<MailboxAutomationRecord[]> {
    return MailboxAutomationRegistry.listThreadAutomations(threadId);
  }

  async createMailboxRule(recipe: MailboxRuleRecipe): Promise<MailboxAutomationRecord> {
    return MailboxAutomationRegistry.createRule({
      ...recipe,
      workspaceId: recipe.workspaceId || this.resolveDefaultWorkspaceId(),
      source: "mailbox_event",
    });
  }

  async updateMailboxRule(
    automationId: string,
    patch: Partial<MailboxRuleRecipe> & { status?: MailboxAutomationStatus },
  ): Promise<MailboxAutomationRecord | null> {
    return MailboxAutomationRegistry.updateRule(automationId, patch);
  }

  async deleteMailboxRule(automationId: string): Promise<boolean> {
    return MailboxAutomationRegistry.deleteRule(automationId);
  }

  async createMailboxSchedule(recipe: MailboxScheduleRecipe): Promise<MailboxAutomationRecord> {
    return MailboxAutomationRegistry.createSchedule({
      ...recipe,
      workspaceId: recipe.workspaceId || this.resolveDefaultWorkspaceId(),
    });
  }

  async createMailboxForward(recipe: MailboxForwardRecipe): Promise<MailboxAutomationRecord> {
    return MailboxAutomationRegistry.createForward({
      ...recipe,
      workspaceId: recipe.workspaceId || this.resolveDefaultWorkspaceId(),
    });
  }

  async updateMailboxSchedule(
    automationId: string,
    patch: Partial<MailboxScheduleRecipe> & { status?: MailboxAutomationStatus },
  ): Promise<MailboxAutomationRecord | null> {
    return MailboxAutomationRegistry.updateSchedule(automationId, patch);
  }

  async updateMailboxForward(
    automationId: string,
    patch: Partial<MailboxForwardRecipe> & { status?: MailboxAutomationStatus },
  ): Promise<MailboxAutomationRecord | null> {
    return MailboxAutomationRegistry.updateForward(automationId, patch);
  }

  async deleteMailboxSchedule(automationId: string): Promise<boolean> {
    return MailboxAutomationRegistry.deleteSchedule(automationId);
  }

  async deleteMailboxForward(automationId: string): Promise<boolean> {
    return MailboxAutomationRegistry.deleteForward(automationId);
  }

  async runMailboxForward(automationId: string): Promise<string> {
    const service = getMailboxForwardingServiceInstance();
    if (!service) {
      throw new Error("Mailbox forwarding service is not available");
    }
    return service.runNow(automationId);
  }

  async listMailboxAutomationHistory(automationId: string, limit = 25): Promise<Any[]> {
    return MailboxAutomationRegistry.listAutomationHistory(automationId, limit);
  }

  async previewMissionControlHandoff(
    threadId: string,
  ): Promise<MailboxMissionControlHandoffPreview | null> {
    const detail = await this.getThread(threadId);
    if (!detail) return null;

    const workspaceId =
      this.resolveThreadWorkspaceId(detail.accountId) ||
      this.resolveDefaultWorkspaceId();
    const companyCandidates = this.buildMissionControlCompanyCandidates(detail);
    const operatorRecommendations = this.buildMissionControlOperatorRecommendations(
      detail,
      companyCandidates[0]?.companyId,
    );
    const evidenceRefs = this.buildMailboxEvidenceRefs(detail);
    const sensitiveContentRedacted = Boolean(detail.sensitiveContent?.hasSensitiveContent);
    const summary = this.buildMissionControlIssueSummary(detail, sensitiveContentRedacted);

    return {
      threadId,
      workspaceId,
      issueTitle: this.buildMissionControlIssueTitle(detail),
      issueSummary: summary,
      companyCandidates,
      recommendedCompanyId:
        companyCandidates[0] && companyCandidates[0].confidence >= 0.7
          ? companyCandidates[0].companyId
          : undefined,
      companyConfirmationRequired: true,
      operatorRecommendations,
      recommendedOperatorRoleId: operatorRecommendations[0]?.agentRoleId,
      sensitiveContentRedacted,
      evidenceRefs,
      existingHandoffs: this.listMissionControlHandoffs(threadId),
    };
  }

  async createMissionControlHandoff(
    request: MailboxMissionControlHandoffRequest,
  ): Promise<MailboxMissionControlHandoffRecord> {
    const detail = await this.getThread(request.threadId);
    if (!detail) {
      throw new Error("Mailbox thread not found");
    }

    const company = this.controlPlaneCore.getCompany(request.companyId);
    if (!company) {
      throw new Error("Company not found for inbox handoff");
    }

    const operator = this.agentRoleRepo.findById(request.operatorRoleId);
    if (!operator || operator.companyId !== company.id || operator.isActive === false) {
      throw new Error("Selected operator is not available for the chosen company");
    }

    const existing = this.findActiveMissionControlHandoff(
      request.threadId,
      company.id,
      operator.id,
    );
    if (existing) {
      return existing;
    }

    const workspaceId =
      this.resolveThreadWorkspaceId(detail.accountId) ||
      company.defaultWorkspaceId ||
      this.resolveDefaultWorkspaceId();
    if (!workspaceId) {
      throw new Error("No workspace available for inbox handoff");
    }

    const sensitiveContentRedacted = Boolean(detail.sensitiveContent?.hasSensitiveContent);
    const outputContract = this.buildMailboxHandoffOutputContract(
      company.id,
      operator.id,
      detail,
    );
    const metadata = {
      source: "mailbox_handoff",
      plannerManaged: false,
      plannerEligible: true,
      plannerAdoptionMode: "linked_follow_up_only",
      inboxHandoff: {
        threadId: detail.id,
        provider: detail.provider,
        subject: detail.subject,
        mailboxViewHint: detail.needsReply ? "needs_reply" : "reference",
        primaryContactEmail: detail.research?.primaryContact?.email || detail.participants[0]?.email,
        primaryContactName: detail.research?.primaryContact?.name || detail.participants[0]?.name,
        companyHint: detail.research?.company,
        projectHint: detail.research?.relatedEntities?.[0],
        summary: stripMailboxSummaryHtmlArtifacts(detail.summary?.summary || detail.snippet),
        sensitiveContentRedacted,
        evidenceRefs: this.buildMailboxEvidenceRefs(detail),
      },
      outputContract,
      completionContract: {
        expectedArtifactType: "work_order",
        doneWhen: [
          "operator reviewed the email thread context",
          "next concrete company action is captured",
          "issue status reflects the handoff outcome",
        ],
      },
    } satisfies Record<string, unknown>;

    const issue = this.controlPlaneCore.createIssue({
      companyId: company.id,
      workspaceId,
      title: request.issueTitle.trim(),
      description:
        request.issueSummary?.trim() || this.buildMissionControlIssueSummary(detail, sensitiveContentRedacted),
      status: "backlog",
      priority: this.mapMailboxPriorityToIssuePriority(detail.priorityBand),
      assigneeAgentRoleId: operator.id,
      metadata,
    });

    let wakeOutcome = "heartbeat_not_available";
    const heartbeatService = getHeartbeatService();
    if (heartbeatService) {
      const result = await heartbeatService.triggerHeartbeat(operator.id);
      wakeOutcome = result.status;
    }

    const record = this.persistMissionControlHandoff({
      threadId: detail.id,
      workspaceId,
      companyId: company.id,
      companyName: company.name,
      operatorRoleId: operator.id,
      operatorDisplayName: operator.displayName,
      issueId: issue.id,
      issueTitle: issue.title,
      latestOutcome: wakeOutcome,
      latestWakeAt: Date.now(),
    });

    const primaryContact = detail.research?.primaryContact || detail.participants[0];
    this.emitMailboxEvent({
      type: "mission_control_handoff_created",
      threadId: detail.id,
      accountId: detail.accountId,
      provider: detail.provider,
      subject: detail.subject,
      summary: `Mission Control handoff created for ${company.name}`,
      evidenceRefs: [
        detail.id,
        issue.id,
        operator.id,
      ],
      payload: {
        issueId: issue.id,
        companyId: company.id,
        companyName: company.name,
        operatorRoleId: operator.id,
        operatorDisplayName: operator.displayName,
        source: "mailbox_handoff",
        primaryContactEmail: primaryContact?.email,
        primaryContactName: primaryContact?.name,
        senderName: primaryContact?.name,
        sensitiveContentRedacted,
      },
    });

    return record;
  }

  listMissionControlHandoffs(threadId: string): MailboxMissionControlHandoffRecord[] {
    const rows = this.db
      .prepare(
        `SELECT
           id,
           thread_id,
           workspace_id,
           company_id,
           company_name,
           operator_role_id,
           operator_display_name,
           issue_id,
           issue_title,
           source,
           latest_outcome,
           latest_wake_at,
           created_at,
           updated_at
         FROM mailbox_mission_control_handoffs
         WHERE thread_id = ?
         ORDER BY updated_at DESC`,
      )
      .all(threadId) as MailboxMissionControlHandoffRow[];
    return rows.map((row) => this.mapMissionControlHandoffRow(row));
  }

  async getMailboxDigest(workspaceId?: string): Promise<MailboxDigestSnapshot> {
    const resolvedWorkspaceId = workspaceId || this.resolveDefaultWorkspaceId();
    if (!resolvedWorkspaceId) {
      return {
        workspaceId: "",
        generatedAt: Date.now(),
        threadCount: 0,
        messageCount: 0,
        unreadCount: 0,
        needsReplyCount: 0,
        proposalCount: 0,
        commitmentCount: 0,
        draftCount: 0,
        composeDraftCount: 0,
        queuedActionCount: 0,
        failedActionCount: 0,
        scheduledSendCount: 0,
        overdueCommitmentCount: 0,
        sensitiveThreadCount: 0,
        eventCount: 0,
        classificationPendingCount: 0,
        syncHealth: [],
        recentEventTypes: [],
      };
    }

    const inboxVisibleFilter = this.buildInboxVisibleThreadFilter("mailbox_threads", resolvedWorkspaceId);
    const joinedInboxVisibleFilter = this.buildInboxVisibleThreadFilter("mt", resolvedWorkspaceId);
    const counts = this.db
      .prepare(
        `SELECT
           COALESCE(COUNT(*), 0) AS thread_count,
           COALESCE(SUM(message_count), 0) AS message_count,
           COALESCE(SUM(unread_count), 0) AS unread_count,
           COALESCE(SUM(CASE WHEN needs_reply = 1 THEN 1 ELSE 0 END), 0) AS needs_reply_count,
           COALESCE(
             SUM(CASE WHEN classification_state IN ('pending', 'backfill_pending') THEN 1 ELSE 0 END),
             0
           ) AS classification_pending_count,
           COALESCE(SUM(CASE WHEN sensitive_content_json IS NOT NULL AND sensitive_content_json != '' THEN 1 ELSE 0 END), 0) AS sensitive_thread_count
         FROM mailbox_threads
         WHERE ${inboxVisibleFilter.sql}`,
      )
      .get(...inboxVisibleFilter.params) as {
      thread_count: number;
      message_count: number;
      unread_count: number;
      needs_reply_count: number;
      classification_pending_count: number;
      sensitive_thread_count: number;
    };
    const proposalCountRow = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM mailbox_action_proposals map
         JOIN mailbox_threads mt ON mt.id = map.thread_id
         WHERE map.status = 'suggested'
           AND ${joinedInboxVisibleFilter.sql}`,
      )
      .get(...joinedInboxVisibleFilter.params) as { count: number };
    const commitmentCountRow = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM mailbox_commitments mc
         JOIN mailbox_threads mt ON mt.id = mc.thread_id
         WHERE mc.state IN ('suggested', 'accepted')
           AND ${joinedInboxVisibleFilter.sql}`,
      )
      .get(...joinedInboxVisibleFilter.params) as { count: number };
    const draftCountRow = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM mailbox_drafts md
         JOIN mailbox_threads mt ON mt.id = md.thread_id
         WHERE ${joinedInboxVisibleFilter.sql}`,
      )
      .get(...joinedInboxVisibleFilter.params) as { count: number };
    const overdueCommitmentCountRow = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM mailbox_commitments mc
         JOIN mailbox_threads mt ON mt.id = mc.thread_id
         WHERE mc.state IN ('suggested', 'accepted')
           AND mc.due_at IS NOT NULL
           AND mc.due_at < ?
           AND ${joinedInboxVisibleFilter.sql}`,
      )
      .get(Date.now(), ...joinedInboxVisibleFilter.params) as { count: number };
    const eventCountRow = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM mailbox_events
         WHERE workspace_id = ?`,
      )
      .get(resolvedWorkspaceId) as { count: number };
    const recentEventRows = this.db
      .prepare(
        `SELECT event_type, COUNT(*) AS count
         FROM mailbox_events
         WHERE workspace_id = ?
         GROUP BY event_type
         ORDER BY MAX(last_seen_at) DESC
         LIMIT 6`,
      )
      .all(resolvedWorkspaceId) as Array<{ event_type: MailboxEventType; count: number }>;
    const lastSyncedRow = this.db
      .prepare(
        `SELECT MAX(last_synced_at) AS last_synced_at
         FROM mailbox_accounts`,
      )
      .get() as { last_synced_at: number | null };
    const clientState = await this.getMailboxClientState();
    const queuedActionCount = clientState.queuedActions.filter((action) => action.status === "queued").length;
    const failedActionCount = clientState.queuedActions.filter((action) => action.status === "failed").length;
    const composeDraftCount = clientState.composeDrafts.filter((draft) => draft.status !== "sent").length;
    const scheduledSendCount = clientState.composeDrafts.filter((draft) => draft.status === "scheduled").length;

    return {
      workspaceId: resolvedWorkspaceId,
      generatedAt: Date.now(),
      threadCount: counts.thread_count || 0,
      messageCount: counts.message_count || 0,
      unreadCount: counts.unread_count || 0,
      needsReplyCount: counts.needs_reply_count || 0,
      proposalCount: proposalCountRow.count || 0,
      commitmentCount: commitmentCountRow.count || 0,
      draftCount: draftCountRow.count || 0,
      composeDraftCount,
      queuedActionCount,
      failedActionCount,
      scheduledSendCount,
      overdueCommitmentCount: overdueCommitmentCountRow.count || 0,
      sensitiveThreadCount: counts.sensitive_thread_count || 0,
      eventCount: eventCountRow.count || 0,
      classificationPendingCount: counts.classification_pending_count || 0,
      lastSyncedAt: lastSyncedRow.last_synced_at || undefined,
      syncHealth: clientState.syncHealth,
      recentEventTypes: recentEventRows.map((row) => ({ type: row.event_type, count: row.count })),
    };
  }

  async getMailboxTodayDigest(input: { limitPerBucket?: number } = {}): Promise<MailboxTodayDigest> {
    const limitPerBucket = Math.min(Math.max(input.limitPerBucket ?? 8, 1), 20);
    const labels: Record<MailboxTodayBucket, string> = {
      needs_action: "Needs action",
      happening_today: "Happening today",
      good_to_know: "Good to know",
      more_to_browse: "More to browse",
    };
    const buckets = await Promise.all(
      VALID_MAILBOX_TODAY_BUCKETS.map(async (bucket) => ({
        bucket,
        label: labels[bucket],
        count: this.countThreadsByTodayBucket(bucket),
        threads: await this.listThreads({ todayBucket: bucket, mailboxView: "inbox", sortBy: "priority", limit: limitPerBucket }),
      })),
    );
    const domainRows = this.db
      .prepare(
        `SELECT domain_category, COUNT(*) AS count
         FROM mailbox_threads
         WHERE local_inbox_hidden = 0
         GROUP BY domain_category
         ORDER BY count DESC`,
      )
      .all() as Array<{ domain_category: MailboxDomainCategory; count: number }>;
    const clientState = await this.getMailboxClientState();
    return {
      buckets,
      domainCounts: domainRows.map((row) => ({
        category: normalizeDomainCategory(row.domain_category, "other"),
        count: row.count,
      })),
      syncHealth: clientState.syncHealth,
      queuedActionCount: clientState.queuedActions.filter((action) => action.status === "queued").length,
      failedActionCount: clientState.queuedActions.filter((action) => action.status === "failed").length,
      composeDraftCount: clientState.composeDrafts.filter((draft) => draft.status !== "sent").length,
      scheduledSendCount: clientState.composeDrafts.filter((draft) => draft.status === "scheduled").length,
      generatedAt: Date.now(),
    };
  }

  private countThreadsByTodayBucket(bucket: MailboxTodayBucket): number {
    const inboxVisibleFilter = this.buildInboxVisibleThreadFilter();
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM mailbox_threads WHERE today_bucket = ? AND ${inboxVisibleFilter.sql}`)
      .get(bucket, ...inboxVisibleFilter.params) as { count: number } | undefined;
    return row?.count || 0;
  }

  async getMailboxSenderCleanupDigest(input: { limit?: number } = {}): Promise<MailboxSenderCleanupDigest> {
    const limit = Math.min(Math.max(input.limit ?? 8, 1), 25);
    const rows = this.db
      .prepare(
        `SELECT
           LOWER(COALESCE(m.from_email, '')) AS email,
           MAX(m.from_name) AS name,
           COUNT(DISTINCT t.id) AS thread_count,
           SUM(t.unread_count) AS unread_count,
           SUM(CASE WHEN t.cleanup_candidate = 1 THEN 1 ELSE 0 END) AS cleanup_count,
           SUM(CASE WHEN t.needs_reply = 1 THEN 1 ELSE 0 END) AS needs_reply_count,
           MAX(t.last_message_at) AS last_message_at
         FROM mailbox_messages m
         JOIN mailbox_threads t ON t.id = m.thread_id
         WHERE m.direction = 'incoming'
           AND m.from_email IS NOT NULL
           AND t.local_inbox_hidden = 0
         GROUP BY LOWER(m.from_email)
         HAVING thread_count >= 2 OR cleanup_count > 0
         ORDER BY cleanup_count DESC, thread_count DESC, last_message_at DESC
         LIMIT ?`,
      )
      .all(limit) as Array<{
      email: string;
      name: string | null;
      thread_count: number;
      unread_count: number | null;
      cleanup_count: number | null;
      needs_reply_count: number | null;
      last_message_at: number;
    }>;
    const senders = rows.map((row) => {
      const threadRows = this.db
        .prepare(
          `SELECT DISTINCT t.*
           FROM mailbox_threads t
           JOIN mailbox_messages m ON m.thread_id = t.id
           WHERE LOWER(m.from_email) = ?
             AND t.local_inbox_hidden = 0
           ORDER BY t.cleanup_candidate DESC, t.last_message_at DESC
           LIMIT 4`,
        )
        .all(row.email) as MailboxThreadRow[];
      const cleanupCount = row.cleanup_count || 0;
      return {
        email: row.email,
        name: row.name || undefined,
        threadCount: row.thread_count,
        unreadCount: row.unread_count || 0,
        cleanupCandidateCount: cleanupCount,
        needsReplyCount: row.needs_reply_count || 0,
        estimatedWeeklyReduction: Math.max(cleanupCount, Math.ceil(row.thread_count / 4)),
        lastMessageAt: row.last_message_at,
        suggestedAction: cleanupCount > 0 ? "cleanup_local" as const : row.unread_count ? "mark_read" as const : "archive" as const,
        threads: threadRows.map((thread) => this.mapThreadRow(thread, this.getSummaryForThread(thread.id))),
      };
    });
    return { generatedAt: Date.now(), senders };
  }

  async askMailbox(input: MailboxAskInput): Promise<MailboxAskResult> {
    const query = input.query.trim();
    if (!query) {
      return { query, results: [], usedLlm: false };
    }
    await this.extractCandidateAttachmentsForAsk(query);
    const limit = Math.min(Math.max(input.limit ?? 8, 1), 20);
    const rows = this.searchMailboxRows(query, limit);
    const results: MailboxAskResult["results"] = [];
    const seenThreads = new Set<string>();
    for (const row of rows) {
      const thread = await this.getThread(row.thread_id);
      if (!thread || seenThreads.has(thread.id)) continue;
      seenThreads.add(thread.id);
      const attachment = row.attachment_id ? this.getMailboxAttachment(row.attachment_id, true) : undefined;
      results.push({
        thread,
        matchedAttachment: attachment || undefined,
        snippet: normalizeWhitespace(row.snippet || thread.summary?.summary || thread.snippet, 260),
        score: row.score,
      });
      if (results.length >= limit) break;
    }
    if (!results.length) {
      const fallback = await this.listThreads({ query, mailboxView: "all", limit });
      for (const thread of fallback) {
        results.push({ thread, snippet: thread.summary?.summary || thread.snippet, score: 0 });
      }
    }

    if (input.includeAnswer === false || !results.length) {
      return { query, results, usedLlm: false };
    }
    const answer = await this.generateMailboxAskAnswer(query, results);
    return {
      query,
      results,
      answer: answer.answer,
      usedLlm: answer.usedLlm,
      error: answer.error,
    };
  }

  private searchMailboxRows(query: string, limit: number): Array<{
    thread_id: string;
    attachment_id: string | null;
    snippet: string;
    score: number;
  }> {
    this.ensureMailboxSearchIndexBackfilled();
    const ftsQuery = buildMailboxFtsQuery(query);
    if (ftsQuery) {
      try {
        return this.db
          .prepare(
            `SELECT thread_id, attachment_id, snippet(mailbox_search_fts, 7, '[', ']', ' … ', 16) AS snippet, bm25(mailbox_search_fts) AS score
             FROM mailbox_search_fts
             WHERE mailbox_search_fts MATCH ?
             ORDER BY score ASC
             LIMIT ?`,
          )
          .all(ftsQuery, Math.max(limit * 3, 12)) as Array<{
          thread_id: string;
          attachment_id: string | null;
          snippet: string;
          score: number;
        }>;
      } catch {
        // Fall back below.
      }
    }
    const needle = `%${query.toLowerCase()}%`;
    return this.db
      .prepare(
        `SELECT DISTINCT t.id AS thread_id, ma.id AS attachment_id,
                COALESCE(ma.filename, t.snippet) AS snippet,
                0 AS score
         FROM mailbox_threads t
         LEFT JOIN mailbox_messages m ON m.thread_id = t.id
         LEFT JOIN mailbox_attachments ma ON ma.thread_id = t.id
         LEFT JOIN mailbox_attachment_text mat ON mat.attachment_id = ma.id
         WHERE LOWER(t.subject || ' ' || t.snippet || ' ' || COALESCE(m.body_text, '') || ' ' || COALESCE(ma.filename, '') || ' ' || COALESCE(mat.text_content, '')) LIKE ?
         ORDER BY t.last_message_at DESC
         LIMIT ?`,
      )
      .all(needle, Math.max(limit * 3, 12)) as Array<{
      thread_id: string;
      attachment_id: string | null;
      snippet: string;
      score: number;
    }>;
  }

  private async generateMailboxAskAnswer(
    query: string,
    results: MailboxAskResult["results"],
  ): Promise<{ answer?: string; usedLlm: boolean; error?: string }> {
    const modelSelection = this.chooseMailboxClassifierModel();
    if (!modelSelection) {
      return { usedLlm: false };
    }
    const workspaceId = this.resolveDefaultWorkspaceId() || "";
    const provider = LLMProviderFactory.createProvider();
    try {
      const response = await provider.createMessage({
        model: modelSelection.modelId,
        maxTokens: MAILBOX_ASK_MAX_TOKENS,
        system: "Answer mailbox questions from the supplied local evidence. Be concise. If evidence is weak, say what matched instead of guessing.",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  query,
                  evidence: results.slice(0, 8).map((result) => ({
                    subject: result.thread.subject,
                    sender: result.thread.participants[0],
                    snippet: result.snippet,
                    attachment: result.matchedAttachment
                      ? {
                          filename: result.matchedAttachment.filename,
                          text: result.matchedAttachment.text?.slice(0, 1200),
                        }
                      : undefined,
                  })),
                }),
              },
            ],
          },
        ],
      });
      recordLlmCallSuccess(
        {
          workspaceId,
          sourceKind: "mailbox_ask",
          sourceId: query.slice(0, 120),
          providerType: provider.type,
          modelKey: modelSelection.modelKey,
          modelId: modelSelection.modelId,
        },
        response.usage,
      );
      return {
        usedLlm: true,
        answer: normalizeWhitespace(response.content.map((block) => (block.type === "text" ? block.text : "")).join("\n"), 900),
      };
    } catch (error) {
      recordLlmCallError(
        {
          workspaceId,
          sourceKind: "mailbox_ask",
          sourceId: query.slice(0, 120),
          providerType: provider.type,
          modelKey: modelSelection.modelKey,
          modelId: modelSelection.modelId,
        },
        error,
      );
      return { usedLlm: false, error: "Could not generate an AI answer. Showing local matches instead." };
    }
  }

  private async extractCandidateAttachmentsForAsk(query: string): Promise<void> {
    const needle = `%${query.toLowerCase()}%`;
    const broadAttachmentQuery = /\b(invoice|contract|receipt|pdf|docx|attachment|file)\b/i.test(query);
    const rows = this.db
      .prepare(
        `SELECT *
         FROM mailbox_attachments
         WHERE extraction_status IN ('not_indexed', 'error')
           AND (? = 1 OR LOWER(filename) LIKE ?)
         ORDER BY updated_at DESC
         LIMIT 3`,
      )
      .all(broadAttachmentQuery ? 1 : 0, needle) as MailboxAttachmentRow[];
    for (const row of rows) {
      if (!isSupportedMailboxAttachment(row.filename, row.mime_type)) continue;
      try {
        await this.extractMailboxAttachmentText(row.id);
      } catch {
        // Search should not fail because one attachment cannot be extracted.
      }
    }
  }

  getMailboxAttachment(attachmentId: string, includeText = false): MailboxAttachmentRecord | null {
    const row = this.db
      .prepare(
        `SELECT ma.*, mat.text_content, mat.extraction_mode
         FROM mailbox_attachments ma
         LEFT JOIN mailbox_attachment_text mat ON mat.attachment_id = ma.id
         WHERE ma.id = ?`,
      )
      .get(attachmentId) as MailboxAttachmentRow | undefined;
    if (!row) return null;
    return this.mapAttachmentRow(row, includeText);
  }

  async extractMailboxAttachmentText(attachmentId: string): Promise<MailboxAttachmentRecord> {
    const row = this.db
      .prepare(`SELECT * FROM mailbox_attachments WHERE id = ?`)
      .get(attachmentId) as MailboxAttachmentRow | undefined;
    if (!row) {
      throw new Error("Attachment not found");
    }
    const now = Date.now();
    if (!isSupportedMailboxAttachment(row.filename, row.mime_type)) {
      this.db
        .prepare(`UPDATE mailbox_attachments SET extraction_status = 'unsupported', extraction_error = NULL, updated_at = ? WHERE id = ?`)
        .run(now, attachmentId);
      const unsupported = this.getMailboxAttachment(attachmentId, true);
      if (!unsupported) throw new Error("Attachment not found");
      return unsupported;
    }
    if (row.size && row.size > MAILBOX_ATTACHMENT_TEXT_MAX_BYTES) {
      this.db
        .prepare(`UPDATE mailbox_attachments SET extraction_status = 'error', extraction_error = ?, updated_at = ? WHERE id = ?`)
        .run("Attachment is too large for local text extraction.", now, attachmentId);
      const tooLarge = this.getMailboxAttachment(attachmentId, true);
      if (!tooLarge) throw new Error("Attachment not found");
      return tooLarge;
    }

    try {
      this.db
        .prepare(`UPDATE mailbox_attachments SET extraction_status = 'pending', extraction_error = NULL, updated_at = ? WHERE id = ?`)
        .run(now, attachmentId);
      const bytes = await this.fetchMailboxAttachmentBytes(row);
      const extracted = await this.extractTextFromAttachmentBytes(row, bytes);
      const text = normalizeWhitespace(extracted.text, MAILBOX_ATTACHMENT_TEXT_MAX_CHARS);
      this.db
        .prepare(
          `INSERT INTO mailbox_attachment_text (attachment_id, text_content, extraction_mode, extracted_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(attachment_id) DO UPDATE SET
             text_content = excluded.text_content,
             extraction_mode = excluded.extraction_mode,
             extracted_at = excluded.extracted_at`,
        )
        .run(attachmentId, encryptMailboxValue(text), extracted.mode, Date.now());
      this.db
        .prepare(`UPDATE mailbox_attachments SET extraction_status = 'indexed', extraction_error = NULL, updated_at = ? WHERE id = ?`)
        .run(Date.now(), attachmentId);
      this.upsertAttachmentSearchIndex(attachmentId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.db
        .prepare(`UPDATE mailbox_attachments SET extraction_status = 'error', extraction_error = ?, updated_at = ? WHERE id = ?`)
        .run(normalizeWhitespace(message, 240), Date.now(), attachmentId);
    }
    const updated = this.getMailboxAttachment(attachmentId, true);
    if (!updated) throw new Error("Attachment not found");
    return updated;
  }

  private async fetchMailboxAttachmentBytes(row: MailboxAttachmentRow): Promise<Buffer> {
    if (row.provider !== "gmail") {
      throw new Error("Attachment text extraction is currently available for Gmail attachments.");
    }
    if (!row.provider_attachment_id) {
      throw new Error("Gmail attachment id is missing.");
    }
    const settings = GoogleWorkspaceSettingsManager.loadSettings();
    const result = await gmailRequest(settings, {
      method: "GET",
      path: `/users/me/messages/${encodeURIComponent(row.provider_message_id)}/attachments/${encodeURIComponent(row.provider_attachment_id)}`,
    });
    const data = asString(result.data?.data);
    if (!data) {
      throw new Error("Gmail did not return attachment data.");
    }
    const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(normalized, "base64");
  }

  private async extractTextFromAttachmentBytes(
    row: MailboxAttachmentRow,
    bytes: Buffer,
  ): Promise<{ text: string; mode: string }> {
    const filename = row.filename.toLowerCase();
    const mimeType = (row.mime_type || "").toLowerCase();
    if (mimeType === "application/pdf" || filename.endsWith(".pdf")) {
      const parsed = await parsePdfBuffer(bytes);
      return { text: parsed.text || "", mode: "pdf-parse" };
    }
    if (
      mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      filename.endsWith(".docx")
    ) {
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({ buffer: bytes });
      return { text: result.value || "", mode: "mammoth-docx" };
    }
    const raw = bytes.toString("utf8");
    return {
      text: mimeType === "text/html" || /\.(html|htm)$/i.test(filename) ? stripHtml(raw) : raw,
      mode: mimeType === "text/html" || /\.(html|htm)$/i.test(filename) ? "html-text" : "plain-text",
    };
  }

  private mapAttachmentRow(row: MailboxAttachmentRow, includeText = false): MailboxAttachmentRecord {
    return {
      id: row.id,
      threadId: row.thread_id,
      messageId: row.message_id,
      provider: row.provider,
      providerMessageId: row.provider_message_id,
      providerAttachmentId: row.provider_attachment_id || undefined,
      filename: row.filename,
      mimeType: row.mime_type || undefined,
      size: row.size ?? undefined,
      extractionStatus: row.extraction_status || "not_indexed",
      extractionError: row.extraction_error || undefined,
      extractionMode: row.extraction_mode || undefined,
      text: includeText ? decryptMailboxValue(row.text_content || "") || undefined : undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private updateSyncProgress(progress: Omit<MailboxSyncProgress, "updatedAt">): void {
    this.syncProgress = {
      ...progress,
      updatedAt: Date.now(),
    };
  }

  private resolveDefaultWorkspaceId(): string | undefined {
    const workspaces = this.workspaceRepo.findAll();
    const preferred = workspaces.find(
      (workspace) => !workspace.isTemp && !isTempWorkspaceId(workspace.id),
    );
    return preferred?.id || workspaces[0]?.id;
  }

  private buildInboxVisibleThreadFilter(
    threadAlias = "mailbox_threads",
    workspaceId = this.resolveDefaultWorkspaceId(),
  ): { sql: string; params: unknown[] } {
    const threadRef = `${threadAlias}.id`;
    const conditions = [
      `${threadAlias}.local_inbox_hidden = 0`,
      `EXISTS (
        SELECT 1
        FROM mailbox_messages m
        WHERE m.thread_id = ${threadRef}
          AND m.direction = 'incoming'
      )`,
    ];
    const params: unknown[] = [];
    if (workspaceId) {
      conditions.push(
        `(
          ${threadAlias}.provider != 'agentmail'
          OR EXISTS (
            SELECT 1
            FROM agentmail_inboxes ai
            WHERE ai.workspace_id = ?
              AND ('agentmail:' || ai.pod_id || ':' || ai.inbox_id) = ${threadAlias}.account_id
          )
        )`,
      );
      params.push(workspaceId);
    }
    if (workspaceId) {
      // A thread is hidden from inbox if it belongs to at least one view with
      // show_in_inbox=0, but does NOT also belong to any view with show_in_inbox=1.
      conditions.push(
        `NOT (
          EXISTS (
            SELECT 1
            FROM mailbox_saved_view_threads svt
            INNER JOIN mailbox_saved_views sv ON sv.id = svt.view_id
            WHERE svt.thread_id = ${threadRef}
              AND sv.workspace_id = ?
              AND sv.show_in_inbox = 0
          )
          AND NOT EXISTS (
            SELECT 1
            FROM mailbox_saved_view_threads svt2
            INNER JOIN mailbox_saved_views sv2 ON sv2.id = svt2.view_id
            WHERE svt2.thread_id = ${threadRef}
              AND sv2.workspace_id = ?
              AND sv2.show_in_inbox != 0
          )
        )`,
      );
      params.push(workspaceId, workspaceId);
    }
    return { sql: conditions.join(" AND "), params };
  }

  /** Drops unknown or stale thread ids (e.g. hallucinated LLM output) before persisting saved views. */
  private filterValidMailboxThreadIds(threadIds: string[], accountId?: string): string[] {
    const ids = [...new Set(threadIds.map((id) => id?.trim()).filter(Boolean))] as string[];
    if (!ids.length) return [];
    const placeholders = ids.map(() => "?").join(",");
    const conditions = [`id IN (${placeholders})`];
    const values: unknown[] = [...ids];
    if (accountId) {
      conditions.push("account_id = ?");
      values.push(accountId);
    }
    const rows = this.db
      .prepare(`SELECT id FROM mailbox_threads WHERE ${conditions.join(" AND ")}`)
      .all(...values) as { id: string }[];
    const allowed = new Set(rows.map((r) => r.id));
    return ids.filter((id) => allowed.has(id));
  }

  private scoreSavedViewCandidate(seedTokens: Set<string>, subject: string, snippet: string): number {
    const tokenize = (value: string): string[] =>
      value
        .toLowerCase()
        .split(/[^a-z0-9]+/i)
        .map((token) => token.trim())
        .filter((token) => token.length >= 3)
        .slice(0, 80);
    const scoreOverlap = (tokens: string[], weight: number): number =>
      tokens.reduce((score, token) => score + (seedTokens.has(token) ? weight : 0), 0);

    return scoreOverlap(tokenize(subject), 3) + scoreOverlap(tokenize(snippet), 1);
  }

  private pruneMailboxTriageFeedback(workspaceId: string): void {
    const maxAgeMs = 90 * 24 * 60 * 60 * 1000;
    const maxRows = 12_000;
    const cutoff = Date.now() - maxAgeMs;
    try {
      this.db
        .prepare(`DELETE FROM mailbox_triage_feedback WHERE workspace_id = ? AND created_at < ?`)
        .run(workspaceId, cutoff);
      const countRow = this.db
        .prepare(`SELECT COUNT(*) AS c FROM mailbox_triage_feedback WHERE workspace_id = ?`)
        .get(workspaceId) as { c: number };
      if (countRow.c > maxRows) {
        const excess = countRow.c - maxRows;
        this.db
          .prepare(
            `DELETE FROM mailbox_triage_feedback WHERE rowid IN (
              SELECT rowid FROM mailbox_triage_feedback
              WHERE workspace_id = ?
              ORDER BY created_at ASC
              LIMIT ?
            )`,
          )
          .run(workspaceId, excess);
      }
    } catch {
      // best-effort retention
    }
  }

  private createThreadSensitiveContent(textParts: string[]): MailboxSensitiveContent {
    return detectSensitiveContent(textParts.filter(Boolean).join("\n"));
  }

  private readThreadSensitiveContent(row: MailboxThreadRow): MailboxSensitiveContent {
    return parseMailboxSensitiveContent(row.sensitive_content_json);
  }

  private buildMailboxEventRecord(event: MailboxEventRecordInput): MailboxEventRecordResult | null {
    const workspaceId = event.workspaceId || this.resolveDefaultWorkspaceId();
    if (!workspaceId) return null;

    const evidenceRefs = normalizeMailboxEvidenceRefs(event.evidenceRefs);
    const payload = {
      ...(event.payload || {}),
      accountId: event.accountId,
      threadId: event.threadId,
      provider: event.provider,
      subject: event.subject,
      summary: event.summary,
      evidenceRefs,
    };
    const fingerprint = buildMailboxEventFingerprint(event.type, workspaceId, payload);
    const timestamp = event.timestamp || Date.now();
    const existing = this.db
      .prepare(
        `SELECT id, duplicate_count
         FROM mailbox_events
         WHERE fingerprint = ?`,
      )
      .get(fingerprint) as { id: string; duplicate_count: number } | undefined;

    if (existing) {
      const duplicateCount = (existing.duplicate_count || 0) + 1;
      this.db
        .prepare(
          `UPDATE mailbox_events
           SET duplicate_count = ?, last_seen_at = ?
           WHERE id = ?`,
        )
        .run(duplicateCount, timestamp, existing.id);
      return {
        event: {
          id: existing.id,
          fingerprint,
          type: event.type,
          workspaceId,
          timestamp,
          accountId: event.accountId,
          threadId: event.threadId,
          provider: event.provider,
          subject: event.subject,
          summary: event.summary,
          evidenceRefs,
          payload,
        },
        duplicateCount,
        isDuplicate: true,
      };
    }

    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO mailbox_events
          (id, fingerprint, workspace_id, event_type, account_id, thread_id, provider, subject, summary_text, evidence_refs_json, payload_json, duplicate_count, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        fingerprint,
        workspaceId,
        event.type,
        event.accountId || null,
        event.threadId || null,
        event.provider || null,
        event.subject || null,
        event.summary || null,
        evidenceRefs.length ? JSON.stringify(evidenceRefs) : null,
        JSON.stringify(payload),
        0,
        timestamp,
        timestamp,
      );

    return {
      event: {
        id,
        fingerprint,
        type: event.type,
        workspaceId,
        timestamp,
        accountId: event.accountId,
        threadId: event.threadId,
        provider: event.provider,
        subject: event.subject,
        summary: event.summary,
        evidenceRefs,
        payload,
      },
      duplicateCount: 0,
      isDuplicate: false,
    };
  }

  private emitMailboxEvent(event: MailboxEventRecordInput): MailboxEvent | null {
    const record = this.buildMailboxEventRecord(event);
    if (!record) return null;
    if (!record.isDuplicate) {
      MailboxAutomationHub.handleMailboxEvent(record.event);
    }
    return record.event;
  }

  async sync(limit = 25): Promise<MailboxSyncResult> {
    if (this.syncInFlight) {
      const status = await this.getSyncStatus();
      return {
        accounts: status.accounts,
        syncedThreads: 0,
        syncedMessages: 0,
        lastSyncedAt: status.lastSyncedAt || Date.now(),
      };
    }
    this.syncInFlight = true;
    this.updateSyncProgress({
      phase: "fetching",
      totalThreads: 0,
      processedThreads: 0,
      totalMessages: 0,
      processedMessages: 0,
      newThreads: 0,
      classifiedThreads: 0,
      skippedThreads: 0,
      label: "Starting mailbox sync...",
    });
    try {
      const accounts: MailboxAccount[] = [];
      const syncErrors: string[] = [];
      let syncedThreads = 0;
      let syncedMessages = 0;

      if (GoogleWorkspaceSettingsManager.loadSettings().enabled) {
        try {
          const result = await this.syncGmail(limit);
          if (result) {
            accounts.push(result.account);
            syncedThreads += result.syncedThreads;
            syncedMessages += result.syncedMessages;
          }
        } catch (error) {
          syncErrors.push(`Gmail sync failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (this.agentMailEnabled()) {
        try {
          const result = await this.syncAgentMail(limit);
          if (result) {
            accounts.push(...result.accounts);
            syncedThreads += result.syncedThreads;
            syncedMessages += result.syncedMessages;
          }
        } catch (error) {
          syncErrors.push(`AgentMail sync failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (this.hasEmailChannel()) {
        try {
          const result = await this.syncImap(limit);
          if (result) {
            accounts.push(result.account);
            syncedThreads += result.syncedThreads;
            syncedMessages += result.syncedMessages;
          }
        } catch (error) {
          syncErrors.push(`Email channel sync failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (accounts.length === 0) {
        throw new Error(
          syncErrors[0] ||
            "No connected mailbox was found. Enable AgentMail, Google Workspace, or configure the Email channel.",
        );
      }

      const lastSyncedAt = Date.now();
      this.updateSyncProgress({
        phase: "done",
        totalThreads: syncedThreads,
        processedThreads: syncedThreads,
        totalMessages: syncedMessages,
        processedMessages: syncedMessages,
        newThreads: syncedThreads,
        classifiedThreads: 0,
        skippedThreads: 0,
        label:
          syncedThreads > 0
            ? `Synced ${syncedThreads} thread${syncedThreads === 1 ? "" : "s"} and ${syncedMessages} message${syncedMessages === 1 ? "" : "s"}`
          : "Mailbox sync complete",
      });
      this.emitMailboxEvent({
        type: "sync_completed",
        workspaceId: this.resolveDefaultWorkspaceId(),
        accountId: accounts[0]?.id,
        provider: accounts[0]?.provider,
        summary: `Synced ${syncedThreads} thread${syncedThreads === 1 ? "" : "s"} and ${syncedMessages} message${syncedMessages === 1 ? "" : "s"}`,
        evidenceRefs: accounts.map((account) => account.id),
        payload: {
          accountCount: accounts.length,
          threadCount: syncedThreads,
          messageCount: syncedMessages,
          accountIds: accounts.map((account) => account.id),
          providers: accounts.map((account) => account.provider),
        },
      });
      return {
        accounts,
        syncedThreads,
        syncedMessages,
        lastSyncedAt,
      };
    } catch (error) {
      this.updateSyncProgress({
        phase: "error",
        totalThreads: 0,
        processedThreads: 0,
        totalMessages: 0,
        processedMessages: 0,
        newThreads: 0,
        classifiedThreads: 0,
        skippedThreads: 0,
        label: `Mailbox sync failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      throw error;
    } finally {
      this.syncInFlight = false;
    }
  }

  private buildAgentMailAccountId(podId: string, inboxId: string): string {
    return `agentmail:${podId}:${inboxId}`;
  }

  private parseAgentMailAccountId(accountId?: string): { podId: string; inboxId: string } | null {
    const raw = asString(accountId);
    if (!raw || !raw.startsWith("agentmail:")) {
      return null;
    }
    const parts = raw.split(":");
    if (parts.length < 3) return null;
    return {
      podId: parts[1] || "",
      inboxId: parts.slice(2).join(":"),
    };
  }

  private getAgentMailBindings(): Array<{ workspace_id: string; pod_id: string }> {
    return this.db
      .prepare(
        `SELECT workspace_id, pod_id
         FROM agentmail_workspace_pods
         ORDER BY updated_at DESC`,
      )
      .all() as Array<{ workspace_id: string; pod_id: string }>;
  }

  private buildAgentMailAccount(
    podId: string,
    inboxId: string,
    address?: string,
    displayName?: string,
  ): MailboxAccount {
    return {
      id: this.buildAgentMailAccountId(podId, inboxId),
      provider: "agentmail",
      address: address || inboxId,
      displayName,
      status: "connected",
      capabilities: ["archive", "trash", "mark_read", "mark_unread", "labels", "send", "provider_drafts", "sync", "realtime"],
      backend: "agentmail",
      lastSyncedAt: Date.now(),
    };
  }

  private normalizeAgentMailLabels(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value
      .map((entry) => asString(entry))
      .filter((entry): entry is string => Boolean(entry))
      .map((entry) => entry.toLowerCase());
  }

  private normalizeAgentMailThread(
    _workspaceId: string,
    podId: string,
    threadPayload: unknown,
  ): NormalizedThreadInput | null {
    const thread = asObject(threadPayload);
    if (!thread) return null;

    const inboxId = asString(thread.inbox_id);
    const providerThreadId = asString(thread.thread_id);
    if (!inboxId || !providerThreadId) {
      return null;
    }

    const accountId = this.buildAgentMailAccountId(podId, inboxId);
    const accountRow = this.db
      .prepare("SELECT address FROM mailbox_accounts WHERE id = ?")
      .get(accountId) as { address: string } | undefined;
    const accountEmail = normalizeEmailAddress(accountRow?.address || inboxId) || inboxId.toLowerCase();
    const threadLabels = this.normalizeAgentMailLabels(thread.labels);
    const rawMessages = Array.isArray(thread.messages) ? thread.messages : [];

    const normalizedMessages = rawMessages
      .map<NormalizedMailboxMessage | null>((entry) => {
        const message = asObject(entry);
        if (!message) return null;
        const providerMessageId = asString(message.message_id);
        if (!providerMessageId) return null;
        const from = parseAddressList(message.from)[0];
        const to = parseAddressList(message.to);
        const cc = parseAddressList(message.cc);
        const bcc = parseAddressList(message.bcc);
        const labels = this.normalizeAgentMailLabels(message.labels);
        const bodyHtml = asString(message.html) || asString(message.body_html) || undefined;
        const bodyText =
          asString(message.text) ||
          asString(message.body_text) ||
          asString(message.body) ||
          (bodyHtml ? stripHtml(bodyHtml) : "");
        const receivedAt =
          parseTimestamp(message.timestamp) ||
          parseTimestamp(message.created_at) ||
          parseTimestamp(message.updated_at) ||
          Date.now();
        const fromEmail = normalizeEmailAddress(from?.email);
        const directionHint = asString(message.direction);
        const outgoing =
          directionHint === "outgoing" ||
          directionHint === "sent" ||
          fromEmail === accountEmail ||
          labels.includes("sent");
        const unread = labels.includes("unread") || threadLabels.includes("unread");

        return {
          id: `agentmail-message:${providerMessageId}`,
          providerMessageId,
          direction: outgoing ? ("outgoing" as const) : ("incoming" as const),
          from,
          to,
          cc,
          bcc,
          subject:
            asString(message.subject) ||
            asString(thread.subject) ||
            "Untitled thread",
          snippet: normalizeWhitespace(
            asString(message.preview) || bodyText || (bodyHtml ? stripHtml(bodyHtml) : ""),
            240,
          ),
          body: normalizeWhitespace(bodyText, 12000),
          bodyHtml,
          receivedAt,
          unread,
          metadata: {
            rfcMessageId:
              asString(message.internet_message_id) ||
              asString(message.message_id_header) ||
              undefined,
          },
        };
      })
      .filter((message): message is NormalizedMailboxMessage => message !== null)
      .sort((a, b) => a.receivedAt - b.receivedAt);

    if (normalizedMessages.length === 0) {
      return null;
    }

    const participants = uniqueParticipants(
      [
        ...parseAddressList(thread.senders),
        ...parseAddressList(thread.recipients),
        ...normalizedMessages.flatMap((message) => [
          ...(message.from ? [message.from] : []),
          ...message.to,
          ...message.cc,
          ...message.bcc,
        ]),
      ].filter((participant) => normalizeEmailAddress(participant.email) !== accountEmail),
    );
    const unreadCount = normalizedMessages.filter((message) => message.unread).length;
    const lastMessage = normalizedMessages[normalizedMessages.length - 1]!;
    const needsReply = normalizedMessages.some(
      (message) => message.direction === "incoming" && message.unread,
    );

    return {
      id: `agentmail-thread:${providerThreadId}`,
      accountId,
      provider: "agentmail",
      providerThreadId,
      subject:
        asString(thread.subject) ||
        lastMessage.subject ||
        "Untitled thread",
      snippet: normalizeWhitespace(
        asString(thread.preview) ||
          asString(thread.snippet) ||
          lastMessage.snippet ||
          lastMessage.body,
        320,
      ),
      participants,
      labels: threadLabels,
      category: "other",
      priorityScore: clampScore(needsReply ? 55 : unreadCount > 0 ? 35 : 10),
      urgencyScore: clampScore(needsReply ? 30 : unreadCount > 0 ? 12 : 0),
      needsReply,
      staleFollowup: false,
      cleanupCandidate: false,
      handled: unreadCount === 0 && !needsReply,
      unreadCount,
      lastMessageAt:
        parseTimestamp(thread.timestamp) ||
        parseTimestamp(thread.received_timestamp) ||
        parseTimestamp(thread.updated_at) ||
        lastMessage.receivedAt,
      messages: normalizedMessages,
    };
  }

  async ingestAgentMailThread(
    _workspaceId: string,
    podId: string,
    threadPayload: unknown,
    options?: { classify?: boolean },
  ): Promise<{ account: MailboxAccount; syncedMessages: number; isNewThread: boolean } | null> {
    const normalized = this.normalizeAgentMailThread(_workspaceId, podId, threadPayload);
    if (!normalized) return null;

    const inboxParts = this.parseAgentMailAccountId(normalized.accountId);
    const inboxRow = inboxParts
      ? (this.db
          .prepare(
            `SELECT email, display_name
             FROM agentmail_inboxes
             WHERE pod_id = ? AND inbox_id = ?`,
          )
          .get(inboxParts.podId, inboxParts.inboxId) as
          | { email: string | null; display_name: string | null }
          | undefined)
      : undefined;

    const account = this.buildAgentMailAccount(
      podId,
      inboxParts?.inboxId || normalized.accountId,
      inboxRow?.email || inboxParts?.inboxId,
      inboxRow?.display_name || undefined,
    );
    this.upsertAccount(account);
    const upsertResult = this.upsertThread(normalized);
    if (upsertResult.shouldClassify && options?.classify !== false) {
      await this.classifyMailboxThreadsForAccount(account.id, {
        includeBackfill: true,
        limit: Math.min(Math.max(normalized.messages.length, 1), MAILBOX_CLASSIFIER_MAX_BATCH),
      });
    }

    this.db
      .prepare("UPDATE mailbox_accounts SET last_synced_at = ?, updated_at = ? WHERE id = ?")
      .run(Date.now(), Date.now(), account.id);

    return {
      account,
      syncedMessages: normalized.messages.length,
      isNewThread: upsertResult.isNewThread,
    };
  }

  private async syncAgentMail(
    limit: number,
  ): Promise<{ accounts: MailboxAccount[]; syncedThreads: number; syncedMessages: number } | null> {
    const bindings = this.getAgentMailBindings();
    if (bindings.length === 0) {
      return null;
    }

    const adminService = new AgentMailAdminService(this.db);
    const client = this.getAgentMailClient();
    const accountsById = new Map<string, MailboxAccount>();
    const classificationCandidates = new Set<string>();
    let processedThreads = 0;
    let processedMessages = 0;

    this.updateSyncProgress({
      phase: "ingesting",
      totalThreads: bindings.length * Math.min(Math.max(limit, 1), 50),
      processedThreads: 0,
      totalMessages: 0,
      processedMessages: 0,
      newThreads: 0,
      classifiedThreads: 0,
      skippedThreads: 0,
      label: "Syncing AgentMail pods...",
    });

    for (const binding of bindings) {
      const refreshed = await adminService.refreshWorkspace(binding.workspace_id);
      for (const inbox of refreshed.inboxes) {
        const account = this.buildAgentMailAccount(
          inbox.podId,
          inbox.inboxId,
          inbox.email,
          inbox.displayName,
        );
        this.upsertAccount(account);
        accountsById.set(account.id, account);
      }

      const listResult = await client.listPodThreads(binding.pod_id, {
        limit: Math.min(Math.max(limit * 3, limit), 100),
        includeSpam: true,
        includeBlocked: true,
        includeTrash: true,
      });
      const threadRefs = Array.isArray(listResult.threads) ? listResult.threads : [];

      for (const threadRef of threadRefs.slice(0, limit)) {
        const providerThreadId = asString(asObject(threadRef)?.thread_id);
        if (!providerThreadId) continue;
        const thread = await client.getPodThread(binding.pod_id, providerThreadId);
        const ingestResult = await this.ingestAgentMailThread(
          binding.workspace_id,
          binding.pod_id,
          thread,
          { classify: false },
        );
        if (!ingestResult) continue;
        accountsById.set(ingestResult.account.id, ingestResult.account);
        classificationCandidates.add(ingestResult.account.id);
        processedThreads += 1;
        processedMessages += ingestResult.syncedMessages;
        this.updateSyncProgress({
          phase: "ingesting",
          accountId: ingestResult.account.id,
          totalThreads: bindings.length * Math.min(Math.max(limit, 1), 50),
          processedThreads,
          totalMessages: Math.max(processedMessages, processedThreads),
          processedMessages,
          newThreads: processedThreads,
          classifiedThreads: 0,
          skippedThreads: 0,
          label: `Syncing AgentMail ${processedThreads} thread${processedThreads === 1 ? "" : "s"} · ${processedMessages} message${processedMessages === 1 ? "" : "s"}`,
        });
      }
    }

    for (const accountId of classificationCandidates) {
      await this.classifyMailboxThreadsForAccount(accountId, {
        includeBackfill: true,
        limit: MAILBOX_CLASSIFIER_MAX_BATCH,
      });
    }

    return {
      accounts: Array.from(accountsById.values()),
      syncedThreads: processedThreads,
      syncedMessages: processedMessages,
    };
  }

  async reclassifyThread(threadId: string): Promise<MailboxReclassifyResult> {
    const thread = this.db
      .prepare("SELECT account_id FROM mailbox_threads WHERE id = ?")
      .get(threadId) as { account_id: string } | undefined;
    if (!thread) {
      throw new Error("Thread not found");
    }
    const updated = await this.classifyThreadById(threadId, { force: true });
    if (updated) {
      this.recordMailboxTriageFeedback(threadId, "reclassify");
    }
    return {
      accountId: thread.account_id,
      scannedThreads: 1,
      reclassifiedThreads: updated ? 1 : 0,
    };
  }

  async reclassifyAccount(input: MailboxReclassifyInput): Promise<MailboxReclassifyResult> {
    const accountId = input.accountId?.trim();
    if (!accountId) {
      throw new Error("Missing accountId for mailbox reclassification");
    }

    if (input.scope === "thread") {
      if (!input.threadId) {
        throw new Error("Missing threadId for mailbox thread reclassification");
      }
      return this.reclassifyThread(input.threadId);
    }

    const includeBackfill = input.scope === "backfill" || input.scope === "account";
    const force = input.scope === "account";
    const result = await this.classifyMailboxThreadsForAccount(accountId, {
      includeBackfill,
      limit: input.limit || MAILBOX_CLASSIFIER_MAX_BATCH,
      force,
    });

    if (force) {
      this.db
        .prepare(
          `UPDATE mailbox_accounts
           SET classification_initial_batch_at = COALESCE(classification_initial_batch_at, ?),
               updated_at = ?
           WHERE id = ?`,
        )
        .run(Date.now(), Date.now(), accountId);
    }

    return result;
  }

  async listThreads(input: MailboxListThreadsInput = {}): Promise<MailboxThreadListItem[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    const queryText = input.query?.trim() || "";

    if (input.accountId) {
      conditions.push("account_id = ?");
      values.push(input.accountId);
    }
    if (input.category && input.category !== "all") {
      conditions.push("category = ?");
      values.push(input.category);
    }
    if (input.todayBucket && input.todayBucket !== "all") {
      conditions.push("today_bucket = ?");
      values.push(input.todayBucket);
    }
    if (input.domainCategory && input.domainCategory !== "all") {
      conditions.push("domain_category = ?");
      values.push(input.domainCategory);
    }
    if (input.folderId) {
      conditions.push(
        `(labels_json LIKE ? OR metadata_json LIKE ?)`,
      );
      values.push(`%"${input.folderId}"%`, `%"folderId":"${input.folderId}"%`);
    }
    if (input.labelId) {
      conditions.push(
        `(labels_json LIKE ? OR metadata_json LIKE ?)`,
      );
      values.push(`%"${input.labelId}"%`, `%"labelId":"${input.labelId}"%`);
    }
    if (input.scheduledOnly) {
      conditions.push(
        `EXISTS (
          SELECT 1 FROM mailbox_compose_drafts mcd
          WHERE mcd.thread_id = mailbox_threads.id
            AND mcd.status = 'scheduled'
        )`,
      );
    }
    if (input.draftOnly) {
      conditions.push(
        `EXISTS (
          SELECT 1 FROM mailbox_compose_drafts mcd
          WHERE mcd.thread_id = mailbox_threads.id
            AND mcd.status NOT IN ('discarded', 'sent')
        )`,
      );
    }
    if (input.queuedOnly) {
      conditions.push(
        `EXISTS (
          SELECT 1 FROM mailbox_queued_actions mqa
          WHERE mqa.thread_id = mailbox_threads.id
            AND mqa.status IN ('queued', 'running', 'failed')
        )`,
      );
    }
    const mailboxView: MailboxThreadMailboxView = input.mailboxView || "inbox";
    if (mailboxView === "inbox") {
      const inboxVisibleFilter = this.buildInboxVisibleThreadFilter();
      conditions.push(inboxVisibleFilter.sql);
      values.push(...inboxVisibleFilter.params);
    } else if (mailboxView === "sent") {
      conditions.push(
        `NOT EXISTS (
          SELECT 1
          FROM mailbox_messages m
          WHERE m.thread_id = mailbox_threads.id
            AND m.direction = 'incoming'
        )`,
      );
    }
    if (typeof input.unreadOnly === "boolean") {
      conditions.push(input.unreadOnly ? "unread_count > 0" : "unread_count = 0");
    }
    if (typeof input.needsReply === "boolean") {
      conditions.push("needs_reply = ?");
      values.push(input.needsReply ? 1 : 0);
    }
    if (typeof input.hasSuggestedProposal === "boolean") {
      conditions.push(
        input.hasSuggestedProposal
          ? `EXISTS (
              SELECT 1
              FROM mailbox_action_proposals map
              WHERE map.thread_id = mailbox_threads.id
                AND map.status = 'suggested'
            )`
          : `NOT EXISTS (
              SELECT 1
              FROM mailbox_action_proposals map
              WHERE map.thread_id = mailbox_threads.id
                AND map.status = 'suggested'
            )`,
      );
    }
    if (typeof input.hasOpenCommitment === "boolean") {
      conditions.push(
        input.hasOpenCommitment
          ? `EXISTS (
              SELECT 1
              FROM mailbox_commitments mc
              WHERE mc.thread_id = mailbox_threads.id
                AND mc.state IN ('suggested', 'accepted')
            )`
          : `NOT EXISTS (
              SELECT 1
              FROM mailbox_commitments mc
              WHERE mc.thread_id = mailbox_threads.id
                AND mc.state IN ('suggested', 'accepted')
            )`,
      );
    }
    if (typeof input.cleanupCandidate === "boolean") {
      conditions.push("cleanup_candidate = ?");
      values.push(input.cleanupCandidate ? 1 : 0);
    }
    if (typeof input.hasAttachment === "boolean") {
      conditions.push(
        input.hasAttachment
          ? `EXISTS (SELECT 1 FROM mailbox_attachments ma WHERE ma.thread_id = mailbox_threads.id)`
          : `NOT EXISTS (SELECT 1 FROM mailbox_attachments ma WHERE ma.thread_id = mailbox_threads.id)`,
      );
    }
    const attachmentQuery = input.attachmentQuery?.trim();
    if (attachmentQuery) {
      conditions.push(
        `EXISTS (SELECT 1 FROM mailbox_attachments ma WHERE ma.thread_id = mailbox_threads.id)`,
      );
    }
    const savedViewId = input.savedViewId?.trim();
    if (savedViewId) {
      conditions.push(
        `EXISTS (
          SELECT 1 FROM mailbox_saved_view_threads svt
          WHERE svt.view_id = ? AND svt.thread_id = mailbox_threads.id
        )`,
      );
      values.push(savedViewId);
    }

    const limit = Math.min(Math.max(input.limit ?? 40, 1), 100);
    const sortBy: MailboxThreadSortOrder = input.sortBy === "recent" ? "recent" : "priority";
    const orderBy =
      sortBy === "recent"
        ? "last_message_at DESC, priority_score DESC, urgency_score DESC"
        : "priority_score DESC, urgency_score DESC, last_message_at DESC";
    const hasPostFilters = Boolean(queryText || attachmentQuery);
    const limitClause = hasPostFilters ? "" : " LIMIT ?";
    const rows = this.db
      .prepare(
        `SELECT
           id,
           account_id,
           provider,
           provider_thread_id,
           subject,
           snippet,
           participants_json,
           labels_json,
           category,
           today_bucket,
           domain_category,
           classification_rationale,
           priority_score,
           urgency_score,
           needs_reply,
           stale_followup,
           cleanup_candidate,
           handled,
           local_inbox_hidden,
           unread_count,
           message_count,
           last_message_at,
           sensitive_content_json,
           classification_state
         FROM mailbox_threads
         ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
         ORDER BY ${orderBy}${limitClause}`,
      )
      .all(...(hasPostFilters ? values : [...values, limit])) as MailboxThreadRow[];

    const filteredRows = rows.filter((row) => {
      if (queryText && !this.threadMatchesQuery(row, queryText)) return false;
      if (attachmentQuery && !this.threadMatchesAttachmentQuery(row.id, attachmentQuery)) return false;
      return true;
    });

    return filteredRows
      .slice(0, limit)
      .map((row) => this.mapThreadRow(row, this.getSummaryForThread(row.id) ?? undefined));
  }

  async getThread(threadId: string): Promise<MailboxThreadDetail | null> {
    const row = this.db
      .prepare(
        `SELECT
           id,
           account_id,
           provider,
           provider_thread_id,
           subject,
           snippet,
           participants_json,
           labels_json,
           category,
           today_bucket,
           domain_category,
           classification_rationale,
           priority_score,
           urgency_score,
           needs_reply,
           stale_followup,
           cleanup_candidate,
           handled,
           local_inbox_hidden,
           unread_count,
           message_count,
           last_message_at,
           sensitive_content_json,
           classification_state
         FROM mailbox_threads
         WHERE id = ?`,
      )
      .get(threadId) as MailboxThreadRow | undefined;
    if (!row) return null;

    const summary = this.getSummaryForThread(threadId) ?? (await this.summarizeThread(threadId));
    const messages = this.getMessagesForThread(threadId);
    const drafts = this.getDraftsForThread(threadId);
    const proposals = this.getProposalsForThread(threadId);
    const commitments = this.getCommitmentsForThread(threadId);
    const contactMemory = this.getPrimaryContactMemory(threadId);
    const research = await this.researchContact(threadId);
    const sensitiveContent = this.readThreadSensitiveContent(row);

    return {
      ...this.mapThreadRow(row, summary || undefined),
      messages,
      drafts,
      proposals,
      commitments,
      contactMemory,
      research,
      sensitiveContent,
    };
  }

  async summarizeThread(threadId: string): Promise<MailboxSummaryCard | null> {
    const detail = await this.getThreadCore(threadId);
    if (!detail) return null;
    const noReplySender = getMailboxNoReplySender(detail.messages, detail.participants);

    const combinedText = detail.messages
      .map((message) => message.body || message.snippet)
      .join("\n\n")
      .trim();
    const lines = excerptLines(combinedText, 12);
    const questions = detail.messages
      .flatMap((message) =>
        excerptLines(message.body, 6).filter((line) => line.includes("?")),
      )
      .slice(0, 3);
    const asks = detail.messages
      .flatMap((message) =>
        excerptLines(message.body, 6).filter((line) =>
          /\bplease|can you|could you|need|action|required|review\b/i.test(line),
        ),
      )
      .slice(0, 3);

    const picked = pickThreadSummaryLine(lines, detail.snippet, detail.subject);
    let summaryText = stripMailboxSummaryHtmlArtifacts(picked);
    if (!summaryText.trim()) {
      summaryText =
        detail.snippet?.trim() ||
        `Recent email activity in ${detail.subject || "this thread"}`;
    }
    const nextAction = noReplySender
      ? "Keep as reference"
      : detail.needsReply
        ? "Draft a reply"
        : detail.cleanupCandidate
        ? "Queue for cleanup review"
        : detail.category === "calendar"
          ? "Propose scheduling options"
          : "Keep as reference";
    const updatedAt = Date.now();
    const primaryContact = detail.participants[0];

    this.db
      .prepare(
        `INSERT INTO mailbox_summaries
          (thread_id, summary_text, key_asks_json, extracted_questions_json, suggested_next_action, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET
           summary_text = excluded.summary_text,
           key_asks_json = excluded.key_asks_json,
           extracted_questions_json = excluded.extracted_questions_json,
           suggested_next_action = excluded.suggested_next_action,
           updated_at = excluded.updated_at`,
      )
      .run(
        threadId,
        encryptMailboxValue(normalizeWhitespace(summaryText, 340)),
        JSON.stringify(asks),
        JSON.stringify(questions),
        nextAction,
        updatedAt,
      );

    this.refreshThreadProposals(detail);
    this.emitMailboxEvent({
      type: "thread_summarized",
      threadId,
      accountId: detail.accountId,
      provider: detail.provider,
      subject: detail.subject,
      summary: normalizeWhitespace(summaryText, 340),
      evidenceRefs: [threadId, ...detail.messages.slice(-1).map((message) => message.id)],
      payload: {
        primaryContactEmail: primaryContact?.email,
        primaryContactName: primaryContact?.name,
        senderName: primaryContact?.name,
        company: companyFromEmail(primaryContact?.email),
        projectHint: detail.category === "calendar" ? detail.subject : undefined,
        keyAsks: asks,
        extractedQuestions: questions,
        suggestedNextAction: nextAction,
      },
    });

    return {
      summary: normalizeWhitespace(summaryText, 340),
      keyAsks: asks,
      extractedQuestions: questions,
      suggestedNextAction: nextAction,
      updatedAt,
    };
  }

  async generateDraft(
    threadId: string,
    options: MailboxDraftOptions = {},
  ): Promise<MailboxDraftSuggestion | null> {
    const detail = await this.getThreadCore(threadId);
    if (!detail) return null;
    const noReplySender = getMailboxNoReplySender(detail.messages, detail.participants);
    if (noReplySender && options.allowNoreplySender !== true) {
      throw new Error(
        `Draft generation is blocked because this thread comes from a no-reply sender (${noReplySender.email}). Confirm the manual override to continue.`,
      );
    }

    const summary = this.getSummaryForThread(threadId) || (await this.summarizeThread(threadId));
    const scheduleSuggestion =
      options.includeAvailability !== false && detail.category === "calendar"
        ? await this.getScheduleSuggestion()
        : null;
    const resolution = await this.resolveContactIdentity(threadId);
    const scopedCompanyId = this.getPrimaryContactMemory(threadId)?.company;
    const relationshipContext = RelationshipMemoryService.buildPromptContext({
      maxPerLayer: 1,
      maxChars: 420,
      contactIdentityId: resolution?.identity?.id,
      companyId: scopedCompanyId,
    });
    const latestIncoming =
      detail.messages.filter((message) => message.direction === "incoming").slice(-1)[0] ||
      detail.messages[detail.messages.length - 1];
    const recipient =
      latestIncoming?.from?.name || latestIncoming?.from?.email || detail.participants[0]?.email || "there";
    const contactEmail = detail.participants[0]?.email;
    const primaryContact = detail.participants[0];
    const styleProfile = this.buildDraftStyleProfile({
      outgoingMessages: contactEmail
        ? this.db
            .prepare(
              `SELECT m.body_text
               FROM mailbox_messages m
               JOIN mailbox_threads t ON t.id = m.thread_id
               WHERE t.account_id = ? AND t.participants_json LIKE ? AND m.direction = 'outgoing'
               ORDER BY m.received_at ASC`,
            )
            .all(detail.accountId, `%${contactEmail}%`)
            .map((row) => normalizeWhitespace(decryptMailboxValue((row as { body_text: string }).body_text) || "", 600))
        : [],
      averageResponseHours: contactEmail ? this.getPrimaryContactMemory(threadId)?.averageResponseHours : undefined,
    });
    const greetingPrefix = styleProfile.greeting?.match(/^(Hi|Hello|Hey)\b/i)?.[1] || "Hi";
    const greeting = recipient && recipient !== "there" ? `${greetingPrefix} ${recipient.split(" ")[0]},` : `${greetingPrefix},`;
    const keyAsk = summary?.keyAsks[0];
    const tone = options.tone || styleProfile.tone || "concise";

    const bodyLines = [greeting, ""];
    if (keyAsk) {
      bodyLines.push(
        tone === "warm"
          ? `Thanks for the note. I took a look at the request about ${keyAsk.replace(/[.?!]$/, "")}.`
          : tone === "executive"
            ? `I reviewed the request regarding ${keyAsk.replace(/[.?!]$/, "")}.`
            : `Thanks for the note. I reviewed the request about ${keyAsk.replace(/[.?!]$/, "")}.`,
      );
    } else {
      bodyLines.push(
        tone === "executive"
          ? `I reviewed the latest update on ${detail.subject.toLowerCase()}.`
          : `Thanks for the update on ${detail.subject.toLowerCase()}.`,
      );
    }

    const scheduleLabels = scheduleSuggestion?.options.map((option) => option.label) || [];

    if (scheduleLabels.length) {
      bodyLines.push("");
      bodyLines.push(
        tone === "executive"
          ? `Available windows: ${scheduleLabels.join(", ")}.`
          : `I can make time for this. A few options on my side: ${scheduleLabels.join(", ")}.`,
      );
    } else if (detail.needsReply) {
      bodyLines.push("");
      bodyLines.push(
        tone === "warm"
          ? "I can take this forward and will follow up with the next concrete step shortly."
          : tone === "executive"
            ? "Next step: I will take this forward and follow up shortly."
            : "I can take this forward and will follow up with the next concrete step shortly.",
      );
    }

    if (styleProfile.styleSignals.length && styleProfile.averageLength < 220) {
      bodyLines.push("");
      bodyLines.push("Keeping this brief and practical.");
    } else if (relationshipContext) {
      const preferenceHint = relationshipContext
        .split("\n")
        .find((line) => line.toLowerCase().includes("feedback preference"));
      if (preferenceHint && !/brief|concise/i.test(tone)) {
        bodyLines.push("");
        bodyLines.push("Keeping this short and practical.");
      }
    }

    bodyLines.push("");
    bodyLines.push(styleProfile.signoff || (tone === "warm" ? "Thanks," : "Best,"));

    const body = bodyLines.join("\n");
    const draftId = randomUUID();
    const now = Date.now();
    const rationale =
      summary?.suggestedNextAction ||
      `Drafted from latest thread context and mailbox memory${styleProfile.styleSignals.length ? ` (${styleProfile.styleSignals.join("; ")})` : ""}.`;
    const scheduleNotes = scheduleSuggestion?.summary;

    this.db
      .prepare(
        `INSERT INTO mailbox_drafts
          (id, thread_id, subject, body_text, tone, rationale, schedule_notes, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        draftId,
        threadId,
        detail.subject.startsWith("Re:") ? detail.subject : `Re: ${detail.subject}`,
        encryptMailboxValue(body),
        tone,
        rationale,
        scheduleNotes || null,
        JSON.stringify({
          source: "mailbox-draft-engine",
          includeAvailability: Boolean(scheduleSuggestion),
        }),
        now,
        now,
      );

    this.upsertProposal({
      threadId,
      type: "reply",
      title: "Review reply draft",
      reasoning: rationale,
      preview: {
        draftId,
        subject: detail.subject.startsWith("Re:") ? detail.subject : `Re: ${detail.subject}`,
      },
    });
    this.emitMailboxEvent({
      type: "draft_created",
      threadId,
      accountId: detail.accountId,
      provider: detail.provider,
      subject: detail.subject,
      summary: normalizeWhitespace(rationale, 220),
      evidenceRefs: [threadId, draftId],
      payload: {
        draftId,
        tone,
        subject: detail.subject.startsWith("Re:") ? detail.subject : `Re: ${detail.subject}`,
        hasScheduleSuggestion: Boolean(scheduleSuggestion),
        primaryContactEmail: primaryContact?.email,
        primaryContactName: primaryContact?.name,
        senderName: primaryContact?.name,
        company: companyFromEmail(primaryContact?.email),
        projectHint: detail.category === "calendar" ? detail.subject : undefined,
      },
    });

    return {
      id: draftId,
      threadId,
      subject: detail.subject.startsWith("Re:") ? detail.subject : `Re: ${detail.subject}`,
      body,
      tone,
      rationale,
      scheduleNotes,
      createdAt: now,
      updatedAt: now,
    };
  }

  async extractCommitments(threadId: string): Promise<MailboxCommitment[]> {
    const detail = await this.getThreadCore(threadId);
    if (!detail) return [];

    const candidates: Array<Pick<MailboxCommitment, "title" | "dueAt" | "sourceExcerpt">> = [];
    for (const message of detail.messages) {
      for (const line of excerptLines(message.body, 12)) {
        if (/\bplease|can you|need to|follow up|action item|todo|deliver\b/i.test(line)) {
          candidates.push({
            title: normalizeWhitespace(line, 180),
            dueAt: parseDueAt(line),
            sourceExcerpt: normalizeWhitespace(line, 180),
          });
        }
      }
    }

    const existingTitles = new Set(
      this.getCommitmentsForThread(threadId).map((item) => item.title.toLowerCase()),
    );
    const created: MailboxCommitment[] = [];
    const now = Date.now();
    const primaryContact = detail.participants[0];
    const resolution = await this.resolveContactIdentity(threadId);
    const companyScope = this.getPrimaryContactMemory(threadId)?.company;

    for (const candidate of candidates.slice(0, 6)) {
      if (existingTitles.has(candidate.title.toLowerCase())) continue;
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO mailbox_commitments
            (id, thread_id, message_id, title, due_at, state, owner_email, source_excerpt, metadata_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
      .run(
        id,
        threadId,
        null,
        candidate.title,
        candidate.dueAt || null,
        "suggested",
        detail.participants[0]?.email || null,
        encryptMailboxValue(candidate.sourceExcerpt || null),
        JSON.stringify({ source: "mailbox-extraction" }),
        now,
        now,
      );
      RelationshipMemoryService.rememberMailboxInsights({
        commitments: [
          {
            text: candidate.title,
            dueAt: candidate.dueAt,
          },
        ],
        contactIdentityId: resolution?.identity?.id,
        companyId: companyScope,
      });
      created.push({
        id,
        threadId,
        title: candidate.title,
        dueAt: candidate.dueAt,
        state: "suggested",
        ownerEmail: detail.participants[0]?.email,
        sourceExcerpt: candidate.sourceExcerpt,
        createdAt: now,
        updatedAt: now,
      });
    }

    this.updateContactOpenCommitments(threadId);
    if (created.length > 0) {
      this.emitMailboxEvent({
        type: "commitments_extracted",
        threadId,
        accountId: detail.accountId,
        provider: detail.provider,
        subject: detail.subject,
        summary: `${created.length} commitment${created.length === 1 ? "" : "s"} extracted`,
        evidenceRefs: [threadId, ...created.map((commitment) => commitment.id)],
        payload: {
          commitmentCount: created.length,
          commitmentTitles: created.map((commitment) => commitment.title),
          dueDates: created.map((commitment) => commitment.dueAt || null),
          primaryContactEmail: primaryContact?.email,
          primaryContactName: primaryContact?.name,
          senderName: primaryContact?.name,
          company: companyFromEmail(primaryContact?.email),
        },
      });
    }
    return this.getCommitmentsForThread(threadId);
  }

  async updateCommitmentState(
    commitmentId: string,
    state: MailboxCommitmentState,
  ): Promise<MailboxCommitment | null> {
    const now = Date.now();
    const result = this.db.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT
             id,
             thread_id,
             message_id,
             title,
             due_at,
             state,
             owner_email,
             source_excerpt,
             metadata_json,
             created_at,
             updated_at
           FROM mailbox_commitments
           WHERE id = ?`,
        )
        .get(commitmentId) as MailboxCommitmentRow | undefined;
      if (!row) return null;

      const metadata = parseCommitmentMetadata(row.metadata_json);
      let nextMetadata: MailboxCommitmentMetadata = { ...metadata };

      if (state === "accepted") {
        const followUpTask = this.ensureFollowUpTaskForCommitment(row, metadata);
        if (followUpTask) {
          nextMetadata = {
            ...nextMetadata,
            followUpTaskId: followUpTask.id,
            followUpTaskCreatedAt: nextMetadata.followUpTaskCreatedAt ?? now,
            followUpTaskWorkspaceId: nextMetadata.followUpTaskWorkspaceId ?? followUpTask.workspaceId,
          };
          if (row.due_at != null) {
            this.taskRepo.update(followUpTask.id, {
              dueDate: row.due_at,
            });
          }
        }
      }

      if (state === "done" || state === "dismissed") {
        const followUpTaskId = metadata.followUpTaskId;
        if (followUpTaskId) {
          const status = state === "done" ? "completed" : "cancelled";
          this.taskRepo.update(followUpTaskId, {
            status,
            completedAt: state === "done" ? now : undefined,
          });
        }
      }

      this.db
        .prepare(
          `UPDATE mailbox_commitments
           SET state = ?, metadata_json = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(state, JSON.stringify(nextMetadata), now, commitmentId);

      if (state === "done") {
        const text = row.title;
        const items = RelationshipMemoryService.listOpenCommitments(200);
        for (const item of items) {
          if (
            text.toLowerCase().includes(item.text.toLowerCase()) ||
            item.text.toLowerCase().includes(text.toLowerCase())
          ) {
            RelationshipMemoryService.updateItem(item.id, { status: "done" });
          }
        }
      }

      const updatedRow = this.db
        .prepare(
          `SELECT
             id,
             thread_id,
             message_id,
             title,
             due_at,
             state,
             owner_email,
             source_excerpt,
             metadata_json,
             created_at,
             updated_at
           FROM mailbox_commitments
           WHERE id = ?`,
        )
        .get(commitmentId) as MailboxCommitmentRow | undefined;
      if (!updatedRow) return null;

      this.updateContactOpenCommitments(updatedRow.thread_id);
      return this.mapCommitmentRow(updatedRow);
    })();

    if (result) {
      const accountRow = this.db
        .prepare("SELECT account_id FROM mailbox_threads WHERE id = ?")
        .get(result.threadId) as { account_id: string } | undefined;
      this.emitMailboxEvent({
        type: "commitment_updated",
        threadId: result.threadId,
        accountId: accountRow?.account_id,
        subject: result.title,
        summary: `Commitment marked ${state}`,
        evidenceRefs: [result.id, result.threadId],
        payload: {
          commitmentId: result.id,
          state,
          title: result.title,
          dueAt: result.dueAt || null,
        },
      });
    }

    return result;
  }

  async updateCommitmentDetails(
    commitmentId: string,
    patch: {
      title?: string;
      dueAt?: number | null;
      ownerEmail?: string | null;
      state?: MailboxCommitmentState;
      sourceExcerpt?: string | null;
    },
  ): Promise<MailboxCommitment | null> {
    const now = Date.now();
    const row = this.db
      .prepare(
        `SELECT
           id,
           thread_id,
           message_id,
           title,
           due_at,
           state,
           owner_email,
           source_excerpt,
           metadata_json,
           created_at,
           updated_at
         FROM mailbox_commitments
         WHERE id = ?`,
      )
      .get(commitmentId) as MailboxCommitmentRow | undefined;
    if (!row) {
      throw new Error("Commitment not found");
    }

    const nextTitle = patch.title?.trim() || row.title;
    const nextDueAt = patch.dueAt === undefined ? row.due_at : patch.dueAt;
    const nextOwnerEmail =
      patch.ownerEmail === undefined ? row.owner_email : patch.ownerEmail?.trim() || null;
    const nextState = patch.state || row.state;
    const nextSourceExcerpt =
      patch.sourceExcerpt === undefined
        ? row.source_excerpt
        : encryptMailboxValue(patch.sourceExcerpt?.trim() || null);
    const metadata = parseCommitmentMetadata(row.metadata_json);

    if (nextState === "accepted") {
      const followUpTask = this.ensureFollowUpTaskForCommitment(
        {
          ...row,
          due_at: nextDueAt || null,
          title: nextTitle,
          owner_email: nextOwnerEmail || null,
          source_excerpt: nextSourceExcerpt || null,
        },
        metadata,
      );
      if (followUpTask && nextDueAt != null) {
        this.taskRepo.update(followUpTask.id, {
          dueDate: nextDueAt,
        });
      }
    }

    this.db
      .prepare(
        `UPDATE mailbox_commitments
         SET title = ?, due_at = ?, state = ?, owner_email = ?, source_excerpt = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(nextTitle, nextDueAt || null, nextState, nextOwnerEmail || null, nextSourceExcerpt || null, now, commitmentId);

    const updated = this.db
      .prepare(
        `SELECT
           id,
           thread_id,
           message_id,
           title,
           due_at,
           state,
           owner_email,
           source_excerpt,
           metadata_json,
           created_at,
           updated_at
         FROM mailbox_commitments
         WHERE id = ?`,
      )
      .get(commitmentId) as MailboxCommitmentRow | undefined;
    if (!updated) return null;

    this.updateContactOpenCommitments(updated.thread_id);
    const mapped = this.mapCommitmentRow(updated);
    this.emitMailboxEvent({
      type: "commitment_updated",
      threadId: updated.thread_id,
      subject: mapped.title,
      summary: `Commitment updated: ${mapped.title}`,
      evidenceRefs: [mapped.id, updated.thread_id],
      payload: {
        commitmentId: mapped.id,
        title: mapped.title,
        state: mapped.state,
        dueAt: mapped.dueAt || null,
        ownerEmail: mapped.ownerEmail || null,
      },
    });
    return mapped;
  }

  async proposeCleanup(limit = 20): Promise<MailboxActionProposal[]> {
    const rows = this.db
      .prepare(
        `SELECT
           id,
           account_id,
           provider,
           provider_thread_id,
           subject,
           snippet,
           participants_json,
           labels_json,
           category,
           today_bucket,
           domain_category,
           classification_rationale,
           priority_score,
           urgency_score,
           needs_reply,
           stale_followup,
           cleanup_candidate,
           handled,
           local_inbox_hidden,
           unread_count,
           message_count,
           last_message_at,
           sensitive_content_json,
           classification_state
         FROM mailbox_threads
         WHERE local_inbox_hidden = 0
           AND (cleanup_candidate = 1 OR (handled = 1 AND category IN ('promotions', 'updates')))
         ORDER BY last_message_at ASC
         LIMIT ?`,
      )
      .all(Math.min(Math.max(limit, 1), 100)) as MailboxThreadRow[];

    for (const row of rows) {
      this.upsertProposal({
        threadId: row.id,
        type: "cleanup",
        title: `Queue cleanup for ${row.subject}`,
        reasoning: "Hide this low-priority handled thread from the Cowork inbox. Use Archive or Trash for a server-side mailbox change.",
        preview: {
          threadId: row.id,
          suggestedAction: "hide from Cowork inbox",
        },
      });
    }

    return rows.flatMap((row) =>
      this.getProposalsForThread(row.id).filter((proposal) => proposal.type === "cleanup"),
    );
  }

  async proposeFollowups(limit = 20): Promise<MailboxActionProposal[]> {
    const rows = this.db
      .prepare(
        `SELECT
           id,
           account_id,
           provider,
           provider_thread_id,
           subject,
           snippet,
           participants_json,
           labels_json,
           category,
           today_bucket,
           domain_category,
           classification_rationale,
           priority_score,
           urgency_score,
           needs_reply,
           stale_followup,
           cleanup_candidate,
           handled,
           local_inbox_hidden,
           unread_count,
           message_count,
           last_message_at,
           sensitive_content_json,
           classification_state
         FROM mailbox_threads
         WHERE local_inbox_hidden = 0
           AND needs_reply = 1
           AND stale_followup = 1
         ORDER BY urgency_score DESC, last_message_at ASC
         LIMIT ?`,
      )
      .all(Math.min(Math.max(limit, 1), 100)) as MailboxThreadRow[];

    for (const row of rows) {
      this.upsertProposal({
        threadId: row.id,
        type: "follow_up",
        title: `Follow up on ${row.subject}`,
        reasoning: "Thread still needs a response and has been waiting long enough to escalate.",
        preview: {
          threadId: row.id,
          lastMessageAt: row.last_message_at,
        },
      });
    }

    return rows.flatMap((row) =>
      this.getProposalsForThread(row.id).filter((proposal) => proposal.type === "follow_up"),
    );
  }

  async reviewBulkAction(input: MailboxBulkReviewInput): Promise<MailboxBulkReviewResult> {
    const proposals =
      input.type === "cleanup"
        ? await this.proposeCleanup(input.limit)
        : await this.proposeFollowups(input.limit);
    return {
      type: input.type,
      proposals,
      count: proposals.length,
    };
  }

  async scheduleReply(threadId: string): Promise<{ threadId: string; suggestions: string[]; summary: string }> {
    const suggestion = await this.getScheduleSuggestion();
    this.upsertProposal({
      threadId,
      type: "schedule",
      title: "Review suggested meeting slots",
      reasoning: suggestion.summary,
      preview: {
        suggestions: suggestion.options.map((option) => option.label),
        slotOptions: suggestion.options,
      },
    });
    return {
      threadId,
      suggestions: suggestion.options.map((option) => option.label),
      summary: suggestion.summary,
    };
  }

  async resolveContactIdentity(threadId: string): Promise<ContactIdentityResolution | null> {
    const detail = await this.getThreadCore(threadId);
    if (!detail) return null;

    const primary = detail.participants[0] || null;
    const workspaceId = this.resolveThreadWorkspaceId(detail.accountId);
    const contactMemory = this.getPrimaryContactMemory(threadId);
    if (!primary?.email || !workspaceId) {
      return {
        identity: null,
        confidence: 0,
        reasonCodes: ["missing_primary_contact"],
        candidates: [],
      };
    }

    const phoneHints = this.collectPhoneHints({
      primaryEmail: primary.email,
      contactMemory,
      messages: detail.messages,
      snippet: detail.snippet,
    });

    return this.contactIdentityService.resolveMailboxContact({
      workspaceId,
      email: primary.email,
      displayName: primary.name,
      companyHint: contactMemory?.company || companyFromEmail(primary.email),
      phoneHints,
      crmHints: contactMemory?.crmLinks || [],
      learnedFacts: contactMemory?.learnedFacts || [],
    });
  }

  getContactIdentity(identityId: string): ContactIdentity | null {
    return this.contactIdentityService.getIdentity(identityId);
  }

  listContactIdentities(workspaceId?: string): ContactIdentity[] {
    return this.contactIdentityService.listIdentities(workspaceId || this.resolveDefaultWorkspaceId());
  }

  listIdentityCandidates(
    workspaceId?: string,
    status?: ContactIdentityCandidate["status"],
  ): ContactIdentityCandidate[] {
    return this.contactIdentityService.listCandidates(workspaceId || this.resolveDefaultWorkspaceId(), status);
  }

  confirmIdentityLink(candidateId: string): ContactIdentityCandidate | null {
    return this.contactIdentityService.confirmCandidate(candidateId);
  }

  rejectIdentityLink(candidateId: string): ContactIdentityCandidate | null {
    return this.contactIdentityService.rejectCandidate(candidateId);
  }

  unlinkIdentityHandle(handleId: string): boolean {
    return this.contactIdentityService.unlinkHandle(handleId);
  }

  searchIdentityLinkTargets(workspaceId: string, query: string, limit?: number): ContactIdentitySearchResult[] {
    return this.contactIdentityService.searchLinkTargets(workspaceId, query, limit);
  }

  linkIdentityHandle(input: {
    workspaceId: string;
    contactIdentityId: string;
    handleType: ContactIdentityHandleType;
    normalizedValue: string;
    displayValue: string;
    source?: "mailbox" | "gateway" | "manual" | "crm" | "kg";
    channelId?: string;
    channelType?: string;
    channelUserId?: string;
  }): ContactIdentity | null {
    const handle = this.contactIdentityService.linkManualHandle(input);
    return handle ? this.contactIdentityService.getIdentity(input.contactIdentityId) : null;
  }

  getIdentityCoverageStats(workspaceId?: string): ContactIdentityCoverageStats {
    return this.contactIdentityService.getCoverageStats(workspaceId || this.resolveDefaultWorkspaceId());
  }

  getChannelPreferenceSummary(contactIdentityId: string): ChannelPreferenceSummary {
    return this.contactIdentityService.getChannelPreferenceSummary(contactIdentityId);
  }

  async getReplyTargets(threadId: string): Promise<ContactIdentityReplyTarget[]> {
    const contactResolution = await this.resolveContactIdentity(threadId);
    return contactResolution?.identity?.id
      ? this.contactIdentityService.getReplyTargets(contactResolution.identity.id)
      : [];
  }

  async getRelationshipTimeline(query: RelationshipTimelineQuery): Promise<RelationshipTimelineEvent[]> {
    if (query.contactIdentityId) {
      return this.contactIdentityService.getTimeline(query);
    }
    if (query.threadId) {
      const resolution = await this.resolveContactIdentity(query.threadId);
      if (!resolution?.identity?.id) return [];
      return this.contactIdentityService.getTimeline({
        ...query,
        contactIdentityId: resolution.identity.id,
      });
    }
    if (query.companyHint) {
      const workspaceId = this.resolveDefaultWorkspaceId();
      const match = workspaceId
        ? this.contactIdentityService.findIdentityByCompanyHint(workspaceId, query.companyHint)
        : null;
      if (match?.id) {
        return this.contactIdentityService.getTimeline({
          ...query,
          contactIdentityId: match.id,
        });
      }
    }
    return [];
  }

  async researchContact(threadId: string): Promise<MailboxResearchResult | null> {
    const detail = await this.getThreadCore(threadId);
    if (!detail) return null;
    const noReplySender = getMailboxNoReplySender(detail.messages, detail.participants);

    const primary = detail.participants[0] || null;
    const domain = primary?.email?.split("@")[1];
    const company = companyFromEmail(primary?.email);
    const contactMemory = this.getPrimaryContactMemory(threadId);
    const resolution = await this.resolveContactIdentity(threadId);
    const identity = resolution?.identity || null;
    const channelPreference =
      identity?.id && (identity.handles.some((handle) => handle.handleType !== "email") || (resolution?.confidence || 0) >= 0.86)
        ? this.contactIdentityService.getChannelPreferenceSummary(identity.id)
        : undefined;
    const unifiedTimeline =
      identity?.id && (identity.handles.some((handle) => handle.handleType !== "email") || (resolution?.confidence || 0) >= 0.86)
        ? this.contactIdentityService.getTimeline({
            threadId,
            contactIdentityId: identity.id,
            limit: 12,
          })
        : [];
    const scopedRelationshipItems =
      identity?.id || contactMemory?.company
        ? RelationshipMemoryService.listItems({
            includeDone: false,
            limit: 8,
            contactIdentityId: identity?.id,
            companyId: contactMemory?.company,
          })
        : [];
    const relationshipSummary = [
      contactMemory?.responseTendency,
      typeof contactMemory?.averageResponseHours === "number"
        ? `Average response time: ${contactMemory.averageResponseHours.toFixed(1)}h`
        : null,
      contactMemory?.openCommitments ? `${contactMemory.openCommitments} open commitment(s)` : null,
      scopedRelationshipItems[0]?.text ? `Memory: ${scopedRelationshipItems[0].text}` : null,
    ]
      .filter((entry): entry is string => Boolean(entry))
      .join(" · ");
    const nextSteps = [
      detail.needsReply && !noReplySender ? "Generate or review a reply draft." : null,
      detail.category === "calendar" ? "Choose one of the proposed time slots and create the event." : null,
      detail.cleanupCandidate ? "Archive or trash after confirming no action is needed." : null,
      !detail.summary && !noReplySender ? "Generate an AI summary before replying." : null,
    ].filter((entry): entry is string => Boolean(entry));

    const result: MailboxResearchResult = {
      primaryContact: primary,
      company,
      domain,
      crmHints: contactMemory?.crmLinks || [],
      learnedFacts: contactMemory?.learnedFacts || [],
      recommendedQueries: [
        primary?.email ? `"${primary.email}"` : undefined,
        company ? `${company} leadership` : undefined,
        domain ? `site:${domain} team` : undefined,
        detail.subject ? `"${detail.subject}" ${company || domain || ""}`.trim() : undefined,
      ].filter((entry): entry is string => Boolean(entry)),
      relationshipSummary: relationshipSummary || undefined,
      styleSignals: contactMemory?.styleSignals,
      recentSubjects: contactMemory?.recentSubjects,
      recentOutboundExample: contactMemory?.recentOutboundExample,
      nextSteps,
      relatedEntities: contactMemory?.learnedFacts?.slice(0, 3),
      contactIdentityId: identity?.id,
      identityConfidence: resolution?.confidence,
      linkedChannels: identity?.handles
        .filter((handle) => handle.handleType !== "email")
        .map((handle) => ({
          handleId: handle.id,
          handleType: handle.handleType,
          label: handle.displayValue,
          channelType: handle.channelType,
        })),
      channelPreference,
      unifiedTimeline,
      identityCandidates: (resolution?.candidates || []).slice(0, 6),
      replyTargets: identity?.id ? this.contactIdentityService.getReplyTargets(identity.id) : [],
    };
    this.emitMailboxEvent({
      type: "contact_researched",
      threadId,
      accountId: detail.accountId,
      provider: detail.provider,
      subject: detail.subject,
      summary: relationshipSummary || company || primary?.email || "Contact researched",
      evidenceRefs: [threadId],
      payload: {
        company,
        domain,
        crmHintCount: result.crmHints.length,
        learnedFactCount: result.learnedFacts.length,
        relatedEntities: result.relatedEntities || [],
        primaryContactEmail: primary?.email,
        primaryContactName: primary?.name,
        senderName: primary?.name,
        contactIdentityId: identity?.id,
        linkedChannelCount: result.linkedChannels?.length || 0,
      },
    });
    return result;
  }

  async applyAction(input: MailboxApplyActionInput): Promise<{ success: boolean; action: string; threadId?: string }> {
    if (input.type === "dismiss_proposal" && input.proposalId) {
      this.updateProposalStatus(input.proposalId, "dismissed");
      const dismissThreadId = input.threadId || this.threadIdFromProposal(input.proposalId);
      if (dismissThreadId) {
        this.recordMailboxTriageFeedback(dismissThreadId, "dismiss_proposal");
      }
      return { success: true, action: input.type };
    }

    const threadId = input.threadId || this.threadIdFromProposal(input.proposalId);
    if (!threadId) {
      throw new Error("Missing threadId or proposalId for mailbox action");
    }

    const thread = await this.getThreadCore(threadId);
    if (!thread) {
      throw new Error("Mailbox thread not found");
    }
    const primaryContact = thread.participants[0];

    switch (input.type) {
      case "cleanup_local":
        this.applyLocalCleanup(thread);
        break;
      case "mark_done":
        await this.applyMarkDone(thread);
        break;
      case "archive":
        await this.applyArchive(thread);
        break;
      case "trash":
        await this.applyTrash(thread);
        break;
      case "mark_read":
        await this.applyMarkRead(thread);
        break;
      case "mark_unread":
        await this.applyMarkUnread(thread);
        break;
      case "move":
        if (!input.folderId) throw new Error("Missing folder for move action");
        this.enqueueMailboxAction({
          accountId: thread.accountId,
          threadId: thread.id,
          type: "move",
          payload: { folderId: input.folderId },
        });
        break;
      case "label":
        if (!input.label) throw new Error("Missing label for label action");
        await this.applyLabel(thread, input.label);
        break;
      case "remove_label":
        if (!input.label && !input.labelId) throw new Error("Missing label for remove label action");
        this.enqueueMailboxAction({
          accountId: thread.accountId,
          threadId: thread.id,
          type: "remove_label",
          payload: { label: input.label, labelId: input.labelId },
        });
        break;
      case "snooze":
        if (!input.snoozeUntil) throw new Error("Missing snooze time");
        this.enqueueMailboxAction({
          accountId: thread.accountId,
          threadId: thread.id,
          type: "snooze",
          payload: { snoozeUntil: input.snoozeUntil },
          nextAttemptAt: input.snoozeUntil,
        });
        this.db.prepare("UPDATE mailbox_threads SET handled = 1, updated_at = ? WHERE id = ?").run(Date.now(), thread.id);
        break;
      case "waiting_on":
        this.enqueueMailboxAction({
          accountId: thread.accountId,
          threadId: thread.id,
          type: "waiting_on",
          payload: { commitmentId: input.commitmentId },
        });
        this.db
          .prepare("UPDATE mailbox_threads SET needs_reply = 0, handled = 1, today_bucket = 'good_to_know', updated_at = ? WHERE id = ?")
          .run(Date.now(), thread.id);
        break;
      case "undo":
        if (!input.actionId) throw new Error("Missing action id for undo");
        await this.undoMailboxAction(input.actionId);
        break;
      case "send_message":
        await this.applySendMessage(thread, {
          mode: input.messageMode || "reply",
          to: input.messageTo || [],
          cc: input.messageCc || [],
          bcc: input.messageBcc || [],
          subject: input.messageSubject,
          body: input.messageBody,
        });
        break;
      case "send_draft":
        await this.applySendDraft(thread, input.draftId, {
          subject: input.draftSubject,
          body: input.draftBody,
        });
        break;
      case "discard_draft":
        await this.applyDiscardDraft(thread, input.draftId);
        break;
      case "schedule_event":
        await this.applyScheduleEvent(thread, input.proposalId);
        break;
      default:
        throw new Error(`Unsupported mailbox action: ${input.type}`);
    }

    if (input.proposalId) {
      this.updateProposalStatus(input.proposalId, "applied");
    }

    this.emitMailboxEvent({
      type: "action_applied",
      threadId,
      accountId: thread.accountId,
      provider: thread.provider,
      subject: thread.subject,
      summary: `Action applied: ${input.type}`,
      evidenceRefs: [threadId, input.proposalId || input.draftId || input.commitmentId].filter(
        (entry): entry is string => Boolean(entry),
      ),
      payload: {
        actionType: input.type,
        proposalId: input.proposalId || null,
        draftId: input.draftId || null,
        commitmentId: input.commitmentId || null,
        label: input.label || null,
        primaryContactEmail: primaryContact?.email,
        primaryContactName: primaryContact?.name,
        senderName: primaryContact?.name,
        company: companyFromEmail(primaryContact?.email),
      },
    });

    if (
      input.type === "archive" ||
      input.type === "trash" ||
      input.type === "mark_read" ||
      input.type === "mark_unread" ||
      input.type === "mark_done" ||
      input.type === "label" ||
      input.type === "cleanup_local" ||
      input.type === "send_message" ||
      input.type === "send_draft"
    ) {
      this.recordMailboxTriageFeedback(threadId, input.type);
    }

    return {
      success: true,
      action: input.type,
      threadId,
    };
  }

  private async syncGmail(limit: number): Promise<{
    account: MailboxAccount;
    syncedThreads: number;
    syncedMessages: number;
  } | null> {
    const settings = GoogleWorkspaceSettingsManager.loadSettings();
    if (!settings.enabled) return null;

    const profileResult = await gmailRequest(settings, {
      method: "GET",
      path: "/users/me/profile",
    });
    const emailAddress = asString(profileResult.data?.emailAddress);
    if (!emailAddress) return null;

    const accountId = `gmail:${emailAddress.toLowerCase()}`;
    const now = Date.now();
    const existingAccount = this.db
      .prepare(
        `SELECT classification_initial_batch_at
         FROM mailbox_accounts
         WHERE id = ?`,
      )
      .get(accountId) as { classification_initial_batch_at: number | null } | undefined;
    const initialClassificationNeeded = !existingAccount?.classification_initial_batch_at;
    this.upsertAccount({
      id: accountId,
      provider: "gmail",
      address: emailAddress.toLowerCase(),
      displayName: emailAddress,
      status: "connected",
      capabilities: ["sync", "provider_search", "realtime", "send", "provider_drafts", "reply_all", "forward", "attachments_download", "attachments_upload", "archive", "trash", "mark_read", "mark_unread", "labels", "undo_send"],
      backend: "gmail_api",
      lastSyncedAt: now,
    });

    const listResult = await gmailRequest(settings, {
      method: "GET",
      path: "/users/me/messages",
      query: {
        maxResults: Math.min(Math.max(limit, 5), 50),
        q: "newer_than:30d",
      },
    });

    const messageRefs = (Array.isArray(listResult.data?.messages) ? listResult.data.messages : []) as Array<{
      threadId?: unknown;
    }>;
    const threadIds = Array.from(
      new Set(
        messageRefs
          .map((entry: Any) => asString(entry?.threadId))
          .filter((entry): entry is string => Boolean(entry)),
      ),
    ).slice(0, limit);

    const classificationCandidates: string[] = [];
    let syncedMessages = 0;
    let processedThreads = 0;
    this.updateSyncProgress({
      phase: "ingesting",
      accountId,
      totalThreads: threadIds.length,
      processedThreads: 0,
      totalMessages: 0,
      processedMessages: 0,
      newThreads: 0,
      classifiedThreads: 0,
      skippedThreads: 0,
      label:
        threadIds.length > 0
          ? `Syncing 0/${threadIds.length} thread${threadIds.length === 1 ? "" : "s"}...`
          : "No new threads found",
    });

    for (const threadId of threadIds) {
      const threadResult = await gmailRequest(settings, {
        method: "GET",
        path: `/users/me/threads/${threadId}`,
        query: {
          format: "full",
        },
      });
      const normalized = this.normalizeGmailThread(accountId, emailAddress.toLowerCase(), threadResult.data);
      if (!normalized) continue;
      const upsertResult = this.upsertThread(normalized);
      if (upsertResult.shouldClassify) {
        classificationCandidates.push(normalized.id);
      }
      syncedMessages += normalized.messages.length;
      processedThreads += 1;
      this.updateSyncProgress({
        phase: "ingesting",
        accountId,
        totalThreads: threadIds.length,
        processedThreads,
        totalMessages: Math.max(syncedMessages, processedThreads),
        processedMessages: syncedMessages,
        newThreads: classificationCandidates.length,
        classifiedThreads: 0,
        skippedThreads: Math.max(0, threadIds.length - processedThreads),
        label:
          threadIds.length > 0
            ? `Syncing ${processedThreads}/${threadIds.length} thread${threadIds.length === 1 ? "" : "s"} · ${syncedMessages} message${syncedMessages === 1 ? "" : "s"}`
            : "No new threads found",
      });
    }

    if (initialClassificationNeeded) {
      this.updateSyncProgress({
        phase: "classifying",
        accountId,
        totalThreads: threadIds.length,
        processedThreads,
        totalMessages: syncedMessages,
        processedMessages: syncedMessages,
        newThreads: classificationCandidates.length,
        classifiedThreads: 0,
        skippedThreads: 0,
        label:
          classificationCandidates.length > 0
            ? `Classifying initial batch of ${classificationCandidates.length} thread${classificationCandidates.length === 1 ? "" : "s"}`
            : "Initial classification complete",
      });
      await this.classifyMailboxThreadsForAccount(accountId, {
        limit: MAILBOX_CLASSIFIER_MAX_BATCH,
      });
    } else if (classificationCandidates.length > 0) {
      let classifiedThreads = 0;
      this.updateSyncProgress({
        phase: "classifying",
        accountId,
        totalThreads: threadIds.length,
        processedThreads,
        totalMessages: syncedMessages,
        processedMessages: syncedMessages,
        newThreads: classificationCandidates.length,
        classifiedThreads: 0,
        skippedThreads: 0,
        label: `Classifying ${classificationCandidates.length} new thread${classificationCandidates.length === 1 ? "" : "s"}...`,
      });
      for (const candidateThreadId of classificationCandidates) {
        await this.classifyThreadById(candidateThreadId);
        classifiedThreads += 1;
        this.updateSyncProgress({
          phase: "classifying",
          accountId,
          totalThreads: threadIds.length,
          processedThreads,
          totalMessages: syncedMessages,
          processedMessages: syncedMessages,
          newThreads: classificationCandidates.length,
          classifiedThreads,
          skippedThreads: 0,
          label:
            classifiedThreads < classificationCandidates.length
              ? `Classifying ${classifiedThreads}/${classificationCandidates.length} new thread${classificationCandidates.length === 1 ? "" : "s"}...`
              : `Classified ${classificationCandidates.length} new thread${classificationCandidates.length === 1 ? "" : "s"}`,
        });
      }
    } else {
      this.updateSyncProgress({
        phase: "done",
        accountId,
        totalThreads: threadIds.length,
        processedThreads,
        totalMessages: syncedMessages,
        processedMessages: syncedMessages,
        newThreads: 0,
        classifiedThreads: 0,
        skippedThreads: 0,
        label:
          threadIds.length > 0
            ? `Synced ${threadIds.length} thread${threadIds.length === 1 ? "" : "s"} and ${syncedMessages} message${syncedMessages === 1 ? "" : "s"}`
          : "Mailbox sync complete",
      });
    }

    this.updateSyncProgress({
      phase: "done",
      accountId,
      totalThreads: threadIds.length,
      processedThreads,
      totalMessages: syncedMessages,
      processedMessages: syncedMessages,
      newThreads: classificationCandidates.length,
      classifiedThreads: classificationCandidates.length,
      skippedThreads: 0,
      label:
        threadIds.length > 0
          ? `Synced ${threadIds.length} thread${threadIds.length === 1 ? "" : "s"} and ${syncedMessages} message${syncedMessages === 1 ? "" : "s"}`
          : "Mailbox sync complete",
    });

    return {
      account: this.mapAccountRow(
        this.db
          .prepare(
            `SELECT id, provider, address, display_name, status, capabilities_json, classification_initial_batch_at, last_synced_at
             FROM mailbox_accounts WHERE id = ?`,
          )
          .get(accountId) as MailboxAccountRow,
      ),
      syncedThreads: threadIds.length,
      syncedMessages,
    };
  }

  private normalizeGmailThread(
    accountId: string,
    accountEmail: string,
    thread: Any,
  ): NormalizedThreadInput | null {
    const threadId = asString(thread?.id);
    const messagesRaw = Array.isArray(thread?.messages) ? thread.messages : [];
    if (!threadId || messagesRaw.length === 0) return null;

    const messages: NormalizedMailboxMessage[] = messagesRaw.map(
      (message: Any): NormalizedMailboxMessage => {
        const payload = asObject(message?.payload) || {};
        const headers = Array.isArray(payload.headers) ? payload.headers : [];
        const subject = extractGmailHeader(headers, "Subject") || "(No subject)";
        const fromRaw = extractGmailHeader(headers, "From");
        const toRaw = extractGmailHeader(headers, "To");
        const ccRaw = extractGmailHeader(headers, "Cc");
        const bccRaw = extractGmailHeader(headers, "Bcc");
        const internalDate = Number(message?.internalDate || Date.now());
        const body = extractGmailBody(payload);
        const bodyHtml = extractGmailHtml(payload) || undefined;
        const snippet = normalizeWhitespace(asString(message?.snippet) || body || subject, 260);
        const fromEmail = normalizeEmailAddress(fromRaw);
        const direction = fromEmail === accountEmail ? "outgoing" : "incoming";
        const providerMessageId = asString(message?.id) || randomUUID();
        return {
          id: `gmail-message:${providerMessageId}`,
          providerMessageId,
          direction,
          from: fromEmail
            ? {
                email: fromEmail,
                name: extractDisplayName(fromRaw || undefined),
              }
            : undefined,
          to: parseAddressList(toRaw),
          cc: parseAddressList(ccRaw),
          bcc: parseAddressList(bccRaw),
          subject,
          snippet,
          body,
          bodyHtml,
          attachments: extractGmailAttachments(payload, providerMessageId),
          receivedAt: Number.isFinite(internalDate) ? internalDate : Date.now(),
          unread: Array.isArray(message?.labelIds) ? message.labelIds.includes("UNREAD") : false,
        };
      },
    );
    messages.sort((a: NormalizedMailboxMessage, b: NormalizedMailboxMessage) => a.receivedAt - b.receivedAt);

    const latest = messages[messages.length - 1];
    const labels = Array.isArray(messagesRaw[messagesRaw.length - 1]?.labelIds)
      ? (messagesRaw[messagesRaw.length - 1].labelIds as string[])
      : [];
    const participants = uniqueParticipants(
      messages.flatMap((message) => [
        ...(message.from ? [message.from] : []),
        ...message.to,
        ...message.cc,
      ]),
    ).filter((participant) => participant.email !== accountEmail);
    const unreadCount = messages.filter((message) => message.unread).length;
    const category: MailboxThreadCategory = "other";
    const needsReply = false;
    const cleanupCandidate = false;
    const scoring = {
      priorityScore: clampScore(unreadCount > 0 ? 25 : 5),
      urgencyScore: clampScore(unreadCount > 0 ? 10 : 0),
      staleFollowup: false,
      handled: unreadCount === 0,
    };

    return {
      id: `gmail-thread:${threadId}`,
      accountId,
      provider: "gmail",
      providerThreadId: threadId,
      subject: latest.subject,
      snippet: latest.snippet,
      participants,
      labels,
      category,
      priorityScore: scoring.priorityScore,
      urgencyScore: scoring.urgencyScore,
      needsReply,
      staleFollowup: scoring.staleFollowup,
      cleanupCandidate,
      handled: scoring.handled,
      unreadCount,
      lastMessageAt: latest.receivedAt,
      messages,
    };
  }

  private async syncImap(limit: number): Promise<{
    account: MailboxAccount;
    syncedThreads: number;
    syncedMessages: number;
  } | null> {
    const channel = this.channelRepo.findByType("email");
    if (!channel || !channel.enabled) return null;
    const cfg = (channel.config as Any) || {};
    const protocol = asString(cfg.protocol) === "loom" ? "loom" : "imap-smtp";
    const now = Date.now();

    if (protocol === "loom") {
      const loomBaseUrl = asString(cfg.loomBaseUrl);
      const accessToken = asString(cfg.loomAccessToken);
      const identity = asString(cfg.loomIdentity) || loomBaseUrl;
      if (!loomBaseUrl || !accessToken || !identity) return null;
      const mailbox = asString(cfg.loomMailboxFolder) || "INBOX";
      const client = new LoomEmailClient({
        baseUrl: loomBaseUrl,
        accessTokenProvider: () => accessToken,
        identity,
        folder: assertSafeLoomMailboxFolder(mailbox),
        pollInterval: asNumber(cfg.loomPollInterval) ?? 30000,
        verbose: process.env.NODE_ENV === "development",
      });
      const messages = await client.fetchRecentEmails(Math.min(Math.max(limit, 5), 50));
      const accountId = `imap:${identity.toLowerCase()}`;
      const existingAccount = this.db
        .prepare(
          `SELECT classification_initial_batch_at
           FROM mailbox_accounts
           WHERE id = ?`,
        )
        .get(accountId) as { classification_initial_batch_at: number | null } | undefined;
      const initialClassificationNeeded = !existingAccount?.classification_initial_batch_at;
      this.upsertAccount({
        id: accountId,
        provider: "imap",
        address: identity.toLowerCase(),
        displayName: identity,
        status: "connected",
        capabilities: ["send", "mark_read"],
        lastSyncedAt: now,
      });
      const threads = this.normalizeImapThreads(accountId, identity.toLowerCase(), messages);
      const classificationCandidates: string[] = [];
      let processedThreads = 0;
      let processedMessages = 0;
      this.updateSyncProgress({
        phase: "ingesting",
        accountId,
        totalThreads: threads.length,
        processedThreads: 0,
        totalMessages: messages.length,
        processedMessages: 0,
        newThreads: 0,
        classifiedThreads: 0,
        skippedThreads: 0,
        label:
          threads.length > 0
            ? `Syncing 0/${threads.length} thread${threads.length === 1 ? "" : "s"}...`
            : "No new threads found",
      });
      for (const thread of threads) {
        const upsertResult = this.upsertThread(thread);
        if (upsertResult.shouldClassify) {
          classificationCandidates.push(thread.id);
        }
        processedThreads += 1;
        processedMessages += thread.messages.length;
        this.updateSyncProgress({
          phase: "ingesting",
          accountId,
          totalThreads: threads.length,
          processedThreads,
          totalMessages: messages.length,
          processedMessages,
          newThreads: classificationCandidates.length,
          classifiedThreads: 0,
          skippedThreads: Math.max(0, threads.length - processedThreads),
          label:
            threads.length > 0
              ? `Syncing ${processedThreads}/${threads.length} thread${threads.length === 1 ? "" : "s"} · ${processedMessages} message${processedMessages === 1 ? "" : "s"}`
              : "No new threads found",
        });
      }
      if (initialClassificationNeeded) {
        this.updateSyncProgress({
          phase: "classifying",
          accountId,
          totalThreads: threads.length,
          processedThreads,
          totalMessages: messages.length,
          processedMessages,
          newThreads: classificationCandidates.length,
          classifiedThreads: 0,
          skippedThreads: 0,
          label:
            classificationCandidates.length > 0
              ? `Classifying initial batch of ${classificationCandidates.length} thread${classificationCandidates.length === 1 ? "" : "s"}`
              : "Initial classification complete",
        });
        await this.classifyMailboxThreadsForAccount(accountId, {
          limit: MAILBOX_CLASSIFIER_MAX_BATCH,
        });
      } else {
        let classifiedThreads = 0;
        if (classificationCandidates.length > 0) {
          this.updateSyncProgress({
            phase: "classifying",
            accountId,
            totalThreads: threads.length,
            processedThreads,
            totalMessages: messages.length,
            processedMessages,
            newThreads: classificationCandidates.length,
            classifiedThreads: 0,
            skippedThreads: 0,
            label: `Classifying ${classificationCandidates.length} new thread${classificationCandidates.length === 1 ? "" : "s"}...`,
          });
          for (const candidateThreadId of classificationCandidates) {
            await this.classifyThreadById(candidateThreadId);
            classifiedThreads += 1;
            this.updateSyncProgress({
              phase: "classifying",
              accountId,
              totalThreads: threads.length,
              processedThreads,
              totalMessages: messages.length,
              processedMessages,
              newThreads: classificationCandidates.length,
              classifiedThreads,
              skippedThreads: 0,
              label:
                classifiedThreads < classificationCandidates.length
                  ? `Classifying ${classifiedThreads}/${classificationCandidates.length} new thread${classificationCandidates.length === 1 ? "" : "s"}...`
                  : `Classified ${classificationCandidates.length} new thread${classificationCandidates.length === 1 ? "" : "s"}`,
            });
          }
        }
      }
      this.updateSyncProgress({
        phase: "done",
        accountId,
        totalThreads: threads.length,
        processedThreads,
        totalMessages: messages.length,
        processedMessages,
        newThreads: classificationCandidates.length,
        classifiedThreads: classificationCandidates.length,
        skippedThreads: 0,
        label:
          threads.length > 0
            ? `Synced ${threads.length} thread${threads.length === 1 ? "" : "s"} and ${messages.length} message${messages.length === 1 ? "" : "s"}`
            : "Mailbox sync complete",
      });
      return {
        account: this.mapAccountRow(
          this.db
            .prepare(
              `SELECT id, provider, address, display_name, status, capabilities_json, classification_initial_batch_at, last_synced_at
               FROM mailbox_accounts WHERE id = ?`,
            )
            .get(accountId) as MailboxAccountRow,
        ),
        syncedThreads: threads.length,
        syncedMessages: messages.length,
      };
    }

    const email = asString(cfg.email);
    const authMethod = asString(cfg.authMethod) === "oauth" ? "oauth" : "password";
    const password = asString(cfg.password);
    const imapHost = asString(cfg.imapHost);
    const smtpHost = asString(cfg.smtpHost);
    if (!email || !imapHost || !smtpHost) return null;
    if (authMethod === "password" && !password) return null;

    const client = this.createStandardEmailClient(channel.id, cfg);
    const messages = await client.fetchRecentEmails(Math.min(Math.max(limit, 5), 50));
    const accountId = `imap:${email.toLowerCase()}`;
    const existingAccount = this.db
      .prepare(
        `SELECT classification_initial_batch_at
         FROM mailbox_accounts
         WHERE id = ?`,
      )
      .get(accountId) as { classification_initial_batch_at: number | null } | undefined;
    const initialClassificationNeeded = !existingAccount?.classification_initial_batch_at;
    this.upsertAccount({
      id: accountId,
      provider: "imap",
      address: email.toLowerCase(),
      displayName: email,
      status: "connected",
      capabilities: ["send", "mark_read"],
      lastSyncedAt: now,
    });
    const threads = this.normalizeImapThreads(accountId, email.toLowerCase(), messages);
    const classificationCandidates: string[] = [];
    let processedThreads = 0;
    let processedMessages = 0;
    this.updateSyncProgress({
      phase: "ingesting",
      accountId,
      totalThreads: threads.length,
      processedThreads: 0,
      totalMessages: messages.length,
      processedMessages: 0,
      newThreads: 0,
      classifiedThreads: 0,
      skippedThreads: 0,
      label:
        threads.length > 0
          ? `Syncing 0/${threads.length} thread${threads.length === 1 ? "" : "s"}...`
          : "No new threads found",
    });
    for (const thread of threads) {
      const upsertResult = this.upsertThread(thread);
      if (upsertResult.shouldClassify) {
        classificationCandidates.push(thread.id);
      }
      processedThreads += 1;
      processedMessages += thread.messages.length;
      this.updateSyncProgress({
        phase: "ingesting",
        accountId,
        totalThreads: threads.length,
        processedThreads,
        totalMessages: messages.length,
        processedMessages,
        newThreads: classificationCandidates.length,
        classifiedThreads: 0,
        skippedThreads: Math.max(0, threads.length - processedThreads),
        label:
          threads.length > 0
            ? `Syncing ${processedThreads}/${threads.length} thread${threads.length === 1 ? "" : "s"} · ${processedMessages} message${processedMessages === 1 ? "" : "s"}`
            : "No new threads found",
      });
    }
    if (initialClassificationNeeded) {
      this.updateSyncProgress({
        phase: "classifying",
        accountId,
        totalThreads: threads.length,
        processedThreads,
        totalMessages: messages.length,
        processedMessages,
        newThreads: classificationCandidates.length,
        classifiedThreads: 0,
        skippedThreads: 0,
        label:
          classificationCandidates.length > 0
            ? `Classifying initial batch of ${classificationCandidates.length} thread${classificationCandidates.length === 1 ? "" : "s"}`
            : "Initial classification complete",
      });
      await this.classifyMailboxThreadsForAccount(accountId, {
        limit: MAILBOX_CLASSIFIER_MAX_BATCH,
      });
    } else if (classificationCandidates.length > 0) {
      let classifiedThreads = 0;
      this.updateSyncProgress({
        phase: "classifying",
        accountId,
        totalThreads: threads.length,
        processedThreads,
        totalMessages: messages.length,
        processedMessages,
        newThreads: classificationCandidates.length,
        classifiedThreads: 0,
        skippedThreads: 0,
        label: `Classifying ${classificationCandidates.length} new thread${classificationCandidates.length === 1 ? "" : "s"}...`,
      });
      for (const candidateThreadId of classificationCandidates) {
        await this.classifyThreadById(candidateThreadId);
        classifiedThreads += 1;
        this.updateSyncProgress({
          phase: "classifying",
          accountId,
          totalThreads: threads.length,
          processedThreads,
          totalMessages: messages.length,
          processedMessages,
          newThreads: classificationCandidates.length,
          classifiedThreads,
          skippedThreads: 0,
          label:
            classifiedThreads < classificationCandidates.length
              ? `Classifying ${classifiedThreads}/${classificationCandidates.length} new thread${classificationCandidates.length === 1 ? "" : "s"}...`
              : `Classified ${classificationCandidates.length} new thread${classificationCandidates.length === 1 ? "" : "s"}`,
        });
      }
    }

    this.updateSyncProgress({
      phase: "done",
      accountId,
      totalThreads: threads.length,
      processedThreads,
      totalMessages: messages.length,
      processedMessages,
      newThreads: classificationCandidates.length,
      classifiedThreads: classificationCandidates.length,
      skippedThreads: 0,
      label:
        threads.length > 0
          ? `Synced ${threads.length} thread${threads.length === 1 ? "" : "s"} and ${messages.length} message${messages.length === 1 ? "" : "s"}`
          : "Mailbox sync complete",
    });

    return {
      account: this.mapAccountRow(
        this.db
          .prepare(
            `SELECT id, provider, address, display_name, status, capabilities_json, classification_initial_batch_at, last_synced_at
             FROM mailbox_accounts WHERE id = ?`,
          )
          .get(accountId) as MailboxAccountRow,
      ),
      syncedThreads: threads.length,
      syncedMessages: messages.length,
    };
  }

  private normalizeImapThreads(
    accountId: string,
    accountEmail: string,
    messagesRaw: Any[],
  ): NormalizedThreadInput[] {
    const groups = new Map<string, Any[]>();
    for (const message of messagesRaw) {
      const subject = normalizeWhitespace(asString(message?.subject) || "(No subject)", 160);
      const from = normalizeEmailAddress(message?.from);
      const key = `${subject.toLowerCase()}::${from || "unknown"}`;
      const bucket = groups.get(key) || [];
      bucket.push(message);
      groups.set(key, bucket);
    }

    return Array.from(groups.entries()).map(([groupKey, group]: [string, Any[]]) => {
      const normalizedMessages: NormalizedMailboxMessage[] = group.map(
        (message: Any): NormalizedMailboxMessage => {
          const providerMessageId = String(message?.uid || message?.messageId || randomUUID());
          const fromEmail = normalizeEmailAddress(message?.from);
          const bodyHtml = asString(message?.html) || undefined;
          const bodySource =
            asString(message?.text) ||
            (bodyHtml ? stripHtml(bodyHtml) : null) ||
            asString(message?.snippet) ||
            "";
          const body = normalizeWhitespace(bodySource, 4000);
          const subject = normalizeWhitespace(asString(message?.subject) || "(No subject)", 160);
          return {
            id: `imap-message:${providerMessageId}`,
            providerMessageId,
            metadata: {
              imapUid: asNumber(message?.uid) ?? undefined,
              rfcMessageId: asString(message?.messageId) || undefined,
            },
            direction: fromEmail === accountEmail ? ("outgoing" as const) : ("incoming" as const),
            from: fromEmail
              ? {
                  email: fromEmail,
                  name: extractDisplayName(message?.from),
                }
              : undefined,
            to: parseAddressList(message?.to),
            cc: parseAddressList(message?.cc),
            bcc: parseAddressList(message?.bcc),
            subject,
            snippet: normalizeWhitespace(asString(message?.snippet) || body || subject, 260),
            body,
            bodyHtml,
            receivedAt: new Date(message?.date || Date.now()).getTime(),
            unread: !message?.isRead,
          };
        },
      );
      normalizedMessages.sort((a: NormalizedMailboxMessage, b: NormalizedMailboxMessage) => a.receivedAt - b.receivedAt);

      const latest = normalizedMessages[normalizedMessages.length - 1];
      const participants = uniqueParticipants(
        normalizedMessages.flatMap((message) => [
          ...(message.from ? [message.from] : []),
          ...message.to,
        ]),
      ).filter((participant) => participant.email !== accountEmail);
      const unreadCount = normalizedMessages.filter((message) => message.unread).length;
      const category: MailboxThreadCategory = "other";
      const needsReply = false;
      const cleanupCandidate = false;
      const scoring = {
        priorityScore: clampScore(unreadCount > 0 ? 25 : 5),
        urgencyScore: clampScore(unreadCount > 0 ? 10 : 0),
        staleFollowup: false,
        handled: unreadCount === 0,
      };

      return {
        id: `imap-thread:${groupKey}`,
        accountId,
        provider: "imap" as const,
        providerThreadId: groupKey,
        subject: latest.subject,
        snippet: latest.snippet,
        participants,
        labels: [],
        category,
        priorityScore: scoring.priorityScore,
        urgencyScore: scoring.urgencyScore,
        needsReply,
        staleFollowup: scoring.staleFollowup,
        cleanupCandidate,
        handled: scoring.handled,
        unreadCount,
        lastMessageAt: latest.receivedAt,
        messages: normalizedMessages,
      };
    });
  }

  private upsertAccount(account: MailboxAccount): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO mailbox_accounts
          (id, provider, address, display_name, status, capabilities_json, sync_cursor, last_synced_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           provider = excluded.provider,
           address = excluded.address,
           display_name = excluded.display_name,
           status = excluded.status,
           capabilities_json = excluded.capabilities_json,
           last_synced_at = excluded.last_synced_at,
           updated_at = excluded.updated_at`,
      )
      .run(
        account.id,
        account.provider,
        account.address,
        account.displayName || null,
        account.status,
        JSON.stringify(account.capabilities),
        null,
        account.lastSyncedAt || null,
        now,
        now,
      );
  }

  private reconcileMailboxMessageIdentity(
    accountId: string,
    targetThreadId: string,
    targetMessageId: string,
    providerMessageId: string,
  ): void {
    const duplicates = this.db
      .prepare(
        `SELECT m.id, m.thread_id
           FROM mailbox_messages m
           JOIN mailbox_threads t ON t.id = m.thread_id
          WHERE t.account_id = ?
            AND m.provider_message_id = ?
            AND m.id != ?`,
      )
      .all(accountId, providerMessageId, targetMessageId) as Array<{
      id: string;
      thread_id: string;
    }>;

    if (duplicates.length === 0) return;

    const orphanedThreadIds = new Set<string>();
    for (const duplicate of duplicates) {
      this.db.prepare("DELETE FROM mailbox_messages WHERE id = ?").run(duplicate.id);
      if (duplicate.thread_id !== targetThreadId) {
        orphanedThreadIds.add(duplicate.thread_id);
      }
    }

    for (const threadId of orphanedThreadIds) {
      this.deleteThreadIfEmpty(threadId);
    }
  }

  private deleteThreadIfEmpty(threadId: string): void {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM mailbox_messages WHERE thread_id = ?")
      .get(threadId) as { count: number } | undefined;
    if ((row?.count || 0) > 0) return;

    this.db.prepare("DELETE FROM mailbox_summaries WHERE thread_id = ?").run(threadId);
    this.db.prepare("DELETE FROM mailbox_drafts WHERE thread_id = ?").run(threadId);
    this.db.prepare("DELETE FROM mailbox_action_proposals WHERE thread_id = ?").run(threadId);
    this.db.prepare("DELETE FROM mailbox_commitments WHERE thread_id = ?").run(threadId);
    this.db.prepare("DELETE FROM mailbox_events WHERE thread_id = ?").run(threadId);
    this.db.prepare("DELETE FROM mailbox_automations WHERE thread_id = ?").run(threadId);
    this.db.prepare("DELETE FROM mailbox_mission_control_handoffs WHERE thread_id = ?").run(threadId);
    this.db.prepare("DELETE FROM mailbox_threads WHERE id = ?").run(threadId);
  }

  private upsertThread(thread: NormalizedThreadInput): ThreadUpsertResult {
    const now = Date.now();
    const fingerprint = mailboxClassificationFingerprint({
      threadId: thread.id,
      accountId: thread.accountId,
      provider: thread.provider,
      subject: thread.subject,
      snippet: thread.snippet,
      unreadCount: thread.unreadCount,
      participants: thread.participants,
      labels: thread.labels,
      lastMessageAt: thread.lastMessageAt,
      messageCount: thread.messages.length,
      messages: thread.messages.slice(-MAILBOX_CLASSIFIER_MAX_MESSAGES).map((message) => ({
        direction: message.direction,
        from: message.from,
        snippet: message.snippet,
        body: message.bodyHtml ? stripHtml(message.bodyHtml) : message.body,
        receivedAt: message.receivedAt,
        unread: message.unread,
      })),
    });
    const existing = this.db
      .prepare(
        `SELECT
           category,
           priority_score,
           urgency_score,
           needs_reply,
           stale_followup,
           cleanup_candidate,
           handled,
           local_inbox_hidden,
           last_message_at,
           classification_state,
           classification_fingerprint,
           classification_model_key,
           classification_prompt_version,
           classification_confidence,
           classification_updated_at,
           classification_error,
           classification_json /* raw LLM response — debug/replay only, not used in runtime logic */
           ,
           today_bucket,
           domain_category,
           classification_rationale
         FROM mailbox_threads
         WHERE id = ?`,
      )
      .get(thread.id) as
      | {
          category: MailboxThreadCategory;
          priority_score: number;
          urgency_score: number;
          needs_reply: number;
          stale_followup: number;
          cleanup_candidate: number;
          handled: number;
          local_inbox_hidden: number;
          last_message_at: number;
          classification_state: MailboxClassificationState;
          classification_fingerprint: string | null;
          classification_model_key: string | null;
          classification_prompt_version: string | null;
          classification_confidence: number;
          classification_updated_at: number | null;
          classification_error: string | null;
          /** Raw LLM JSON response — stored for debugging/replay only; not used in runtime logic. */
          classification_json: string | null;
          today_bucket: MailboxTodayBucket;
          domain_category: MailboxDomainCategory;
          classification_rationale: string | null;
        }
      | undefined;
    const isNewThread = !existing;
    const keepExistingClassification = existing?.classification_state === "classified";
    const preserveBackfillState =
      !keepExistingClassification &&
      existing?.classification_state === "backfill_pending" &&
      existing.classification_fingerprint === fingerprint;
    const nextClassificationState: MailboxClassificationState = keepExistingClassification
      ? "classified"
      : preserveBackfillState
        ? "backfill_pending"
        : "pending";
    const classificationValues = keepExistingClassification || preserveBackfillState ? existing : null;
    const shouldClassify = !existing || existing.classification_state !== "classified";
    const preserveLocalInboxHidden =
      existing?.local_inbox_hidden === 1 && thread.lastMessageAt <= existing.last_message_at;
    const sensitiveContent = this.createThreadSensitiveContent([
      thread.subject,
      thread.snippet,
      ...thread.messages.map((message) => message.bodyHtml ? stripHtml(message.bodyHtml) : message.body),
    ]);
    const baseText = `${thread.subject} ${thread.snippet} ${thread.messages.map((message) => message.body).join(" ")}`;
    const fallbackDomainCategory = deriveDomainCategoryFromText(baseText, classificationValues?.category || thread.category);
    const fallbackTodayBucket = deriveTodayBucket({
      category: classificationValues?.category || thread.category,
      domainCategory: fallbackDomainCategory,
      needsReply: Boolean(classificationValues?.needs_reply ?? thread.needsReply),
      priorityScore: classificationValues?.priority_score ?? thread.priorityScore,
      urgencyScore: classificationValues?.urgency_score ?? thread.urgencyScore,
      cleanupCandidate: Boolean(classificationValues?.cleanup_candidate ?? thread.cleanupCandidate),
      handled: Boolean(classificationValues?.handled ?? thread.handled),
      text: baseText,
    });

    this.db
      .prepare(
        `INSERT INTO mailbox_threads
          (id, account_id, provider_thread_id, provider, subject, snippet, participants_json, labels_json, category, today_bucket, domain_category, classification_rationale, priority_score, urgency_score, needs_reply, stale_followup, cleanup_candidate, handled, local_inbox_hidden, unread_count, message_count, last_message_at, last_synced_at, classification_state, classification_fingerprint, classification_model_key, classification_prompt_version, classification_confidence, classification_updated_at, classification_error, classification_json, sensitive_content_json, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           account_id = excluded.account_id,
           provider_thread_id = excluded.provider_thread_id,
           provider = excluded.provider,
           subject = excluded.subject,
           snippet = excluded.snippet,
           participants_json = excluded.participants_json,
           labels_json = excluded.labels_json,
           category = excluded.category,
           today_bucket = excluded.today_bucket,
           domain_category = excluded.domain_category,
           classification_rationale = excluded.classification_rationale,
           priority_score = excluded.priority_score,
           urgency_score = excluded.urgency_score,
           needs_reply = excluded.needs_reply,
           stale_followup = excluded.stale_followup,
           cleanup_candidate = excluded.cleanup_candidate,
           handled = excluded.handled,
           local_inbox_hidden = excluded.local_inbox_hidden,
           unread_count = excluded.unread_count,
           message_count = excluded.message_count,
           last_message_at = excluded.last_message_at,
           last_synced_at = excluded.last_synced_at,
           classification_state = excluded.classification_state,
           classification_fingerprint = excluded.classification_fingerprint,
           classification_model_key = excluded.classification_model_key,
           classification_prompt_version = excluded.classification_prompt_version,
           classification_confidence = excluded.classification_confidence,
           classification_updated_at = excluded.classification_updated_at,
           classification_error = excluded.classification_error,
           classification_json = excluded.classification_json,
           sensitive_content_json = excluded.sensitive_content_json,
           metadata_json = excluded.metadata_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        thread.id,
        thread.accountId,
        thread.providerThreadId,
        thread.provider,
        thread.subject,
        thread.snippet,
        JSON.stringify(thread.participants),
        JSON.stringify(thread.labels),
        classificationValues?.category || thread.category,
        classificationValues?.today_bucket || fallbackTodayBucket,
        classificationValues?.domain_category || fallbackDomainCategory,
        classificationValues?.classification_rationale || null,
        classificationValues?.priority_score ?? thread.priorityScore,
        classificationValues?.urgency_score ?? thread.urgencyScore,
        classificationValues?.needs_reply ?? (thread.needsReply ? 1 : 0),
        classificationValues?.stale_followup ?? (thread.staleFollowup ? 1 : 0),
        classificationValues?.cleanup_candidate ?? (thread.cleanupCandidate ? 1 : 0),
        classificationValues?.handled ?? (thread.handled ? 1 : 0),
        preserveLocalInboxHidden ? 1 : 0,
        thread.unreadCount,
        thread.messages.length,
        thread.lastMessageAt,
        now,
        nextClassificationState,
        fingerprint,
        classificationValues?.classification_model_key || null,
        classificationValues?.classification_prompt_version || null,
        classificationValues?.classification_confidence ?? 0,
        classificationValues?.classification_updated_at || null,
        classificationValues?.classification_error || null,
        classificationValues?.classification_json || null,
        JSON.stringify(sensitiveContent),
        JSON.stringify({
          priorityBand: priorityBandFromScore(classificationValues?.priority_score ?? thread.priorityScore),
        }),
        now,
        now,
      );

    for (const message of thread.messages) {
      this.reconcileMailboxMessageIdentity(
        thread.accountId,
        thread.id,
        message.id,
        message.providerMessageId,
      );
      this.db
        .prepare(
          `INSERT INTO mailbox_messages
            (id, thread_id, provider_message_id, direction, from_name, from_email, to_json, cc_json, bcc_json, subject, snippet, body_text, body_html, received_at, is_unread, metadata_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             provider_message_id = excluded.provider_message_id,
             direction = excluded.direction,
             from_name = excluded.from_name,
             from_email = excluded.from_email,
             to_json = excluded.to_json,
             cc_json = excluded.cc_json,
             bcc_json = excluded.bcc_json,
             subject = excluded.subject,
             snippet = excluded.snippet,
             body_text = excluded.body_text,
             body_html = excluded.body_html,
             received_at = excluded.received_at,
             is_unread = excluded.is_unread,
             metadata_json = excluded.metadata_json,
             updated_at = excluded.updated_at`,
        )
        .run(
          message.id,
          thread.id,
          message.providerMessageId,
          message.direction,
          message.from?.name || null,
          message.from?.email || null,
          JSON.stringify(message.to),
          JSON.stringify(message.cc),
          JSON.stringify(message.bcc),
          message.subject,
          message.snippet,
          encryptMailboxValue(message.body),
          encryptMailboxValue(message.bodyHtml || null),
          message.receivedAt,
          message.unread ? 1 : 0,
          JSON.stringify(message.metadata || {}),
          now,
          now,
        );
      this.upsertMessageSearchIndex(thread, message);
      this.upsertMessageAttachments(thread, message, now);
    }

    this.upsertPrimaryContact(thread);
    RelationshipMemoryService.rememberMailboxInsights({
      facts: thread.participants
        .slice(0, 1)
        .map((participant) => `Recent email contact: ${participant.name || participant.email}`),
    });
    if (keepExistingClassification) {
      this.refreshThreadProposals({
        id: thread.id,
        subject: thread.subject,
        needsReply: Boolean(classificationValues?.needs_reply),
        cleanupCandidate: Boolean(classificationValues?.cleanup_candidate),
        staleFollowup: Boolean(classificationValues?.stale_followup),
        category: classificationValues?.category || thread.category,
      });
    } else {
      this.db
      .prepare(
          `DELETE FROM mailbox_action_proposals
           WHERE thread_id = ?
             AND status = 'suggested'
             AND proposal_type IN ('reply', 'cleanup', 'follow_up', 'schedule')`,
        )
        .run(thread.id);
    }

    return {
      shouldClassify,
      isNewThread,
    };
  }

  private upsertMessageSearchIndex(thread: NormalizedThreadInput, message: NormalizedMailboxMessage): void {
    try {
      this.db
        .prepare(`DELETE FROM mailbox_search_fts WHERE record_type = 'message' AND record_id = ?`)
        .run(message.id);
      this.db
        .prepare(
          `INSERT INTO mailbox_search_fts
             (record_type, record_id, thread_id, message_id, attachment_id, subject, sender, body, attachment_filename, attachment_text)
           VALUES ('message', ?, ?, ?, NULL, ?, ?, ?, '', '')`,
        )
        .run(
          message.id,
          thread.id,
          message.id,
          message.subject || thread.subject,
          [message.from?.name, message.from?.email].filter(Boolean).join(" "),
          `${message.snippet || ""}\n${message.bodyHtml ? stripHtml(message.bodyHtml) : message.body || ""}`,
        );
    } catch {
      // FTS is optional; mailbox search falls back to row scanning.
    }
  }

  private ensureMailboxSearchIndexBackfilled(): void {
    if (this.mailboxSearchIndexBackfillAttempted) return;
    this.mailboxSearchIndexBackfillAttempted = true;

    try {
      const messageRows = this.db
        .prepare(
          `SELECT
             m.id,
             m.thread_id,
             m.from_name,
             m.from_email,
             m.subject,
             m.snippet,
             m.body_text,
             m.body_html,
             t.subject AS thread_subject
           FROM mailbox_messages m
           INNER JOIN mailbox_threads t ON t.id = m.thread_id
           WHERE NOT EXISTS (
             SELECT 1
             FROM mailbox_search_fts f
             WHERE f.record_type = 'message'
               AND f.record_id = m.id
           )`,
        )
        .all() as Array<
        Pick<
          MailboxMessageRow,
          "id" | "thread_id" | "from_name" | "from_email" | "subject" | "snippet" | "body_text" | "body_html"
        > & { thread_subject: string }
      >;
      const insertMessage = this.db.prepare(
        `INSERT INTO mailbox_search_fts
           (record_type, record_id, thread_id, message_id, attachment_id, subject, sender, body, attachment_filename, attachment_text)
         VALUES ('message', ?, ?, ?, NULL, ?, ?, ?, '', '')`,
      );
      for (const row of messageRows) {
        const bodyHtml = decryptMailboxValue(row.body_html || "");
        const bodyText = decryptMailboxValue(row.body_text || "");
        insertMessage.run(
          row.id,
          row.thread_id,
          row.id,
          row.subject || row.thread_subject,
          [row.from_name, row.from_email].filter(Boolean).join(" "),
          `${row.snippet || ""}\n${bodyHtml ? stripHtml(bodyHtml) : bodyText || ""}`,
        );
      }

      const attachmentRows = this.db
        .prepare(
          `SELECT ma.*, mat.text_content, mat.extraction_mode
           FROM mailbox_attachments ma
           INNER JOIN mailbox_attachment_text mat ON mat.attachment_id = ma.id
           WHERE NOT EXISTS (
             SELECT 1
             FROM mailbox_search_fts f
             WHERE f.record_type = 'attachment'
               AND f.record_id = ma.id
           )`,
        )
        .all() as MailboxAttachmentRow[];
      for (const row of attachmentRows) {
        this.upsertAttachmentSearchIndex(row.id);
      }
    } catch {
      // FTS is optional; mailbox search falls back to row scanning.
    }
  }

  private upsertMessageAttachments(thread: NormalizedThreadInput, message: NormalizedMailboxMessage, now: number): void {
    const nextAttachments = message.attachments || [];
    const nextIds = new Set(nextAttachments.map((attachment) => attachment.id));
    const existingRows = this.db
      .prepare(`SELECT id FROM mailbox_attachments WHERE message_id = ?`)
      .all(message.id) as Array<{ id: string }>;
    for (const existing of existingRows) {
      if (nextIds.has(existing.id)) continue;
      try {
        this.db.prepare(`DELETE FROM mailbox_search_fts WHERE record_type = 'attachment' AND record_id = ?`).run(existing.id);
      } catch {
        // Optional FTS table may be unavailable.
      }
      this.db.prepare(`DELETE FROM mailbox_attachment_text WHERE attachment_id = ?`).run(existing.id);
      this.db.prepare(`DELETE FROM mailbox_attachments WHERE id = ?`).run(existing.id);
    }

    for (const attachment of nextAttachments) {
      this.db
        .prepare(
          `INSERT INTO mailbox_attachments
            (id, thread_id, message_id, provider, provider_message_id, provider_attachment_id, filename, mime_type, size, extraction_status, extraction_error, metadata_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'not_indexed', NULL, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             thread_id = excluded.thread_id,
             message_id = excluded.message_id,
             provider = excluded.provider,
             provider_message_id = excluded.provider_message_id,
             provider_attachment_id = excluded.provider_attachment_id,
             filename = excluded.filename,
             mime_type = excluded.mime_type,
             size = excluded.size,
             metadata_json = excluded.metadata_json,
             updated_at = excluded.updated_at`,
        )
        .run(
          attachment.id,
          thread.id,
          message.id,
          thread.provider,
          message.providerMessageId,
          attachment.providerAttachmentId || null,
          attachment.filename,
          attachment.mimeType || null,
          attachment.size ?? null,
          JSON.stringify({ source: "mailbox_sync" }),
          now,
          now,
        );
      this.upsertAttachmentSearchIndex(attachment.id);
    }
  }

  private upsertAttachmentSearchIndex(attachmentId: string): void {
    const row = this.db
      .prepare(
        `SELECT ma.*, mat.text_content, mat.extraction_mode
         FROM mailbox_attachments ma
         LEFT JOIN mailbox_attachment_text mat ON mat.attachment_id = ma.id
         WHERE ma.id = ?`,
      )
      .get(attachmentId) as MailboxAttachmentRow | undefined;
    if (!row) return;
    try {
      this.db
        .prepare(`DELETE FROM mailbox_search_fts WHERE record_type = 'attachment' AND record_id = ?`)
        .run(row.id);
      this.db
        .prepare(
          `INSERT INTO mailbox_search_fts
             (record_type, record_id, thread_id, message_id, attachment_id, subject, sender, body, attachment_filename, attachment_text)
           VALUES ('attachment', ?, ?, ?, ?, '', '', '', ?, ?)`,
        )
        .run(row.id, row.thread_id, row.message_id, row.id, row.filename, decryptMailboxValue(row.text_content || ""));
    } catch {
      // FTS is optional.
    }
  }

  private buildClassificationSnapshot(
    thread: MailboxThreadDetail | (MailboxThreadListItem & { messages: MailboxMessage[] }),
  ): MailboxClassificationSnapshot {
    return {
      threadId: thread.id,
      accountId: thread.accountId,
      provider: thread.provider,
      subject: thread.subject,
      snippet: thread.snippet,
      unreadCount: thread.unreadCount,
      categoryHint: thread.category,
      participants: thread.participants,
      labels: thread.labels,
      lastMessageAt: thread.lastMessageAt,
      messageCount: thread.messageCount,
      messages: thread.messages.slice(-MAILBOX_CLASSIFIER_MAX_MESSAGES).map((message) => ({
        direction: message.direction,
        from: message.from,
        snippet: message.snippet,
        body: message.bodyHtml ? stripHtml(message.bodyHtml) : message.body,
        receivedAt: message.receivedAt,
        unread: message.unread,
      })),
    };
  }

  private chooseMailboxClassifierModel(): { providerType: string; modelKey: string; modelId: string } | null {
    try {
      const settings = LLMProviderFactory.loadSettings();
      const providerType = settings.providerType;
      const routing = LLMProviderFactory.getProviderRoutingSettings(settings, providerType);
      const preferredKey =
        routing.automatedTaskModelKey || routing.cheapModelKey || settings.modelKey || "";
      if (!preferredKey) return null;
      const selection = LLMProviderFactory.resolveTaskModelSelection({
        providerType,
        modelKey: preferredKey,
      });
      return {
        providerType: selection.providerType,
        modelKey: selection.modelKey,
        modelId: selection.modelId,
      };
    } catch {
      return null;
    }
  }

  private parseClassificationResponse(text: string): MailboxClassificationResult | null {
    const jsonText = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    if (!jsonText.startsWith("{")) return null;
    try {
      const parsed = JSON.parse(jsonText) as Record<string, unknown>;
      const category = String(parsed.category || "").toLowerCase();
      const validCategory: MailboxThreadCategory = [
        "priority",
        "calendar",
        "follow_up",
        "promotions",
        "updates",
        "personal",
        "other",
      ].includes(category)
        ? (category as MailboxThreadCategory)
        : "other";
      const confidence = clampConfidence(Number(parsed.confidence ?? 0));
      if (confidence < MAILBOX_CLASSIFIER_MIN_CONFIDENCE) {
        return null;
      }
      const domainCategory = normalizeDomainCategory(parsed.domainCategory, "other");
      const todayBucket = normalizeTodayBucket(parsed.todayBucket, deriveTodayBucket({
        category: validCategory,
        domainCategory,
        needsReply: parsed.needsReply === true,
        priorityScore: clampScore(Number(parsed.priorityScore ?? 0)),
        urgencyScore: clampScore(Number(parsed.urgencyScore ?? 0)),
        cleanupCandidate: parsed.cleanupCandidate === true,
        handled: parsed.handled === true,
        text: `${parsed.rationale || ""} ${Array.isArray(parsed.labels) ? parsed.labels.join(" ") : ""}`,
      }));
      return {
        category: validCategory,
        todayBucket,
        domainCategory,
        needsReply: parsed.needsReply === true,
        priorityScore: clampScore(Number(parsed.priorityScore ?? 0)),
        urgencyScore: clampScore(Number(parsed.urgencyScore ?? 0)),
        staleFollowup: parsed.staleFollowup === true,
        cleanupCandidate: parsed.cleanupCandidate === true,
        handled: parsed.handled === true,
        confidence,
        rationale: typeof parsed.rationale === "string" ? normalizeWhitespace(parsed.rationale, 220) : undefined,
        labels: Array.isArray(parsed.labels)
          ? parsed.labels.filter((label): label is string => typeof label === "string")
          : undefined,
      };
    } catch {
      return null;
    }
  }

  private async classifyThreadWithLLM(
    thread: MailboxThreadDetail | (MailboxThreadListItem & { messages: MailboxMessage[] }),
    options?: { force?: boolean },
  ): Promise<MailboxClassificationResult | null> {
    const snapshot = this.buildClassificationSnapshot(thread);
    const fingerprint = mailboxClassificationFingerprint(snapshot);
    const existing = this.db
      .prepare(
        `SELECT classification_state, classification_fingerprint, classification_prompt_version
         FROM mailbox_threads
         WHERE id = ?`,
      )
      .get(thread.id) as
      | {
          classification_state: MailboxClassificationState;
          classification_fingerprint: string | null;
          classification_prompt_version: string | null;
        }
      | undefined;

    if (
      !options?.force &&
      existing?.classification_state === "classified" &&
      existing.classification_fingerprint === fingerprint &&
      existing.classification_prompt_version === MAILBOX_CLASSIFIER_PROMPT_VERSION
    ) {
      return null;
    }

    const modelSelection = this.chooseMailboxClassifierModel();
    if (!modelSelection) {
      return mailboxClassificationFallback(snapshot);
    }

    const provider = LLMProviderFactory.createProvider();
    const workspaceId =
      this.resolveThreadWorkspaceId(thread.accountId) ||
      this.resolveDefaultWorkspaceId();
    const system = [
      "You classify inbox threads for triage.",
      "Return compact strict JSON only with this shape:",
      '{ "category": "priority|calendar|follow_up|promotions|updates|personal|other", "todayBucket": "needs_action|happening_today|good_to_know|more_to_browse", "domainCategory": "travel|packages|receipts|bills|shopping|newsletters|events|finance|customer|hiring|approvals|ops|personal|other", "needsReply": boolean, "priorityScore": number, "urgencyScore": number, "staleFollowup": boolean, "cleanupCandidate": boolean, "handled": boolean, "confidence": number, "rationale": string, "labels": string[] }',
      "Use unreadCount only as a weak signal. Do not mark a thread as needsReply for receipts, security alerts, verification codes, password resets, onboarding, or automated account notifications unless the sender explicitly asks the user to respond.",
      "Treat priority as business urgency, not sender importance.",
      "Use todayBucket as a daily attention lane: needs_action for response/approval/high urgency, happening_today for dated travel/package/bill/event items, good_to_know for useful updates, more_to_browse for newsletters/promotions/low-value cleanup.",
      "Use domainCategory to describe the thread's life/work domain, not its priority.",
      "Keep scores in the 0 to 100 range and confidence in the 0 to 1 range.",
      "Prefer false negatives over false positives for needsReply.",
      "Keep rationale under 160 characters and labels under 6 items.",
    ].join(" ");

    const messages: LLMMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                threadId: snapshot.threadId,
                provider: snapshot.provider,
                subject: snapshot.subject,
                snippet: snapshot.snippet,
                unreadCount: snapshot.unreadCount,
                categoryHint: snapshot.categoryHint,
                labels: snapshot.labels,
                participants: snapshot.participants,
                lastMessageAt: snapshot.lastMessageAt,
                messageCount: snapshot.messageCount,
                messages: snapshot.messages.map((message) => ({
                  direction: message.direction,
                  from: message.from,
                  receivedAt: message.receivedAt,
                  unread: message.unread,
                  snippet: message.snippet,
                  body: summarizeMailboxBody(message.body),
                })),
              },
              null,
              2,
            ),
          },
        ],
      },
    ];

    try {
      const response = await provider.createMessage({
        model: modelSelection.modelId,
        maxTokens: MAILBOX_CLASSIFIER_MAX_TOKENS,
        system,
        messages,
      });
      recordLlmCallSuccess(
        {
          workspaceId,
          sourceKind: "mailbox_classification",
          sourceId: thread.id,
          providerType: provider.type,
          modelKey: modelSelection.modelKey,
          modelId: modelSelection.modelId,
        },
        response.usage,
      );
      const text = response.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("\n")
        .trim();
      const parsed = this.parseClassificationResponse(text);
      if (!parsed) {
        return mailboxClassificationFallback(snapshot);
      }
      return parsed;
    } catch (error) {
      recordLlmCallError({
        workspaceId,
        sourceKind: "mailbox_classification",
        sourceId: thread.id,
        providerType: provider.type,
        modelKey: modelSelection.modelKey,
        modelId: modelSelection.modelId,
      }, error);
      return mailboxClassificationFallback(snapshot);
    }
  }

  private persistThreadClassification(
    threadId: string,
    result: MailboxClassificationResult,
    fingerprint: string,
    modelKey: string | null,
    existingState: MailboxClassificationState,
    rawJson?: string,
  ): void {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE mailbox_threads
         SET category = ?,
             today_bucket = ?,
             domain_category = ?,
             classification_rationale = ?,
             priority_score = ?,
             urgency_score = ?,
             needs_reply = ?,
             stale_followup = ?,
             cleanup_candidate = ?,
             handled = ?,
             classification_state = 'classified',
             classification_fingerprint = ?,
             classification_model_key = ?,
             classification_prompt_version = ?,
             classification_confidence = ?,
             classification_updated_at = ?,
             classification_error = NULL,
             classification_json = ?,
             metadata_json = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(
        result.category,
        result.todayBucket,
        result.domainCategory,
        result.rationale || null,
        clampScore(result.priorityScore),
        clampScore(result.urgencyScore),
        result.needsReply ? 1 : 0,
        result.staleFollowup ? 1 : 0,
        result.cleanupCandidate ? 1 : 0,
        result.handled ? 1 : 0,
        fingerprint,
        modelKey,
        MAILBOX_CLASSIFIER_PROMPT_VERSION,
        clampConfidence(result.confidence),
        now,
        rawJson || JSON.stringify(result),
        JSON.stringify({
          priorityBand: priorityBandFromScore(result.priorityScore),
          todayBucket: result.todayBucket,
          domainCategory: result.domainCategory,
          classification: {
            state: "classified",
            modelKey,
            promptVersion: MAILBOX_CLASSIFIER_PROMPT_VERSION,
            confidence: clampConfidence(result.confidence),
            fingerprint,
            classifiedAt: now,
            previousState: existingState,
          },
        }),
        now,
        threadId,
      );
  }

  private async classifyThreadById(
    threadId: string,
    options?: { force?: boolean; preserveBackfill?: boolean },
  ): Promise<boolean> {
    const detail = await this.getThreadCore(threadId);
    if (!detail) return false;
    const snapshot = this.buildClassificationSnapshot(detail);
    const fingerprint = mailboxClassificationFingerprint(snapshot);
    const existing = this.db
      .prepare(
        `SELECT classification_state, classification_fingerprint, classification_prompt_version
         FROM mailbox_threads
         WHERE id = ?`,
      )
      .get(threadId) as
      | {
          classification_state: MailboxClassificationState;
          classification_fingerprint: string | null;
          classification_prompt_version: string | null;
        }
      | undefined;

    if (
      !options?.force &&
      existing?.classification_state === "classified" &&
      existing.classification_fingerprint === fingerprint &&
      existing.classification_prompt_version === MAILBOX_CLASSIFIER_PROMPT_VERSION
    ) {
      return false;
    }

    const result = await this.classifyThreadWithLLM(detail, { force: options?.force });
    if (!result) return false;

    const modelSelection = this.chooseMailboxClassifierModel();
    this.persistThreadClassification(
      threadId,
      result,
      fingerprint,
      modelSelection?.modelKey || null,
      existing?.classification_state || "pending",
      JSON.stringify(result),
    );

    this.refreshThreadProposals({
      id: detail.id,
      subject: detail.subject,
      needsReply: result.needsReply,
      cleanupCandidate: result.cleanupCandidate,
      staleFollowup: result.staleFollowup,
      category: result.category,
    });
    this.upsertPrimaryContact({ ...detail, needsReply: result.needsReply } as unknown as NormalizedThreadInput);
    const primaryContact = detail.participants[0];
    this.emitMailboxEvent({
      type: "thread_classified",
      threadId,
      accountId: detail.accountId,
      provider: detail.provider,
      subject: detail.subject,
      summary: result.rationale || `Classified as ${result.category}`,
      evidenceRefs: [threadId, ...detail.messages.slice(-2).map((message) => message.id)],
      payload: {
        category: result.category,
        todayBucket: result.todayBucket,
        domainCategory: result.domainCategory,
        needsReply: result.needsReply,
        priorityScore: result.priorityScore,
        urgencyScore: result.urgencyScore,
        staleFollowup: result.staleFollowup,
        cleanupCandidate: result.cleanupCandidate,
        handled: result.handled,
        confidence: result.confidence,
        labels: result.labels || [],
        classificationFingerprint: fingerprint,
        primaryContactEmail: primaryContact?.email,
        primaryContactName: primaryContact?.name,
        senderName: primaryContact?.name,
        company: companyFromEmail(primaryContact?.email),
      },
    });
    return true;
  }

  private async classifyMailboxThreadsForAccount(
    accountId: string,
    options?: { includeBackfill?: boolean; limit?: number; force?: boolean },
  ): Promise<MailboxReclassifyResult> {
    const limit = Math.min(Math.max(options?.limit ?? MAILBOX_CLASSIFIER_MAX_BATCH, 1), 200);
    const account = this.db
      .prepare(
        `SELECT id, classification_initial_batch_at
         FROM mailbox_accounts
         WHERE id = ?`,
      )
      .get(accountId) as { id: string; classification_initial_batch_at: number | null } | undefined;
    if (!account) {
      return { accountId, scannedThreads: 0, reclassifiedThreads: 0 };
    }

    const canBackfill = options?.includeBackfill === true || !account.classification_initial_batch_at;
    const includeAll = options?.force === true && options?.includeBackfill === true;
    const rows = includeAll
      ? (this.db
          .prepare(
            `SELECT id
             FROM mailbox_threads
             WHERE account_id = ?
             ORDER BY unread_count DESC, last_message_at DESC
             LIMIT ?`,
          )
          .all(accountId, limit) as Array<{ id: string }>)
      : (this.db
          .prepare(
            `SELECT id
             FROM mailbox_threads
             WHERE account_id = ?
               AND classification_state IN (${(canBackfill ? ["pending", "backfill_pending"] : ["pending"])
                 .map(() => "?")
                 .join(", ")})
             ORDER BY unread_count DESC, last_message_at DESC
             LIMIT ?`,
          )
          .all(accountId, ...(canBackfill ? ["pending", "backfill_pending"] : ["pending"]), limit) as Array<{
          id: string;
        }>);

    let reclassifiedThreads = 0;
    for (const row of rows) {
      const updated = await this.classifyThreadById(row.id, {
        force: options?.force,
      });
      if (updated) reclassifiedThreads += 1;
    }

    if (!account.classification_initial_batch_at && canBackfill) {
      this.db
        .prepare(
          `UPDATE mailbox_accounts
           SET classification_initial_batch_at = COALESCE(classification_initial_batch_at, ?),
               updated_at = ?
           WHERE id = ?`,
        )
        .run(Date.now(), Date.now(), accountId);
    }

    return {
      accountId,
      scannedThreads: rows.length,
      reclassifiedThreads,
    };
  }

  private refreshThreadProposals(thread: Pick<
    NormalizedThreadInput,
    "id" | "subject" | "needsReply" | "cleanupCandidate" | "staleFollowup" | "category"
  >): void {
    this.db
      .prepare(
        `DELETE FROM mailbox_action_proposals
         WHERE thread_id = ?
           AND status = 'suggested'
           AND proposal_type IN ('reply', 'cleanup', 'follow_up', 'schedule')`,
      )
      .run(thread.id);

    if (thread.needsReply) {
      this.upsertProposal({
        threadId: thread.id,
        type: "reply",
        title: `Reply to ${thread.subject}`,
        reasoning: "Latest message appears to require a response.",
      });
    }
    if (thread.cleanupCandidate) {
      this.upsertProposal({
        threadId: thread.id,
        type: "cleanup",
        title: `Clean up ${thread.subject}`,
        reasoning: "Hide this thread from the Cowork inbox. Use Archive or Trash if you want to change the server-side mailbox.",
      });
    }
    if (thread.staleFollowup) {
      this.upsertProposal({
        threadId: thread.id,
        type: "follow_up",
        title: `Follow up on ${thread.subject}`,
        reasoning: "This thread still needs a reply and has gone stale.",
      });
    }
    if (thread.category === "calendar") {
      this.upsertProposal({
        threadId: thread.id,
        type: "schedule",
        title: `Propose meeting slots for ${thread.subject}`,
        reasoning: "Thread content looks scheduling related.",
      });
    }
  }

  private upsertPrimaryContact(thread: NormalizedThreadInput): void {
    const primary = thread.participants[0];
    if (!primary?.email) return;
    const now = Date.now();
    const company = companyFromEmail(primary.email);
    const sensitiveContent = this.createThreadSensitiveContent([
      thread.subject,
      thread.snippet,
      ...thread.messages.map((message) => message.bodyHtml ? stripHtml(message.bodyHtml) : message.body),
    ]);
    const learnedFacts = [
      primary.name ? `Name: ${primary.name}` : null,
      company ? `Company: ${company}` : null,
    ].filter((entry): entry is string => Boolean(entry));

    this.db
      .prepare(
        `INSERT INTO mailbox_contacts
          (id, account_id, email, name, company, role, encryption_preference, policy_flags_json, crm_links_json, learned_facts_json, response_tendency, last_interaction_at, open_commitments, updated_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(email) DO UPDATE SET
           account_id = excluded.account_id,
           name = COALESCE(excluded.name, mailbox_contacts.name),
           company = COALESCE(excluded.company, mailbox_contacts.company),
           encryption_preference = CASE
             WHEN mailbox_contacts.encryption_preference IS NULL THEN excluded.encryption_preference
             ELSE mailbox_contacts.encryption_preference
           END,
           policy_flags_json = CASE
             WHEN mailbox_contacts.policy_flags_json IS NULL THEN excluded.policy_flags_json
             ELSE mailbox_contacts.policy_flags_json
           END,
           learned_facts_json = excluded.learned_facts_json,
           last_interaction_at = excluded.last_interaction_at,
           updated_at = excluded.updated_at`,
      )
      .run(
        `contact:${primary.email}`,
        thread.accountId,
        primary.email,
        primary.name || null,
        company || null,
        null,
        sensitiveContent.hasSensitiveContent ? "preferred" : null,
        JSON.stringify(sensitiveContent.hasSensitiveContent ? ["sensitive_content"] : []),
        JSON.stringify([]),
        JSON.stringify(learnedFacts),
        thread.needsReply ? "awaiting_reply" : "fyi",
        thread.lastMessageAt,
        this.getCommitmentsForThread(thread.id).filter((item) => item.state !== "done").length,
        now,
        now,
      );
  }

  private getSummaryForThread(threadId: string): MailboxSummaryCard | null {
    const row = this.db
      .prepare(
        `SELECT
           thread_id,
           summary_text,
           key_asks_json,
           extracted_questions_json,
           suggested_next_action,
           updated_at
         FROM mailbox_summaries
         WHERE thread_id = ?`,
      )
      .get(threadId) as MailboxSummaryRow | undefined;
    if (!row) return null;
    return this.mapSummaryRow(row);
  }

  private getMessagesForThread(threadId: string): MailboxMessage[] {
    const rows = this.db
      .prepare(
        `SELECT
           id,
           thread_id,
           provider_message_id,
           direction,
           from_name,
           from_email,
           to_json,
           cc_json,
           bcc_json,
           subject,
           snippet,
           body_text,
           body_html,
           received_at,
           is_unread,
           metadata_json
         FROM mailbox_messages
         WHERE thread_id = ?
         ORDER BY received_at ASC`,
      )
      .all(threadId) as MailboxMessageRow[];
    return rows.map((row) => this.mapMessageRow(row));
  }

  private getDraftsForThread(threadId: string): MailboxDraftSuggestion[] {
    const rows = this.db
      .prepare(
        `SELECT
           id,
           thread_id,
           subject,
           body_text,
           tone,
           rationale,
           schedule_notes,
           created_at,
           updated_at
         FROM mailbox_drafts
         WHERE thread_id = ?
         ORDER BY updated_at DESC`,
      )
      .all(threadId) as MailboxDraftRow[];
    return rows.map((row) => this.mapDraftRow(row));
  }

  private getProposalsForThread(threadId: string): MailboxActionProposal[] {
    const rows = this.db
      .prepare(
        `SELECT
           id,
           thread_id,
           proposal_type,
           title,
           reasoning,
           preview_json,
           status,
           created_at,
           updated_at
         FROM mailbox_action_proposals
         WHERE thread_id = ?
         ORDER BY updated_at DESC`,
      )
      .all(threadId) as MailboxProposalRow[];
    return rows.map((row) => this.mapProposalRow(row));
  }

  private getCommitmentsForThread(threadId: string): MailboxCommitment[] {
    const rows = this.db
      .prepare(
        `SELECT
           id,
           thread_id,
           message_id,
           title,
           due_at,
           state,
           owner_email,
           source_excerpt,
           metadata_json,
           created_at,
           updated_at
         FROM mailbox_commitments
         WHERE thread_id = ?
         ORDER BY updated_at DESC`,
      )
      .all(threadId) as MailboxCommitmentRow[];
    return rows.map((row) => this.mapCommitmentRow(row));
  }

  private getPrimaryContactMemory(threadId: string): MailboxContactMemory | null {
    const thread = this.db
      .prepare("SELECT account_id, participants_json FROM mailbox_threads WHERE id = ?")
      .get(threadId) as { account_id: string; participants_json: string | null } | undefined;
    const email = parseJsonArray<MailboxParticipant>(thread?.participants_json).find(Boolean)?.email;
    if (!thread?.account_id || !email) return null;
    const row = this.db
      .prepare(
        `SELECT
           id,
           account_id,
           email,
           name,
           company,
           role,
           encryption_preference,
           policy_flags_json,
           crm_links_json,
           learned_facts_json,
           response_tendency,
           last_interaction_at,
           open_commitments
         FROM mailbox_contacts
         WHERE email = ?`,
      )
      .get(email) as MailboxContactRow | undefined;
    if (!row) return null;
    return {
      ...this.mapContactRow(row),
      ...this.getContactInsights(thread.account_id, email),
    };
  }

  private collectPhoneHints(input: {
    primaryEmail?: string;
    contactMemory?: MailboxContactMemory | null;
    messages: MailboxMessage[];
    snippet?: string;
  }): string[] {
    const candidates = new Set<string>();
    const pushPhone = (value?: string | null) => {
      const digits = String(value || "").replace(/[^\d]/g, "");
      if (digits.length >= 8) candidates.add(digits);
    };

    for (const hint of input.contactMemory?.crmLinks || []) {
      pushPhone(hint);
    }
    for (const fact of input.contactMemory?.learnedFacts || []) {
      for (const match of fact.match(/\+?\d[\d\s().-]{7,}\d/g) || []) {
        pushPhone(match);
      }
    }
    for (const body of [
      input.snippet,
      ...input.messages.map((message) => message.body),
      ...input.messages.map((message) => message.snippet),
    ]) {
      for (const match of String(body || "").match(/\+?\d[\d\s().-]{7,}\d/g) || []) {
        pushPhone(match);
      }
    }
    return [...candidates];
  }

  private getContactInsights(
    accountId: string,
    email: string,
  ): Pick<
    MailboxContactMemory,
    | "totalThreads"
    | "totalMessages"
    | "averageResponseHours"
    | "lastOutboundAt"
    | "recentSubjects"
    | "styleSignals"
    | "recentOutboundExample"
    | "responseTendency"
  > {
    const like = `%${email}%`;
    const threadRows = this.db
      .prepare(
        `SELECT id, subject, last_message_at
         FROM mailbox_threads
         WHERE account_id = ? AND participants_json LIKE ?
         ORDER BY last_message_at DESC`,
      )
      .all(accountId, like) as Array<{ id: string; subject: string; last_message_at: number }>;

    const messageRows = this.db
      .prepare(
        `SELECT
           m.thread_id,
           m.direction,
           m.body_text,
           m.received_at
         FROM mailbox_messages m
         JOIN mailbox_threads t ON t.id = m.thread_id
         WHERE t.account_id = ? AND t.participants_json LIKE ?
         ORDER BY m.received_at ASC`,
      )
      .all(accountId, like) as Array<{
        thread_id: string;
        direction: "incoming" | "outgoing";
        body_text: string;
        received_at: number;
      }>;

    const outgoingMessages = messageRows
      .filter((row) => row.direction === "outgoing")
      .map((row) => normalizeWhitespace(decryptMailboxValue(row.body_text) || "", 600))
      .filter(Boolean);

    const responseSamples: number[] = [];
    const latestIncomingByThread = new Map<string, number>();
    for (const row of messageRows) {
      if (row.direction === "incoming") {
        latestIncomingByThread.set(row.thread_id, row.received_at);
        continue;
      }
      const lastIncoming = latestIncomingByThread.get(row.thread_id);
      if (lastIncoming && row.received_at >= lastIncoming) {
        responseSamples.push((row.received_at - lastIncoming) / (60 * 60 * 1000));
        latestIncomingByThread.delete(row.thread_id);
      }
    }

    const styleProfile = this.buildDraftStyleProfile({
      outgoingMessages,
      averageResponseHours: average(responseSamples),
    });

    return {
      totalThreads: threadRows.length,
      totalMessages: messageRows.length,
      averageResponseHours: styleProfile.averageResponseHours,
      lastOutboundAt: messageRows.filter((row) => row.direction === "outgoing").slice(-1)[0]?.received_at,
      recentSubjects: threadRows.map((row) => row.subject).filter(Boolean).slice(0, 3),
      styleSignals: styleProfile.styleSignals,
      recentOutboundExample: styleProfile.recentOutboundExample,
      responseTendency:
        styleProfile.averageResponseHours && styleProfile.averageResponseHours <= 6
          ? `Usually replies within ${styleProfile.averageResponseHours.toFixed(1)} hours`
          : outgoingMessages.length
            ? `Tone tends ${styleProfile.tone}`
            : undefined,
    };
  }

  private buildDraftStyleProfile(input: {
    outgoingMessages: string[];
    averageResponseHours?: number;
  }): DraftStyleProfile {
    const outgoingMessages = input.outgoingMessages.filter(Boolean);
    const tone = outgoingMessages.length ? classifyTone(outgoingMessages) : "concise";
    const greeting = inferGreeting(outgoingMessages);
    const signoff = inferSignoff(outgoingMessages) || (tone === "warm" ? "Thanks," : "Best,");
    const averageLength = average(outgoingMessages.map((message) => message.length)) || 0;
    const styleSignals = [
      averageLength < 220 ? "Prefers short replies" : averageLength > 500 ? "Often writes with fuller context" : null,
      greeting?.startsWith("Hey") ? "Usually opens casually" : greeting?.startsWith("Hello") ? "Usually opens formally" : null,
      /^thanks/i.test(signoff) ? "Usually signs off with Thanks" : /^best/i.test(signoff) ? "Usually signs off with Best" : null,
      typeof input.averageResponseHours === "number"
        ? `Average response time ${input.averageResponseHours.toFixed(1)}h`
        : null,
    ].filter((entry): entry is string => Boolean(entry));

    return {
      greeting,
      signoff,
      tone,
      averageLength,
      averageResponseHours: input.averageResponseHours,
      styleSignals,
      recentOutboundExample: outgoingMessages.length
        ? normalizeWhitespace(outgoingMessages[outgoingMessages.length - 1], 180)
        : undefined,
    };
  }

  private async getThreadCore(
    threadId: string,
  ): Promise<(MailboxThreadListItem & { messages: MailboxMessage[] }) | null> {
    const row = this.db
      .prepare(
        `SELECT
           id,
           account_id,
           provider,
           provider_thread_id,
           subject,
           snippet,
           participants_json,
           labels_json,
           category,
           today_bucket,
           domain_category,
           classification_rationale,
           priority_score,
           urgency_score,
           needs_reply,
           stale_followup,
           cleanup_candidate,
           handled,
           local_inbox_hidden,
           unread_count,
           message_count,
           last_message_at,
           sensitive_content_json,
           classification_state
         FROM mailbox_threads
         WHERE id = ?`,
      )
      .get(threadId) as MailboxThreadRow | undefined;
    if (!row) return null;
    return {
      ...this.mapThreadRow(row, this.getSummaryForThread(threadId) || undefined),
      messages: this.getMessagesForThread(threadId),
    };
  }

  private resolveThreadWorkspaceId(_accountId?: string): string | undefined {
    const agentMail = this.parseAgentMailAccountId(_accountId);
    if (agentMail) {
      const row = this.db
        .prepare(
          `SELECT workspace_id
           FROM agentmail_inboxes
           WHERE pod_id = ? AND inbox_id = ?
           LIMIT 1`,
        )
        .get(agentMail.podId, agentMail.inboxId) as { workspace_id: string } | undefined;
      if (row?.workspace_id) {
        return row.workspace_id;
      }
    }
    return this.resolveDefaultWorkspaceId();
  }

  private buildMissionControlIssueTitle(detail: MailboxThreadDetail): string {
    const subject = normalizeWhitespace(detail.subject || "Inbox handoff", 120);
    const primary = detail.research?.primaryContact?.name || detail.participants[0]?.name;
    return primary ? `${subject} (${primary})` : subject;
  }

  private buildMissionControlIssueSummary(
    detail: MailboxThreadDetail,
    sensitiveContentRedacted: boolean,
  ): string {
    const primaryContact = detail.research?.primaryContact || detail.participants[0];
    const lines = [
      `Inbox handoff from ${primaryContact?.name || primaryContact?.email || "unknown sender"}.`,
      detail.research?.company ? `Company hint: ${detail.research.company}.` : null,
      `Thread subject: ${detail.subject || "Untitled thread"}.`,
      detail.summary?.summary
        ? `Summary: ${stripMailboxSummaryHtmlArtifacts(detail.summary.summary)}`
        : detail.snippet
          ? `Summary: ${stripMailboxSummaryHtmlArtifacts(detail.snippet)}`
          : null,
      detail.commitments.length
        ? `Open commitments: ${detail.commitments
            .map((commitment) =>
              commitment.dueAt
                ? `${commitment.title} (due ${formatMailboxDateTime(commitment.dueAt)})`
                : commitment.title,
            )
            .join(" · ")}`
        : null,
      detail.research?.nextSteps?.length
        ? `Mailbox next steps: ${detail.research.nextSteps.join(" · ")}`
        : null,
      sensitiveContentRedacted
        ? "Sensitive content detected. Review mailbox evidence refs instead of relying on raw excerpts."
        : this.buildMailboxExcerpt(detail),
    ];
    return lines.filter((entry): entry is string => Boolean(entry)).join("\n\n");
  }

  private buildMailboxExcerpt(detail: MailboxThreadDetail): string | null {
    const latestRelevant = [...detail.messages]
      .sort((a, b) => b.receivedAt - a.receivedAt)
      .find((message) => normalizeWhitespace(message.body || message.snippet, 220).length > 0);
    if (!latestRelevant) return null;
    return `Latest message excerpt: ${normalizeWhitespace(
      stripMailboxSummaryHtmlArtifacts(latestRelevant.body || latestRelevant.snippet),
      220,
    )}`;
  }

  private buildMailboxEvidenceRefs(detail: MailboxThreadDetail): CompanyEvidenceRef[] {
    const refs: CompanyEvidenceRef[] = [
      { type: "mailbox_thread", id: detail.id, label: detail.subject || "mailbox thread" },
    ];
    for (const message of detail.messages.slice(0, 3)) {
      refs.push({
        type: "mailbox_message",
        id: message.id,
        label: message.direction === "outgoing" ? "sent email" : "received email",
      });
    }
    for (const commitment of detail.commitments.slice(0, 3)) {
      refs.push({
        type: "mailbox_commitment",
        id: commitment.id,
        label: commitment.title,
      });
    }
    return refs;
  }

  private buildMissionControlCompanyCandidates(
    detail: MailboxThreadDetail,
  ): MailboxCompanyCandidate[] {
    const companies = this.controlPlaneCore.listCompanies();
    const email = detail.research?.primaryContact?.email || detail.participants[0]?.email;
    const domain = (detail.research?.domain || email?.split("@")[1] || "").toLowerCase();
    const companyHint = (
      detail.research?.company ||
      detail.contactMemory?.company ||
      companyFromEmail(email) ||
      ""
    ).toLowerCase();
    const relatedText = [
      detail.subject,
      detail.summary?.summary,
      detail.research?.relatedEntities?.join(" "),
      detail.research?.recommendedQueries?.join(" "),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    const scored = companies
      .map((company) => {
        let score = 0;
        const reasons: string[] = [];
        const name = company.name.toLowerCase();
        const slug = company.slug.toLowerCase();
        if (companyHint && (name.includes(companyHint) || companyHint.includes(name))) {
          score += 0.45;
          reasons.push("contact company matches company name");
        }
        if (domain) {
          const domainLabel = domain.split(".")[0] || domain;
          if (domainLabel === slug || name.includes(domainLabel) || slug.includes(domainLabel)) {
            score += 0.32;
            reasons.push("sender domain matches company slug");
          }
        }
        if (relatedText && (relatedText.includes(name) || relatedText.includes(slug))) {
          score += 0.22;
          reasons.push("thread context references the company");
        }
        if (company.isDefault) {
          score += 0.05;
        }
        return {
          companyId: company.id,
          name: company.name,
          slug: company.slug,
          confidence: Math.max(0, Math.min(1, score)),
          reason: reasons[0] || "manual selection recommended",
          defaultWorkspaceId: company.defaultWorkspaceId,
        } satisfies MailboxCompanyCandidate;
      })
      .filter((candidate) => candidate.confidence > 0.05)
      .sort((a, b) => b.confidence - a.confidence);

    return scored.slice(0, 5);
  }

  private buildMissionControlOperatorRecommendations(
    detail: MailboxThreadDetail,
    companyId?: string,
  ): MailboxOperatorRecommendation[] {
    const companyRoles = companyId
      ? this.agentRoleRepo.findByCompanyId(companyId, false)
      : this.agentRoleRepo.findAll(false);
    const roles = companyRoles.filter((role) => role.isActive !== false);
    const text = [
      detail.subject,
      detail.summary?.summary,
      detail.snippet,
      detail.research?.relationshipSummary,
      detail.research?.nextSteps?.join(" "),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    const desiredKind =
      detail.commitments.length > 0 ||
      detail.priorityBand === "critical" ||
      /\b(support|customer|service|refund|issue|outage|incident|escalation|complaint|risk)\b/.test(text)
        ? "customer_ops"
        : /\b(sales|partnership|pipeline|candidate|recruit|hiring|outbound|lead)\b/.test(text)
          ? "growth"
          : /\b(plan|planning|scope|roadmap|project|blocker|spec|milestone)\b/.test(text)
            ? "planner"
            : "founder_office";

    const scored = roles
      .map((role) => {
        const roleText = `${role.name} ${role.displayName} ${role.operatorMandate || ""}`.toLowerCase();
        let roleKind: MailboxOperatorRecommendation["roleKind"] = "other";
        let score = 0.2;
        if (/\bcustomer|support|ops\b/.test(roleText)) {
          roleKind = "customer_ops";
          score += desiredKind === "customer_ops" ? 0.55 : 0.1;
        } else if (/\bgrowth|sales|recruit|partnership\b/.test(roleText)) {
          roleKind = "growth";
          score += desiredKind === "growth" ? 0.55 : 0.1;
        } else if (/\bplanner|strategy|program|project\b/.test(roleText)) {
          roleKind = "planner";
          score += desiredKind === "planner" ? 0.55 : 0.1;
        } else if (/\bfounder|office\b/.test(roleText)) {
          roleKind = "founder_office";
          score += desiredKind === "founder_office" ? 0.55 : 0.1;
        }
        if (Array.isArray(role.allowedLoopTypes) && role.allowedLoopTypes.includes("execution")) {
          score += 0.08;
        }
        if (Array.isArray(role.outputTypes) && role.outputTypes.includes("work_order")) {
          score += 0.08;
        }
        return {
          agentRoleId: role.id,
          displayName: role.displayName,
          companyId: role.companyId,
          confidence: Math.max(0, Math.min(1, score)),
          reason:
            desiredKind === roleKind
              ? `recommended for ${desiredKind.replace("_", " ")} inbox work`
              : "available operator for selected company",
          roleKind,
        } satisfies MailboxOperatorRecommendation;
      })
      .filter((entry) => entry.confidence > 0.15)
      .sort((a, b) => b.confidence - a.confidence);

    return scored.slice(0, 5);
  }

  private buildMailboxHandoffOutputContract(
    companyId: string,
    operatorRoleId: string,
    detail: MailboxThreadDetail,
  ): CompanyOutputContract {
    return {
      companyId,
      operatorRoleId,
      loopType: "execution",
      outputType: "work_order",
      valueReason: "Inbox thread handed off into company operations",
      reviewRequired: detail.sensitiveContent?.hasSensitiveContent === true,
      reviewReason: detail.sensitiveContent?.hasSensitiveContent ? "customer_risk" : undefined,
      evidenceRefs: this.buildMailboxEvidenceRefs(detail),
      companyPriority:
        detail.priorityBand === "critical"
          ? "critical"
          : detail.priorityBand === "high"
            ? "high"
            : "normal",
      triggerReason: detail.needsReply ? "needs_reply" : "reference_handoff",
      expectedOutputType: "status_digest",
    };
  }

  private mapMailboxPriorityToIssuePriority(band: MailboxPriorityBand): number {
    switch (band) {
      case "critical":
        return 1;
      case "high":
        return 2;
      case "medium":
        return 3;
      default:
        return 4;
    }
  }

  private persistMissionControlHandoff(input: {
    threadId: string;
    workspaceId: string;
    companyId: string;
    companyName: string;
    operatorRoleId: string;
    operatorDisplayName: string;
    issueId: string;
    issueTitle: string;
    latestOutcome?: string;
    latestWakeAt?: number;
  }): MailboxMissionControlHandoffRecord {
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO mailbox_mission_control_handoffs (
           id,
           thread_id,
           workspace_id,
           company_id,
           company_name,
           operator_role_id,
           operator_display_name,
           issue_id,
           issue_title,
           source,
           latest_outcome,
           latest_wake_at,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'mailbox_handoff', ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.threadId,
        input.workspaceId,
        input.companyId,
        input.companyName,
        input.operatorRoleId,
        input.operatorDisplayName,
        input.issueId,
        input.issueTitle,
        input.latestOutcome || null,
        input.latestWakeAt || null,
        now,
        now,
      );
    const row = this.db
      .prepare(
        `SELECT * FROM mailbox_mission_control_handoffs WHERE id = ?`,
      )
      .get(id) as MailboxMissionControlHandoffRow;
    return this.mapMissionControlHandoffRow(row);
  }

  private findActiveMissionControlHandoff(
    threadId: string,
    companyId: string,
    operatorRoleId: string,
  ): MailboxMissionControlHandoffRecord | null {
    const rows = this.db
      .prepare(
        `SELECT *
         FROM mailbox_mission_control_handoffs
         WHERE thread_id = ?
           AND company_id = ?
           AND operator_role_id = ?
         ORDER BY updated_at DESC`,
      )
      .all(threadId, companyId, operatorRoleId) as MailboxMissionControlHandoffRow[];
    for (const row of rows) {
      const record = this.mapMissionControlHandoffRow(row);
      if (record.issueStatus === "open") return record;
    }
    return null;
  }

  private mapMissionControlHandoffRow(
    row: MailboxMissionControlHandoffRow,
  ): MailboxMissionControlHandoffRecord {
    const issue = this.controlPlaneCore.getIssue(row.issue_id);
    const issueStatus: MailboxMissionControlHandoffRecord["issueStatus"] =
      issue?.status === "done"
        ? "done"
        : issue?.status === "cancelled"
          ? "cancelled"
          : "open";
    return {
      id: row.id,
      threadId: row.thread_id,
      workspaceId: row.workspace_id,
      companyId: row.company_id,
      companyName: row.company_name,
      operatorRoleId: row.operator_role_id,
      operatorDisplayName: row.operator_display_name,
      issueId: row.issue_id,
      issueTitle: row.issue_title,
      issueStatus,
      source: "mailbox_handoff",
      latestOutcome: row.latest_outcome || undefined,
      latestWakeAt: row.latest_wake_at || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private async getScheduleSuggestion(): Promise<ScheduleSuggestion> {
    if (!GoogleWorkspaceSettingsManager.loadSettings().enabled) {
      const now = new Date();
      const options: ScheduleOption[] = [];
      const preferredHours = [11, 15, 10];
      for (let dayOffset = 1; dayOffset <= 5 && options.length < 3; dayOffset++) {
        const date = new Date(now.getTime() + dayOffset * 24 * 60 * 60 * 1000);
        if (date.getDay() === 0 || date.getDay() === 6) continue;
        const hour = preferredHours[options.length] ?? preferredHours[preferredHours.length - 1];
        date.setHours(hour, 0, 0, 0);
        options.push(buildScheduleOption(date));
      }
      return {
        options,
        summary: "Google Calendar not connected, using lightweight default availability placeholders.",
      };
    }

    const settings = GoogleWorkspaceSettingsManager.loadSettings();
    const now = new Date();
    const timeMin = now.toISOString();
    const timeMax = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000).toISOString();
    const response = await googleCalendarRequest(settings, {
      method: "GET",
      path: "/calendars/primary/events",
      query: {
        timeMin,
        timeMax,
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 25,
      },
    });
    const busy = Array.isArray(response.data?.items) ? response.data.items : [];
    const taken = (busy as Array<{ start?: { dateTime?: string } }>)
      .map((item: { start?: { dateTime?: string } }) => asString(item?.start?.dateTime))
      .filter((value: string | null): value is string => Boolean(value))
      .map((value: string) => new Date(value).getHours());

    const preferredHours = [10, 11, 14, 15, 16];
    const options: ScheduleOption[] = [];
    for (let dayOffset = 1; dayOffset <= 5 && options.length < 3; dayOffset++) {
      const date = new Date(now.getTime() + dayOffset * 24 * 60 * 60 * 1000);
      if (date.getDay() === 0 || date.getDay() === 6) continue;
      for (const hour of preferredHours) {
        if (taken.includes(hour)) continue;
        const candidate = new Date(date);
        candidate.setHours(hour, 0, 0, 0);
        options.push(buildScheduleOption(candidate));
        if (options.length >= 3) break;
      }
    }

    return {
      options:
        options.length
          ? options
          : (() => {
              const fallback: ScheduleOption[] = [];
              for (let dayOffset = 1; dayOffset <= 5 && fallback.length < 3; dayOffset++) {
                const date = new Date(now.getTime() + dayOffset * 24 * 60 * 60 * 1000);
                if (date.getDay() === 0 || date.getDay() === 6) continue;
                date.setHours([11, 15, 10][fallback.length] ?? 11, 0, 0, 0);
                fallback.push(buildScheduleOption(date));
              }
              return fallback;
            })(),
      summary: "Suggested free windows based on the next few days of Google Calendar events.",
    };
  }

  private async applyArchive(thread: MailboxThreadDetail | (MailboxThreadListItem & { messages: MailboxMessage[] })): Promise<void> {
    if (thread.provider === "gmail") {
      const settings = GoogleWorkspaceSettingsManager.loadSettings();
      await gmailRequest(settings, {
        method: "POST",
        path: `/users/me/threads/${encodeURIComponent(thread.providerThreadId)}/modify`,
        body: {
          removeLabelIds: ["INBOX"],
        },
      });
    } else if (thread.provider === "agentmail") {
      const account = this.parseAgentMailAccountId(thread.accountId);
      const latestMessage = [...thread.messages].sort((a, b) => b.receivedAt - a.receivedAt)[0];
      if (!account || !latestMessage) {
        throw new Error("Unable to resolve AgentMail message for archive.");
      }
      await this.getAgentMailClient().updateMessage(account.inboxId, latestMessage.providerMessageId, {
        addLabels: ["archived"],
        removeLabels: ["inbox"],
      });
    } else {
      throw new Error("Archive is not supported for the current IMAP adapter.");
    }

    this.db
      .prepare("UPDATE mailbox_threads SET handled = 1, cleanup_candidate = 0, local_inbox_hidden = 1, updated_at = ? WHERE id = ?")
      .run(Date.now(), thread.id);
  }

  private applyLocalCleanup(thread: MailboxThreadDetail | (MailboxThreadListItem & { messages: MailboxMessage[] })): void {
    this.db
      .prepare(
        "UPDATE mailbox_threads SET handled = 1, cleanup_candidate = 0, local_inbox_hidden = 1, updated_at = ? WHERE id = ?",
      )
      .run(Date.now(), thread.id);
  }

  private async applyMarkDone(thread: MailboxThreadDetail | (MailboxThreadListItem & { messages: MailboxMessage[] })): Promise<void> {
    const now = Date.now();
    const openCommitments = this.db
      .prepare(
        `SELECT id
         FROM mailbox_commitments
         WHERE thread_id = ?
           AND state IN ('suggested', 'accepted')`,
      )
      .all(thread.id) as Array<{ id: string }>;
    for (const commitment of openCommitments) {
      await this.updateCommitmentState(commitment.id, "done");
    }
    this.db
      .prepare(
        `UPDATE mailbox_threads
         SET needs_reply = 0,
             stale_followup = 0,
             handled = 1,
             today_bucket = CASE WHEN today_bucket = 'needs_action' THEN 'good_to_know' ELSE today_bucket END,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(now, thread.id);
    this.updateProposalStatusByThreadAndType(thread.id, "reply", "applied");
    this.updateProposalStatusByThreadAndType(thread.id, "follow_up", "dismissed");
  }

  private async applyTrash(thread: MailboxThreadDetail | (MailboxThreadListItem & { messages: MailboxMessage[] })): Promise<void> {
    if (thread.provider === "gmail") {
      const settings = GoogleWorkspaceSettingsManager.loadSettings();
      await gmailRequest(settings, {
        method: "POST",
        path: `/users/me/threads/${encodeURIComponent(thread.providerThreadId)}/trash`,
      });
    } else if (thread.provider === "agentmail") {
      const account = this.parseAgentMailAccountId(thread.accountId);
      const latestMessage = [...thread.messages].sort((a, b) => b.receivedAt - a.receivedAt)[0];
      if (!account || !latestMessage) {
        throw new Error("Unable to resolve AgentMail message for trash.");
      }
      await this.getAgentMailClient().updateMessage(account.inboxId, latestMessage.providerMessageId, {
        addLabels: ["trash"],
      });
    } else {
      throw new Error("Trash is not supported for the current IMAP adapter.");
    }

    this.db
      .prepare("UPDATE mailbox_threads SET handled = 1, cleanup_candidate = 0, local_inbox_hidden = 1, updated_at = ? WHERE id = ?")
      .run(Date.now(), thread.id);
  }

  private async applyMarkRead(thread: MailboxThreadDetail | (MailboxThreadListItem & { messages: MailboxMessage[] })): Promise<void> {
    if (thread.provider === "gmail") {
      const settings = GoogleWorkspaceSettingsManager.loadSettings();
      await gmailRequest(settings, {
        method: "POST",
        path: `/users/me/threads/${encodeURIComponent(thread.providerThreadId)}/modify`,
        body: {
          removeLabelIds: ["UNREAD"],
        },
      });
    } else if (thread.provider === "agentmail") {
      const account = this.parseAgentMailAccountId(thread.accountId);
      if (!account) {
        throw new Error("Unable to resolve AgentMail inbox for mark_read.");
      }
      const unreadMessages = thread.messages.filter((message) => message.unread);
      for (const message of unreadMessages) {
        await this.getAgentMailClient().updateMessage(account.inboxId, message.providerMessageId, {
          removeLabels: ["unread"],
          addLabels: ["read"],
        });
      }
    } else {
      const channel = this.channelRepo.findByType("email");
      if (!channel) throw new Error("Email channel is not configured");
      const cfg = (channel.config as Any) || {};
      if (asString(cfg.protocol) === "loom") {
        const loomBaseUrl = asString(cfg.loomBaseUrl);
        const accessToken = asString(cfg.loomAccessToken);
        const identity = asString(cfg.loomIdentity) || loomBaseUrl;
        if (!loomBaseUrl || !accessToken || !identity) {
          throw new Error("LOOM email channel is missing mailbox credentials.");
        }
        const mailbox = asString(cfg.loomMailboxFolder) || "INBOX";
        const client = new LoomEmailClient({
          baseUrl: loomBaseUrl,
          accessTokenProvider: () => accessToken,
          identity,
          folder: assertSafeLoomMailboxFolder(mailbox),
          pollInterval: asNumber(cfg.loomPollInterval) ?? 30000,
          verbose: process.env.NODE_ENV === "development",
        });
        const latest = thread.messages.filter((message) => message.unread).slice(-1)[0];
        const uid = Number(latest?.providerMessageId);
        if (!Number.isFinite(uid)) {
          throw new Error("Unable to resolve LOOM UID for mark_read");
        }
        await client.markAsRead(uid);
      } else {
        const client = this.createStandardEmailClient(channel.id, cfg);
        const uid = await this.resolveImapUidForMarkRead(thread.id, client);
        if (uid === null || !Number.isFinite(uid)) {
          throw new Error("Unable to resolve IMAP UID for mark_read");
        }
        await client.markAsRead(uid);
      }
    }

    this.db.prepare("UPDATE mailbox_messages SET is_unread = 0 WHERE thread_id = ?").run(thread.id);
    this.db
      .prepare("UPDATE mailbox_threads SET unread_count = 0, handled = CASE WHEN needs_reply = 0 THEN 1 ELSE handled END, updated_at = ? WHERE id = ?")
      .run(Date.now(), thread.id);
  }

  private async applyMarkUnread(thread: MailboxThreadDetail | (MailboxThreadListItem & { messages: MailboxMessage[] })): Promise<void> {
    const latestMessage = [...thread.messages].sort((a, b) => b.receivedAt - a.receivedAt)[0];
    if (thread.provider === "gmail") {
      const settings = GoogleWorkspaceSettingsManager.loadSettings();
      await gmailRequest(settings, {
        method: "POST",
        path: `/users/me/threads/${encodeURIComponent(thread.providerThreadId)}/modify`,
        body: {
          addLabelIds: ["UNREAD"],
        },
      });
    } else if (thread.provider === "agentmail") {
      const account = this.parseAgentMailAccountId(thread.accountId);
      if (!account || !latestMessage) {
        throw new Error("Unable to resolve AgentMail message for mark_unread.");
      }
      await this.getAgentMailClient().updateMessage(account.inboxId, latestMessage.providerMessageId, {
        removeLabels: ["read"],
        addLabels: ["unread"],
      });
    } else {
      const channel = this.channelRepo.findByType("email");
      if (!channel) throw new Error("Email channel is not configured");
      const cfg = (channel.config as Any) || {};
      if (asString(cfg.protocol) === "loom") {
        const loomBaseUrl = asString(cfg.loomBaseUrl);
        const accessToken = asString(cfg.loomAccessToken);
        const identity = asString(cfg.loomIdentity) || loomBaseUrl;
        if (!loomBaseUrl || !accessToken || !identity) {
          throw new Error("LOOM email channel is missing mailbox credentials.");
        }
        const mailbox = asString(cfg.loomMailboxFolder) || "INBOX";
        const client = new LoomEmailClient({
          baseUrl: loomBaseUrl,
          accessTokenProvider: () => accessToken,
          identity,
          folder: assertSafeLoomMailboxFolder(mailbox),
          pollInterval: asNumber(cfg.loomPollInterval) ?? 30000,
          verbose: process.env.NODE_ENV === "development",
        });
        const uid = Number(latestMessage?.providerMessageId);
        if (!Number.isFinite(uid)) {
          throw new Error("Unable to resolve LOOM UID for mark_unread");
        }
        await client.markAsUnread(uid);
      } else {
        const client = this.createStandardEmailClient(channel.id, cfg);
        const uid = await this.resolveImapUidForMarkRead(thread.id, client);
        if (uid === null || !Number.isFinite(uid)) {
          throw new Error("Unable to resolve IMAP UID for mark_unread");
        }
        await client.markAsUnread(uid);
      }
    }

    const targetMessageId = latestMessage?.id || null;
    if (targetMessageId) {
      this.db
        .prepare("UPDATE mailbox_messages SET is_unread = CASE WHEN id = ? THEN 1 ELSE is_unread END, updated_at = ? WHERE thread_id = ?")
        .run(targetMessageId, Date.now(), thread.id);
    }
    this.db
      .prepare("UPDATE mailbox_threads SET unread_count = 1, handled = 0, updated_at = ? WHERE id = ?")
      .run(Date.now(), thread.id);
  }

  private extractStoredImapUid(row: Pick<MailboxMessageRow, "provider_message_id" | "metadata_json">): number | null {
    const providerUid = Number(row.provider_message_id);
    if (Number.isFinite(providerUid)) {
      return providerUid;
    }
    const metadata = parseMailboxMessageMetadata(row.metadata_json);
    return Number.isFinite(metadata.imapUid) ? metadata.imapUid || null : null;
  }

  private mailboxRowMatchesImapMessage(
    row: Pick<MailboxMessageRow, "subject" | "from_email" | "received_at">,
    message: EmailMessage,
  ): boolean {
    const rowSubject = normalizeWhitespace(row.subject || "", 160).toLowerCase();
    const messageSubject = normalizeWhitespace(message.subject || "", 160).toLowerCase();
    const rowFrom = normalizeEmailAddress(row.from_email || "");
    const messageFrom = normalizeEmailAddress(message.from?.address || "");
    return (
      rowSubject.length > 0 &&
      rowSubject === messageSubject &&
      rowFrom !== null &&
      rowFrom.length > 0 &&
      rowFrom === messageFrom &&
      Math.abs(message.date.getTime() - row.received_at) <= 5 * 60 * 1000
    );
  }

  private persistResolvedImapMessageMetadata(
    row: Pick<MailboxMessageRow, "id" | "metadata_json">,
    message: EmailMessage,
  ): void {
    const previous = parseMailboxMessageMetadata(row.metadata_json);
    this.db
      .prepare("UPDATE mailbox_messages SET metadata_json = ?, updated_at = ? WHERE id = ?")
      .run(
        JSON.stringify({
          ...previous,
          imapUid: message.uid,
          rfcMessageId: message.messageId,
        }),
        Date.now(),
        row.id,
      );
  }

  private async resolveImapUidForMarkRead(threadId: string, client: EmailClient): Promise<number | null> {
    const rows = this.db
      .prepare(
        `SELECT
           id,
           provider_message_id,
           subject,
           from_email,
           received_at,
           is_unread,
           metadata_json
         FROM mailbox_messages
         WHERE thread_id = ?
         ORDER BY is_unread DESC, received_at DESC`,
      )
      .all(threadId) as Array<
      Pick<
        MailboxMessageRow,
        "id" | "provider_message_id" | "subject" | "from_email" | "received_at" | "is_unread" | "metadata_json"
      >
    >;

    for (const row of rows) {
      const uid = this.extractStoredImapUid(row);
      if (Number.isFinite(uid)) {
        return uid;
      }
    }

    const remoteMessages = await client.fetchRecentEmails(Math.min(Math.max(rows.length * 10, 25), 200));
    const priorityRows = rows.some((row) => Boolean(row.is_unread))
      ? rows.filter((row) => Boolean(row.is_unread))
      : rows;

    for (const row of priorityRows) {
      const metadata = parseMailboxMessageMetadata(row.metadata_json);
      const candidateIds = new Set(
        [row.provider_message_id, metadata.rfcMessageId].filter((value): value is string => Boolean(value)),
      );
      const match =
        remoteMessages.find((message) => candidateIds.has(message.messageId)) ||
        remoteMessages.find((message) => this.mailboxRowMatchesImapMessage(row, message));
      if (!match || !Number.isFinite(match.uid)) {
        continue;
      }
      this.persistResolvedImapMessageMetadata(row, match);
      mailboxLogger.warn("Recovered legacy IMAP UID for mailbox mark_read", {
        threadId,
        mailboxMessageId: row.id,
        messageId: match.messageId,
        uid: match.uid,
      });
      return match.uid;
    }

    return null;
  }

  private async applyLabel(
    thread: MailboxThreadDetail | (MailboxThreadListItem & { messages: MailboxMessage[] }),
    label: string,
  ): Promise<void> {
    if (thread.provider === "agentmail") {
      const account = this.parseAgentMailAccountId(thread.accountId);
      const latestMessage = [...thread.messages].sort((a, b) => b.receivedAt - a.receivedAt)[0];
      if (!account || !latestMessage) {
        throw new Error("Unable to resolve AgentMail message for label update.");
      }
      await this.getAgentMailClient().updateMessage(account.inboxId, latestMessage.providerMessageId, {
        addLabels: [label],
      });
    } else if (thread.provider !== "gmail") {
      throw new Error("Label actions are only supported for Gmail- or AgentMail-backed threads.");
    } else {
      const settings = GoogleWorkspaceSettingsManager.loadSettings();
      await gmailRequest(settings, {
        method: "POST",
        path: `/users/me/threads/${encodeURIComponent(thread.providerThreadId)}/modify`,
        body: {
          addLabelIds: [label],
        },
      });
    }

    const labels = Array.from(new Set([...thread.labels, label]));
    this.db
      .prepare("UPDATE mailbox_threads SET labels_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(labels), Date.now(), thread.id);
  }

  private async applySendDraft(
    thread: MailboxThreadDetail | (MailboxThreadListItem & { messages: MailboxMessage[] }),
    draftId?: string,
    override?: { subject?: string; body?: string },
  ): Promise<void> {
    const drafts = this.getDraftsForThread(thread.id);
    const draft = draftId ? drafts.find((entry) => entry.id === draftId) : drafts[0];
    if (!draft) throw new Error("Draft not found");

    const recipient = thread.participants[0]?.email;
    if (!recipient) throw new Error("No recipient found for draft");

    const subject = override?.subject?.trim() || draft.subject;
    const body = override?.body ?? draft.body;

    if (subject !== draft.subject || body !== draft.body) {
      this.db
        .prepare(
          `UPDATE mailbox_drafts
           SET subject = ?,
               body_text = ?,
               updated_at = ?
           WHERE id = ?`,
        )
        .run(subject, body, Date.now(), draft.id);
    }

    if (thread.provider === "gmail") {
      const settings = GoogleWorkspaceSettingsManager.loadSettings();
      const stripCRLF = (v: string) => v.replace(/[\r\n]/g, "");
      const raw = Buffer.from(
        [
          `To: ${stripCRLF(recipient)}`,
          `Subject: ${stripCRLF(subject)}`,
          "MIME-Version: 1.0",
          'Content-Type: text/plain; charset="UTF-8"',
          "",
          body,
        ].join("\r\n"),
      )
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      await gmailRequest(settings, {
        method: "POST",
        path: "/users/me/messages/send",
        body: {
          raw,
          threadId: thread.providerThreadId,
        },
      });
    } else if (thread.provider === "agentmail") {
      const account = this.parseAgentMailAccountId(thread.accountId);
      const latestInbound = [...thread.messages]
        .filter((message) => message.direction === "incoming")
        .sort((a, b) => b.receivedAt - a.receivedAt)[0];
      if (!account || !latestInbound) {
        throw new Error("Unable to resolve AgentMail reply target.");
      }
      await this.getAgentMailClient().replyAllMessage(account.inboxId, latestInbound.providerMessageId, {
        text: body,
        subject,
      });
    } else {
      const channel = this.channelRepo.findByType("email");
      if (!channel) throw new Error("Email channel is not configured");
      const cfg = (channel.config as Any) || {};
      const client = this.createStandardEmailClient(channel.id, cfg);
      await client.sendEmail({
        to: recipient,
        subject,
        text: body,
      });
    }

    this.db
      .prepare("DELETE FROM mailbox_drafts WHERE id = ?")
      .run(draft.id);
    this.db
      .prepare(
        `UPDATE mailbox_threads
         SET needs_reply = 0,
             handled = 1,
             today_bucket = CASE WHEN today_bucket = 'needs_action' THEN 'good_to_know' ELSE today_bucket END,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(Date.now(), thread.id);
    this.updateProposalStatusByThreadAndType(thread.id, "reply", "applied");
  }

  private async applySendMessage(
    thread: MailboxThreadDetail | (MailboxThreadListItem & { messages: MailboxMessage[] }),
    input: {
      mode: "reply" | "reply_all" | "forward";
      to: string[];
      cc: string[];
      bcc: string[];
      subject?: string;
      body?: string;
    },
  ): Promise<void> {
    const to = this.normalizeRecipientEmails(input.to);
    const cc = this.normalizeRecipientEmails(input.cc);
    const bcc = this.normalizeRecipientEmails(input.bcc);
    const allRecipients = [...to, ...cc, ...bcc];
    if (!allRecipients.length) throw new Error("Add at least one recipient before sending.");

    const body = input.body || "";
    if (!body.trim()) throw new Error("Write a message before sending.");

    const subject =
      input.subject?.trim() ||
      this.prefixMailboxSubject(thread.subject, input.mode === "forward" ? "Fwd:" : "Re:");

    if (thread.provider === "gmail") {
      const settings = GoogleWorkspaceSettingsManager.loadSettings();
      const stripCRLF = (value: string) => value.replace(/[\r\n]/g, "");
      const headers = [
        `To: ${to.map(stripCRLF).join(", ")}`,
        cc.length ? `Cc: ${cc.map(stripCRLF).join(", ")}` : null,
        bcc.length ? `Bcc: ${bcc.map(stripCRLF).join(", ")}` : null,
        `Subject: ${stripCRLF(subject)}`,
        "MIME-Version: 1.0",
        'Content-Type: text/plain; charset="UTF-8"',
      ].filter((entry): entry is string => Boolean(entry));
      const raw = Buffer.from([...headers, "", body].join("\r\n"))
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      await gmailRequest(settings, {
        method: "POST",
        path: "/users/me/messages/send",
        body: {
          raw,
          threadId: input.mode === "forward" ? undefined : thread.providerThreadId,
        },
      });
    } else if (thread.provider === "agentmail") {
      if (input.mode === "forward") {
        throw new Error("Manual forward is not available for AgentMail threads yet.");
      }
      const account = this.parseAgentMailAccountId(thread.accountId);
      const latestInbound = [...thread.messages]
        .filter((message) => message.direction === "incoming")
        .sort((a, b) => b.receivedAt - a.receivedAt)[0];
      if (!account || !latestInbound) {
        throw new Error("Unable to resolve AgentMail reply target.");
      }
      await this.getAgentMailClient().replyAllMessage(account.inboxId, latestInbound.providerMessageId, {
        text: body,
        subject,
      });
    } else {
      const channel = this.channelRepo.findByType("email");
      if (!channel) throw new Error("Email channel is not configured");
      const cfg = (channel.config as Any) || {};
      const client = this.createStandardEmailClient(channel.id, cfg);
      await client.sendEmail({
        to,
        cc,
        bcc,
        subject,
        text: body,
      });
    }

    if (input.mode !== "forward") {
      this.db
        .prepare(
          `UPDATE mailbox_threads
           SET needs_reply = 0,
               handled = 1,
               today_bucket = CASE WHEN today_bucket = 'needs_action' THEN 'good_to_know' ELSE today_bucket END,
               updated_at = ?
           WHERE id = ?`,
        )
        .run(Date.now(), thread.id);
      this.updateProposalStatusByThreadAndType(thread.id, "reply", "applied");
    }
  }

  private async applyDiscardDraft(
    thread: MailboxThreadDetail | (MailboxThreadListItem & { messages: MailboxMessage[] }),
    draftId?: string,
  ): Promise<void> {
    const drafts = this.getDraftsForThread(thread.id);
    const draft = draftId ? drafts.find((entry) => entry.id === draftId) : drafts[0];
    if (!draft) throw new Error("Draft not found");

    this.db
      .prepare("DELETE FROM mailbox_drafts WHERE id = ?")
      .run(draft.id);

    this.updateProposalStatusByThreadAndType(thread.id, "reply", "dismissed");
  }

  private async applyScheduleEvent(
    thread: MailboxThreadDetail | (MailboxThreadListItem & { messages: MailboxMessage[] }),
    proposalId?: string,
  ): Promise<void> {
    if (!GoogleWorkspaceSettingsManager.loadSettings().enabled) {
      throw new Error("Google Calendar must be connected before creating schedule events.");
    }
    const proposal =
      proposalId
        ? this.getProposalsForThread(thread.id).find((entry) => entry.id === proposalId)
        : undefined;
    const previewOptions = Array.isArray(proposal?.preview?.slotOptions)
      ? proposal.preview.slotOptions
          .map((value) => {
            const record = asObject(value);
            const label = asString(record?.label);
            const start = asString(record?.start);
            const end = asString(record?.end);
            if (!label || !start || !end) return null;
            return { label, start, end } satisfies ScheduleOption;
          })
          .filter((value): value is ScheduleOption => Boolean(value))
      : [];
    const selectedOption = previewOptions[0] || (await this.getScheduleSuggestion()).options[0];
    if (!selectedOption) {
      throw new Error("No schedule slot is available");
    }

    await googleCalendarRequest(GoogleWorkspaceSettingsManager.loadSettings(), {
      method: "POST",
      path: "/calendars/primary/events",
      body: {
        summary: thread.subject,
        description: `Scheduled from Inbox Agent. Suggested slot: ${selectedOption.label}`,
        start: { dateTime: selectedOption.start },
        end: { dateTime: selectedOption.end },
        attendees: thread.participants.slice(0, 1).map((participant) => ({ email: participant.email })),
      },
    });

    this.updateProposalStatusByThreadAndType(thread.id, "schedule", "applied");
  }

  private updateProposalStatus(proposalId: string, status: MailboxProposalStatus): void {
    this.db
      .prepare(
        `UPDATE mailbox_action_proposals
         SET status = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(status, Date.now(), proposalId);
  }

  private updateProposalStatusByThreadAndType(
    threadId: string,
    type: MailboxProposalType,
    status: MailboxProposalStatus,
  ): void {
    this.db
      .prepare(
        `UPDATE mailbox_action_proposals
         SET status = ?, updated_at = ?
         WHERE thread_id = ? AND proposal_type = ?`,
      )
      .run(status, Date.now(), threadId, type);
  }

  private threadIdFromProposal(proposalId?: string): string | undefined {
    if (!proposalId) return undefined;
    const row = this.db
      .prepare("SELECT thread_id FROM mailbox_action_proposals WHERE id = ?")
      .get(proposalId) as { thread_id: string } | undefined;
    return row?.thread_id;
  }

  private updateContactOpenCommitments(threadId: string): void {
    const contact = this.getPrimaryContactMemory(threadId);
    if (!contact) return;
    const openCount = this.getCommitmentsForThread(threadId).filter((item) =>
      item.state === "suggested" || item.state === "accepted",
    ).length;
    this.db
      .prepare(
        `UPDATE mailbox_contacts
         SET open_commitments = ?, updated_at = ?
         WHERE email = ?`,
      )
      .run(openCount, Date.now(), contact.email);
  }

  private upsertProposal(input: {
    threadId: string;
    type: MailboxProposalType;
    title: string;
    reasoning: string;
    preview?: Record<string, unknown>;
  }): void {
    const existing = this.db
      .prepare(
        `SELECT id
         FROM mailbox_action_proposals
         WHERE thread_id = ? AND proposal_type = ? AND status = 'suggested'
         LIMIT 1`,
      )
      .get(input.threadId, input.type) as { id: string } | undefined;
    const now = Date.now();
    if (existing?.id) {
      this.db
        .prepare(
          `UPDATE mailbox_action_proposals
           SET title = ?, reasoning = ?, preview_json = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          input.title,
          input.reasoning,
          input.preview ? JSON.stringify(input.preview) : null,
          now,
          existing.id,
        );
      return;
    }

    this.db
      .prepare(
        `INSERT INTO mailbox_action_proposals
          (id, thread_id, proposal_type, title, reasoning, preview_json, status, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.threadId,
        input.type,
        input.title,
        input.reasoning,
        input.preview ? JSON.stringify(input.preview) : null,
        "suggested",
        JSON.stringify({ source: "mailbox-service" }),
        now,
        now,
      );
  }

  private hasEmailChannel(): boolean {
    const channel = this.channelRepo.findByType("email");
    return Boolean(channel?.enabled);
  }

  private async getEmailOAuthAccessToken(channelId: string): Promise<string> {
    const channel = this.channelRepo.findById(channelId);
    if (!channel || channel.type !== "email") {
      throw new Error("Email channel not found");
    }

    const config = (channel.config as Any) || {};
    if ((config.authMethod as string | undefined) !== "oauth") {
      throw new Error("Email channel is not configured for OAuth");
    }

    const accessToken = asString(config.accessToken);
    const tokenExpiresAt = asNumber(config.tokenExpiresAt);
    const now = Date.now();
    if (accessToken && (!tokenExpiresAt || now < tokenExpiresAt - 2 * 60 * 1000)) {
      return accessToken;
    }

    if ((config.oauthProvider as string | undefined) !== "microsoft") {
      throw new Error("Unsupported email OAuth provider");
    }

    const oauthClientId = asString(config.oauthClientId);
    const refreshToken = asString(config.refreshToken);
    if (!oauthClientId || !refreshToken) {
      if (accessToken) return accessToken;
      throw new Error("Email OAuth refresh token is required");
    }

    const refreshed = await refreshMicrosoftEmailAccessToken({
      clientId: oauthClientId,
      clientSecret: asString(config.oauthClientSecret) || undefined,
      refreshToken,
      tenant: asString(config.oauthTenant) || MICROSOFT_EMAIL_DEFAULT_TENANT,
    });

    const nextConfig = {
      ...config,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken || refreshToken,
      tokenExpiresAt: refreshed.expiresIn ? Date.now() + refreshed.expiresIn * 1000 : tokenExpiresAt,
      scopes: refreshed.scopes || (config.scopes as string[] | undefined),
    };
    this.channelRepo.update(channelId, { config: nextConfig });
    return refreshed.accessToken;
  }

  private createStandardEmailClient(channelId: string, config: Any): EmailClient {
    const authMethod = asString(config.authMethod) === "oauth" ? "oauth" : "password";
    return new EmailClient({
      authMethod,
      accessToken: authMethod === "oauth" ? asString(config.accessToken) || undefined : undefined,
      oauthAccessTokenProvider:
        authMethod === "oauth" ? async () => this.getEmailOAuthAccessToken(channelId) : undefined,
      imapHost: asString(config.imapHost) || "",
      imapPort: asNumber(config.imapPort) ?? 993,
      imapSecure: asBoolean(config.imapSecure) ?? true,
      smtpHost: asString(config.smtpHost) || "",
      smtpPort: asNumber(config.smtpPort) ?? 587,
      smtpSecure: asBoolean(config.smtpSecure) ?? false,
      email: asString(config.email) || "",
      password: authMethod === "password" ? asString(config.password) || "" : undefined,
      displayName: asString(config.displayName) || undefined,
      mailbox: asString(config.mailbox) || "INBOX",
      pollInterval: 30000,
      verbose: process.env.NODE_ENV === "development",
    });
  }

  private getMailboxSyncHealth(accounts: MailboxAccount[]): MailboxSyncHealth[] {
    const queueRows = this.db
      .prepare(
        `SELECT account_id, status, COUNT(*) AS count
         FROM mailbox_queued_actions
         GROUP BY account_id, status`,
      )
      .all() as Array<{ account_id: string | null; status: string; count: number }>;
    const draftRows = this.db
      .prepare(
        `SELECT account_id, status, COUNT(*) AS count
         FROM mailbox_compose_drafts
         WHERE status NOT IN ('discarded', 'sent')
         GROUP BY account_id, status`,
      )
      .all() as Array<{ account_id: string; status: string; count: number }>;

    return accounts.map((account) => {
      const queuedActionCount = queueRows
        .filter((row) => row.account_id === account.id && row.status === "queued")
        .reduce((sum, row) => sum + row.count, 0);
      const failedActionCount = queueRows
        .filter((row) => row.account_id === account.id && row.status === "failed")
        .reduce((sum, row) => sum + row.count, 0);
      const draftCount = draftRows
        .filter((row) => row.account_id === account.id)
        .reduce((sum, row) => sum + row.count, 0);
      const scheduledSendCount = draftRows
        .filter((row) => row.account_id === account.id && row.status === "scheduled")
        .reduce((sum, row) => sum + row.count, 0);
      const backend = account.backend || "imap_smtp";
      return {
        accountId: account.id,
        provider: account.provider,
        backend,
        status: account.status,
        capabilities: account.capabilities,
        lastSyncedAt: account.lastSyncedAt,
        queuedActionCount,
        failedActionCount,
        draftCount,
        scheduledSendCount,
        statusLabel:
          account.status === "connected"
            ? `${backend.replace("_", " ")} connected`
            : account.status === "degraded"
              ? `${backend.replace("_", " ")} needs attention`
              : "Reconnect mailbox",
      };
    });
  }

  private listMailboxFolders(): MailboxFolder[] {
    const rows = this.db
      .prepare(
        `SELECT id, account_id, provider_folder_id, name, role, unread_count, total_count, created_at, updated_at
         FROM mailbox_folders
         ORDER BY account_id, role, name`,
      )
      .all() as MailboxFolderRow[];
    const persisted = rows.map((row) => this.mapMailboxFolderRow(row));
    const existingKeys = new Set(persisted.map((folder) => `${folder.accountId}:${folder.role}`));
    const synthetic: MailboxFolder[] = [];
    const accounts = this.db
      .prepare(`SELECT id, provider, address, display_name, status, capabilities_json, sync_cursor, classification_initial_batch_at, last_synced_at FROM mailbox_accounts`)
      .all() as MailboxAccountRow[];
    const standard: Array<{ role: MailboxFolder["role"]; name: string }> = [
      { role: "inbox", name: "Inbox" },
      { role: "sent", name: "Sent" },
      { role: "drafts", name: "Drafts" },
      { role: "scheduled", name: "Scheduled" },
      { role: "archive", name: "Archive" },
      { role: "trash", name: "Trash" },
      { role: "spam", name: "Spam" },
    ];
    const now = Date.now();
    for (const account of accounts) {
      for (const folder of standard) {
        if (existingKeys.has(`${account.id}:${folder.role}`)) continue;
        synthetic.push({
          id: `${account.id}:${folder.role}`,
          accountId: account.id,
          providerFolderId: folder.role,
          name: folder.name,
          role: folder.role,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
    return [...persisted, ...synthetic];
  }

  private listMailboxLabels(): MailboxLabel[] {
    const rows = this.db
      .prepare(
        `SELECT id, account_id, provider_label_id, name, color, unread_count, total_count, created_at, updated_at
         FROM mailbox_labels
         ORDER BY account_id, name`,
      )
      .all() as MailboxLabelRow[];
    return rows.map((row) => this.mapMailboxLabelRow(row));
  }

  private listMailboxIdentities(): MailboxIdentity[] {
    const rows = this.db
      .prepare(
        `SELECT id, account_id, provider_identity_id, email, display_name, signature_id, is_default, created_at, updated_at
         FROM mailbox_identities
         ORDER BY account_id, is_default DESC, email`,
      )
      .all() as MailboxIdentityRow[];
    const identities = rows.map((row) => this.mapMailboxIdentityRow(row));
    const existingAccounts = new Set(identities.map((identity) => identity.accountId));
    const accounts = this.db
      .prepare(`SELECT id, provider, address, display_name, status, capabilities_json, sync_cursor, classification_initial_batch_at, last_synced_at FROM mailbox_accounts`)
      .all() as MailboxAccountRow[];
    const now = Date.now();
    return [
      ...identities,
      ...accounts
        .filter((account) => !existingAccounts.has(account.id))
        .map((account) => ({
          id: `${account.id}:default`,
          accountId: account.id,
          email: account.address,
          displayName: account.display_name || undefined,
          isDefault: true,
          createdAt: now,
          updatedAt: now,
        })),
    ];
  }

  private listMailboxSignatures(): MailboxSignature[] {
    const rows = this.db
      .prepare(
        `SELECT id, account_id, name, body_html, body_text, is_default, created_at, updated_at
         FROM mailbox_signatures
         ORDER BY account_id, is_default DESC, name`,
      )
      .all() as MailboxSignatureRow[];
    return rows.map((row) => this.mapMailboxSignatureRow(row));
  }

  private listMailboxComposeDrafts(): MailboxComposeDraft[] {
    const rows = this.db
      .prepare(
        `SELECT id, account_id, thread_id, provider_draft_id, mode, status, subject, body_text, body_html,
                to_json, cc_json, bcc_json, identity_id, signature_id, attachments_json, scheduled_at,
                send_after, latest_error, created_at, updated_at
         FROM mailbox_compose_drafts
         WHERE status != 'discarded'
         ORDER BY updated_at DESC
         LIMIT 100`,
      )
      .all() as MailboxComposeDraftRow[];
    return rows.map((row) => this.mapMailboxComposeDraftRow(row));
  }

  private listMailboxQueuedActions(): MailboxQueuedAction[] {
    const rows = this.db
      .prepare(
        `SELECT id, account_id, thread_id, draft_id, action_type, status, payload_json, attempts, next_attempt_at,
                latest_error, undo_of_action_id, created_at, updated_at
         FROM mailbox_queued_actions
         WHERE status IN ('queued', 'running', 'failed')
         ORDER BY updated_at DESC
         LIMIT 100`,
      )
      .all() as MailboxQueuedActionRow[];
    return rows.map((row) => this.mapMailboxQueuedActionRow(row));
  }

  private listMailboxOutgoingMessages(): MailboxOutgoingMessage[] {
    const rows = this.db
      .prepare(
        `SELECT id, draft_id, account_id, status, provider_message_id, scheduled_at, send_after, latest_error, created_at, updated_at
         FROM mailbox_outgoing_messages
         WHERE status IN ('queued', 'running', 'failed')
         ORDER BY updated_at DESC
         LIMIT 100`,
      )
      .all() as MailboxOutgoingMessageRow[];
    return rows.map((row) => this.mapMailboxOutgoingMessageRow(row));
  }

  private getMailboxClientSettings(): MailboxClientState["settings"] {
    const row = this.db
      .prepare(
        `SELECT remote_content_policy, send_delay_seconds, sync_recent_days, attachment_cache, notifications
         FROM mailbox_client_settings
         WHERE id = 'default'`,
      )
      .get() as
      | {
          remote_content_policy: MailboxClientState["settings"]["remoteContentPolicy"];
          send_delay_seconds: number;
          sync_recent_days: number;
          attachment_cache: MailboxClientState["settings"]["attachmentCache"];
          notifications: MailboxClientState["settings"]["notifications"];
        }
      | undefined;
    return {
      remoteContentPolicy: row?.remote_content_policy || "load",
      sendDelaySeconds: Number.isFinite(row?.send_delay_seconds) ? row!.send_delay_seconds : 30,
      syncRecentDays: Number.isFinite(row?.sync_recent_days) ? row!.sync_recent_days : 30,
      attachmentCache: row?.attachment_cache || "metadata_on_demand",
      notifications: row?.notifications || "needs_reply",
    };
  }

  private getMailboxComposeDraft(draftId: string): MailboxComposeDraft | null {
    const row = this.db
      .prepare(
        `SELECT id, account_id, thread_id, provider_draft_id, mode, status, subject, body_text, body_html,
                to_json, cc_json, bcc_json, identity_id, signature_id, attachments_json, scheduled_at,
                send_after, latest_error, created_at, updated_at
         FROM mailbox_compose_drafts
         WHERE id = ?`,
      )
      .get(draftId) as MailboxComposeDraftRow | undefined;
    return row ? this.mapMailboxComposeDraftRow(row) : null;
  }

  private getMailboxOutgoingMessage(id: string): MailboxOutgoingMessage | null {
    const row = this.db
      .prepare(
        `SELECT id, draft_id, account_id, status, provider_message_id, scheduled_at, send_after, latest_error, created_at, updated_at
         FROM mailbox_outgoing_messages
         WHERE id = ?`,
      )
      .get(id) as MailboxOutgoingMessageRow | undefined;
    return row ? this.mapMailboxOutgoingMessageRow(row) : null;
  }

  private getMailboxQueuedAction(actionId: string): MailboxQueuedAction | null {
    const row = this.db
      .prepare(
        `SELECT id, account_id, thread_id, draft_id, action_type, status, payload_json, attempts, next_attempt_at,
                latest_error, undo_of_action_id, created_at, updated_at
         FROM mailbox_queued_actions
         WHERE id = ?`,
      )
      .get(actionId) as MailboxQueuedActionRow | undefined;
    return row ? this.mapMailboxQueuedActionRow(row) : null;
  }

  private enqueueMailboxAction(input: {
    accountId?: string;
    threadId?: string;
    draftId?: string;
    type: MailboxQueuedAction["type"];
    payload: Record<string, unknown>;
    nextAttemptAt?: number;
    undoOfActionId?: string;
  }): MailboxQueuedAction {
    const now = Date.now();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO mailbox_queued_actions
          (id, account_id, thread_id, draft_id, action_type, status, payload_json, attempts, next_attempt_at, latest_error, undo_of_action_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'queued', ?, 0, ?, NULL, ?, ?, ?)`,
      )
      .run(
        id,
        input.accountId || null,
        input.threadId || null,
        input.draftId || null,
        input.type,
        JSON.stringify(input.payload || {}),
        input.nextAttemptAt || Date.now(),
        input.undoOfActionId || null,
        now,
        now,
      );
    return this.getMailboxQueuedAction(id)!;
  }

  private resolveComposeAccountId(accountId?: string, threadId?: string): string {
    if (accountId) return accountId;
    if (threadId) {
      const row = this.db.prepare("SELECT account_id FROM mailbox_threads WHERE id = ?").get(threadId) as
        | { account_id: string }
        | undefined;
      if (row?.account_id) return row.account_id;
    }
    const firstAccount = this.db
      .prepare("SELECT id FROM mailbox_accounts ORDER BY updated_at DESC LIMIT 1")
      .get() as { id: string } | undefined;
    if (!firstAccount?.id) throw new Error("Connect a mailbox account before composing.");
    return firstAccount.id;
  }

  private buildReplyRecipients(thread: MailboxThreadDetail | null, replyAll: boolean): MailboxRecipientInput[] {
    if (!thread) return [];
    const latestIncoming = [...thread.messages].reverse().find((message) => message.direction === "incoming");
    const recipients = new Map<string, MailboxRecipientInput>();
    const add = (participant?: MailboxParticipant) => {
      if (!participant?.email) return;
      const normalized = normalizeMailboxEmailAddress(participant.email);
      if (!normalized) return;
      recipients.set(normalized, { email: participant.email, name: participant.name });
    };
    add(latestIncoming?.from || thread.participants[0]);
    if (replyAll && latestIncoming) {
      for (const participant of latestIncoming.to) add(participant);
      for (const participant of latestIncoming.cc) add(participant);
    }
    return Array.from(recipients.values());
  }

  private prefixMailboxSubject(subject: string, prefix: string): string {
    const trimmed = subject.trim();
    return trimmed.toLowerCase().startsWith(prefix.toLowerCase()) ? trimmed : `${prefix} ${trimmed}`;
  }

  private normalizeRecipients(recipients: MailboxRecipientInput[]): MailboxRecipientInput[] {
    return recipients
      .map((recipient) => ({
        email: normalizeMailboxEmailAddress(recipient.email),
        name: recipient.name?.trim() || undefined,
      }))
      .filter((recipient) => recipient.email.includes("@"));
  }

  private normalizeRecipientEmails(recipients: string[]): string[] {
    return Array.from(
      new Set(
        recipients
          .flatMap((recipient) => recipient.split(/[,\n;]/))
          .map((recipient) => normalizeMailboxEmailAddress(recipient))
          .filter((recipient) => recipient.includes("@")),
      ),
    );
  }

  private mapMailboxFolderRow(row: MailboxFolderRow): MailboxFolder {
    return {
      id: row.id,
      accountId: row.account_id,
      providerFolderId: row.provider_folder_id,
      name: row.name,
      role: row.role,
      unreadCount: row.unread_count ?? undefined,
      totalCount: row.total_count ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapMailboxLabelRow(row: MailboxLabelRow): MailboxLabel {
    return {
      id: row.id,
      accountId: row.account_id,
      providerLabelId: row.provider_label_id,
      name: row.name,
      color: row.color || undefined,
      unreadCount: row.unread_count ?? undefined,
      totalCount: row.total_count ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapMailboxIdentityRow(row: MailboxIdentityRow): MailboxIdentity {
    return {
      id: row.id,
      accountId: row.account_id,
      providerIdentityId: row.provider_identity_id || undefined,
      email: row.email,
      displayName: row.display_name || undefined,
      signatureId: row.signature_id || undefined,
      isDefault: Boolean(row.is_default),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapMailboxSignatureRow(row: MailboxSignatureRow): MailboxSignature {
    return {
      id: row.id,
      accountId: row.account_id,
      name: row.name,
      bodyHtml: row.body_html || undefined,
      bodyText: row.body_text,
      isDefault: Boolean(row.is_default),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapMailboxComposeDraftRow(row: MailboxComposeDraftRow): MailboxComposeDraft {
    return {
      id: row.id,
      accountId: row.account_id,
      mode: row.mode,
      status: row.status,
      threadId: row.thread_id || undefined,
      providerDraftId: row.provider_draft_id || undefined,
      subject: row.subject,
      bodyText: row.body_text,
      bodyHtml: row.body_html || undefined,
      to: parseJsonArray<MailboxRecipientInput>(row.to_json),
      cc: parseJsonArray<MailboxRecipientInput>(row.cc_json),
      bcc: parseJsonArray<MailboxRecipientInput>(row.bcc_json),
      identityId: row.identity_id || undefined,
      signatureId: row.signature_id || undefined,
      attachments: parseJsonArray<MailboxComposeDraft["attachments"][number]>(row.attachments_json),
      scheduledAt: row.scheduled_at || undefined,
      sendAfter: row.send_after || undefined,
      latestError: row.latest_error || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapMailboxOutgoingMessageRow(row: MailboxOutgoingMessageRow): MailboxOutgoingMessage {
    return {
      id: row.id,
      draftId: row.draft_id || undefined,
      accountId: row.account_id,
      status: row.status,
      providerMessageId: row.provider_message_id || undefined,
      scheduledAt: row.scheduled_at || undefined,
      sendAfter: row.send_after || undefined,
      latestError: row.latest_error || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapMailboxQueuedActionRow(row: MailboxQueuedActionRow): MailboxQueuedAction {
    return {
      id: row.id,
      accountId: row.account_id || undefined,
      threadId: row.thread_id || undefined,
      draftId: row.draft_id || undefined,
      type: row.action_type,
      status: row.status,
      payload: parseJsonObject(row.payload_json),
      attempts: row.attempts,
      nextAttemptAt: row.next_attempt_at || undefined,
      latestError: row.latest_error || undefined,
      undoOfActionId: row.undo_of_action_id || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapAccountRow(row: MailboxAccountRow): MailboxAccount {
    const storedCapabilities = parseJsonArray<string>(row.capabilities_json);
    const backend = resolveMailboxProviderBackend({
      provider: row.provider,
      capabilities: storedCapabilities,
    });
    return {
      id: row.id,
      provider: row.provider,
      address: row.address,
      displayName: row.display_name || undefined,
      status: row.status,
      capabilities: mergeMailboxCapabilities(storedCapabilities, backend),
      backend,
      lastSyncedAt: row.last_synced_at || undefined,
      classificationInitialBatchAt: row.classification_initial_batch_at || undefined,
    };
  }

  private threadMatchesQuery(row: MailboxThreadRow, query: string): boolean {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;

    const threadText = [
      row.subject,
      row.snippet,
      ...parseJsonArray<MailboxParticipant>(row.participants_json).flatMap((participant) => [
        participant.email,
        participant.name || "",
      ]),
      ...parseJsonArray<string>(row.labels_json),
    ]
      .join(" ")
      .toLowerCase();
    if (threadText.includes(needle)) return true;
    const attachmentRows = this.db
      .prepare(
        `SELECT ma.filename, mat.text_content
         FROM mailbox_attachments ma
         LEFT JOIN mailbox_attachment_text mat ON mat.attachment_id = ma.id
         WHERE ma.thread_id = ?`,
      )
      .all(row.id) as Array<{ filename: string; text_content: string | null }>;
    if (
      attachmentRows.some((attachment) =>
        `${attachment.filename} ${decryptMailboxValue(attachment.text_content || "")}`.toLowerCase().includes(needle),
      )
    ) {
      return true;
    }

    return this.getMessagesForThread(row.id).some((message) => {
      const messageText = [
        message.subject,
        message.snippet,
        message.body,
        message.from?.email,
        message.from?.name,
        ...message.to.map((participant) => participant.email),
        ...message.to.map((participant) => participant.name || ""),
        ...message.cc.map((participant) => participant.email),
        ...message.cc.map((participant) => participant.name || ""),
        ...message.bcc.map((participant) => participant.email),
        ...message.bcc.map((participant) => participant.name || ""),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return messageText.includes(needle);
    });
  }

  private threadMatchesAttachmentQuery(threadId: string, query: string): boolean {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;

    const attachmentRows = this.db
      .prepare(
        `SELECT ma.filename, mat.text_content
         FROM mailbox_attachments ma
         LEFT JOIN mailbox_attachment_text mat ON mat.attachment_id = ma.id
         WHERE ma.thread_id = ?`,
      )
      .all(threadId) as Array<{ filename: string; text_content: string | null }>;
    return attachmentRows.some((attachment) =>
      `${attachment.filename} ${decryptMailboxValue(attachment.text_content || "")}`.toLowerCase().includes(needle),
    );
  }

  private mapThreadRow(row: MailboxThreadRow, summary?: MailboxSummaryCard | null): MailboxThreadListItem {
    const sensitiveContent = this.readThreadSensitiveContent(row);
    return {
      id: row.id,
      accountId: row.account_id,
      provider: row.provider,
      providerThreadId: row.provider_thread_id,
      subject: row.subject,
      snippet: row.snippet,
      participants: parseJsonArray<MailboxParticipant>(row.participants_json),
      labels: parseJsonArray<string>(row.labels_json),
      category: row.category,
      todayBucket: normalizeTodayBucket(row.today_bucket, "more_to_browse"),
      domainCategory: normalizeDomainCategory(row.domain_category, "other"),
      priorityBand: priorityBandFromScore(row.priority_score),
      priorityScore: row.priority_score,
      urgencyScore: row.urgency_score,
      needsReply: Boolean(row.needs_reply),
      staleFollowup: Boolean(row.stale_followup),
      cleanupCandidate: Boolean(row.cleanup_candidate),
      handled: Boolean(row.handled),
      unreadCount: row.unread_count,
      messageCount: row.message_count,
      lastMessageAt: row.last_message_at,
      hasSensitiveContent: sensitiveContent.hasSensitiveContent,
      summary: summary ?? undefined,
      attachments: this.getAttachmentSummariesForThread(row.id),
      classificationState: row.classification_state,
    };
  }

  private getAttachmentSummariesForThread(threadId: string, limit = 6): MailboxAttachmentSummary[] {
    const rows = this.db
      .prepare(
        `SELECT id, message_id, filename, mime_type, size, extraction_status
         FROM mailbox_attachments
         WHERE thread_id = ?
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(threadId, Math.min(Math.max(limit, 1), 20)) as Array<{
      id: string;
      message_id: string;
      filename: string;
      mime_type: string | null;
      size: number | null;
      extraction_status: MailboxAttachmentSummary["extractionStatus"];
    }>;
    return rows.map((row) => ({
      id: row.id,
      messageId: row.message_id,
      filename: row.filename,
      mimeType: row.mime_type || undefined,
      size: row.size ?? undefined,
      extractionStatus: row.extraction_status || "not_indexed",
    }));
  }

  private mapMessageRow(row: MailboxMessageRow): MailboxMessage {
    return {
      id: row.id,
      threadId: row.thread_id,
      providerMessageId: row.provider_message_id,
      direction: row.direction,
      from: row.from_email
        ? {
            email: row.from_email,
            name: row.from_name || undefined,
          }
        : undefined,
      to: parseJsonArray<MailboxParticipant>(row.to_json),
      cc: parseJsonArray<MailboxParticipant>(row.cc_json),
      bcc: parseJsonArray<MailboxParticipant>(row.bcc_json),
      subject: row.subject,
      snippet: row.snippet,
      body: decryptMailboxValue(row.body_text) || "",
      bodyHtml: decryptMailboxValue(row.body_html) || undefined,
      receivedAt: row.received_at,
      unread: Boolean(row.is_unread),
    };
  }

  private mapSummaryRow(row: MailboxSummaryRow): MailboxSummaryCard {
    const raw = decryptMailboxValue(row.summary_text) || "";
    const cleaned = stripMailboxSummaryHtmlArtifacts(raw);
    return {
      summary: cleaned.trim() ? cleaned : raw,
      keyAsks: parseJsonArray<string>(row.key_asks_json),
      extractedQuestions: parseJsonArray<string>(row.extracted_questions_json),
      suggestedNextAction: row.suggested_next_action,
      updatedAt: row.updated_at,
    };
  }

  private mapDraftRow(row: MailboxDraftRow): MailboxDraftSuggestion {
    return {
      id: row.id,
      threadId: row.thread_id,
      subject: row.subject,
      body: decryptMailboxValue(row.body_text) || "",
      tone: row.tone,
      rationale: row.rationale,
      scheduleNotes: row.schedule_notes || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapProposalRow(row: MailboxProposalRow): MailboxActionProposal {
    return {
      id: row.id,
      threadId: row.thread_id,
      type: row.proposal_type,
      title: row.title,
      reasoning: row.reasoning,
      preview: row.preview_json ? (JSON.parse(row.preview_json) as Record<string, unknown>) : undefined,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapCommitmentRow(row: MailboxCommitmentRow): MailboxCommitment {
    const metadata = parseCommitmentMetadata(row.metadata_json);
    return {
      id: row.id,
      threadId: row.thread_id,
      messageId: row.message_id || undefined,
      title: row.title,
      dueAt: row.due_at || undefined,
      state: row.state,
      ownerEmail: row.owner_email || undefined,
      sourceExcerpt: decryptMailboxValue(row.source_excerpt) || undefined,
      followUpTaskId: metadata.followUpTaskId,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private ensureFollowUpTaskForCommitment(
    row: MailboxCommitmentRow,
    metadata: MailboxCommitmentMetadata,
  ): Task | null {
    if (metadata.followUpTaskId) {
      const existing = this.taskRepo.findById(metadata.followUpTaskId);
      if (existing) return existing;
    }

    const thread = this.db
      .prepare(
        `SELECT id, subject, participants_json
         FROM mailbox_threads
         WHERE id = ?`,
      )
      .get(row.thread_id) as { id: string; subject: string; participants_json: string | null } | undefined;
    const workspaceId = this.resolveFollowUpWorkspaceId();
    if (!workspaceId) {
      throw new Error("No workspace available to create a follow-up task");
    }

    const recipient = parseJsonArray<MailboxParticipant>(thread?.participants_json)[0]?.email;
    const title = `Follow up: ${normalizeWhitespace(row.title, 90) || "email commitment"}`;
    const promptParts = [
      `Follow up on this email commitment.`,
      `Commitment: ${row.title}`,
      thread?.subject ? `Thread subject: ${thread.subject}` : null,
      row.due_at ? `Due date: ${new Date(row.due_at).toISOString()}` : null,
      recipient ? `Primary contact: ${recipient}` : null,
      row.source_excerpt ? `Source excerpt: ${decryptMailboxValue(row.source_excerpt) || ""}` : null,
      "Track this as a real follow-up item and close it when the commitment is complete.",
    ].filter((part): part is string => Boolean(part));

    const task = this.taskRepo.create({
      title,
      prompt: promptParts.join("\n"),
      rawPrompt: promptParts.join("\n"),
      userPrompt: promptParts.join("\n"),
      status: "pending",
      workspaceId,
      source: "manual",
    });

    this.db
      .prepare(
        `UPDATE mailbox_commitments
         SET metadata_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        JSON.stringify({
          ...metadata,
          followUpTaskId: task.id,
          followUpTaskCreatedAt: Date.now(),
          followUpTaskWorkspaceId: workspaceId,
        }),
        Date.now(),
        row.id,
      );

    return task;
  }

  private recordMailboxTriageFeedback(threadId: string, feedbackKind: string, payload?: Record<string, unknown>): void {
    const workspaceId = this.resolveDefaultWorkspaceId();
    if (!workspaceId) return;
    const id = randomUUID();
    const now = Date.now();
    try {
      this.db
        .prepare(
          `INSERT INTO mailbox_triage_feedback (id, workspace_id, thread_id, feedback_kind, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          workspaceId,
          threadId,
          feedbackKind,
          payload ? JSON.stringify(payload) : null,
          now,
        );
      this.pruneMailboxTriageFeedback(workspaceId);
    } catch {
      // Best-effort
    }
  }

  listMailboxSnippets(): MailboxSnippetRecord[] {
    const workspaceId = this.resolveDefaultWorkspaceId();
    if (!workspaceId) return [];
    const rows = this.db
      .prepare(
        `SELECT id, workspace_id, shortcut, body_text, subject_hint, created_at, updated_at
         FROM mailbox_snippets
         WHERE workspace_id = ?
         ORDER BY updated_at DESC`,
      )
      .all(workspaceId) as Array<{
      id: string;
      workspace_id: string;
      shortcut: string;
      body_text: string;
      subject_hint: string | null;
      created_at: number;
      updated_at: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspace_id,
      shortcut: row.shortcut,
      body: row.body_text,
      subjectHint: row.subject_hint || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  upsertMailboxSnippet(input: MailboxSnippetInput & { id?: string }): MailboxSnippetRecord {
    const workspaceId = this.resolveDefaultWorkspaceId();
    if (!workspaceId) {
      throw new Error("No workspace for mailbox snippets");
    }
    const shortcut = input.shortcut.trim();
    const body = input.body.trim();
    if (!shortcut || !body) {
      throw new Error("Snippet shortcut and body are required");
    }
    const id = input.id?.trim() || randomUUID();
    const now = Date.now();
    const existing = this.db
      .prepare(`SELECT id FROM mailbox_snippets WHERE id = ? AND workspace_id = ?`)
      .get(id, workspaceId) as { id: string } | undefined;
    try {
      if (existing) {
        this.db
          .prepare(
            `UPDATE mailbox_snippets
             SET shortcut = ?, body_text = ?, subject_hint = ?, updated_at = ?
             WHERE id = ? AND workspace_id = ?`,
          )
          .run(shortcut, body, input.subjectHint?.trim() || null, now, id, workspaceId);
      } else {
        this.db
          .prepare(
            `INSERT INTO mailbox_snippets (id, workspace_id, shortcut, body_text, subject_hint, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(id, workspaceId, shortcut, body, input.subjectHint?.trim() || null, now, now);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("UNIQUE constraint failed: mailbox_snippets")) {
        throw new Error(`A snippet with the shortcut "${shortcut}" already exists in this workspace.`);
      }
      throw err;
    }
    const row = this.db
      .prepare(`SELECT * FROM mailbox_snippets WHERE id = ? AND workspace_id = ?`)
      .get(id, workspaceId) as {
      id: string;
      workspace_id: string;
      shortcut: string;
      body_text: string;
      subject_hint: string | null;
      created_at: number;
      updated_at: number;
    };
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      shortcut: row.shortcut,
      body: row.body_text,
      subjectHint: row.subject_hint || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  deleteMailboxSnippet(id: string): boolean {
    const workspaceId = this.resolveDefaultWorkspaceId();
    if (!workspaceId) return false;
    const result = this.db
      .prepare(`DELETE FROM mailbox_snippets WHERE id = ? AND workspace_id = ?`)
      .run(id, workspaceId);
    return result.changes > 0;
  }

  listMailboxSavedViews(): MailboxSavedViewRecord[] {
    const workspaceId = this.resolveDefaultWorkspaceId();
    if (!workspaceId) return [];
    const rows = this.db
      .prepare(
        `SELECT id, workspace_id, name, instructions, seed_thread_id, show_in_inbox, created_at, updated_at
         FROM mailbox_saved_views
         WHERE workspace_id = ?
         ORDER BY updated_at DESC`,
      )
      .all(workspaceId) as Array<{
      id: string;
      workspace_id: string;
      name: string;
      instructions: string;
      seed_thread_id: string | null;
      show_in_inbox: number;
      created_at: number;
      updated_at: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspace_id,
      name: row.name,
      instructions: row.instructions,
      seedThreadId: row.seed_thread_id || undefined,
      showInInbox: row.show_in_inbox !== 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async previewMailboxLabelSimilar(input: {
    seedThreadId: string;
    name: string;
    instructions: string;
  }): Promise<MailboxSavedViewPreviewResult> {
    const seedAccountId = (
      this.db.prepare(`SELECT account_id FROM mailbox_threads WHERE id = ?`).get(input.seedThreadId) as
        | { account_id: string }
        | undefined
    )?.account_id;
    const workspaceId =
      this.resolveThreadWorkspaceId(seedAccountId || "") || this.resolveDefaultWorkspaceId();
    if (!workspaceId) {
      return { threadIds: [] };
    }
    const seed = await this.getThreadCore(input.seedThreadId);
    if (!seed) {
      return { threadIds: [] };
    }
    const summary = this.getSummaryForThread(input.seedThreadId);
    const seedSummaryText = stripMailboxSummaryHtmlArtifacts(summary?.summary || seed.snippet);
    const seedTokens = new Set(
      [
        input.name,
        input.instructions,
        seed.subject,
        seed.snippet,
        seedSummaryText,
      ]
        .join(" ")
        .toLowerCase()
        .split(/[^a-z0-9]+/i)
        .map((token) => token.trim())
        .filter((token) => token.length >= 3)
        .slice(0, 120),
    );
    const candidateRows = this.db
      .prepare(
        `SELECT id, subject, snippet, last_message_at
         FROM mailbox_threads
         WHERE account_id = ?
           AND id != ?
         ORDER BY last_message_at DESC
         LIMIT 300`,
      )
      .all(seed.accountId, input.seedThreadId) as Array<{
      id: string;
      subject: string;
      snippet: string;
      last_message_at: number;
    }>;
    const candidateList = candidateRows
      .map((candidate) => ({
        threadId: candidate.id,
        subject: candidate.subject,
        snippet: candidate.snippet,
        score: this.scoreSavedViewCandidate(seedTokens, candidate.subject, candidate.snippet),
        lastMessageAt: candidate.last_message_at,
      }))
      .sort((left, right) =>
        right.score === left.score
          ? right.lastMessageAt - left.lastMessageAt
          : right.score - left.score,
      )
      .slice(0, 60)
      .map((c) => ({
        threadId: c.threadId,
        subject: c.subject,
        snippet: c.snippet,
      }));
    const result = await mailboxLlmSimilarThreadIds({
      workspaceId,
      seedThreadId: input.seedThreadId,
      seedSubject: seed.subject,
      seedSnippet: seed.snippet,
      seedSummary: seedSummaryText,
      viewName: input.name.trim() || "Saved view",
      instructions: input.instructions.trim() || "Similar threads to the open conversation.",
      candidates: candidateList,
    });
    const validIds = this.filterValidMailboxThreadIds(result.threadIds, seed.accountId);
    return {
      threadIds: validIds,
      rationale: result.rationale,
      error: result.error,
    };
  }

  async createMailboxSavedView(input: {
    name: string;
    instructions: string;
    seedThreadId?: string;
    threadIds: string[];
    showInInbox?: boolean;
  }): Promise<MailboxSavedViewRecord> {
    const workspaceId = this.resolveDefaultWorkspaceId();
    if (!workspaceId) {
      throw new Error("No workspace for saved views");
    }
    const name = input.name.trim();
    const instructions = input.instructions.trim();
    if (!name || !instructions) {
      throw new Error("Saved view name and instructions are required");
    }
    const seedAccountId = input.seedThreadId?.trim()
      ? (
          this.db.prepare(`SELECT account_id FROM mailbox_threads WHERE id = ?`).get(input.seedThreadId.trim()) as
            | { account_id: string }
            | undefined
        )?.account_id
      : undefined;
    const rawIds = [...input.threadIds];
    if (input.seedThreadId?.trim()) {
      rawIds.push(input.seedThreadId.trim());
    }
    const validThreadIds = this.filterValidMailboxThreadIds(rawIds, seedAccountId);
    if (validThreadIds.length === 0) {
      throw new Error("Saved views need at least one valid thread. Preview again before saving.");
    }
    const id = randomUUID();
    const now = Date.now();
    const showIn = input.showInInbox !== false ? 1 : 0;
    this.db
      .prepare(
        `INSERT INTO mailbox_saved_views
          (id, workspace_id, name, instructions, seed_thread_id, show_in_inbox, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        workspaceId,
        name,
        instructions,
        input.seedThreadId?.trim() || null,
        showIn,
        now,
        now,
      );
    const insertMember = this.db.prepare(
      `INSERT OR REPLACE INTO mailbox_saved_view_threads (view_id, thread_id, score) VALUES (?, ?, ?)`,
    );
    for (const threadId of validThreadIds) {
      insertMember.run(id, threadId, 1);
    }
    return {
      id,
      workspaceId,
      name,
      instructions,
      seedThreadId: input.seedThreadId,
      showInInbox: showIn === 1,
      createdAt: now,
      updatedAt: now,
    };
  }

  deleteMailboxSavedView(viewId: string): boolean {
    const workspaceId = this.resolveDefaultWorkspaceId();
    if (!workspaceId) return false;
    const result = this.db
      .prepare(`DELETE FROM mailbox_saved_views WHERE id = ? AND workspace_id = ?`)
      .run(viewId, workspaceId);
    return result.changes > 0;
  }

  async getMailboxQuickReplySuggestions(threadId: string): Promise<MailboxQuickReplySuggestionsResult> {
    const detail = await this.getThreadCore(threadId);
    if (!detail) return { suggestions: [] };
    if (getMailboxNoReplySender(detail.messages, detail.participants)) {
      return { suggestions: [] };
    }
    const workspaceId =
      this.resolveThreadWorkspaceId(detail.accountId) || this.resolveDefaultWorkspaceId();
    if (!workspaceId) return { suggestions: [] };
    const summary = this.getSummaryForThread(threadId);
    const summaryText = stripMailboxSummaryHtmlArtifacts(summary?.summary || detail.snippet);
    const latest = detail.messages.filter((m) => m.direction === "incoming").slice(-1)[0] || detail.messages[detail.messages.length - 1];
    const latestSnippet = latest?.snippet || latest?.body?.slice(0, 600) || detail.snippet;
    return mailboxLlmQuickReplies({
      workspaceId,
      threadId,
      subject: detail.subject,
      summary: summaryText,
      latestSnippet,
    });
  }

  async createReviewScheduleForSavedView(viewId: string): Promise<MailboxAutomationRecord> {
    const workspaceId = this.resolveDefaultWorkspaceId();
    if (!workspaceId) {
      throw new Error("No workspace for mailbox automation");
    }
    const row = this.db
      .prepare(
        `SELECT id, name, instructions FROM mailbox_saved_views WHERE id = ? AND workspace_id = ?`,
      )
      .get(viewId, workspaceId) as { id: string; name: string; instructions: string } | undefined;
    if (!row) {
      throw new Error("Saved view not found");
    }
    try {
      return await MailboxAutomationRegistry.createSchedule({
        workspaceId,
        name: `Inbox view review: ${row.name}`,
        description: row.instructions,
        kind: "reminder",
        schedule: { kind: "cron", expr: "0 9 * * 1", tz: Intl.DateTimeFormat().resolvedOptions().timeZone },
        taskTitle: `Review saved inbox view: ${row.name}`,
        taskPrompt: [
          `Review and triage threads in the Inbox Agent saved view "${row.name}".`,
          `View instructions: ${row.instructions}`,
          "Open Inbox Agent, select this saved view filter, and process outstanding threads.",
        ].join("\n"),
        enabled: true,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("Cron service") || msg.toLowerCase().includes("cron")) {
        throw new Error(
          "The automation scheduler is not available, so weekly reminders cannot be created. Enable automation/cron in your environment and try again.",
        );
      }
      throw e;
    }
  }

  private resolveFollowUpWorkspaceId(): string | null {
    const workspaces = this.workspaceRepo.findAll();
    const preferred = workspaces.find(
      (workspace) => !workspace.isTemp && !isTempWorkspaceId(workspace.id),
    );
    return (preferred ?? workspaces[0])?.id ?? null;
  }

  private mapContactRow(row: MailboxContactRow): MailboxContactMemory {
    return {
      id: row.id,
      accountId: row.account_id,
      email: row.email,
      name: row.name || undefined,
      company: row.company || undefined,
      role: row.role || undefined,
      encryptionPreference: row.encryption_preference || undefined,
      policyFlags: parseJsonArray<string>(row.policy_flags_json),
      crmLinks: parseJsonArray<string>(row.crm_links_json),
      learnedFacts: parseJsonArray<string>(row.learned_facts_json),
      responseTendency: row.response_tendency || undefined,
      lastInteractionAt: row.last_interaction_at || undefined,
      openCommitments: row.open_commitments || 0,
    };
  }
}
