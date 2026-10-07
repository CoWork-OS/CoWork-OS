import { loadDocumentArchive } from "../security/document-archive";
import { AgentRoleRepository } from "../agents/agent-repository-facades";
import { TaskRepository, WorkspaceRepository } from "../database/repository-facades";
import { ChannelRepository } from "../database/repository-facades";
import { foldSearchText, quoteFtsTerm, splitSearchTokens } from "../database/fts-query";
import {
  bindStatementContext,
  detachedStatementContext,
} from "../database/statements/statement-burst";
import type Database from "better-sqlite3";
import { createMailboxStatementPort, type MailboxStatementPort } from "./mailbox-statement-port";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  pbkdf2Sync,
  randomBytes,
  randomUUID,
} from "crypto";
import { createLogger } from "../utils/logger";
import fs from "fs";
import os from "os";
import path from "path";
import { ChannelStore } from "../database/repositories";

import { LLMProviderFactory } from "../agent/llm/provider-factory";
import { recordLlmCallError, recordLlmCallSuccess } from "../agent/llm/usage-telemetry";
import type { LLMMessage, LLMProviderType } from "../agent/llm/types";
import { GoogleWorkspaceSettingsManager } from "../settings/google-workspace-manager";
import { AgentMailSettingsManager } from "../settings/agentmail-manager";
import { gmailRequest } from "../utils/gmail-api";
import { googleCalendarRequest } from "../utils/google-calendar-api";
import { EmailClient, type EmailAttachment } from "../gateway/channels/email-client";
import { LoomEmailClient } from "../gateway/channels/loom-client";
import { assertSafeLoomMailboxFolder } from "../utils/loom";
import { refreshMicrosoftEmailAccessToken } from "../utils/microsoft-email-oauth";
import { getSafeStorage, type SafeStorageLike } from "../utils/safe-storage";
import { getUserDataDir } from "../utils/user-data-dir";
import { notifyDetectedIntegrationAuthIssue } from "../notifications/integration-auth";
import { RelationshipMemoryService } from "../memory/RelationshipMemoryService";
import { buildContactMemoryContext } from "../memory/contact-memory-context";
import { PlaybookService } from "../memory/PlaybookService";
import { KnowledgeGraphService } from "../knowledge-graph/KnowledgeGraphService";
import { getHeartbeatService } from "../agents/HeartbeatService";
import { ControlPlaneCoreService } from "../control-plane/ControlPlaneCoreService";
import { ContactIdentityService } from "../identity/identity-repository-facades";
import { MailboxAutomationHub } from "./MailboxAutomationHub";
import { MailboxAutomationRegistry } from "./MailboxAutomationRegistry";
import {
  buildMailboxAskNoEvidenceAnswer,
  ensureMailboxEmbeddingTable,
  MailboxAgentSearchService,
  type MailboxSearchQueryPlan,
} from "./MailboxAgentSearchService";
import type { MailboxThreadWrite } from "./mailbox-units";
import { AgentMailClient } from "../agentmail/AgentMailClient";
import { AgentMailAdminService } from "../agentmail/AgentMailAdminService";
import { mailboxLlmQuickReplies, mailboxLlmSimilarThreadIds } from "./mailbox-inbox-product-llm";
import { mergeMailboxCapabilities, resolveMailboxProviderBackend } from "./MailboxProviderClient";
import { getMailboxForwardingServiceInstance } from "./mailbox-forwarding-singleton";
import {
  LOCAL_PDF_PARSE_LIMITS,
  PdfParseLimitError,
  parsePdfBufferBounded,
} from "../utils/bounded-pdf-parser";
import { evaluateWorkspaceFilesystemAccess } from "../security/access-profile-paths";
import { PermissionSettingsManager } from "../security/permission-settings-manager";
import { taskAgentConfigForCreation } from "../../shared/security/task-entrypoint";
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
  MailboxClientSettingsPatch,
  MailboxDomainCategory,
  MailboxDigest,
  MailboxDigestSnapshot,
  MailboxDraftOptions,
  MailboxDraftAttachmentInput,
  MailboxDraftSuggestion,
  MailboxEvent,
  MailboxEventType,
  MailboxAutomationRecord,
  MailboxForwardRecipe,
  MailboxCompanyCandidate,
  MailboxMissionControlHandoffPreview,
  MailboxMissionControlHandoffRecord,
  MailboxMissionControlHandoffRequest,
  MailboxAskRunEvent,
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
  MailboxSendOutcomeResolution,
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
  MailboxSentFollowupDraftInput,
  MailboxSentFollowupDraftResult,
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
import {
  MICROSOFT_EMAIL_DEFAULT_TENANT,
  MICROSOFT_EMAIL_GRAPH_READWRITE_SCOPES,
  MICROSOFT_EMAIL_GRAPH_SEND_SCOPES,
  normalizeMicrosoftEmailReadScopes,
} from "../../shared/microsoft-email";
import { isMicrosoftConsumerEmailAddress } from "../../shared/email-provider-support";
import type {
  AgentRole,
  CompanyEvidenceRef,
  CompanyOutputContract,
  Issue,
  Task,
} from "../../shared/types";
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
  metadata_json: string | null;
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
  microsoftGraphMessageId?: string;
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

type MailboxAskRunOptions = {
  onAskEvent?: (event: MailboxAskRunEvent) => void;
};

type MailboxAskActionPlan =
  | {
      action: "sent_followup_drafts";
      thresholdHours?: number;
      limit?: number;
      rationale?: string;
      usedLlm: boolean;
    }
  | {
      action: "none";
      rationale?: string;
      usedLlm: boolean;
    };

const MAILBOX_CIPHER_PREFIX = "mbox:";
const MAILBOX_CIPHER_SALT = "cowork-mailbox-content-v1";
const MAILBOX_MACHINE_ID_FILE = ".cowork-machine-id";
const MAILBOX_AUTO_SYNC_INTERVAL_MS = 2 * 60 * 1000;
const MAILBOX_AUTO_SYNC_INITIAL_DELAY_MS = 30 * 1000;
const MAILBOX_AUTO_SYNC_LIMIT = 25;
const MAILBOX_SENT_FOLLOWUP_DEFAULT_THRESHOLD_HOURS = 24;
const MAILBOX_SENT_FOLLOWUP_MAX_LIMIT = 20;
const MICROSOFT_GRAPH_API_BASE = "https://graph.microsoft.com/v1.0";
const MICROSOFT_GRAPH_MESSAGE_SELECT =
  "id,conversationId,parentFolderId,subject,bodyPreview,body,from,toRecipients,ccRecipients,bccRecipients,receivedDateTime,isRead,hasAttachments,internetMessageId";
const MICROSOFT_GRAPH_READWRITE_SCOPES = [...MICROSOFT_EMAIL_GRAPH_READWRITE_SCOPES];
const MICROSOFT_GRAPH_SEND_SCOPES = [...MICROSOFT_EMAIL_GRAPH_SEND_SCOPES];
const MAILBOX_AUTH_SYNC_BACKOFF_MS = 15 * 60 * 1000;
const MAILBOX_SYNC_ERROR_LABEL_MAX_LENGTH = 600;

let mailboxCipherState: MailboxCipherState | null = null;

const mailboxLogger = createLogger("MailboxService");
const MAILBOX_SEND_OUTCOME_UNKNOWN_MESSAGE =
  "Delivery status is unknown. Check the provider's Sent folder before attempting another send.";

class MailboxSendOutcomeUnknownError extends Error {
  constructor() {
    super(MAILBOX_SEND_OUTCOME_UNKNOWN_MESSAGE);
    this.name = "MailboxSendOutcomeUnknownError";
  }
}

const MAILBOX_CONNECTION_ERROR_RE =
  /\b(connect|connection|network|timeout|timed out|socket|dns|fetch failed|failed to fetch|enotfound|eai_again|econnrefused|econnreset|econnaborted|enotconn|etimedout|enetunreach|ehostunreach|err_internet_disconnected|unknown system error)\b/i;
const GMAIL_TRANSIENT_SYNC_BACKOFF_MS = 15 * 60 * 1000;

function flattenMailboxError(error: unknown): Error[] {
  const errors = (error as Any)?.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    return errors.flatMap((entry) => flattenMailboxError(entry));
  }
  if (error instanceof Error) return [error];
  return [new Error(String(error))];
}

function isMailboxConnectionError(error: unknown): boolean {
  const flattened = flattenMailboxError(error);
  return flattened.some((entry) => {
    const code = String((entry as Any)?.code || "");
    const message = String(entry.message || "");
    if (isMailboxAuthConfigurationError(message)) return false;
    return MAILBOX_CONNECTION_ERROR_RE.test(code) || MAILBOX_CONNECTION_ERROR_RE.test(message);
  });
}

function isMailboxAuthConfigurationError(message: string): boolean {
  return /\b(google workspace|oauth|token|refresh token|access token|authorization|authentication scope|insufficient authentication scopes|reconnect)\b/i.test(
    message,
  );
}

function summarizeMailboxConnectionError(error: unknown): string {
  const flattened = flattenMailboxError(error);
  const code = flattened.map((entry) => String((entry as Any)?.code || "")).find(Boolean);
  const message = flattened.map((entry) => entry.message.trim()).find(Boolean);
  const port = flattened
    .map((entry) => Number((entry as Any)?.port))
    .find((value) => Number.isFinite(value));
  const parts: string[] = [];
  if (port) parts.push(`port ${port}`);
  if (code && code !== message) parts.push(code);
  if (message) parts.push(message);
  return parts.length ? parts.join(": ") : "connection failed";
}

function formatMailboxSyncErrors(
  errors: readonly { message: string }[],
  fallback = "Mailbox sync temporarily unavailable; retrying later",
): string {
  const messages = [...new Set(errors.map((entry) => entry.message.trim()).filter(Boolean))];
  if (messages.length === 0) return fallback;
  const label = messages.join(" · ");
  if (label.length <= MAILBOX_SYNC_ERROR_LABEL_MAX_LENGTH) return label;
  return `${label.slice(0, MAILBOX_SYNC_ERROR_LABEL_MAX_LENGTH - 1).trimEnd()}…`;
}

function normalizeMicrosoftScope(scope: string): string {
  return scope.trim().toLowerCase();
}

function microsoftScopesIncludeAll(
  granted: string[] | undefined,
  required: readonly string[],
): boolean {
  if (!granted || granted.length === 0) return false;
  const grantedSet = new Set(granted.map(normalizeMicrosoftScope).filter(Boolean));
  return required.every((scope) => {
    const normalized = normalizeMicrosoftScope(scope);
    return normalized === "offline_access" || grantedSet.has(normalized);
  });
}

function escapeODataString(value: string): string {
  return value.replace(/'/g, "''");
}

function toMailboxActionError(
  action: MailboxApplyActionInput["type"],
  provider: MailboxProvider,
  error: unknown,
): Error {
  const originalMessage = error instanceof Error ? error.message : String(error);
  if (isMailboxAuthConfigurationError(originalMessage)) {
    return new Error(`Mailbox action ${action} needs mailbox authorization: ${originalMessage}`, {
      cause: error,
    });
  }
  if (isMailboxConnectionError(error)) {
    return new Error(
      `Mailbox provider connection failed while applying ${action}. CoWork could not reach the ${provider} mail server (${summarizeMailboxConnectionError(error)}). Check your network/VPN/firewall and mailbox integration settings, then retry.`,
    );
  }
  return new Error(`Mailbox action ${action} failed: ${originalMessage}`, { cause: error });
}

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

// The derivation inputs are fixed for the process, so the key is derived once instead of
// once per value (100k PBKDF2 rounds took ~20 ms of host CPU for every field of a sync).
let derivedMailboxCipherKey: { machineId: string; key: Buffer } | null = null;

function deriveMailboxCipherKey(machineId: string): Buffer {
  if (derivedMailboxCipherKey?.machineId === machineId) return derivedMailboxCipherKey.key;
  // machineId is the secret (password); MAILBOX_CIPHER_SALT is the domain separator (salt).
  const key = pbkdf2Sync(machineId, MAILBOX_CIPHER_SALT, 100000, 32, "sha512");
  derivedMailboxCipherKey = { machineId, key };
  return key;
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

  const key = deriveMailboxCipherKey(
    state.machineId ||
      `${os.hostname()}:${os.homedir()}:${process.env.USER || process.env.USERNAME || "default-user"}`,
  );
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
        state.machineId ||
          `${os.hostname()}:${os.homedir()}:${process.env.USER || process.env.USERNAME || "default-user"}`,
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
  localInboxHidden?: boolean;
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
      microsoftGraphMessageId: asString(parsed?.microsoftGraphMessageId) ?? undefined,
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

  if (
    /\b(password|passcode|otp|one[- ]time code|verification code|secret key|api key|token|credential|login)\b/.test(
      lower,
    )
  ) {
    add("credentials", "Credentials or authentication data detected");
  }
  if (
    /\b(invoice|payment|wire transfer|bank account|routing number|credit card|card number|ssn|tax id|salary|compensation)\b/.test(
      lower,
    )
  ) {
    add("financial", "Financial or payment details detected");
  }
  if (
    /\b(ssn|social security|date of birth|dob|home address|phone number|personal data|pii)\b/.test(
      lower,
    )
  ) {
    add("pii", "Potential personal information detected");
  }
  if (
    /\b(attorney|legal|agreement|contract|nda|non[- ]disclosure|litigation|settlement)\b/.test(
      lower,
    )
  ) {
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
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
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

function buildMailboxEventFingerprint(
  type: MailboxEventType,
  workspaceId: string,
  payload: Record<string, unknown>,
): string {
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
        ? [
            ...new Set(
              (payload.evidenceRefs as unknown[])
                .map((item) => asString(item))
                .filter((item): item is string => Boolean(item)),
            ),
          ].sort()
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
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
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

const MAILBOX_QUERY_STOP_WORDS = new Set([
  "a",
  "about",
  "an",
  "and",
  "any",
  "are",
  "can",
  "do",
  "does",
  "for",
  "from",
  "have",
  "how",
  "i",
  "in",
  "is",
  "it",
  "make",
  "me",
  "my",
  "need",
  "of",
  "on",
  "or",
  "should",
  "the",
  "to",
  "when",
  "with",
]);

function normalizeMailboxSearchText(value: string): string {
  return foldSearchText(value);
}

function tokenizeMailboxQuery(query: string): string[] {
  const normalized = normalizeMailboxSearchText(query);
  // Unicode tokens (RECALL-9): an ASCII-only split dropped every non-Latin word.
  const tokens = splitSearchTokens(normalized.replace(/[_-]+/g, " ")).filter(
    (token) => !MAILBOX_QUERY_STOP_WORDS.has(token),
  );
  return Array.from(new Set(tokens)).slice(0, 10);
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

function graphEmailAddressToParticipant(input: unknown): MailboxParticipant | undefined {
  const value = asObject(input);
  const email = normalizeEmailAddress(value);
  if (!email) return undefined;
  return {
    email,
    name: asString(value?.name) || undefined,
  };
}

function graphRecipientsToParticipants(input: unknown): MailboxParticipant[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((entry) => graphEmailAddressToParticipant(asObject(entry)?.emailAddress))
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
  const orderedParts = mimeType === "multipart/alternative" ? [...parts].reverse() : parts;

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

function isAutomatedMailbox(
  subject: string,
  body: string,
  senderEmail?: string,
  labels: string[] = [],
): boolean {
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
    /\b(?:can|could|would|will|are|is|do|does|did|what|when|where|why|how)\b[^?.!]{0,80}\?/i.test(
      text,
    )
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
    /\breceipt|invoice|notification|alert|verification|password|security|privacy|passkey|account update|account revision|account confirmation|identity verified\b/.test(
      text,
    )
  ) {
    return "updates";
  }
  if (/\bmeet|schedule|calendar|availability|slot\b/.test(`${lowerSubject} ${lowerBody}`)) {
    return "calendar";
  }
  if (/\bfollow up|checking in|circling back|nudge\b/.test(`${lowerSubject} ${lowerBody}`)) {
    return "follow_up";
  }
  if (
    labelSet.has("IMPORTANT") ||
    /\burgent|asap|deadline|today|blocking\b/.test(`${lowerSubject} ${lowerBody}`)
  ) {
    return "priority";
  }
  if (
    /\b(family|friend|friends|personal|birthday|wedding|party|vacation|holiday|catch up|coffee|lunch|dinner|weekend|invitation|invite|rsvp|congratulations|condolences)\b/.test(
      text,
    )
  ) {
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
const MAILBOX_COMPOSE_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
const MAILBOX_OUTBOX_POLL_INTERVAL_MS = 30_000;
const MAILBOX_OUTBOX_MAX_ATTEMPTS = 5;
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
  return tokenizeMailboxQuery(query)
    .map((token) => quoteFtsTerm(token))
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

function normalizeDomainCategory(
  value: unknown,
  fallback: MailboxDomainCategory,
): MailboxDomainCategory {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return VALID_MAILBOX_DOMAIN_CATEGORIES.includes(normalized as MailboxDomainCategory)
    ? (normalized as MailboxDomainCategory)
    : fallback;
}

function deriveDomainCategoryFromText(
  text: string,
  category?: MailboxThreadCategory,
): MailboxDomainCategory {
  const haystack = text.toLowerCase();
  if (
    /\b(flight|boarding|hotel|airbnb|reservation|itinerary|train|rental car|trip)\b/.test(haystack)
  )
    return "travel";
  if (/\b(package|delivered|delivery|shipment|tracking|ups|fedex|usps|dhl)\b/.test(haystack))
    return "packages";
  if (
    /\b(receipt|invoice|paid|payment confirmation|order confirmation|tax receipt)\b/.test(haystack)
  )
    return "receipts";
  if (/\b(bill|statement|due|autopay|utility|subscription renewal)\b/.test(haystack))
    return "bills";
  if (/\b(order|cart|sale|discount|promo code|shop|purchase)\b/.test(haystack)) return "shopping";
  if (/\b(newsletter|digest|roundup|unsubscribe|weekly update)\b/.test(haystack))
    return "newsletters";
  if (
    category === "calendar" ||
    /\b(meeting|webinar|event|calendar|invite|rsvp|appointment)\b/.test(haystack)
  )
    return "events";
  if (/\b(bank|finance|portfolio|payroll|expense|reimbursement|stripe|quickbooks)\b/.test(haystack))
    return "finance";
  if (/\b(customer|client|support|ticket|renewal|contract|account)\b/.test(haystack))
    return "customer";
  if (/\b(candidate|interview|recruit|resume|offer|hiring)\b/.test(haystack)) return "hiring";
  if (/\b(approve|approval|sign off|review required|permission)\b/.test(haystack))
    return "approvals";
  if (/\b(incident|deploy|ops|outage|status page|alert|server|production)\b/.test(haystack))
    return "ops";
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
  if (params.needsReply || params.priorityScore >= 60 || params.urgencyScore >= 60)
    return "needs_action";
  const text = params.text.toLowerCase();
  if (
    params.category === "calendar" ||
    ["travel", "packages", "bills", "events"].includes(params.domainCategory) ||
    /\b(today|tomorrow|tonight|overdue|due|arriving|delivered|starts?|appointment)\b/.test(text)
  ) {
    return "happening_today";
  }
  if (
    params.cleanupCandidate ||
    params.handled ||
    ["newsletters", "shopping"].includes(params.domainCategory)
  ) {
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
      priorityScore: clampScore(snapshot.unreadCount > 0 ? 15 : 5),
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
    priorityScore: clampScore(snapshot.unreadCount > 0 ? 15 : 5),
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

function guessMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".txt" || ext === ".md" || ext === ".csv") return "text/plain";
  if (ext === ".html" || ext === ".htm") return "text/html";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".docx")
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (ext === ".xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (ext === ".pptx")
    return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  return "application/octet-stream";
}

export class MailboxService {
  private static backgroundServices = new Set<MailboxService>();
  private static outboxDrainInFlight = false;

  static async stopBackgroundServices(): Promise<void> {
    // Task tools create lightweight MailboxService instances too and can replace
    // the active accessor. Shutdown must target the actual loop owners.
    await Promise.all([...this.backgroundServices].map((service) => service.stop()));
  }

  private channelRepo: ChannelRepository;
  // `hasEmailChannel` feeds the synchronous availability check, so it reads on the host.
  private channelStore: ChannelStore;
  private taskRepo: TaskRepository;
  private workspaceRepo: WorkspaceRepository;
  private agentRoleRepo: AgentRoleRepository;
  private controlPlaneCore: ControlPlaneCoreService;
  private contactIdentityService: ContactIdentityService;
  private syncInFlight = false;
  private syncProgress: MailboxSyncProgress | null = null;
  private autoSyncTimer: ReturnType<typeof setInterval> | null = null;
  private autoSyncInitialTimer: ReturnType<typeof setTimeout> | null = null;
  private outboxTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private backgroundRuns = new Set<Promise<void>>();
  private outboxDrainInFlight = false;
  private lastAutoSyncAttemptAt = 0;
  private mailboxAuthSyncBackoffUntil = 0;
  private mailboxAuthSyncBackoffKey: string | null = null;
  private mailboxAuthSyncBackoffSuppressedCount = 0;
  private googleWorkspaceAutoSyncAuthNoticeKey: string | null = null;
  private gmailTransientSyncBackoffUntil = 0;
  private gmailTransientSyncNoticeKey: string | null = null;
  private gmailTransientSyncLabel: string | null = null;
  private gmailTransientSyncSuppressedCount = 0;
  private mailboxSearchIndexBackfillAttempted = false;
  private mailboxAgentSearchService: MailboxAgentSearchService | null = null;

  /**
   * The mailbox domain's database access (DB6): catalogued statements, run in the database
   * worker when the runtime routes the domain there, on this connection otherwise.
   */
  private readonly sql: MailboxStatementPort;

  constructor(db: Database.Database, options: MailboxServiceOptions = {}) {
    this.sql = createMailboxStatementPort(db);
    ensureMailboxEmbeddingTable(db);
    this.channelRepo = new ChannelRepository(db);
    this.channelStore = new ChannelStore(db);
    this.taskRepo = new TaskRepository(db);
    this.workspaceRepo = new WorkspaceRepository(db);
    this.agentRoleRepo = new AgentRoleRepository(db);
    this.controlPlaneCore = new ControlPlaneCoreService(db);
    this.contactIdentityService = new ContactIdentityService(db);
    setMailboxServiceInstance(this);
    if (options.autoSync === true && process.env.NODE_ENV !== "test") {
      this.startAutoSyncLoop();
      this.startOutboxLoop();
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

  private getMailboxAgentSearchService(): MailboxAgentSearchService {
    if (!this.mailboxAgentSearchService) {
      this.mailboxAgentSearchService = new MailboxAgentSearchService(this.sql, {
        getThread: (threadId) => this.getThread(threadId),
        getAttachment: (attachmentId, includeText) =>
          this.getMailboxAttachment(attachmentId, includeText),
        extractCandidateAttachments: (query) => this.extractCandidateAttachmentsForAsk(query),
        ensureLocalSearchIndex: () => this.ensureMailboxSearchIndexBackfilled(),
        providerSearch: (plan, limit) => this.searchConnectedMailboxProviders(plan, limit),
        fallbackSearch: async (query, limit) => {
          const fallback = await this.listThreads({ query, mailboxView: "all", limit });
          return fallback.map((thread) => ({
            thread,
            snippet: thread.summary?.summary || thread.snippet,
            score: 0,
            searchSources: ["local_fts"],
            matchedFields: ["thread"],
            evidenceSnippets: [thread.summary?.summary || thread.snippet].filter(Boolean),
          }));
        },
      });
    }
    return this.mailboxAgentSearchService;
  }

  private startAutoSyncLoop(): void {
    if (this.stopped || this.autoSyncTimer) return;
    MailboxService.backgroundServices.add(this);
    const run = () => {
      this.runInBackground(() => this.runAutoSyncIfDue());
    };
    this.autoSyncInitialTimer = setTimeout(run, MAILBOX_AUTO_SYNC_INITIAL_DELAY_MS);
    this.autoSyncInitialTimer.unref?.();
    this.autoSyncTimer = setInterval(run, MAILBOX_AUTO_SYNC_INTERVAL_MS);
    this.autoSyncTimer.unref?.();
  }

  private startOutboxLoop(): void {
    if (this.stopped || this.outboxTimer) return;
    MailboxService.backgroundServices.add(this);
    const run = () => {
      this.runInBackground(() => this.processMailboxQueue());
    };
    this.outboxTimer = setInterval(run, MAILBOX_OUTBOX_POLL_INTERVAL_MS);
    this.outboxTimer.unref?.();
    run();
  }

  private runInBackground(work: () => Promise<unknown>): void {
    if (this.stopped) return;
    // Scheduled work is an operation of its own, not part of the one that scheduled it.
    const run = Promise.resolve()
      .then(() =>
        this.stopped ? undefined : detachedStatementContext("MailboxService.background", work),
      )
      .then(() => undefined)
      .catch((error) => {
        mailboxLogger.warn("Mailbox background work failed:", error);
      })
      .finally(() => this.backgroundRuns.delete(run));
    this.backgroundRuns.add(run);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.autoSyncInitialTimer) clearTimeout(this.autoSyncInitialTimer);
    if (this.autoSyncTimer) clearInterval(this.autoSyncTimer);
    if (this.outboxTimer) clearInterval(this.outboxTimer);
    this.autoSyncInitialTimer = null;
    this.autoSyncTimer = null;
    this.outboxTimer = null;
    // Network work can resume with database writes; drain it before storage closes.
    await Promise.allSettled(this.backgroundRuns);
    MailboxService.backgroundServices.delete(this);
    if (getMailboxServiceInstance() === this) setMailboxServiceInstance(null);
  }

  private async runAutoSyncIfDue(): Promise<void> {
    const now = Date.now();
    if (this.syncInFlight) return;
    if (now - this.lastAutoSyncAttemptAt < MAILBOX_AUTO_SYNC_INTERVAL_MS - 1_000) return;
    if (!this.isAvailable()) return;
    if (this.mailboxAuthSyncBackoffUntil > now) {
      this.noteMailboxAuthSyncBackoff();
      return;
    }
    if (this.mailboxAuthSyncBackoffUntil > 0) {
      this.resetMailboxAuthSyncBackoff();
    }

    const status = await this.getSyncStatus();
    const googleWorkspaceAuthIssue = this.getGoogleWorkspaceAuthIssue();
    const hasOtherMailboxProvider = this.agentMailEnabled() || this.hasEmailChannel();
    if (googleWorkspaceAuthIssue && !hasOtherMailboxProvider) {
      this.lastAutoSyncAttemptAt = now;
      this.updateSyncProgress({
        phase: "error",
        totalThreads: 0,
        processedThreads: 0,
        totalMessages: 0,
        processedMessages: 0,
        newThreads: 0,
        classifiedThreads: 0,
        skippedThreads: 0,
        label: googleWorkspaceAuthIssue.statusLabel,
      });
      if (this.googleWorkspaceAutoSyncAuthNoticeKey !== googleWorkspaceAuthIssue.key) {
        this.googleWorkspaceAutoSyncAuthNoticeKey = googleWorkspaceAuthIssue.key;
        mailboxLogger.warn(googleWorkspaceAuthIssue.logMessage);
      }
      return;
    }
    if (!googleWorkspaceAuthIssue) {
      this.googleWorkspaceAutoSyncAuthNoticeKey = null;
    } else if (this.googleWorkspaceAutoSyncAuthNoticeKey !== googleWorkspaceAuthIssue.key) {
      this.googleWorkspaceAutoSyncAuthNoticeKey = googleWorkspaceAuthIssue.key;
      mailboxLogger.warn(googleWorkspaceAuthIssue.logMessage);
    }
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
      const result = await this.sync(MAILBOX_AUTO_SYNC_LIMIT, { source: "auto" });
      this.resetMailboxAuthSyncBackoff();
      mailboxLogger.info("Mailbox autosync complete", {
        accountCount: result.accounts.length,
        syncedThreads: result.syncedThreads,
        syncedMessages: result.syncedMessages,
      });
    } catch (error) {
      if (isMailboxAuthConfigurationError(error instanceof Error ? error.message : String(error))) {
        this.noteMailboxAuthSyncFailure(error);
      }
      mailboxLogger.warn("Mailbox autosync failed:", error);
    }
  }

  private noteMailboxAuthSyncFailure(error: unknown): void {
    const detail = summarizeMailboxConnectionError(error);
    const key = detail || "mailbox-auth";
    this.mailboxAuthSyncBackoffUntil = Date.now() + MAILBOX_AUTH_SYNC_BACKOFF_MS;
    if (this.mailboxAuthSyncBackoffKey !== key) {
      this.mailboxAuthSyncBackoffKey = key;
      this.mailboxAuthSyncBackoffSuppressedCount = 0;
      mailboxLogger.warn(
        "Mailbox autosync paused after an authorization failure; reconnect the affected mailbox integration before retrying.",
      );
      return;
    }
    this.mailboxAuthSyncBackoffSuppressedCount += 1;
  }

  private noteMailboxAuthSyncBackoff(): void {
    this.mailboxAuthSyncBackoffSuppressedCount += 1;
    if (this.mailboxAuthSyncBackoffSuppressedCount % 5 === 0) {
      mailboxLogger.warn(
        `Mailbox autosync remains paused after an authorization failure; suppressed ${this.mailboxAuthSyncBackoffSuppressedCount} repeated authorization retry attempts.`,
      );
    }
  }

  private resetMailboxAuthSyncBackoff(): void {
    this.mailboxAuthSyncBackoffUntil = 0;
    this.mailboxAuthSyncBackoffKey = null;
    this.mailboxAuthSyncBackoffSuppressedCount = 0;
  }

  private getAgentMailClient(): AgentMailClient {
    return new AgentMailClient(AgentMailSettingsManager.loadSettings());
  }

  private agentMailEnabled(): boolean {
    const settings = AgentMailSettingsManager.loadSettings();
    return Boolean(settings.enabled && settings.apiKey);
  }

  private getGoogleWorkspaceAuthIssue(): {
    key: string;
    statusLabel: string;
    logMessage: string;
  } | null {
    const settings = GoogleWorkspaceSettingsManager.loadSettings();
    if (!settings.enabled) return null;
    if (!settings.accessToken && !settings.refreshToken) {
      return {
        key: "google-workspace-token-missing",
        statusLabel: "Google Workspace needs reconnect; Gmail autosync paused",
        logMessage:
          "Gmail autosync paused: Google Workspace access token is not configured. Reconnect in Settings > Integrations > Google Workspace.",
      };
    }
    if (
      settings.accessToken &&
      settings.tokenExpiresAt &&
      settings.tokenExpiresAt <= Date.now() &&
      !settings.refreshToken
    ) {
      return {
        key: "google-workspace-token-expired",
        statusLabel: "Google Workspace token expired; Gmail autosync paused",
        logMessage:
          "Gmail autosync paused: Google Workspace access token expired and no refresh token is available. Reconnect in Settings > Integrations > Google Workspace.",
      };
    }
    return null;
  }

  private async getExistingMailboxAccounts(
    provider: MailboxProvider,
    status?: MailboxAccount["status"],
  ): Promise<MailboxAccount[]> {
    const rows = (await this.sql.all("getExistingMailboxAccounts_1", [
      provider,
    ])) as MailboxAccountRow[];
    return rows.map((row) => {
      const account = this.mapAccountRow(row);
      return status ? { ...account, status } : account;
    });
  }

  private isMicrosoftGraphAccountRow(row: MailboxAccountRow): boolean {
    if (row.provider === "outlook_graph") return true;
    const capabilities = parseJsonArray<string>(row.capabilities_json);
    return (
      resolveMailboxProviderBackend({
        provider: row.provider,
        capabilities,
      }) === "microsoft_graph"
    );
  }

  private async getObsoleteDuplicateMailboxAccountIds(
    rows?: MailboxAccountRow[],
  ): Promise<string[]> {
    const accountRows =
      rows ||
      ((await this.sql.all("getObsoleteDuplicateMailboxAccountIds_1", [])) as MailboxAccountRow[]);
    const graphAddresses = new Set(
      accountRows
        .filter((row) => this.isMicrosoftGraphAccountRow(row))
        .map((row) => normalizeEmailAddress(row.address))
        .filter((address): address is string => Boolean(address)),
    );
    return accountRows
      .filter(
        (row) =>
          row.provider === "imap" && graphAddresses.has(normalizeEmailAddress(row.address) || ""),
      )
      .map((row) => row.id);
  }

  private async filterVisibleMailboxAccountRows(
    rows: MailboxAccountRow[],
  ): Promise<MailboxAccountRow[]> {
    const obsoleteIds = new Set(await this.getObsoleteDuplicateMailboxAccountIds(rows));
    return rows.filter((row) => !obsoleteIds.has(row.id));
  }

  private noteGmailTransientSyncFailure(error: unknown): string {
    const detail = summarizeMailboxConnectionError(error);
    const label = `Gmail sync temporarily unavailable; retrying later (${detail})`;
    const noticeKey = detail || "gmail-transient-sync";
    this.gmailTransientSyncBackoffUntil = Date.now() + GMAIL_TRANSIENT_SYNC_BACKOFF_MS;
    this.gmailTransientSyncLabel = label;
    if (this.gmailTransientSyncNoticeKey !== noticeKey) {
      this.gmailTransientSyncNoticeKey = noticeKey;
      this.gmailTransientSyncSuppressedCount = 0;
      mailboxLogger.warn(`${label}.`);
    } else {
      this.gmailTransientSyncSuppressedCount += 1;
      if (this.gmailTransientSyncSuppressedCount % 5 === 0) {
        mailboxLogger.warn(
          `Gmail sync is still temporarily unavailable (${detail}); suppressed ${this.gmailTransientSyncSuppressedCount} repeated autosync notice${this.gmailTransientSyncSuppressedCount === 1 ? "" : "s"}.`,
        );
      }
    }
    return label;
  }

  private noteGmailTransientSyncBackoff(): string {
    const label =
      this.gmailTransientSyncLabel || "Gmail sync temporarily unavailable; retrying later";
    this.gmailTransientSyncSuppressedCount += 1;
    if (this.gmailTransientSyncSuppressedCount % 5 === 0) {
      mailboxLogger.warn(
        `Gmail sync autosync is still in transient network backoff; suppressed ${this.gmailTransientSyncSuppressedCount} repeated autosync notice${this.gmailTransientSyncSuppressedCount === 1 ? "" : "s"}.`,
      );
    }
    return label;
  }

  private resetGmailTransientSyncFailure(): void {
    this.gmailTransientSyncBackoffUntil = 0;
    this.gmailTransientSyncNoticeKey = null;
    this.gmailTransientSyncLabel = null;
    this.gmailTransientSyncSuppressedCount = 0;
  }

  private async isLoomEmailChannel(): Promise<boolean> {
    const channel = await this.channelRepo.findByType("email");
    const cfg = (channel?.config as Any) || {};
    return Boolean(channel?.enabled && asString(cfg.protocol) === "loom");
  }

  async getSyncStatus(): Promise<MailboxSyncStatus> {
    const accountRows = (await this.sql.all("getSyncStatus_1", [])) as MailboxAccountRow[];

    const googleWorkspaceAuthIssue = this.getGoogleWorkspaceAuthIssue();
    const gmailTransientSyncActive = this.gmailTransientSyncBackoffUntil > Date.now();
    const visibleAccountRows = await this.filterVisibleMailboxAccountRows(accountRows);
    const accounts = visibleAccountRows.map((row) => {
      const account = this.mapAccountRow(row);
      return (googleWorkspaceAuthIssue || gmailTransientSyncActive) && account.provider === "gmail"
        ? { ...account, status: "degraded" as const }
        : account;
    });
    const inboxVisibleFilter = await this.buildInboxVisibleThreadFilter();
    const countsRow = (await this.sql.get(
      "syncStatusThreadCounts",
      inboxVisibleFilter.params,
      inboxVisibleFilter.shape,
    )) as {
      thread_count: number;
      unread_count: number;
      needs_reply_count: number;
      classification_pending_count: number;
    };
    const proposalCountRow = (await this.sql.get(
      "visibleSuggestedProposalCount",
      inboxVisibleFilter.params,
      inboxVisibleFilter.shape,
    )) as { count: number };
    const commitmentCountRow = (await this.sql.get(
      "visibleOpenCommitmentCount",
      inboxVisibleFilter.params,
      inboxVisibleFilter.shape,
    )) as { count: number };

    const lastSyncedAt =
      accounts.map((account) => account.lastSyncedAt || 0).sort((a, b) => b - a)[0] || undefined;
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
      statusLabel: googleWorkspaceAuthIssue
        ? googleWorkspaceAuthIssue.statusLabel
        : this.syncProgress?.phase === "error" && this.syncProgress.label
          ? this.syncProgress.label
          : accounts.length === 0
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
      syncHealth: await this.getMailboxSyncHealth(status.accounts),
      folders: await this.listMailboxFolders(),
      labels: await this.listMailboxLabels(),
      identities: await this.listMailboxIdentities(),
      signatures: await this.listMailboxSignatures(),
      composeDrafts: await this.listMailboxComposeDrafts(),
      queuedActions: await this.listMailboxQueuedActions(),
      outgoing: await this.listMailboxOutgoingMessages(),
      settings: await this.getMailboxClientSettings(),
    };
  }

  async getMailboxDraft(draftId: string): Promise<MailboxComposeDraft | null> {
    return this.getMailboxComposeDraft(draftId);
  }

  async createMailboxDraft(input: MailboxComposeDraftInput): Promise<MailboxComposeDraft> {
    const accountId = await this.resolveComposeAccountId(input.accountId, input.threadId);
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
    const workspaceId = await this.resolveComposeDraftWorkspaceIdForCreate(
      accountId,
      input.threadId,
    );
    await this.sql.run("createMailboxDraft_1", [
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
      JSON.stringify({
        source: "mailbox_compose",
        ...(workspaceId ? { workspaceId } : {}),
      }),
      now,
      now,
    ]);
    return (await this.getMailboxComposeDraft(id))!;
  }

  async updateMailboxDraft(
    draftId: string,
    patch: MailboxComposeDraftPatch,
  ): Promise<MailboxComposeDraft> {
    const draft = await this.getMailboxComposeDraft(draftId);
    if (!draft) throw new Error("Mailbox compose draft not found");
    const next = {
      subject: patch.subject ?? draft.subject,
      bodyText: patch.bodyText ?? draft.bodyText,
      bodyHtml: patch.bodyHtml === undefined ? draft.bodyHtml : patch.bodyHtml || undefined,
      to: patch.to ?? draft.to,
      cc: patch.cc ?? draft.cc,
      bcc: patch.bcc ?? draft.bcc,
      identityId: patch.identityId === undefined ? draft.identityId : patch.identityId || undefined,
      signatureId:
        patch.signatureId === undefined ? draft.signatureId : patch.signatureId || undefined,
      scheduledAt:
        patch.scheduledAt === undefined ? draft.scheduledAt : patch.scheduledAt || undefined,
    };
    await this.sql.run("updateMailboxDraft_1", [
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
    ]);
    return (await this.getMailboxComposeDraft(draftId))!;
  }

  async addMailboxDraftAttachment(
    draftId: string,
    input: MailboxDraftAttachmentInput,
  ): Promise<MailboxComposeDraft> {
    const draft = await this.getMailboxComposeDraft(draftId);
    if (!draft) throw new Error("Mailbox compose draft not found");
    const attachment = await this.normalizeComposeAttachmentInput(
      input,
      await this.resolveComposeDraftWorkspaceId(draft),
    );
    const attachments = [...draft.attachments, attachment];
    await this.sql.run("addMailboxDraftAttachment_1", [
      JSON.stringify(attachments),
      Date.now(),
      draftId,
    ]);
    return (await this.getMailboxComposeDraft(draftId))!;
  }

  async removeMailboxDraftAttachment(
    draftId: string,
    attachmentId: string,
  ): Promise<MailboxComposeDraft> {
    const draft = await this.getMailboxComposeDraft(draftId);
    if (!draft) throw new Error("Mailbox compose draft not found");
    const attachments = draft.attachments.filter((attachment) => attachment.id !== attachmentId);
    await this.sql.run("addMailboxDraftAttachment_1", [
      JSON.stringify(attachments),
      Date.now(),
      draftId,
    ]);
    return (await this.getMailboxComposeDraft(draftId))!;
  }

  async updateMailboxClientSettings(
    patch: MailboxClientSettingsPatch,
  ): Promise<MailboxClientState["settings"]> {
    const current = await this.getMailboxClientSettings();
    const next: MailboxClientState["settings"] = {
      remoteContentPolicy: ["load", "block", "ask"].includes(String(patch.remoteContentPolicy))
        ? patch.remoteContentPolicy!
        : current.remoteContentPolicy,
      sendDelaySeconds: Number.isFinite(patch.sendDelaySeconds)
        ? Math.min(Math.max(Math.floor(patch.sendDelaySeconds!), 0), 24 * 60 * 60)
        : current.sendDelaySeconds,
      syncRecentDays: Number.isFinite(patch.syncRecentDays)
        ? Math.min(Math.max(Math.floor(patch.syncRecentDays!), 1), 365)
        : current.syncRecentDays,
      attachmentCache: ["metadata_on_demand", "recent_cache", "never_cache"].includes(
        String(patch.attachmentCache),
      )
        ? patch.attachmentCache!
        : current.attachmentCache,
      notifications: ["all", "priority", "needs_reply", "off"].includes(String(patch.notifications))
        ? patch.notifications!
        : current.notifications,
    };
    await this.sql.run("updateMailboxClientSettings_1", [
      next.remoteContentPolicy,
      next.sendDelaySeconds,
      next.syncRecentDays,
      next.attachmentCache,
      next.notifications,
      Date.now(),
    ]);
    return this.getMailboxClientSettings();
  }

  async sendMailboxDraft(draftId: string): Promise<MailboxOutgoingMessage> {
    const draft = await this.getMailboxComposeDraft(draftId);
    if (!draft) throw new Error("Mailbox compose draft not found");
    if (!draft.to.length && !draft.cc.length && !draft.bcc.length) {
      throw new Error("Add at least one recipient before sending.");
    }
    const settings = await this.getMailboxClientSettings();
    const now = Date.now();
    const sendAfter = Math.max(draft.scheduledAt || 0, now + settings.sendDelaySeconds * 1000);
    const outgoingId = randomUUID();
    await this.sql.run("sendMailboxDraft_1", [
      outgoingId,
      draft.id,
      draft.accountId,
      draft.scheduledAt || null,
      sendAfter,
      JSON.stringify({ undoable: true }),
      now,
      now,
    ]);
    await this.sql.run("sendMailboxDraft_2", [
      draft.scheduledAt ? "scheduled" : "queued",
      sendAfter,
      now,
      draft.id,
    ]);
    await this.enqueueMailboxAction({
      accountId: draft.accountId,
      threadId: draft.threadId,
      draftId: draft.id,
      type: "send",
      payload: { outgoingId, sendAfter },
      nextAttemptAt: sendAfter,
    });
    void this.processMailboxQueue();
    return (await this.getMailboxOutgoingMessage(outgoingId))!;
  }

  async scheduleMailboxSend(draftId: string, scheduledAt: number): Promise<MailboxComposeDraft> {
    if (!Number.isFinite(scheduledAt) || scheduledAt <= Date.now()) {
      throw new Error("Scheduled send time must be in the future.");
    }
    return this.updateMailboxDraft(draftId, { scheduledAt });
  }

  async discardMailboxDraft(draftId: string): Promise<boolean> {
    const now = Date.now();
    const result = await this.sql.run("discardMailboxDraft_1", [now, draftId]);
    await this.sql.run("discardMailboxDraft_2", [now, draftId]);
    await this.sql.run("discardMailboxDraft_3", [now, draftId]);
    return result.changes > 0;
  }

  async undoMailboxAction(actionId: string): Promise<MailboxQueuedAction> {
    const existing = await this.getMailboxQueuedAction(actionId);
    if (!existing) throw new Error("Mailbox action not found");
    const now = Date.now();
    if (existing.type === "send" && existing.draftId) {
      await this.discardMailboxDraft(existing.draftId);
    }
    await this.sql.run("undoMailboxAction_1", [now, actionId]);
    return this.enqueueMailboxAction({
      accountId: existing.accountId,
      threadId: existing.threadId,
      draftId: existing.draftId,
      type: "undo",
      payload: { actionId, actionType: existing.type },
      undoOfActionId: actionId,
    });
  }

  async retryMailboxAction(actionId: string): Promise<MailboxQueuedAction> {
    const existing = await this.getMailboxQueuedAction(actionId);
    if (!existing) throw new Error("Mailbox action not found");
    if (existing.status === "outcome_unknown") {
      throw new Error(MAILBOX_SEND_OUTCOME_UNKNOWN_MESSAGE);
    }
    if (existing.status !== "failed") {
      return existing;
    }
    await this.sql.run("retryMailboxAction_1", [Date.now(), Date.now(), actionId]);
    void this.processMailboxQueue();
    return (await this.getMailboxQueuedAction(actionId))!;
  }

  async resolveMailboxSendOutcome(
    actionId: string,
    resolution: MailboxSendOutcomeResolution,
  ): Promise<MailboxQueuedAction> {
    const existing = await this.getMailboxQueuedAction(actionId);
    if (!existing) throw new Error("Mailbox action not found");
    if (existing.type !== "send" || existing.status !== "outcome_unknown" || !existing.draftId) {
      throw new Error("Only an unresolved mailbox send can be reconciled.");
    }
    const draft = await this.getMailboxComposeDraft(existing.draftId);
    if (!draft) throw new Error("Mailbox compose draft not found");
    const now = Date.now();
    await this.sql.unit("mailbox_resolveSendOutcome", [
      actionId,
      existing.draftId,
      resolution,
      now,
    ]);

    if (resolution === "confirmed_sent") {
      try {
        await this.applyPostSendLocalState(draft);
      } catch (error) {
        mailboxLogger.warn(
          "Could not update local mailbox state after manual send confirmation:",
          error,
        );
      }
    } else {
      await this.processMailboxQueue();
    }
    return (await this.getMailboxQueuedAction(actionId))!;
  }

  async processMailboxQueue(
    limit = 25,
  ): Promise<{ processed: number; succeeded: number; failed: number }> {
    if (this.outboxDrainInFlight || MailboxService.outboxDrainInFlight) {
      return { processed: 0, succeeded: 0, failed: 0 };
    }
    this.outboxDrainInFlight = true;
    MailboxService.outboxDrainInFlight = true;
    let processed = 0;
    let succeeded = 0;
    let failed = 0;
    try {
      await this.recoverInterruptedMailboxSends();
      const rows = (await this.sql.all("processMailboxQueue_1", [
        Date.now(),
        Math.min(Math.max(limit, 1), 100),
      ])) as MailboxQueuedActionRow[];
      for (const row of rows) {
        processed += 1;
        try {
          await this.processMailboxQueuedAction(this.mapMailboxQueuedActionRow(row));
          succeeded += 1;
        } catch (error) {
          failed += 1;
          if (
            row.action_type === "send" &&
            row.draft_id &&
            error instanceof MailboxSendOutcomeUnknownError
          ) {
            await this.markMailboxSendOutcomeUnknown(row.id, row.draft_id);
          } else {
            await this.markMailboxQueuedActionFailed(row, error);
          }
        }
      }
    } finally {
      this.outboxDrainInFlight = false;
      MailboxService.outboxDrainInFlight = false;
    }
    return { processed, succeeded, failed };
  }

  async listMailboxEvents(limit = 50, threadId?: string): Promise<MailboxEvent[]> {
    const workspaceId = await this.resolveDefaultWorkspaceId();
    if (!workspaceId) return [];
    const rows = (await this.sql.all("listMailboxEvents_1", [
      workspaceId,
      threadId || null,
      threadId || null,
      Math.min(Math.max(limit, 1), 200),
    ])) as MailboxEventRow[];
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
      workspaceId: input?.workspaceId || (await this.resolveDefaultWorkspaceId()),
      threadId: input?.threadId,
    });
  }

  async listThreadAutomations(threadId: string): Promise<MailboxAutomationRecord[]> {
    return MailboxAutomationRegistry.listThreadAutomations(threadId);
  }

  async createMailboxRule(recipe: MailboxRuleRecipe): Promise<MailboxAutomationRecord> {
    return MailboxAutomationRegistry.createRule({
      ...recipe,
      workspaceId: recipe.workspaceId || (await this.resolveDefaultWorkspaceId()),
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
      workspaceId: recipe.workspaceId || (await this.resolveDefaultWorkspaceId()),
    });
  }

  async createMailboxForward(recipe: MailboxForwardRecipe): Promise<MailboxAutomationRecord> {
    return MailboxAutomationRegistry.createForward({
      ...recipe,
      workspaceId: recipe.workspaceId || (await this.resolveDefaultWorkspaceId()),
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
      (await this.resolveThreadWorkspaceId(detail.accountId)) ||
      (await this.resolveDefaultWorkspaceId());
    const companyCandidates = await this.buildMissionControlCompanyCandidates(detail);
    const operatorRecommendations = await this.buildMissionControlOperatorRecommendations(
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
      existingHandoffs: await this.listMissionControlHandoffs(threadId),
    };
  }

  async createMissionControlHandoff(
    request: MailboxMissionControlHandoffRequest,
  ): Promise<MailboxMissionControlHandoffRecord> {
    const detail = await this.getThread(request.threadId);
    if (!detail) {
      throw new Error("Mailbox thread not found");
    }

    const company = await this.controlPlaneCore.getCompany(request.companyId);
    if (!company) {
      throw new Error("Company not found for inbox handoff");
    }

    const operator = await this.agentRoleRepo.findById(request.operatorRoleId);
    // Companies are no longer user-managed: any active agent without a company can
    // take the handoff; agents explicitly linked to a different company still cannot.
    if (
      !operator ||
      (operator.companyId && operator.companyId !== company.id) ||
      operator.isActive === false
    ) {
      throw new Error("Selected operator is not available for the chosen company");
    }

    const existing = await this.findActiveMissionControlHandoff(
      request.threadId,
      company.id,
      operator.id,
    );
    if (existing) {
      return existing;
    }

    const workspaceId =
      (await this.resolveThreadWorkspaceId(detail.accountId)) ||
      company.defaultWorkspaceId ||
      (await this.resolveDefaultWorkspaceId());
    if (!workspaceId) {
      throw new Error("No workspace available for inbox handoff");
    }

    const sensitiveContentRedacted = Boolean(detail.sensitiveContent?.hasSensitiveContent);
    const outputContract = this.buildMailboxHandoffOutputContract(company.id, operator.id, detail);
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
        primaryContactEmail:
          detail.research?.primaryContact?.email || detail.participants[0]?.email,
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

    const issue = await this.controlPlaneCore.createIssue({
      companyId: company.id,
      workspaceId,
      title: request.issueTitle.trim(),
      description:
        request.issueSummary?.trim() ||
        this.buildMissionControlIssueSummary(detail, sensitiveContentRedacted),
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

    const record = await this.persistMissionControlHandoff({
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
    await this.emitMailboxEvent({
      type: "mission_control_handoff_created",
      threadId: detail.id,
      accountId: detail.accountId,
      provider: detail.provider,
      subject: detail.subject,
      summary: `Mission Control handoff created for ${company.name}`,
      evidenceRefs: [detail.id, issue.id, operator.id],
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

  async listMissionControlHandoffs(
    threadId: string,
  ): Promise<MailboxMissionControlHandoffRecord[]> {
    const rows = (await this.sql.all("listMissionControlHandoffs_1", [
      threadId,
    ])) as MailboxMissionControlHandoffRow[];
    return Promise.all(rows.map((row) => this.mapMissionControlHandoffRow(row)));
  }

  async getMailboxDigest(workspaceId?: string): Promise<MailboxDigestSnapshot> {
    const resolvedWorkspaceId = workspaceId || (await this.resolveDefaultWorkspaceId());
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

    const inboxVisibleFilter = await this.buildInboxVisibleThreadFilter(resolvedWorkspaceId);
    const counts = (await this.sql.get(
      "digestThreadCounts",
      inboxVisibleFilter.params,
      inboxVisibleFilter.shape,
    )) as {
      thread_count: number;
      message_count: number;
      unread_count: number;
      needs_reply_count: number;
      classification_pending_count: number;
      sensitive_thread_count: number;
    };
    const proposalCountRow = (await this.sql.get(
      "visibleSuggestedProposalCount",
      inboxVisibleFilter.params,
      inboxVisibleFilter.shape,
    )) as { count: number };
    const commitmentCountRow = (await this.sql.get(
      "visibleOpenCommitmentCount",
      inboxVisibleFilter.params,
      inboxVisibleFilter.shape,
    )) as { count: number };
    const draftCountRow = (await this.sql.get(
      "visibleDraftCount",
      inboxVisibleFilter.params,
      inboxVisibleFilter.shape,
    )) as { count: number };
    const overdueCommitmentCountRow = (await this.sql.get(
      "visibleOverdueCommitmentCount",
      [Date.now(), ...inboxVisibleFilter.params],
      inboxVisibleFilter.shape,
    )) as { count: number };
    const eventCountRow = (await this.sql.get("getMailboxDigest_1", [resolvedWorkspaceId])) as {
      count: number;
    };
    const recentEventRows = (await this.sql.all("getMailboxDigest_2", [
      resolvedWorkspaceId,
    ])) as Array<{ event_type: MailboxEventType; count: number }>;
    const lastSyncedRow = (await this.sql.get("getMailboxDigest_3", [])) as {
      last_synced_at: number | null;
    };
    const clientState = await this.getMailboxClientState();
    const queuedActionCount = clientState.queuedActions.filter(
      (action) => action.status === "queued",
    ).length;
    const failedActionCount = clientState.queuedActions.filter(
      (action) => action.status === "failed",
    ).length;
    const composeDraftCount = clientState.composeDrafts.filter(
      (draft) => draft.status !== "sent",
    ).length;
    const scheduledSendCount = clientState.composeDrafts.filter(
      (draft) => draft.status === "scheduled",
    ).length;

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

  async getMailboxTodayDigest(
    input: { limitPerBucket?: number } = {},
  ): Promise<MailboxTodayDigest> {
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
        count: await this.countThreadsByTodayBucket(bucket),
        threads: await this.listThreads({
          todayBucket: bucket,
          mailboxView: "inbox",
          sortBy: "priority",
          limit: limitPerBucket,
        }),
      })),
    );
    const domainRows = (await this.sql.all("getMailboxTodayDigest_1", [])) as Array<{
      domain_category: MailboxDomainCategory;
      count: number;
    }>;
    const clientState = await this.getMailboxClientState();
    return {
      buckets,
      domainCounts: domainRows.map((row) => ({
        category: normalizeDomainCategory(row.domain_category, "other"),
        count: row.count,
      })),
      syncHealth: clientState.syncHealth,
      queuedActionCount: clientState.queuedActions.filter((action) => action.status === "queued")
        .length,
      failedActionCount: clientState.queuedActions.filter((action) => action.status === "failed")
        .length,
      composeDraftCount: clientState.composeDrafts.filter((draft) => draft.status !== "sent")
        .length,
      scheduledSendCount: clientState.composeDrafts.filter((draft) => draft.status === "scheduled")
        .length,
      generatedAt: Date.now(),
    };
  }

  private async countThreadsByTodayBucket(bucket: MailboxTodayBucket): Promise<number> {
    const inboxVisibleFilter = await this.buildInboxVisibleThreadFilter();
    const row = (await this.sql.get(
      "visibleTodayBucketCount",
      [bucket, ...inboxVisibleFilter.params],
      inboxVisibleFilter.shape,
    )) as { count: number } | undefined;
    return row?.count || 0;
  }

  async getMailboxSenderCleanupDigest(
    input: { limit?: number } = {},
  ): Promise<MailboxSenderCleanupDigest> {
    const limit = Math.min(Math.max(input.limit ?? 8, 1), 25);
    const rows = (await this.sql.all("getMailboxSenderCleanupDigest_1", [limit])) as Array<{
      email: string;
      name: string | null;
      thread_count: number;
      unread_count: number | null;
      cleanup_count: number | null;
      needs_reply_count: number | null;
      last_message_at: number;
    }>;
    const senders: MailboxSenderCleanupDigest["senders"] = [];
    for (const row of rows) {
      const threadRows = (await this.sql.all("getMailboxSenderCleanupDigest_2", [
        row.email,
      ])) as MailboxThreadRow[];
      const cleanupCount = row.cleanup_count || 0;
      senders.push({
        email: row.email,
        name: row.name || undefined,
        threadCount: row.thread_count,
        unreadCount: row.unread_count || 0,
        cleanupCandidateCount: cleanupCount,
        needsReplyCount: row.needs_reply_count || 0,
        estimatedWeeklyReduction: Math.max(cleanupCount, Math.ceil(row.thread_count / 4)),
        lastMessageAt: row.last_message_at,
        suggestedAction:
          cleanupCount > 0
            ? ("cleanup_local" as const)
            : row.unread_count
              ? ("mark_read" as const)
              : ("archive" as const),
        threads: await this.mapThreadRowsWithSummaries(threadRows),
      });
    }
    return { generatedAt: Date.now(), senders };
  }

  async askMailbox(
    input: MailboxAskInput,
    options: MailboxAskRunOptions = {},
  ): Promise<MailboxAskResult> {
    const query = input.query.trim();
    const runId = input.runId || randomUUID();
    const steps: MailboxAskRunEvent[] = [];
    const emitAskEvent = (event: Omit<MailboxAskRunEvent, "runId" | "timestamp">): void => {
      const runEvent: MailboxAskRunEvent = {
        runId,
        timestamp: Date.now(),
        ...event,
      };
      steps.push(runEvent);
      options.onAskEvent?.(runEvent);
    };
    if (!query) {
      return { query, runId, results: [], usedLlm: false, steps };
    }
    emitAskEvent({
      type: "started",
      stepId: "start",
      label: "Ask Inbox",
      detail: "Starting mailbox question run.",
      status: "running",
      payload: { query },
    });
    emitAskEvent({
      type: "step_started",
      stepId: "classify_intent",
      label: "Classify intent",
      detail: "Checking whether this is a mailbox question or a safe mailbox action.",
      status: "running",
    });
    const actionPlan = await this.planMailboxAskAction(query, input.limit);
    emitAskEvent({
      type: "step_completed",
      stepId: "classify_intent",
      label: "Classify intent",
      detail:
        actionPlan.action === "sent_followup_drafts"
          ? "Follow-up draft action detected."
          : "Mailbox question detected.",
      status: "done",
      payload: { action: actionPlan.action, usedLlm: actionPlan.usedLlm },
    });
    if (actionPlan.action === "sent_followup_drafts") {
      emitAskEvent({
        type: "step_started",
        stepId: "create_followup_drafts",
        label: "Create follow-up drafts",
        detail:
          "Finding sent threads without newer inbound replies and creating reviewable drafts.",
        status: "running",
      });
      const actionResult = await this.createSentFollowupDrafts({
        thresholdHours: actionPlan.thresholdHours,
        limit: actionPlan.limit ?? input.limit,
      });
      const results = actionResult.drafts.map((entry) => ({
        thread: entry.thread,
        snippet: entry.reason,
        score: 0,
      }));
      emitAskEvent({
        type: "step_completed",
        stepId: "create_followup_drafts",
        label: "Create follow-up drafts",
        detail: `${actionResult.createdDraftCount} draft${actionResult.createdDraftCount === 1 ? "" : "s"} created.`,
        status: "done",
        payload: {
          createdDraftCount: actionResult.createdDraftCount,
          skippedExistingDraftCount: actionResult.skippedExistingDraftCount,
        },
      });
      emitAskEvent({
        type: "completed",
        stepId: "complete",
        label: "Answer ready",
        detail: "Follow-up draft run completed.",
        status: "done",
      });
      return {
        query,
        runId,
        results,
        steps,
        usedLlm: actionPlan.usedLlm,
        action: {
          type: "sent_followup_drafts",
          result: actionResult,
        },
        answer: this.formatSentFollowupDraftAnswer(actionResult),
      };
    }
    const limit = Math.min(Math.max(input.limit ?? 8, 1), 20);
    const search = await this.getMailboxAgentSearchService().search(query, limit, {
      stepStarted: (stepId, label, detail, payload) =>
        emitAskEvent({
          type: "step_started",
          stepId,
          label,
          detail,
          status: "running",
          payload,
        }),
      stepCompleted: (stepId, label, detail, payload) =>
        emitAskEvent({
          type: "step_completed",
          stepId,
          label,
          detail,
          status: "done",
          payload,
        }),
    });
    const results = search.results;

    if (input.includeAnswer === false || !results.length) {
      emitAskEvent({
        type: "completed",
        stepId: "complete",
        label: results.length ? "Matches ready" : "No reliable evidence",
        detail: results.length
          ? `${results.length} mailbox result${results.length === 1 ? "" : "s"} matched.`
          : "No reliable mailbox evidence matched this question.",
        status: "done",
        payload: { resultCount: results.length },
      });
      return {
        query,
        runId,
        results,
        steps,
        usedLlm: false,
        answer:
          input.includeAnswer === false || results.length
            ? undefined
            : buildMailboxAskNoEvidenceAnswer(search),
      };
    }
    emitAskEvent({
      type: "step_started",
      stepId: "generate_answer",
      label: "Generate answer",
      detail: "Answering from the shortlisted mailbox evidence.",
      status: "running",
    });
    const answer = await this.generateMailboxAskAnswer(query, results, search);
    emitAskEvent({
      type: answer.error ? "error" : "step_completed",
      stepId: "generate_answer",
      label: "Generate answer",
      detail: answer.error || "Answer generated from mailbox evidence.",
      status: answer.error ? "error" : "done",
    });
    emitAskEvent({
      type: answer.error ? "error" : "completed",
      stepId: "complete",
      label: answer.error ? "Ask failed" : "Answer ready",
      detail: answer.error || "Mailbox question run completed.",
      status: answer.error ? "error" : "done",
      payload: { resultCount: results.length },
    });
    return {
      query,
      runId,
      results,
      steps,
      answer: answer.answer,
      usedLlm: answer.usedLlm,
      error: answer.error,
    };
  }

  private async searchMailboxRows(
    query: string,
    limit: number,
  ): Promise<
    Array<{
      thread_id: string;
      attachment_id: string | null;
      snippet: string;
      score: number;
    }>
  > {
    await this.ensureMailboxSearchIndexBackfilled();
    const tokens = tokenizeMailboxQuery(query);
    const ftsQuery = buildMailboxFtsQuery(query);
    if (ftsQuery) {
      try {
        const rows = (await this.sql.all("searchMailboxRows_1", [
          ftsQuery,
          Math.max(limit * 12, 80),
        ])) as Array<{
          thread_id: string;
          attachment_id: string | null;
          snippet: string;
          subject: string;
          sender: string;
          body: string;
          attachment_filename: string;
          attachment_text: string;
          fts_score: number;
        }>;
        return rows
          .map((row) => ({
            thread_id: row.thread_id,
            attachment_id: row.attachment_id,
            snippet: row.snippet,
            score: this.scoreMailboxSearchRow(query, tokens, row),
          }))
          .sort((a, b) => b.score - a.score)
          .slice(0, Math.max(limit * 3, 12));
      } catch {
        // Fall back below.
      }
    }
    const needle = `%${normalizeMailboxSearchText(query)}%`;
    return (await this.sql.all("searchMailboxRows_2", [needle, Math.max(limit * 3, 12)])) as Array<{
      thread_id: string;
      attachment_id: string | null;
      snippet: string;
      score: number;
    }>;
  }

  private scoreMailboxSearchRow(
    query: string,
    tokens: string[],
    row: {
      subject?: string | null;
      sender?: string | null;
      body?: string | null;
      attachment_filename?: string | null;
      attachment_text?: string | null;
      fts_score?: number;
    },
  ): number {
    const subject = normalizeMailboxSearchText(row.subject || "");
    const sender = normalizeMailboxSearchText(row.sender || "");
    const body = normalizeMailboxSearchText(row.body || "");
    const attachment = normalizeMailboxSearchText(
      `${row.attachment_filename || ""} ${row.attachment_text || ""}`,
    );
    const haystack = `${subject} ${sender} ${body} ${attachment}`;
    const matched = tokens.filter((token) => haystack.includes(token));
    const subjectSenderMatches = tokens.filter(
      (token) => subject.includes(token) || sender.includes(token),
    );
    const attachmentMatches = tokens.filter((token) => attachment.includes(token));
    const importantMatches = matched.filter(
      (token) => token.length >= 4 || /^[a-z]{2,4}\d*$/.test(token),
    );
    const phraseBonus = normalizeMailboxSearchText(query)
      .split(
        /\b(?:when|where|what|who|how|do|does|should|need|make|pay|payment|date|for|my|the|a|an)\b/,
      )
      .map((part) => part.trim())
      .filter((part) => part.length >= 4)
      .some((part) => haystack.includes(part))
      ? 8
      : 0;
    return (
      matched.length * 10 +
      importantMatches.length * 6 +
      subjectSenderMatches.length * 12 +
      attachmentMatches.length * 4 +
      phraseBonus -
      Math.max(0, row.fts_score || 0)
    );
  }

  private async generateMailboxAskAnswer(
    query: string,
    results: MailboxAskResult["results"],
    search?: Awaited<ReturnType<MailboxAgentSearchService["search"]>>,
  ): Promise<{ answer?: string; usedLlm: boolean; error?: string }> {
    const modelSelection = this.chooseMailboxClassifierModel();
    if (!modelSelection) {
      return { usedLlm: false };
    }
    const workspaceId = (await this.resolveDefaultWorkspaceId()) || "";
    try {
      const provider = LLMProviderFactory.createProvider();
      const evidence = await Promise.all(
        results.slice(0, 8).map(async (result) => {
          const detail = await this.getThread(result.thread.id);
          return {
            subject: result.thread.subject,
            sender: result.thread.participants[0],
            snippet: result.snippet,
            score: result.score,
            searchSources: result.searchSources,
            matchedFields: result.matchedFields,
            evidenceSnippets: result.evidenceSnippets,
            messages: (detail?.messages || []).slice(-3).map((message) => ({
              direction: message.direction,
              from: message.from,
              receivedAt: message.receivedAt,
              snippet: message.snippet,
              body: normalizeWhitespace(
                message.bodyHtml ? stripHtml(message.bodyHtml) : message.body,
                2200,
              ),
            })),
            attachment: result.matchedAttachment
              ? {
                  filename: result.matchedAttachment.filename,
                  text: result.matchedAttachment.text?.slice(0, 1600),
                }
              : undefined,
          };
        }),
      );
      const response = await provider.createMessage({
        model: modelSelection.modelId,
        maxTokens: MAILBOX_ASK_MAX_TOKENS,
        system:
          "Answer mailbox questions from the supplied mailbox evidence. Be concise. If the evidence directly answers the question, answer from that email and mention the relevant subject/sender. If the evidence is only related, say that related emails were found but the requested fact was not clear. If evidence is weak, do not guess. Preserve dates, amounts, account names, and due-date wording exactly when present.",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  query,
                  search: search
                    ? {
                        plan: {
                          entities: search.plan.entities,
                          tokens: search.plan.tokens,
                          expandedTokens: search.plan.expandedTokens.slice(0, 18),
                          wantsAttachmentEvidence: search.plan.wantsAttachmentEvidence,
                          wantsFinancialEvidence: search.plan.wantsFinancialEvidence,
                          wantsDueDate: search.plan.wantsDueDate,
                        },
                        coverage: search.coverage,
                      }
                    : undefined,
                  evidence,
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
          providerType: modelSelection.providerType,
          modelKey: modelSelection.modelKey,
          modelId: modelSelection.modelId,
        },
        response.usage,
      );
      return {
        usedLlm: true,
        answer: normalizeWhitespace(
          response.content.map((block) => (block.type === "text" ? block.text : "")).join("\n"),
          900,
        ),
      };
    } catch (error) {
      recordLlmCallError(
        {
          workspaceId,
          sourceKind: "mailbox_ask",
          sourceId: query.slice(0, 120),
          providerType: modelSelection.providerType,
          modelKey: modelSelection.modelKey,
          modelId: modelSelection.modelId,
        },
        error,
      );
      return {
        usedLlm: false,
        error: "Could not generate an AI answer. Showing local matches instead.",
      };
    }
  }

  private async searchConnectedMailboxProviders(
    plan: MailboxSearchQueryPlan,
    limit: number,
  ): Promise<Array<{ thread: MailboxThreadDetail; snippet?: string; score?: number }>> {
    const results: Array<{ thread: MailboxThreadDetail; snippet?: string; score?: number }> = [];
    const seen = new Set<string>();
    try {
      for (const result of await this.searchGmailProvider(plan, limit)) {
        if (seen.has(result.thread.id)) continue;
        seen.add(result.thread.id);
        results.push(result);
      }
    } catch {
      // Provider-native search is additive; keep local and other provider results.
    }
    try {
      for (const result of await this.searchMicrosoftGraphProvider(
        plan,
        Math.max(0, limit - results.length),
      )) {
        if (seen.has(result.thread.id)) continue;
        seen.add(result.thread.id);
        results.push(result);
        if (results.length >= limit) break;
      }
    } catch {
      // Provider-native search is additive; keep local results.
    }
    return results.slice(0, limit);
  }

  private async searchGmailProvider(
    plan: MailboxSearchQueryPlan,
    limit: number,
  ): Promise<Array<{ thread: MailboxThreadDetail; snippet?: string; score?: number }>> {
    const settings = GoogleWorkspaceSettingsManager.loadSettings();
    if (!settings.enabled || limit <= 0) return [];
    const profileResult = await gmailRequest(settings, {
      method: "GET",
      path: "/users/me/profile",
    });
    const emailAddress = asString(profileResult.data?.emailAddress);
    if (!emailAddress) return [];
    const accountId = `gmail:${emailAddress.toLowerCase()}`;
    const refs: string[] = [];
    const seenProviderThreads = new Set<string>();
    for (const query of plan.providerQueries) {
      const result = await gmailRequest(settings, {
        method: "GET",
        path: "/users/me/messages",
        query: {
          maxResults: Math.min(Math.max(limit, 5), 10),
          q: normalizeWhitespace(`${query} in:anywhere`, 220),
        },
      });
      const messages = (Array.isArray(result.data?.messages) ? result.data.messages : []) as Array<{
        threadId?: unknown;
      }>;
      for (const message of messages) {
        const threadId = asString(message.threadId);
        if (!threadId || seenProviderThreads.has(threadId)) continue;
        seenProviderThreads.add(threadId);
        refs.push(threadId);
        if (refs.length >= limit) break;
      }
      if (refs.length >= limit) break;
    }

    const results: Array<{ thread: MailboxThreadDetail; snippet?: string; score?: number }> = [];
    for (const threadId of refs) {
      const threadResult = await gmailRequest(settings, {
        method: "GET",
        path: `/users/me/threads/${encodeURIComponent(threadId)}`,
        query: {
          format: "full",
        },
      });
      const normalized = this.normalizeGmailThread(
        accountId,
        emailAddress.toLowerCase(),
        threadResult.data,
      );
      if (!normalized) continue;
      await this.upsertThread(normalized);
      const detail = await this.getThread(normalized.id);
      if (detail) {
        results.push({
          thread: detail,
          snippet: detail.snippet,
          score: 54,
        });
      }
    }
    return results;
  }

  private async searchMicrosoftGraphProvider(
    plan: MailboxSearchQueryPlan,
    limit: number,
  ): Promise<Array<{ thread: MailboxThreadDetail; snippet?: string; score?: number }>> {
    if (limit <= 0) return [];
    const channel = await this.channelRepo.findByType("email");
    if (!channel || !channel.enabled) return [];
    const config = (channel.config as Any) || {};
    if (asString(config.authMethod) !== "oauth" || asString(config.oauthProvider) !== "microsoft")
      return [];
    const address = (
      asString(config.email) ||
      asString(config.displayName) ||
      "outlook"
    ).toLowerCase();
    const accountId = `outlook-graph:${address}`;
    await this.upsertAccount({
      id: accountId,
      provider: "outlook_graph",
      address,
      displayName: asString(config.displayName) || address,
      status: "connected",
      capabilities: mergeMailboxCapabilities(["provider_search"], "microsoft_graph"),
      backend: "microsoft_graph",
      lastSyncedAt: Date.now(),
    });

    const seen = new Set<string>();
    const normalizedThreads: NormalizedThreadInput[] = [];
    for (const rawQuery of plan.providerQueries) {
      const searchQuery = normalizeWhitespace(
        rawQuery.replace(/\bhas:attachment\b/gi, "attachment"),
        160,
      );
      if (!searchQuery) continue;
      const data = await this.microsoftGraphRequest(channel.id, {
        method: "GET",
        path: "/me/messages",
        scopes: MICROSOFT_GRAPH_READWRITE_SCOPES,
        query: {
          $search: `"${searchQuery.replace(/"/g, '\\"')}"`,
          $top: String(Math.min(Math.max(limit, 5), 10)),
          $select: MICROSOFT_GRAPH_MESSAGE_SELECT,
        },
        headers: {
          ConsistencyLevel: "eventual",
        },
      });
      const messages = Array.isArray(data?.value) ? data.value : [];
      for (const message of messages) {
        const normalized = this.normalizeMicrosoftGraphMessage(accountId, address, message);
        if (!normalized || seen.has(normalized.id)) continue;
        seen.add(normalized.id);
        normalizedThreads.push(normalized);
        if (normalizedThreads.length >= limit) break;
      }
      if (normalizedThreads.length >= limit) break;
    }

    const results: Array<{ thread: MailboxThreadDetail; snippet?: string; score?: number }> = [];
    for (const normalized of normalizedThreads) {
      await this.upsertThread(normalized);
      const detail = await this.getThread(normalized.id);
      if (detail) results.push({ thread: detail, snippet: detail.snippet, score: 52 });
    }
    return results;
  }

  async createSentFollowupDrafts(
    input: MailboxSentFollowupDraftInput = {},
  ): Promise<MailboxSentFollowupDraftResult> {
    const thresholdHours = Math.min(
      Math.max(
        Math.floor(input.thresholdHours || MAILBOX_SENT_FOLLOWUP_DEFAULT_THRESHOLD_HOURS),
        1,
      ),
      24 * 30,
    );
    const limit = Math.min(Math.max(input.limit ?? 5, 1), MAILBOX_SENT_FOLLOWUP_MAX_LIMIT);
    const now = Date.now();
    const cutoff = now - thresholdHours * 60 * 60 * 1000;
    const rows = (await this.sql.all("createSentFollowupDrafts_1", [cutoff, limit * 3])) as Array<
      MailboxThreadRow & {
        latest_outbound_message_id: string;
        latest_outbound_subject: string | null;
        latest_outbound_to_json: string | null;
        latest_outbound_cc_json: string | null;
        latest_outbound_at: number;
      }
    >;

    const drafts: MailboxSentFollowupDraftResult["drafts"] = [];
    let skippedExistingDraftCount = 0;

    for (const row of rows) {
      if (drafts.length >= limit) break;
      const existingDraft = (await this.sql.get("createSentFollowupDrafts_2", [row.id, row.id])) as
        | { id: string }
        | undefined;
      if (existingDraft) {
        skippedExistingDraftCount += 1;
        continue;
      }

      const to = this.normalizeRecipients(
        parseJsonArray<MailboxRecipientInput>(row.latest_outbound_to_json),
      );
      if (!to.length) {
        continue;
      }
      const cc = this.normalizeRecipients(
        parseJsonArray<MailboxRecipientInput>(row.latest_outbound_cc_json),
      );
      const thread = await this.mapThreadRow(row, await this.getSummaryForThread(row.id));
      const waitHours = Math.max(1, Math.floor((now - row.latest_outbound_at) / (60 * 60 * 1000)));
      const subject = this.prefixMailboxSubject(row.latest_outbound_subject || row.subject, "Re:");
      const bodyText = this.buildSentFollowupDraftBody(thread, to, waitHours);
      const reason = `No inbound reply detected ${waitHours} hours after your last sent message. Prioritized by mailbox priority and urgency.`;
      const draftId = randomUUID();
      await this.sql.run("createSentFollowupDrafts_3", [
        draftId,
        row.id,
        subject,
        encryptMailboxValue(bodyText),
        reason,
        JSON.stringify({
          source: "sent_followup_scan",
          latestOutboundMessageId: row.latest_outbound_message_id,
          thresholdHours,
          waitHours,
          to,
          cc,
        }),
        now,
        now,
      ]);
      const draft = {
        id: draftId,
        threadId: row.id,
        subject,
        body: bodyText,
        tone: "concise" as const,
        rationale: reason,
        createdAt: now,
        updatedAt: now,
      };
      drafts.push({
        thread,
        draft,
        lastOutboundAt: row.latest_outbound_at,
        waitHours,
        reason,
      });
      await this.emitMailboxEvent({
        type: "draft_created",
        threadId: row.id,
        accountId: row.account_id,
        provider: row.provider,
        subject: row.subject,
        summary: reason,
        evidenceRefs: [row.id, row.latest_outbound_message_id, draftId],
        payload: {
          draftId,
          source: "sent_followup_scan",
          thresholdHours,
          waitHours,
          recipientCount: to.length + cc.length,
        },
      });
    }

    return {
      thresholdHours,
      createdDraftCount: drafts.length,
      skippedExistingDraftCount,
      drafts,
      generatedAt: now,
    };
  }

  private isSentFollowupDraftRequest(query: string): boolean {
    const normalized = query.toLowerCase();
    return (
      /\b(draft|write|create|prepare|compose|generate|make)\b/.test(normalized) &&
      /\b(follow[-\s]?up(s)?|chase|nudge|remind|circle back|check in)\b/.test(normalized) &&
      /\b(no reply|no replies|not replied|haven[\u2019']?t (replied|responded|answered)|hasn[\u2019']?t (replied|responded|answered)|haven[\u2019']?t heard back|not heard back|heard nothing|unanswered|waiting|still waiting|no response|after \d+\s*(h|hr|hour|hours|d|day|days))\b/.test(
        normalized,
      )
    );
  }

  private async planMailboxAskAction(
    query: string,
    requestedLimit?: number,
  ): Promise<MailboxAskActionPlan> {
    const fallback = this.planMailboxAskActionHeuristically(query, requestedLimit);
    const modelSelection = this.chooseMailboxClassifierModel();
    if (!modelSelection) {
      return fallback;
    }

    const workspaceId = (await this.resolveDefaultWorkspaceId()) || "";
    try {
      const provider = LLMProviderFactory.createProvider();
      const response = await provider.createMessage({
        model: modelSelection.modelId,
        maxTokens: 320,
        system:
          "Classify mailbox instructions into the supported safe action catalog. Return compact JSON only. Do not invent unsupported actions.",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  instruction: query,
                  requestedLimit,
                  safeActions: [
                    {
                      action: "sent_followup_drafts",
                      description:
                        "Find sent/outbound email threads where the user's latest outbound message has no newer inbound reply, prioritize candidates, and create local reviewable follow-up drafts. Never sends messages.",
                      parameters: {
                        thresholdHours:
                          "Optional age threshold for the latest outbound message. Default 24. Examples: 'after 2 days' => 48, 'older than a week' => 168.",
                        limit: "Optional max number of drafts, 1-20.",
                      },
                    },
                    {
                      action: "none",
                      description:
                        "Use when the instruction is only a search/question, asks for unsupported mailbox mutations, or should not create drafts.",
                    },
                  ],
                  outputShape: {
                    action: "sent_followup_drafts | none",
                    thresholdHours: "number | undefined",
                    limit: "number | undefined",
                    rationale: "short string",
                  },
                }),
              },
            ],
          },
        ],
      });
      recordLlmCallSuccess(
        {
          workspaceId,
          sourceKind: "mailbox_ask_action_plan",
          sourceId: query.slice(0, 120),
          providerType: modelSelection.providerType,
          modelKey: modelSelection.modelKey,
          modelId: modelSelection.modelId,
        },
        response.usage,
      );
      const text = response.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("\n");
      const parsed = this.parseMailboxAskActionPlanText(text);
      if (parsed) {
        return parsed;
      }
    } catch (error) {
      recordLlmCallError(
        {
          workspaceId,
          sourceKind: "mailbox_ask_action_plan",
          sourceId: query.slice(0, 120),
          providerType: modelSelection.providerType,
          modelKey: modelSelection.modelKey,
          modelId: modelSelection.modelId,
        },
        error,
      );
    }
    return fallback;
  }

  private planMailboxAskActionHeuristically(
    query: string,
    requestedLimit?: number,
  ): MailboxAskActionPlan {
    if (!this.isSentFollowupDraftRequest(query)) {
      return { action: "none", usedLlm: false };
    }
    return {
      action: "sent_followup_drafts",
      thresholdHours: this.extractSentFollowupThresholdHours(query),
      limit: requestedLimit,
      rationale: "Instruction asks for draft follow-ups on sent messages without replies.",
      usedLlm: false,
    };
  }

  private parseMailboxAskActionPlanText(text: string): MailboxAskActionPlan | null {
    const trimmed = text.trim();
    const jsonText = trimmed.match(/\{[\s\S]*\}/)?.[0] || trimmed;
    try {
      const parsed = asObject(JSON.parse(jsonText));
      const action = asString(parsed?.action);
      const thresholdHours = asNumber(parsed?.thresholdHours) ?? undefined;
      const limit = asNumber(parsed?.limit) ?? undefined;
      const rationale = asString(parsed?.rationale) || undefined;
      if (action === "sent_followup_drafts") {
        return {
          action,
          thresholdHours,
          limit,
          rationale,
          usedLlm: true,
        };
      }
      if (action === "none") {
        return {
          action,
          rationale,
          usedLlm: true,
        };
      }
    } catch {
      return null;
    }
    return null;
  }

  private extractSentFollowupThresholdHours(query: string): number {
    const normalized = query.toLowerCase();
    const hourMatch = normalized.match(
      /\b(?:after|older than|over)\s+(\d{1,3})\s*(?:h|hr|hrs|hour|hours)\b/,
    );
    if (hourMatch) return Number(hourMatch[1]);
    const dayMatch = normalized.match(/\b(?:after|older than|over)\s+(\d{1,2})\s*(?:d|day|days)\b/);
    if (dayMatch) return Number(dayMatch[1]) * 24;
    return MAILBOX_SENT_FOLLOWUP_DEFAULT_THRESHOLD_HOURS;
  }

  private buildSentFollowupDraftBody(
    thread: MailboxThreadListItem,
    recipients: MailboxRecipientInput[],
    waitHours: number,
  ): string {
    const firstRecipient = recipients[0];
    const firstName = firstRecipient?.name?.trim().split(/\s+/)[0];
    const greeting = firstName ? `Hi ${firstName},` : "Hi,";
    const subject = normalizeWhitespace(thread.subject.replace(/^(re|fwd):\s*/i, ""), 90);
    const waitLabel = waitHours >= 48 ? `${Math.floor(waitHours / 24)} days` : `${waitHours} hours`;
    return [
      greeting,
      "",
      `Just following up on my note about ${subject || "this"}. I know schedules get busy, so I wanted to check whether you had a chance to review it.`,
      "",
      `When you have a moment, a quick update would be helpful. It has been about ${waitLabel} since my last message.`,
      "",
      "Thanks,",
    ].join("\n");
  }

  private formatSentFollowupDraftAnswer(result: MailboxSentFollowupDraftResult): string {
    if (!result.createdDraftCount) {
      return result.skippedExistingDraftCount
        ? `I found sent follow-up candidates after ${result.thresholdHours} hours, but they already have open drafts.`
        : `I did not find sent threads that still need a follow-up after ${result.thresholdHours} hours.`;
    }
    const topDrafts = result.drafts
      .slice(0, 5)
      .map(
        (entry, index) =>
          `${index + 1}. ${entry.thread.subject} - draft created after ${entry.waitHours} hours without a reply.`,
      )
      .join("\n");
    const skipped = result.skippedExistingDraftCount
      ? `\n\nSkipped ${result.skippedExistingDraftCount} thread${result.skippedExistingDraftCount === 1 ? "" : "s"} that already had an open draft.`
      : "";
    return `Created ${result.createdDraftCount} follow-up draft${result.createdDraftCount === 1 ? "" : "s"} from sent threads with no inbound reply after ${result.thresholdHours} hours.\n\n${topDrafts}${skipped}`;
  }

  private async extractCandidateAttachmentsForAsk(query: string): Promise<void> {
    const needle = `%${query.toLowerCase()}%`;
    const broadAttachmentQuery =
      /\b(invoice|contract|receipt|pdf|docx|attachment|file|statement|extract|payment|credit|card|bill|ekstre|hesap|odeme|ödeme|kredi|kart)\b/i.test(
        query,
      );
    const rows = (await this.sql.all("extractCandidateAttachmentsForAsk_1", [
      broadAttachmentQuery ? 1 : 0,
      needle,
    ])) as MailboxAttachmentRow[];
    for (const row of rows) {
      if (!isSupportedMailboxAttachment(row.filename, row.mime_type)) continue;
      try {
        await this.extractMailboxAttachmentText(row.id);
      } catch {
        // Search should not fail because one attachment cannot be extracted.
      }
    }
  }

  async getMailboxAttachment(
    attachmentId: string,
    includeText = false,
  ): Promise<MailboxAttachmentRecord | null> {
    const row = (await this.sql.get("getMailboxAttachment_1", [attachmentId])) as
      | MailboxAttachmentRow
      | undefined;
    if (!row) return null;
    return this.mapAttachmentRow(row, includeText);
  }

  async extractMailboxAttachmentText(attachmentId: string): Promise<MailboxAttachmentRecord> {
    const row = (await this.sql.get("extractMailboxAttachmentText_1", [attachmentId])) as
      | MailboxAttachmentRow
      | undefined;
    if (!row) {
      throw new Error("Attachment not found");
    }
    const now = Date.now();
    if (!isSupportedMailboxAttachment(row.filename, row.mime_type)) {
      await this.sql.run("extractMailboxAttachmentText_2", [now, attachmentId]);
      const unsupported = await this.getMailboxAttachment(attachmentId, true);
      if (!unsupported) throw new Error("Attachment not found");
      return unsupported;
    }
    if (row.size && row.size > MAILBOX_ATTACHMENT_TEXT_MAX_BYTES) {
      await this.sql.run("extractMailboxAttachmentText_3", [
        "Attachment is too large for local text extraction.",
        now,
        attachmentId,
      ]);
      const tooLarge = await this.getMailboxAttachment(attachmentId, true);
      if (!tooLarge) throw new Error("Attachment not found");
      return tooLarge;
    }

    try {
      await this.sql.run("extractMailboxAttachmentText_4", [now, attachmentId]);
      const bytes = await this.fetchMailboxAttachmentBytes(row);
      const extracted = await this.extractTextFromAttachmentBytes(row, bytes);
      const text = normalizeWhitespace(extracted.text, MAILBOX_ATTACHMENT_TEXT_MAX_CHARS);
      await this.sql.run("extractMailboxAttachmentText_5", [
        attachmentId,
        encryptMailboxValue(text),
        extracted.mode,
        Date.now(),
      ]);
      await this.sql.run("extractMailboxAttachmentText_6", [Date.now(), attachmentId]);
      await this.upsertAttachmentSearchIndex(attachmentId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.sql.run("extractMailboxAttachmentText_3", [
        normalizeWhitespace(message, 240),
        Date.now(),
        attachmentId,
      ]);
    }
    const updated = await this.getMailboxAttachment(attachmentId, true);
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
      // Attachments are untrusted: parse in a bounded worker, never on the main thread.
      try {
        const parsed = await parsePdfBufferBounded(bytes, LOCAL_PDF_PARSE_LIMITS);
        return { text: parsed.text || "", mode: "pdf-parse" };
      } catch (error) {
        if (error instanceof PdfParseLimitError) {
          throw new Error(`PDF attachment is too large or complex to extract (${error.message}).`);
        }
        throw error;
      }
    }
    if (
      mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      filename.endsWith(".docx")
    ) {
      const mammoth = await import("mammoth");
      await loadDocumentArchive(bytes);
      const result = await mammoth.extractRawText({ buffer: bytes });
      return { text: result.value || "", mode: "mammoth-docx" };
    }
    const raw = bytes.toString("utf8");
    return {
      text: mimeType === "text/html" || /\.(html|htm)$/i.test(filename) ? stripHtml(raw) : raw,
      mode:
        mimeType === "text/html" || /\.(html|htm)$/i.test(filename) ? "html-text" : "plain-text",
    };
  }

  private mapAttachmentRow(
    row: MailboxAttachmentRow,
    includeText = false,
  ): MailboxAttachmentRecord {
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

  private async resolveDefaultWorkspaceId(): Promise<string | undefined> {
    const workspaces = await this.workspaceRepo.findAll();
    const preferred = workspaces.find(
      (workspace) => !workspace.isTemp && !isTempWorkspaceId(workspace.id),
    );
    return preferred?.id || workspaces[0]?.id;
  }

  /**
   * Parameters and shape of the inbox visibility filter; the SQL comes from the catalog
   * (`inboxVisibleThreadFilterSql`), so it is identical on the host and in the worker.
   */
  private async buildInboxVisibleThreadFilter(
    requestedWorkspaceId?: string,
  ): Promise<{ shape: { withWorkspace: boolean; obsoleteAccounts: number }; params: string[] }> {
    const workspaceId =
      requestedWorkspaceId === undefined
        ? await this.resolveDefaultWorkspaceId()
        : requestedWorkspaceId;
    const params: string[] = [];
    if (workspaceId) params.push(workspaceId, workspaceId, workspaceId);
    const obsoleteAccountIds = await this.getObsoleteDuplicateMailboxAccountIds();
    params.push(...obsoleteAccountIds);
    return {
      shape: { withWorkspace: Boolean(workspaceId), obsoleteAccounts: obsoleteAccountIds.length },
      params,
    };
  }

  /** Drops unknown or stale thread ids (e.g. hallucinated LLM output) before persisting saved views. */
  private async filterValidMailboxThreadIds(
    threadIds: string[],
    accountId?: string,
  ): Promise<string[]> {
    const ids = [...new Set(threadIds.map((id) => id?.trim()).filter(Boolean))] as string[];
    if (!ids.length) return [];
    const rows = await this.sql.all<{ id: string }>("existingThreadIds", [
      JSON.stringify(ids),
      accountId || null,
      accountId || null,
    ]);
    const allowed = new Set(rows.map((r) => r.id));
    return ids.filter((id) => allowed.has(id));
  }

  private scoreSavedViewCandidate(
    seedTokens: Set<string>,
    subject: string,
    snippet: string,
  ): number {
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

  private async pruneMailboxTriageFeedback(workspaceId: string): Promise<void> {
    const maxAgeMs = 90 * 24 * 60 * 60 * 1000;
    const maxRows = 12_000;
    const cutoff = Date.now() - maxAgeMs;
    try {
      await this.sql.run("pruneMailboxTriageFeedback_1", [workspaceId, cutoff]);
      const countRow = (await this.sql.get("pruneMailboxTriageFeedback_2", [workspaceId])) as {
        c: number;
      };
      if (countRow.c > maxRows) {
        const excess = countRow.c - maxRows;
        await this.sql.run("pruneMailboxTriageFeedback_3", [workspaceId, excess]);
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

  private async buildMailboxEventRecord(
    event: MailboxEventRecordInput,
  ): Promise<MailboxEventRecordResult | null> {
    const workspaceId = event.workspaceId || (await this.resolveDefaultWorkspaceId());
    if (!workspaceId) return null;

    const evidenceRefs = normalizeMailboxEvidenceRefs(event.evidenceRefs);
    const payload = {
      ...event.payload,
      accountId: event.accountId,
      threadId: event.threadId,
      provider: event.provider,
      subject: event.subject,
      summary: event.summary,
      evidenceRefs,
    };
    const fingerprint = buildMailboxEventFingerprint(event.type, workspaceId, payload);
    const timestamp = event.timestamp || Date.now();
    const existing = (await this.sql.get("buildMailboxEventRecord_1", [fingerprint])) as
      | { id: string; duplicate_count: number }
      | undefined;

    if (existing) {
      const duplicateCount = (existing.duplicate_count || 0) + 1;
      await this.sql.run("buildMailboxEventRecord_2", [duplicateCount, timestamp, existing.id]);
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
    await this.sql.run("buildMailboxEventRecord_3", [
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
    ]);

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

  private async emitMailboxEvent(event: MailboxEventRecordInput): Promise<MailboxEvent | null> {
    const record = await this.buildMailboxEventRecord(event);
    if (!record) return null;
    if (!record.isDuplicate) {
      await MailboxAutomationHub.handleMailboxEvent(record.event);
    }
    return record.event;
  }

  private async countPendingMailboxClassifications(accountIds: string[]): Promise<number> {
    const ids = Array.from(new Set(accountIds.filter(Boolean)));
    if (ids.length === 0) return 0;
    const row = await this.sql.get<{ count: number }>("pendingClassificationCountForAccounts", [
      JSON.stringify(ids),
    ]);
    return row?.count || 0;
  }

  private async listMailboxAccountIds(): Promise<string[]> {
    const rows = (await this.sql.all("listMailboxAccountIds_1", [])) as Array<{
      id: string;
    }>;
    const obsoleteIds = new Set(await this.getObsoleteDuplicateMailboxAccountIds());
    return rows.map((row) => row.id).filter((id) => Boolean(id) && !obsoleteIds.has(id));
  }

  private async classifyPendingMailboxBacklog(
    accountIds: string[],
    limit: number,
  ): Promise<MailboxReclassifyResult> {
    const ids = Array.from(new Set(accountIds.filter(Boolean)));
    const cappedLimit = Math.min(Math.max(limit, 1), 200);
    const pendingCount = await this.countPendingMailboxClassifications(ids);
    if (ids.length === 0 || pendingCount === 0) {
      return { accountId: "all", scannedThreads: 0, reclassifiedThreads: 0 };
    }

    mailboxLogger.info("Mailbox pending classification pass starting", {
      accountCount: ids.length,
      pendingCount,
      limit: cappedLimit,
    });

    this.updateSyncProgress({
      phase: "classifying",
      totalThreads: pendingCount,
      processedThreads: 0,
      totalMessages: 0,
      processedMessages: 0,
      newThreads: pendingCount,
      classifiedThreads: 0,
      skippedThreads: 0,
      label: `Classifying ${Math.min(pendingCount, cappedLimit)} pending thread${Math.min(pendingCount, cappedLimit) === 1 ? "" : "s"}...`,
    });

    let remaining = cappedLimit;
    let scannedThreads = 0;
    let reclassifiedThreads = 0;
    for (const accountId of ids) {
      if (remaining <= 0) break;
      const result = await this.classifyMailboxThreadsForAccount(accountId, {
        includeBackfill: true,
        limit: remaining,
      });
      scannedThreads += result.scannedThreads;
      reclassifiedThreads += result.reclassifiedThreads;
      remaining -= result.scannedThreads;
      this.updateSyncProgress({
        phase: "classifying",
        accountId,
        totalThreads: pendingCount,
        processedThreads: scannedThreads,
        totalMessages: 0,
        processedMessages: 0,
        newThreads: pendingCount,
        classifiedThreads: reclassifiedThreads,
        skippedThreads: Math.max(0, pendingCount - scannedThreads),
        label:
          scannedThreads < Math.min(pendingCount, cappedLimit)
            ? `Classifying ${scannedThreads}/${Math.min(pendingCount, cappedLimit)} pending threads...`
            : `Classified ${reclassifiedThreads} pending thread${reclassifiedThreads === 1 ? "" : "s"}`,
      });
    }

    mailboxLogger.info("Mailbox pending classification pass complete", {
      accountCount: ids.length,
      pendingCount,
      scannedThreads,
      reclassifiedThreads,
    });

    return {
      accountId: "all",
      scannedThreads,
      reclassifiedThreads,
    };
  }

  async sync(limit = 25, options: { source?: "auto" | "manual" } = {}): Promise<MailboxSyncResult> {
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
      const syncErrors: Array<{ message: string; transient: boolean }> = [];
      let syncedThreads = 0;
      let syncedMessages = 0;
      let successfulProviderCount = 0;

      const googleWorkspaceSettings = GoogleWorkspaceSettingsManager.loadSettings();
      const googleWorkspaceAuthIssue = this.getGoogleWorkspaceAuthIssue();
      if (googleWorkspaceSettings.enabled && !googleWorkspaceAuthIssue) {
        if (options.source === "auto" && this.gmailTransientSyncBackoffUntil > Date.now()) {
          const label = this.noteGmailTransientSyncBackoff();
          syncErrors.push({ message: label, transient: true });
          accounts.push(...(await this.getExistingMailboxAccounts("gmail", "degraded")));
        } else {
          try {
            const result = await this.syncGmail(limit);
            if (result) {
              this.resetGmailTransientSyncFailure();
              successfulProviderCount += 1;
              accounts.push(result.account);
              syncedThreads += result.syncedThreads;
              syncedMessages += result.syncedMessages;
            }
          } catch (error) {
            void notifyDetectedIntegrationAuthIssue(error);
            if (isMailboxConnectionError(error)) {
              const label = this.noteGmailTransientSyncFailure(error);
              syncErrors.push({ message: label, transient: true });
              accounts.push(...(await this.getExistingMailboxAccounts("gmail", "degraded")));
            } else {
              syncErrors.push({
                message: `Gmail sync failed: ${error instanceof Error ? error.message : String(error)}`,
                transient: false,
              });
            }
          }
        }
      } else if (googleWorkspaceAuthIssue) {
        syncErrors.push({ message: googleWorkspaceAuthIssue.statusLabel, transient: true });
        void notifyDetectedIntegrationAuthIssue(new Error(googleWorkspaceAuthIssue.logMessage));
      }

      if (this.agentMailEnabled()) {
        try {
          const result = await this.syncAgentMail(limit);
          if (result) {
            successfulProviderCount += 1;
            accounts.push(...result.accounts);
            syncedThreads += result.syncedThreads;
            syncedMessages += result.syncedMessages;
          }
        } catch (error) {
          void notifyDetectedIntegrationAuthIssue(error);
          syncErrors.push({
            message: `AgentMail sync failed: ${error instanceof Error ? error.message : String(error)}`,
            transient: false,
          });
        }
      }

      if (this.hasEmailChannel()) {
        try {
          const result = await this.syncImap(limit);
          if (result) {
            successfulProviderCount += 1;
            accounts.push(result.account);
            syncedThreads += result.syncedThreads;
            syncedMessages += result.syncedMessages;
          }
        } catch (error) {
          void notifyDetectedIntegrationAuthIssue(error);
          mailboxLogger.warn("Email channel sync failed", {
            message: error instanceof Error ? error.message : String(error),
            transient: isMailboxConnectionError(error),
          });
          syncErrors.push({
            message: `Email channel sync failed: ${error instanceof Error ? error.message : String(error)}`,
            transient: isMailboxConnectionError(error),
          });
          if (isMailboxConnectionError(error)) {
            accounts.push(...(await this.getExistingMailboxAccounts("imap", "degraded")));
          }
        }
      }

      const onlyTransientErrors =
        syncErrors.length > 0 && syncErrors.every((entry) => entry.transient);
      if (onlyTransientErrors && successfulProviderCount === 0) {
        const label = formatMailboxSyncErrors(syncErrors);
        this.updateSyncProgress({
          phase: "error",
          totalThreads: 0,
          processedThreads: 0,
          totalMessages: 0,
          processedMessages: 0,
          newThreads: 0,
          classifiedThreads: 0,
          skippedThreads: 0,
          label,
        });
        return {
          accounts,
          syncedThreads: 0,
          syncedMessages: 0,
          lastSyncedAt: Date.now(),
        };
      }

      if (accounts.length === 0) {
        throw new Error(
          formatMailboxSyncErrors(
            syncErrors,
            "No connected mailbox was found. Enable AgentMail, Google Workspace, or configure the Email channel.",
          ),
        );
      }

      if (successfulProviderCount > 0) {
        this.resetMailboxAuthSyncBackoff();
      }

      const backlogResult =
        options.source === "auto"
          ? { scannedThreads: 0, reclassifiedThreads: 0 }
          : await this.classifyPendingMailboxBacklog(
              await this.listMailboxAccountIds(),
              MAILBOX_CLASSIFIER_MAX_BATCH,
            );

      const lastSyncedAt = Date.now();
      const syncWarning = syncErrors.length > 0 ? formatMailboxSyncErrors(syncErrors) : undefined;
      const doneLabel =
        syncedThreads > 0
          ? `Synced ${syncedThreads} thread${syncedThreads === 1 ? "" : "s"} and ${syncedMessages} message${syncedMessages === 1 ? "" : "s"}${backlogResult.reclassifiedThreads > 0 ? ` · classified ${backlogResult.reclassifiedThreads}` : ""}`
          : backlogResult.reclassifiedThreads > 0
            ? `Classified ${backlogResult.reclassifiedThreads} pending thread${backlogResult.reclassifiedThreads === 1 ? "" : "s"}`
            : "Mailbox sync complete";
      this.updateSyncProgress({
        phase: "done",
        totalThreads: syncedThreads,
        processedThreads: syncedThreads,
        totalMessages: syncedMessages,
        processedMessages: syncedMessages,
        newThreads: syncedThreads,
        classifiedThreads: backlogResult.reclassifiedThreads,
        skippedThreads: 0,
        label: syncWarning ? `${doneLabel} · ${syncWarning}` : doneLabel,
      });
      await this.emitMailboxEvent({
        type: "sync_completed",
        workspaceId: await this.resolveDefaultWorkspaceId(),
        accountId: accounts[0]?.id,
        provider: accounts[0]?.provider,
        summary: syncWarning
          ? `Synced ${syncedThreads} thread${syncedThreads === 1 ? "" : "s"} and ${syncedMessages} message${syncedMessages === 1 ? "" : "s"} with warnings`
          : `Synced ${syncedThreads} thread${syncedThreads === 1 ? "" : "s"} and ${syncedMessages} message${syncedMessages === 1 ? "" : "s"}`,
        evidenceRefs: accounts.map((account) => account.id),
        payload: {
          accountCount: accounts.length,
          threadCount: syncedThreads,
          messageCount: syncedMessages,
          accountIds: accounts.map((account) => account.id),
          providers: accounts.map((account) => account.provider),
          warnings: syncErrors.map((entry) => entry.message),
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

  private async getAgentMailBindings(): Promise<Array<{ workspace_id: string; pod_id: string }>> {
    return (await this.sql.all("getAgentMailBindings_1", [])) as Array<{
      workspace_id: string;
      pod_id: string;
    }>;
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
      capabilities: [
        "archive",
        "trash",
        "mark_read",
        "mark_unread",
        "labels",
        "send",
        "reply_all",
        "sync",
        "realtime",
      ],
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

  private async normalizeAgentMailThread(
    _workspaceId: string,
    podId: string,
    threadPayload: unknown,
  ): Promise<NormalizedThreadInput | null> {
    const thread = asObject(threadPayload);
    if (!thread) return null;

    const inboxId = asString(thread.inbox_id);
    const providerThreadId = asString(thread.thread_id);
    if (!inboxId || !providerThreadId) {
      return null;
    }

    const accountId = this.buildAgentMailAccountId(podId, inboxId);
    const accountRow = (await this.sql.get("normalizeAgentMailThread_1", [accountId])) as
      | { address: string }
      | undefined;
    const accountEmail =
      normalizeEmailAddress(accountRow?.address || inboxId) || inboxId.toLowerCase();
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
          subject: asString(message.subject) || asString(thread.subject) || "Untitled thread",
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
      subject: asString(thread.subject) || lastMessage.subject || "Untitled thread",
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
    const normalized = await this.normalizeAgentMailThread(_workspaceId, podId, threadPayload);
    if (!normalized) return null;

    const inboxParts = this.parseAgentMailAccountId(normalized.accountId);
    const inboxRow = inboxParts
      ? ((await this.sql.get("ingestAgentMailThread_1", [inboxParts.podId, inboxParts.inboxId])) as
          | { email: string | null; display_name: string | null }
          | undefined)
      : undefined;

    const account = this.buildAgentMailAccount(
      podId,
      inboxParts?.inboxId || normalized.accountId,
      inboxRow?.email || inboxParts?.inboxId,
      inboxRow?.display_name || undefined,
    );
    await this.upsertAccount(account);
    const upsertResult = await this.upsertThread(normalized);
    if (upsertResult.shouldClassify && options?.classify !== false) {
      await this.classifyMailboxThreadsForAccount(account.id, {
        includeBackfill: true,
        limit: Math.min(Math.max(normalized.messages.length, 1), MAILBOX_CLASSIFIER_MAX_BATCH),
      });
    }

    await this.sql.run("ingestAgentMailThread_2", [Date.now(), Date.now(), account.id]);

    return {
      account,
      syncedMessages: normalized.messages.length,
      isNewThread: upsertResult.isNewThread,
    };
  }

  private async syncAgentMail(
    limit: number,
  ): Promise<{ accounts: MailboxAccount[]; syncedThreads: number; syncedMessages: number } | null> {
    const bindings = await this.getAgentMailBindings();
    if (bindings.length === 0) {
      return null;
    }

    const adminService = new AgentMailAdminService(this.sql);
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
        await this.upsertAccount(account);
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
    const thread = (await this.sql.get("reclassifyThread_1", [threadId])) as
      | { account_id: string }
      | undefined;
    if (!thread) {
      throw new Error("Thread not found");
    }
    const updated = await this.classifyThreadById(threadId, { force: true });
    if (updated) {
      await this.recordMailboxTriageFeedback(threadId, "reclassify");
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
      await this.sql.run("reclassifyAccount_1", [Date.now(), Date.now(), accountId]);
    }

    return result;
  }

  async listThreads(input: MailboxListThreadsInput = {}): Promise<MailboxThreadListItem[]> {
    // Condition keys from the catalog's thread-list vocabulary, in parameter order (DB6).
    const conditions: string[] = [];
    const values: Array<string | number> = [];
    let visibleShape: { withWorkspace: boolean; obsoleteAccounts: number } | undefined;
    const queryText = input.query?.trim() || "";

    if (input.accountId) {
      conditions.push("account");
      values.push(input.accountId);
    }
    if (input.category && input.category !== "all") {
      conditions.push("category");
      values.push(input.category);
    }
    if (input.todayBucket && input.todayBucket !== "all") {
      conditions.push("todayBucket");
      values.push(input.todayBucket);
    }
    if (input.domainCategory && input.domainCategory !== "all") {
      conditions.push("domainCategory");
      values.push(input.domainCategory);
    }
    if (input.folderId) {
      conditions.push("folder");
      values.push(`%"${input.folderId}"%`, `%"folderId":"${input.folderId}"%`);
    }
    if (input.labelId) {
      conditions.push("label");
      values.push(`%"${input.labelId}"%`, `%"labelId":"${input.labelId}"%`);
    }
    if (input.scheduledOnly) conditions.push("scheduledOnly");
    if (input.draftOnly) conditions.push("draftOnly");
    if (input.queuedOnly) conditions.push("queuedOnly");
    const mailboxView: MailboxThreadMailboxView = input.mailboxView || "inbox";
    if (mailboxView === "inbox") {
      const inboxVisibleFilter = await this.buildInboxVisibleThreadFilter();
      conditions.push("inboxVisible");
      values.push(...inboxVisibleFilter.params);
      visibleShape = inboxVisibleFilter.shape;
    } else if (mailboxView === "sent") {
      conditions.push("sentOnly");
    }
    if (typeof input.unreadOnly === "boolean") {
      conditions.push(input.unreadOnly ? "unread" : "read");
    }
    if (typeof input.needsReply === "boolean") {
      conditions.push("needsReply");
      values.push(input.needsReply ? 1 : 0);
    }
    if (typeof input.hasSuggestedProposal === "boolean") {
      conditions.push(input.hasSuggestedProposal ? "hasSuggestedProposal" : "noSuggestedProposal");
    }
    if (typeof input.hasOpenCommitment === "boolean") {
      conditions.push(input.hasOpenCommitment ? "hasOpenCommitment" : "noOpenCommitment");
    }
    if (typeof input.cleanupCandidate === "boolean") {
      conditions.push("cleanupCandidate");
      values.push(input.cleanupCandidate ? 1 : 0);
    }
    if (typeof input.hasAttachment === "boolean") {
      conditions.push(input.hasAttachment ? "hasAttachment" : "noAttachment");
    }
    const attachmentQuery = input.attachmentQuery?.trim();
    if (attachmentQuery) conditions.push("hasAttachment");
    const savedViewId = input.savedViewId?.trim();
    if (savedViewId) {
      conditions.push("savedView");
      values.push(savedViewId);
    }

    const limit = Math.min(Math.max(input.limit ?? 40, 1), 100);
    const sortBy: MailboxThreadSortOrder = input.sortBy === "recent" ? "recent" : "priority";
    const hasPostFilters = Boolean(queryText || attachmentQuery);
    const rows = await this.sql.all<MailboxThreadRow>(
      "listThreads",
      hasPostFilters ? values : [...values, limit],
      {
        conditions: conditions.join(","),
        sortBy,
        limit: !hasPostFilters,
        ...(visibleShape ?? { withWorkspace: false, obsoleteAccounts: 0 }),
      },
    );

    const filteredRows: MailboxThreadRow[] = [];
    for (const row of rows) {
      if (filteredRows.length >= limit) break;
      if (queryText && !(await this.threadMatchesQuery(row, queryText))) continue;
      if (attachmentQuery && !(await this.threadMatchesAttachmentQuery(row.id, attachmentQuery))) {
        continue;
      }
      filteredRows.push(row);
    }

    return this.mapThreadRowsWithSummaries(filteredRows);
  }

  async listThreadsForAccount(
    accountId: string,
    input: MailboxListThreadsInput = {},
  ): Promise<MailboxThreadListItem[]> {
    await this.requireMailboxAccount(accountId);
    return this.listThreads({ ...input, accountId });
  }

  async getThread(threadId: string): Promise<MailboxThreadDetail | null> {
    const row = (await this.sql.get("getThread_1", [threadId])) as MailboxThreadRow | undefined;
    if (!row) return null;

    const summary =
      (await this.getSummaryForThread(threadId)) ?? (await this.summarizeThread(threadId));
    const messages = await this.getMessagesForThread(threadId);
    const drafts = await this.getDraftsForThread(threadId);
    const proposals = await this.getProposalsForThread(threadId);
    const commitments = await this.getCommitmentsForThread(threadId);
    const contactMemory = await this.getPrimaryContactMemory(threadId);
    const research = await this.researchContact(threadId);
    const sensitiveContent = this.readThreadSensitiveContent(row);

    return {
      ...(await this.mapThreadRow(row, summary || undefined)),
      messages,
      drafts,
      proposals,
      commitments,
      contactMemory,
      research,
      sensitiveContent,
    };
  }

  async getThreadForAccount(
    threadId: string,
    accountId: string,
  ): Promise<(MailboxThreadListItem & { messages: MailboxMessage[] }) | null> {
    await this.requireMailboxAccount(accountId);
    const row = (await this.sql.get("getThread_1", [threadId])) as MailboxThreadRow | undefined;
    if (!row || row.account_id !== accountId) return null;
    return {
      ...(await this.mapThreadRow(row, (await this.getSummaryForThread(threadId)) || undefined)),
      messages: await this.getMessagesForThread(threadId),
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
      .flatMap((message) => excerptLines(message.body, 6).filter((line) => line.includes("?")))
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
        detail.snippet?.trim() || `Recent email activity in ${detail.subject || "this thread"}`;
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

    await this.sql.run("summarizeThread_1", [
      threadId,
      encryptMailboxValue(normalizeWhitespace(summaryText, 340)),
      JSON.stringify(asks),
      JSON.stringify(questions),
      nextAction,
      updatedAt,
    ]);

    await this.refreshThreadProposals(detail);
    await this.emitMailboxEvent({
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

    const summary =
      (await this.getSummaryForThread(threadId)) || (await this.summarizeThread(threadId));
    const scheduleSuggestion =
      options.includeAvailability !== false && detail.category === "calendar"
        ? await this.getScheduleSuggestion()
        : null;
    const resolution = await this.resolveContactIdentity(threadId);
    const scopedCompanyId = (await this.getPrimaryContactMemory(threadId))?.company;
    // Contact-scoped memory_items of this sender (third-party, private): drafting a reply
    // to the contact already works on their content.
    const relationshipContext = await buildContactMemoryContext({
      maxPerSection: 1,
      maxChars: 420,
      contactIdentityId: resolution?.identity?.id,
      companyId: scopedCompanyId,
    }).catch(() => "");
    const latestIncoming =
      detail.messages.filter((message) => message.direction === "incoming").slice(-1)[0] ||
      detail.messages[detail.messages.length - 1];
    const recipient =
      latestIncoming?.from?.name ||
      latestIncoming?.from?.email ||
      detail.participants[0]?.email ||
      "there";
    const contactEmail = detail.participants[0]?.email;
    const primaryContact = detail.participants[0];
    const styleProfile = this.buildDraftStyleProfile({
      outgoingMessages: contactEmail
        ? (await this.sql.all("generateDraft_1", [detail.accountId, `%${contactEmail}%`])).map(
            (row) =>
              normalizeWhitespace(
                decryptMailboxValue((row as { body_text: string }).body_text) || "",
                600,
              ),
          )
        : [],
      averageResponseHours: contactEmail
        ? (await this.getPrimaryContactMemory(threadId))?.averageResponseHours
        : undefined,
    });
    const greetingPrefix = styleProfile.greeting?.match(/^(Hi|Hello|Hey)\b/i)?.[1] || "Hi";
    const greeting =
      recipient && recipient !== "there"
        ? `${greetingPrefix} ${recipient.split(" ")[0]},`
        : `${greetingPrefix},`;
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

    await this.sql.run("generateDraft_2", [
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
    ]);

    await this.upsertProposal({
      threadId,
      type: "reply",
      title: "Review reply draft",
      reasoning: rationale,
      preview: {
        draftId,
        subject: detail.subject.startsWith("Re:") ? detail.subject : `Re: ${detail.subject}`,
      },
    });
    await this.emitMailboxEvent({
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
      (await this.getCommitmentsForThread(threadId)).map((item) => item.title.toLowerCase()),
    );
    const created: MailboxCommitment[] = [];
    const now = Date.now();
    const primaryContact = detail.participants[0];
    const resolution = await this.resolveContactIdentity(threadId);
    const companyScope = (await this.getPrimaryContactMemory(threadId))?.company;

    for (const candidate of candidates.slice(0, 6)) {
      if (existingTitles.has(candidate.title.toLowerCase())) continue;
      const id = randomUUID();
      await this.sql.run("extractCommitments_1", [
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
      ]);
      await RelationshipMemoryService.rememberMailboxInsights({
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

    await this.updateContactOpenCommitments(threadId);
    if (created.length > 0) {
      await this.emitMailboxEvent({
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
    // DB6: no host transaction here. It used to span keychain-backed relationship
    // memory and task creation; the commitment row now commits on its own (in the
    // worker when routed), and the follow-up task is ensured idempotently from it.
    const result = await (async (): Promise<MailboxCommitment | null> => {
      const row = (await this.sql.get("updateCommitmentState_1", [commitmentId])) as
        | MailboxCommitmentRow
        | undefined;
      if (!row) return null;

      const metadata = parseCommitmentMetadata(row.metadata_json);
      let nextMetadata: MailboxCommitmentMetadata = { ...metadata };

      if (state === "accepted") {
        const followUpTask = await this.ensureFollowUpTaskForCommitment(row, metadata);
        if (followUpTask) {
          nextMetadata = {
            ...nextMetadata,
            followUpTaskId: followUpTask.id,
            followUpTaskCreatedAt: nextMetadata.followUpTaskCreatedAt ?? now,
            followUpTaskWorkspaceId:
              nextMetadata.followUpTaskWorkspaceId ?? followUpTask.workspaceId,
          };
          if (row.due_at != null) {
            await this.taskRepo.update(followUpTask.id, {
              dueDate: row.due_at,
            });
          }
        }
      }

      if (state === "done" || state === "dismissed") {
        const followUpTaskId = metadata.followUpTaskId;
        if (followUpTaskId) {
          const status = state === "done" ? "completed" : "cancelled";
          await this.taskRepo.update(followUpTaskId, {
            status,
            completedAt: state === "done" ? now : undefined,
          });
        }
      }

      await this.sql.run("updateCommitmentState_2", [
        state,
        JSON.stringify(nextMetadata),
        now,
        commitmentId,
      ]);

      if (state === "done") {
        const text = row.title;
        const items = RelationshipMemoryService.listOpenCommitments(200);
        for (const item of items) {
          if (
            text.toLowerCase().includes(item.text.toLowerCase()) ||
            item.text.toLowerCase().includes(text.toLowerCase())
          ) {
            await RelationshipMemoryService.updateItem(item.id, { status: "done" });
          }
        }
      }

      const updatedRow = (await this.sql.get("updateCommitmentState_1", [commitmentId])) as
        | MailboxCommitmentRow
        | undefined;
      if (!updatedRow) return null;

      await this.updateContactOpenCommitments(updatedRow.thread_id);
      return this.mapCommitmentRow(updatedRow);
    })();

    if (result) {
      const accountRow = (await this.sql.get("reclassifyThread_1", [result.threadId])) as
        | { account_id: string }
        | undefined;
      await this.emitMailboxEvent({
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
    const row = (await this.sql.get("updateCommitmentDetails_1", [commitmentId])) as
      | MailboxCommitmentRow
      | undefined;
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
      const followUpTask = await this.ensureFollowUpTaskForCommitment(
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
        await this.taskRepo.update(followUpTask.id, {
          dueDate: nextDueAt,
        });
      }
    }

    await this.sql.run("updateCommitmentDetails_2", [
      nextTitle,
      nextDueAt || null,
      nextState,
      nextOwnerEmail || null,
      nextSourceExcerpt || null,
      now,
      commitmentId,
    ]);

    const updated = (await this.sql.get("updateCommitmentDetails_1", [commitmentId])) as
      | MailboxCommitmentRow
      | undefined;
    if (!updated) return null;

    await this.updateContactOpenCommitments(updated.thread_id);
    const mapped = this.mapCommitmentRow(updated);
    await this.emitMailboxEvent({
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
    const rows = (await this.sql.all("proposeCleanup_1", [
      Math.min(Math.max(limit, 1), 100),
    ])) as MailboxThreadRow[];

    for (const row of rows) {
      await this.upsertProposal({
        threadId: row.id,
        type: "cleanup",
        title: `Queue cleanup for ${row.subject}`,
        reasoning:
          "Hide this low-priority handled thread from the Cowork inbox. Use Archive or Trash for a server-side mailbox change.",
        preview: {
          threadId: row.id,
          suggestedAction: "hide from Cowork inbox",
        },
      });
    }

    const proposals: MailboxActionProposal[] = [];
    for (const row of rows) {
      for (const proposal of await this.getProposalsForThread(row.id)) {
        if (proposal.type === "cleanup") proposals.push(proposal);
      }
    }
    return proposals;
  }

  async proposeFollowups(limit = 20): Promise<MailboxActionProposal[]> {
    const rows = (await this.sql.all("proposeFollowups_1", [
      Math.min(Math.max(limit, 1), 100),
    ])) as MailboxThreadRow[];

    for (const row of rows) {
      await this.upsertProposal({
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

    const proposals: MailboxActionProposal[] = [];
    for (const row of rows) {
      for (const proposal of await this.getProposalsForThread(row.id)) {
        if (proposal.type === "follow_up") proposals.push(proposal);
      }
    }
    return proposals;
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

  async scheduleReply(
    threadId: string,
  ): Promise<{ threadId: string; suggestions: string[]; summary: string }> {
    if (!(await this.summarizeThread(threadId))) {
      throw new Error("Mailbox thread not found");
    }
    const suggestion = await this.getScheduleSuggestion();
    await this.upsertProposal({
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
    const workspaceId = await this.resolveThreadWorkspaceId(detail.accountId);
    const contactMemory = await this.getPrimaryContactMemory(threadId);
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

  async getContactIdentity(identityId: string): Promise<ContactIdentity | null> {
    return this.contactIdentityService.getIdentity(identityId);
  }

  async listContactIdentities(workspaceId?: string): Promise<ContactIdentity[]> {
    return this.contactIdentityService.listIdentities(
      workspaceId || (await this.resolveDefaultWorkspaceId()),
    );
  }

  async listIdentityCandidates(
    workspaceId?: string,
    status?: ContactIdentityCandidate["status"],
  ): Promise<ContactIdentityCandidate[]> {
    return this.contactIdentityService.listCandidates(
      workspaceId || (await this.resolveDefaultWorkspaceId()),
      status,
    );
  }

  async confirmIdentityLink(candidateId: string): Promise<ContactIdentityCandidate | null> {
    return this.contactIdentityService.confirmCandidate(candidateId);
  }

  async rejectIdentityLink(candidateId: string): Promise<ContactIdentityCandidate | null> {
    return this.contactIdentityService.rejectCandidate(candidateId);
  }

  async unlinkIdentityHandle(handleId: string): Promise<boolean> {
    return this.contactIdentityService.unlinkHandle(handleId);
  }

  async searchIdentityLinkTargets(
    workspaceId: string,
    query: string,
    limit?: number,
  ): Promise<ContactIdentitySearchResult[]> {
    return this.contactIdentityService.searchLinkTargets(workspaceId, query, limit);
  }

  async linkIdentityHandle(input: {
    workspaceId: string;
    contactIdentityId: string;
    handleType: ContactIdentityHandleType;
    normalizedValue: string;
    displayValue: string;
    source?: "mailbox" | "gateway" | "manual" | "crm" | "kg";
    channelId?: string;
    channelType?: string;
    channelUserId?: string;
  }): Promise<ContactIdentity | null> {
    const handle = await this.contactIdentityService.linkManualHandle(input);
    return handle ? await this.contactIdentityService.getIdentity(input.contactIdentityId) : null;
  }

  async getIdentityCoverageStats(workspaceId?: string): Promise<ContactIdentityCoverageStats> {
    return this.contactIdentityService.getCoverageStats(
      workspaceId || (await this.resolveDefaultWorkspaceId()),
    );
  }

  async getChannelPreferenceSummary(contactIdentityId: string): Promise<ChannelPreferenceSummary> {
    return this.contactIdentityService.getChannelPreferenceSummary(contactIdentityId);
  }

  async getReplyTargets(threadId: string): Promise<ContactIdentityReplyTarget[]> {
    const contactResolution = await this.resolveContactIdentity(threadId);
    return contactResolution?.identity?.id
      ? await this.contactIdentityService.getReplyTargets(contactResolution.identity.id)
      : [];
  }

  async getRelationshipTimeline(
    query: RelationshipTimelineQuery,
  ): Promise<RelationshipTimelineEvent[]> {
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
      const workspaceId = await this.resolveDefaultWorkspaceId();
      const match = workspaceId
        ? await this.contactIdentityService.findIdentityByCompanyHint(
            workspaceId,
            query.companyHint,
          )
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
    const contactMemory = await this.getPrimaryContactMemory(threadId);
    const resolution = await this.resolveContactIdentity(threadId);
    const identity = resolution?.identity || null;
    const channelPreference =
      identity?.id &&
      (identity.handles.some((handle) => handle.handleType !== "email") ||
        (resolution?.confidence || 0) >= 0.86)
        ? await this.contactIdentityService.getChannelPreferenceSummary(identity.id)
        : undefined;
    const unifiedTimeline =
      identity?.id &&
      (identity.handles.some((handle) => handle.handleType !== "email") ||
        (resolution?.confidence || 0) >= 0.86)
        ? await this.contactIdentityService.getTimeline({
            threadId,
            contactIdentityId: identity.id,
            limit: 12,
          })
        : [];
    const scopedRelationshipItems =
      identity?.id || contactMemory?.company
        ? await RelationshipMemoryService.listItems({
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
      detail.category === "calendar"
        ? "Choose one of the proposed time slots and create the event."
        : null,
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
      replyTargets: identity?.id
        ? await this.contactIdentityService.getReplyTargets(identity.id)
        : [],
    };
    await this.emitMailboxEvent({
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

  async applyAction(
    input: MailboxApplyActionInput,
  ): Promise<{ success: boolean; action: string; threadId?: string }> {
    if (input.type === "dismiss_proposal" && input.proposalId) {
      await this.updateProposalStatus(input.proposalId, "dismissed");
      const dismissThreadId = input.threadId || (await this.threadIdFromProposal(input.proposalId));
      if (dismissThreadId) {
        await this.recordMailboxTriageFeedback(dismissThreadId, "dismiss_proposal");
      }
      return { success: true, action: input.type };
    }

    const threadId = input.threadId || (await this.threadIdFromProposal(input.proposalId));
    if (!threadId) {
      throw new Error("Missing threadId or proposalId for mailbox action");
    }

    const thread = await this.getThreadCore(threadId);
    if (!thread) {
      throw new Error("Mailbox thread not found");
    }
    const primaryContact = thread.participants[0];

    try {
      switch (input.type) {
        case "cleanup_local":
          await this.applyLocalCleanup(thread);
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
          await this.enqueueMailboxAction({
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
          if (!input.label && !input.labelId)
            throw new Error("Missing label for remove label action");
          await this.enqueueMailboxAction({
            accountId: thread.accountId,
            threadId: thread.id,
            type: "remove_label",
            payload: { label: input.label, labelId: input.labelId },
          });
          break;
        case "snooze":
          if (!input.snoozeUntil) throw new Error("Missing snooze time");
          await this.enqueueMailboxAction({
            accountId: thread.accountId,
            threadId: thread.id,
            type: "snooze",
            payload: { snoozeUntil: input.snoozeUntil },
            nextAttemptAt: input.snoozeUntil,
          });
          await this.sql.run("applyAction_1", [Date.now(), thread.id]);
          break;
        case "waiting_on":
          await this.enqueueMailboxAction({
            accountId: thread.accountId,
            threadId: thread.id,
            type: "waiting_on",
            payload: { commitmentId: input.commitmentId },
          });
          await this.sql.run("applyAction_2", [Date.now(), thread.id]);
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
    } catch (error) {
      void notifyDetectedIntegrationAuthIssue(error);
      throw toMailboxActionError(input.type, thread.provider, error);
    }

    if (input.proposalId) {
      await this.updateProposalStatus(input.proposalId, "applied");
    }

    await this.emitMailboxEvent({
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
      await this.recordMailboxTriageFeedback(threadId, input.type);
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
    const existingAccount = (await this.sql.get("syncGmail_1", [accountId])) as
      | { classification_initial_batch_at: number | null }
      | undefined;
    const initialClassificationNeeded = !existingAccount?.classification_initial_batch_at;
    await this.upsertAccount({
      id: accountId,
      provider: "gmail",
      address: emailAddress.toLowerCase(),
      displayName: emailAddress,
      status: "connected",
      capabilities: [
        "sync",
        "provider_search",
        "realtime",
        "send",
        "provider_drafts",
        "reply_all",
        "forward",
        "attachments_download",
        "attachments_upload",
        "archive",
        "trash",
        "mark_read",
        "mark_unread",
        "labels",
        "undo_send",
      ],
      backend: "gmail_api",
      lastSyncedAt: now,
    });
    await this.refreshGmailNavigation(accountId);

    const listResult = await gmailRequest(settings, {
      method: "GET",
      path: "/users/me/messages",
      query: {
        maxResults: Math.min(Math.max(limit, 5), 50),
        q: "newer_than:30d",
      },
    });

    const messageRefs = (
      Array.isArray(listResult.data?.messages) ? listResult.data.messages : []
    ) as Array<{
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
      const normalized = this.normalizeGmailThread(
        accountId,
        emailAddress.toLowerCase(),
        threadResult.data,
      );
      if (!normalized) continue;
      const upsertResult = await this.upsertThread(normalized);
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
        (await this.sql.get("syncGmail_2", [accountId])) as MailboxAccountRow,
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
    messages.sort(
      (a: NormalizedMailboxMessage, b: NormalizedMailboxMessage) => a.receivedAt - b.receivedAt,
    );

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

  private normalizeMicrosoftGraphMessage(
    accountId: string,
    accountEmail: string,
    message: Any,
    options: { localInboxHidden?: boolean } = {},
  ): NormalizedThreadInput | null {
    const messageId = asString(message?.id);
    if (!messageId) return null;
    const conversationId = asString(message?.conversationId) || messageId;
    const subject = asString(message?.subject) || "(No subject)";
    const bodyObject = asObject(message?.body) || {};
    const bodyContent = asString(bodyObject.content) || "";
    const bodyContentType = asString(bodyObject.contentType) || "";
    const isHtmlBody = bodyContentType.toLowerCase() === "html";
    const bodyText = isHtmlBody ? stripHtml(bodyContent) : bodyContent;
    const snippet = normalizeWhitespace(asString(message?.bodyPreview) || bodyText || subject, 260);
    const fromRaw = asObject(message?.from)?.emailAddress;
    const from = graphEmailAddressToParticipant(fromRaw);
    const receivedAt = Date.parse(asString(message?.receivedDateTime) || "") || Date.now();
    const direction =
      normalizeMailboxEmailAddress(from?.email) === normalizeMailboxEmailAddress(accountEmail)
        ? "outgoing"
        : "incoming";
    const normalizedMessage: NormalizedMailboxMessage = {
      id: `outlook-graph-message:${messageId}`,
      providerMessageId: messageId,
      metadata: {
        microsoftGraphMessageId: messageId,
        rfcMessageId: asString(message?.internetMessageId) || undefined,
      },
      direction,
      from,
      to: graphRecipientsToParticipants(message?.toRecipients),
      cc: graphRecipientsToParticipants(message?.ccRecipients),
      bcc: graphRecipientsToParticipants(message?.bccRecipients),
      subject,
      snippet,
      body: bodyText || snippet,
      bodyHtml: isHtmlBody ? bodyContent : undefined,
      attachments: [],
      receivedAt,
      unread: asBoolean(message?.isRead) === false,
    };
    const participants = uniqueParticipants([
      ...(from ? [from] : []),
      ...normalizedMessage.to,
      ...normalizedMessage.cc,
    ]).filter(
      (participant) =>
        normalizeMailboxEmailAddress(participant.email) !==
        normalizeMailboxEmailAddress(accountEmail),
    );
    return {
      id: `outlook-graph-thread:${conversationId}`,
      accountId,
      provider: "outlook_graph",
      providerThreadId: conversationId,
      subject,
      snippet,
      participants,
      labels: [],
      category: "other",
      priorityScore: clampScore(normalizedMessage.unread ? 25 : 5),
      urgencyScore: clampScore(normalizedMessage.unread ? 10 : 0),
      needsReply: false,
      staleFollowup: false,
      cleanupCandidate: false,
      handled: !normalizedMessage.unread,
      localInboxHidden: options.localInboxHidden,
      unreadCount: normalizedMessage.unread ? 1 : 0,
      lastMessageAt: receivedAt,
      messages: [normalizedMessage],
    };
  }

  private getMicrosoftGraphThreadIdFromMessage(message: Any): string | null {
    const messageId = asString(message?.id);
    if (!messageId) return null;
    const conversationId = asString(message?.conversationId) || messageId;
    return `outlook-graph-thread:${conversationId}`;
  }

  private async hideMicrosoftGraphJunkThreads(
    accountId: string,
    messages: Any[],
    visibleInboxThreadIds: Set<string>,
  ): Promise<number> {
    const junkThreadIds = new Set<string>();
    for (const message of messages) {
      const threadId = this.getMicrosoftGraphThreadIdFromMessage(message);
      if (!threadId || visibleInboxThreadIds.has(threadId)) continue;
      junkThreadIds.add(threadId);
    }
    if (junkThreadIds.size === 0) return 0;

    const now = Date.now();
    let hidden = 0;
    for (const threadId of junkThreadIds) {
      hidden += (await this.sql.run("hideMicrosoftGraphJunkThread", [now, accountId, threadId]))
        .changes;
    }
    return hidden;
  }

  private async syncMicrosoftGraphEmailChannel(
    channelId: string,
    config: Any,
    limit: number,
  ): Promise<{
    account: MailboxAccount;
    syncedThreads: number;
    syncedMessages: number;
  } | null> {
    const address = (
      asString(config.email) ||
      asString(config.displayName) ||
      "outlook"
    ).toLowerCase();
    if (!address) return null;

    const accountId = `outlook-graph:${address}`;
    const now = Date.now();
    const existingAccount = (await this.sql.get("syncGmail_1", [accountId])) as
      | { classification_initial_batch_at: number | null }
      | undefined;
    const initialClassificationNeeded = !existingAccount?.classification_initial_batch_at;
    await this.upsertAccount({
      id: accountId,
      provider: "outlook_graph",
      address,
      displayName: asString(config.displayName) || address,
      status: "connected",
      capabilities: mergeMailboxCapabilities(
        [
          "sync",
          "provider_search",
          "send",
          "reply_all",
          "forward",
          "attachments_download",
          "mark_read",
          "mark_unread",
        ],
        "microsoft_graph",
      ),
      backend: "microsoft_graph",
      lastSyncedAt: now,
    });
    await this.refreshMicrosoftGraphNavigation(channelId, accountId);

    const graphLimit = Math.min(Math.max(limit, 5), 50);
    const recentData = await this.microsoftGraphRequest(channelId, {
      method: "GET",
      path: "/me/mailFolders/inbox/messages",
      scopes: MICROSOFT_GRAPH_READWRITE_SCOPES,
      query: {
        $top: String(graphLimit),
        $orderby: "receivedDateTime desc",
        $select: MICROSOFT_GRAPH_MESSAGE_SELECT,
      },
    });
    const unreadInboxData = await this.microsoftGraphRequest(channelId, {
      method: "GET",
      path: "/me/mailFolders/inbox/messages",
      scopes: MICROSOFT_GRAPH_READWRITE_SCOPES,
      query: {
        $top: String(graphLimit),
        $filter: "isRead eq false",
        $select: MICROSOFT_GRAPH_MESSAGE_SELECT,
      },
    });
    let junkData: Any | undefined;
    try {
      junkData = await this.microsoftGraphRequest(channelId, {
        method: "GET",
        path: "/me/mailFolders/junkemail/messages",
        scopes: MICROSOFT_GRAPH_READWRITE_SCOPES,
        query: {
          $top: "100",
          $select: "id,conversationId",
        },
      });
    } catch (error) {
      mailboxLogger.warn("Microsoft Graph junk folder cleanup skipped", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    const messagesById = new Map<string, Any>();
    for (const message of [
      ...(Array.isArray(recentData?.value) ? recentData.value : []),
      ...(Array.isArray(unreadInboxData?.value) ? unreadInboxData.value : []),
    ]) {
      const messageId = asString(message?.id);
      if (!messageId) continue;
      messagesById.set(messageId, message);
    }
    const messages = Array.from(messagesById.values());
    const inboxThreadIds = new Set(
      messages
        .map((message) => this.getMicrosoftGraphThreadIdFromMessage(message))
        .filter((threadId): threadId is string => Boolean(threadId)),
    );
    const hiddenJunkThreads = await this.hideMicrosoftGraphJunkThreads(
      accountId,
      Array.isArray(junkData?.value) ? junkData.value : [],
      inboxThreadIds,
    );
    mailboxLogger.info("Microsoft Graph mailbox sync fetched messages", {
      accountId,
      recentCount: Array.isArray(recentData?.value) ? recentData.value.length : 0,
      unreadInboxCount: Array.isArray(unreadInboxData?.value) ? unreadInboxData.value.length : 0,
      mergedCount: messages.length,
      hiddenJunkThreads,
    });
    const threads = messages
      .map((message: Any) =>
        this.normalizeMicrosoftGraphMessage(accountId, address, message, {
          localInboxHidden: false,
        }),
      )
      .filter((thread: NormalizedThreadInput | null): thread is NormalizedThreadInput =>
        Boolean(thread),
      );

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
          ? `Syncing 0/${threads.length} Outlook thread${threads.length === 1 ? "" : "s"}...`
          : "No new Outlook messages found",
    });

    for (const thread of threads) {
      const upsertResult = await this.upsertThread(thread);
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
            ? `Syncing ${processedThreads}/${threads.length} Outlook thread${threads.length === 1 ? "" : "s"} · ${processedMessages} message${processedMessages === 1 ? "" : "s"}`
            : "No new Outlook messages found",
      });
    }

    if (initialClassificationNeeded) {
      await this.classifyMailboxThreadsForAccount(accountId, {
        limit: MAILBOX_CLASSIFIER_MAX_BATCH,
      });
    } else {
      for (const candidateThreadId of classificationCandidates) {
        await this.classifyThreadById(candidateThreadId);
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
          ? `Synced ${threads.length} Outlook thread${threads.length === 1 ? "" : "s"} and ${messages.length} message${messages.length === 1 ? "" : "s"}`
          : "Outlook mailbox sync complete",
    });

    return {
      account: this.mapAccountRow(
        (await this.sql.get("syncGmail_2", [accountId])) as MailboxAccountRow,
      ),
      syncedThreads: threads.length,
      syncedMessages: messages.length,
    };
  }

  private async syncImap(limit: number): Promise<{
    account: MailboxAccount;
    syncedThreads: number;
    syncedMessages: number;
  } | null> {
    const channel = await this.channelRepo.findByType("email");
    if (!channel || !channel.enabled) return null;
    const cfg = (channel.config as Any) || {};
    if (this.isMicrosoftEmailOAuthConfig(cfg)) {
      return this.syncMicrosoftGraphEmailChannel(channel.id, cfg, limit);
    }
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
      const existingAccount = (await this.sql.get("syncImap_1", [accountId])) as
        | { classification_initial_batch_at: number | null }
        | undefined;
      const initialClassificationNeeded = !existingAccount?.classification_initial_batch_at;
      await this.upsertAccount({
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
        const upsertResult = await this.upsertThread(thread);
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
          (await this.sql.get("syncImap_2", [accountId])) as MailboxAccountRow,
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
    const existingAccount = (await this.sql.get("syncGmail_1", [accountId])) as
      | { classification_initial_batch_at: number | null }
      | undefined;
    const initialClassificationNeeded = !existingAccount?.classification_initial_batch_at;
    await this.upsertAccount({
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
      const upsertResult = await this.upsertThread(thread);
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
        (await this.sql.get("syncGmail_2", [accountId])) as MailboxAccountRow,
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
    const referencedThreadKeys = new Map<string, string>();
    for (const message of messagesRaw) {
      const references = Array.isArray(message?.references)
        ? message.references.map((entry: unknown) => asString(entry)).filter(Boolean)
        : [];
      const inReplyTo = asString(message?.inReplyTo);
      const threadSeed = references[0] || inReplyTo;
      if (!threadSeed) continue;
      const threadKey = `conversation:${sha256(threadSeed).slice(0, 24)}`;
      referencedThreadKeys.set(threadSeed, threadKey);
      for (const reference of references) {
        referencedThreadKeys.set(reference, threadKey);
      }
    }

    for (const message of messagesRaw) {
      const providerMessageId =
        asString(message?.messageId) || String(message?.uid || randomUUID());
      const references = Array.isArray(message?.references)
        ? message.references.map((entry: unknown) => asString(entry)).filter(Boolean)
        : [];
      const inReplyTo = asString(message?.inReplyTo);
      const threadSeed = references[0] || inReplyTo;
      const key =
        (threadSeed
          ? referencedThreadKeys.get(threadSeed)
          : referencedThreadKeys.get(providerMessageId)) ||
        `message:${sha256(providerMessageId).slice(0, 24)}`;
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
      normalizedMessages.sort(
        (a: NormalizedMailboxMessage, b: NormalizedMailboxMessage) => a.receivedAt - b.receivedAt,
      );

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

  private async upsertAccount(account: MailboxAccount): Promise<void> {
    const now = Date.now();
    await this.sql.run("upsertAccount_1", [
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
    ]);
  }

  private async reconcileMailboxMessageIdentity(
    accountId: string,
    targetThreadId: string,
    targetMessageId: string,
    providerMessageId: string,
  ): Promise<void> {
    const duplicates = (await this.sql.all("reconcileMailboxMessageIdentity_1", [
      accountId,
      providerMessageId,
      targetMessageId,
    ])) as Array<{
      id: string;
      thread_id: string;
    }>;

    if (duplicates.length === 0) return;

    const orphanedThreadIds = new Set<string>();
    for (const duplicate of duplicates) {
      await this.sql.run("reconcileMailboxMessageIdentity_2", [duplicate.id]);
      if (duplicate.thread_id !== targetThreadId) {
        orphanedThreadIds.add(duplicate.thread_id);
      }
    }

    for (const threadId of orphanedThreadIds) {
      await this.deleteThreadIfEmpty(threadId);
    }
  }

  private async deleteThreadIfEmpty(threadId: string): Promise<void> {
    const row = (await this.sql.get("deleteThreadIfEmpty_1", [threadId])) as
      | { count: number }
      | undefined;
    if ((row?.count || 0) > 0) return;

    await this.sql.run("deleteThreadIfEmpty_2", [threadId]);
    await this.sql.run("deleteThreadIfEmpty_3", [threadId]);
    await this.sql.run("deleteThreadIfEmpty_4", [threadId]);
    await this.sql.run("deleteThreadIfEmpty_5", [threadId]);
    await this.sql.run("deleteThreadIfEmpty_6", [threadId]);
    await this.sql.run("deleteThreadIfEmpty_7", [threadId]);
    await this.sql.run("deleteThreadIfEmpty_8", [threadId]);
    await this.sql.run("deleteThreadIfEmpty_9", [threadId]);
  }

  private async upsertThread(thread: NormalizedThreadInput): Promise<ThreadUpsertResult> {
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
    // Every row the upsert consults, in one snapshot (DB6); the writes follow in one unit.
    const state = await this.sql.unit("mailbox_threadUpsertState", [
      {
        threadId: thread.id,
        accountId: thread.accountId,
        messages: thread.messages.map((message) => ({
          id: message.id,
          providerMessageId: message.providerMessageId,
          attachmentIds: (message.attachments || []).map((attachment) => attachment.id),
        })),
      },
    ]);
    const existing = state.existing as
      | {
          category: MailboxThreadCategory;
          priority_score: number;
          urgency_score: number;
          needs_reply: number;
          stale_followup: number;
          cleanup_candidate: number;
          handled: number;
          local_inbox_hidden: number;
          unread_count: number;
          last_message_at: number;
          message_count: number;
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
    const classificationValues =
      keepExistingClassification || preserveBackfillState ? existing : null;
    const shouldClassify = !existing || existing.classification_state !== "classified";
    const preserveLocalInboxHidden =
      thread.localInboxHidden === undefined &&
      existing?.local_inbox_hidden === 1 &&
      thread.lastMessageAt <= existing.last_message_at;
    const nextLocalInboxHidden =
      thread.localInboxHidden === undefined
        ? preserveLocalInboxHidden
          ? 1
          : 0
        : thread.localInboxHidden
          ? 1
          : 0;
    const localMessageRows = state.localMessages;
    const locallyReadMessageIds = new Set(
      localMessageRows.filter((message) => message.is_unread === 0).map((message) => message.id),
    );
    const preserveThreadReadState =
      existing?.unread_count === 0 &&
      thread.unreadCount > 0 &&
      thread.messages.length <= (existing.message_count || 0);
    const isMessageUnreadAfterLocalState = (message: NormalizedMailboxMessage): boolean =>
      preserveThreadReadState || locallyReadMessageIds.has(message.id) ? false : message.unread;
    const sensitiveContent = this.createThreadSensitiveContent([
      thread.subject,
      thread.snippet,
      ...thread.messages.map((message) =>
        message.bodyHtml ? stripHtml(message.bodyHtml) : message.body,
      ),
    ]);
    const baseText = `${thread.subject} ${thread.snippet} ${thread.messages.map((message) => message.body).join(" ")}`;
    const fallbackDomainCategory = deriveDomainCategoryFromText(
      baseText,
      classificationValues?.category || thread.category,
    );
    const nextUnreadCount = thread.messages.filter(isMessageUnreadAfterLocalState).length;
    const nextHandled =
      nextUnreadCount === 0 && !(classificationValues?.needs_reply ?? thread.needsReply)
        ? 1
        : nextUnreadCount > 0
          ? 0
          : (classificationValues?.handled ?? (thread.handled ? 1 : 0));
    const fallbackTodayBucket = deriveTodayBucket({
      category: classificationValues?.category || thread.category,
      domainCategory: fallbackDomainCategory,
      needsReply: Boolean(classificationValues?.needs_reply ?? thread.needsReply),
      priorityScore: classificationValues?.priority_score ?? thread.priorityScore,
      urgencyScore: classificationValues?.urgency_score ?? thread.urgencyScore,
      cleanupCandidate: Boolean(classificationValues?.cleanup_candidate ?? thread.cleanupCandidate),
      handled: Boolean(nextHandled),
      text: baseText,
    });

    const writes: MailboxThreadWrite[] = [];
    writes.push({
      kind: "run",
      name: "upsertThread_3",
      params: [
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
        nextHandled,
        nextLocalInboxHidden,
        nextUnreadCount,
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
          priorityBand: priorityBandFromScore(
            classificationValues?.priority_score ?? thread.priorityScore,
          ),
        }),
        now,
        now,
      ],
    });

    for (const message of thread.messages) {
      const consulted = state.messages[message.id];
      // Messages elsewhere with this provider id are this message's stale copies.
      const orphanedThreadIds = new Set<string>();
      for (const duplicate of consulted?.duplicates || []) {
        writes.push({
          kind: "run",
          name: "reconcileMailboxMessageIdentity_2",
          params: [duplicate.id],
        });
        if (duplicate.thread_id !== thread.id) orphanedThreadIds.add(duplicate.thread_id);
      }
      for (const threadId of orphanedThreadIds)
        writes.push({ kind: "deleteThreadIfEmpty", threadId });
      writes.push({
        kind: "run",
        name: "upsertThread_5",
        params: [
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
          isMessageUnreadAfterLocalState(message) ? 1 : 0,
          JSON.stringify(message.metadata || {}),
          now,
          now,
        ],
      });
      writes.push(...this.messageSearchIndexWrites(thread, message, consulted?.embeddingHash));
      writes.push(
        ...this.messageAttachmentWrites(
          thread,
          message,
          now,
          consulted?.existingAttachmentIds || [],
          state.attachments,
        ),
      );
      if (consulted?.previousThreadId && consulted.previousThreadId !== thread.id) {
        writes.push({ kind: "deleteThreadIfEmpty", threadId: consulted.previousThreadId });
      }
    }
    await this.sql.unit("mailbox_applyThreadWrites", [writes]);

    await this.upsertPrimaryContact(thread);
    await RelationshipMemoryService.rememberMailboxInsights({
      facts: thread.participants
        .slice(0, 1)
        .map((participant) => `Recent email contact: ${participant.name || participant.email}`),
    });
    if (keepExistingClassification) {
      await this.refreshThreadProposals({
        id: thread.id,
        subject: thread.subject,
        needsReply: Boolean(classificationValues?.needs_reply),
        cleanupCandidate: Boolean(classificationValues?.cleanup_candidate),
        staleFollowup: Boolean(classificationValues?.stale_followup),
        category: classificationValues?.category || thread.category,
      });
    } else {
      await this.sql.run("upsertThread_6", [thread.id]);
    }

    return {
      shouldClassify,
      isNewThread,
    };
  }

  /** Search index and embedding writes for a message, best effort (DB6 thread upsert). */
  private messageSearchIndexWrites(
    thread: NormalizedThreadInput,
    message: NormalizedMailboxMessage,
    existingEmbeddingHash: string | null | undefined,
  ): MailboxThreadWrite[] {
    const sender = [message.from?.name, message.from?.email].filter(Boolean).join(" ");
    const body = `${message.snippet || ""}\n${message.bodyHtml ? stripHtml(message.bodyHtml) : message.body || ""}`;
    const writes: MailboxThreadWrite[] = [
      {
        kind: "optional",
        statements: [
          { name: "upsertMessageSearchIndex_1", params: [message.id] },
          {
            name: "upsertMessageSearchIndex_2",
            params: [
              message.id,
              thread.id,
              message.id,
              message.subject || thread.subject,
              sender,
              body,
            ],
          },
        ],
      },
    ];
    const embedding = MailboxAgentSearchService.prepareEmbeddingParams(
      {
        recordType: "message",
        recordId: message.id,
        accountId: thread.accountId,
        threadId: thread.id,
        messageId: message.id,
        subject: message.subject || thread.subject,
        sender,
        body,
      },
      existingEmbeddingHash,
    );
    if (embedding) {
      writes.push({
        kind: "optional",
        statements: [{ name: "search_upsertEmbeddingForPlainText_2", params: embedding }],
      });
    }
    return writes;
  }

  /**
   * Attachment writes for a message (DB6 thread upsert): drop the attachments it no longer
   * has, upsert the rest, and re-index each with its stored extracted text.
   */
  private messageAttachmentWrites(
    thread: NormalizedThreadInput,
    message: NormalizedMailboxMessage,
    now: number,
    existingAttachmentIds: string[],
    consulted: Record<string, { textContent: string | null; embeddingHash: string | null }>,
  ): MailboxThreadWrite[] {
    const writes: MailboxThreadWrite[] = [];
    const nextAttachments = message.attachments || [];
    const nextIds = new Set(nextAttachments.map((attachment) => attachment.id));
    for (const existingId of existingAttachmentIds) {
      if (nextIds.has(existingId)) continue;
      writes.push({
        kind: "optional",
        statements: [{ name: "upsertMessageAttachments_2", params: [existingId] }],
      });
      writes.push({
        kind: "optional",
        statements: [{ name: "upsertMessageAttachments_3", params: [existingId] }],
      });
      writes.push({ kind: "run", name: "upsertMessageAttachments_4", params: [existingId] });
      writes.push({ kind: "run", name: "upsertMessageAttachments_5", params: [existingId] });
    }
    for (const attachment of nextAttachments) {
      writes.push({
        kind: "run",
        name: "upsertMessageAttachments_6",
        params: [
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
        ],
      });
      const attachmentText = decryptMailboxValue(consulted[attachment.id]?.textContent || "") || "";
      writes.push({
        kind: "optional",
        statements: [
          { name: "upsertMessageAttachments_2", params: [attachment.id] },
          {
            name: "upsertAttachmentSearchIndex_1",
            params: [
              attachment.id,
              thread.id,
              message.id,
              attachment.id,
              attachment.filename,
              attachmentText,
            ],
          },
        ],
      });
      const embedding = MailboxAgentSearchService.prepareEmbeddingParams(
        {
          recordType: "attachment",
          recordId: attachment.id,
          threadId: thread.id,
          messageId: message.id,
          attachmentId: attachment.id,
          attachmentFilename: attachment.filename,
          attachmentText,
        },
        consulted[attachment.id]?.embeddingHash,
      );
      if (embedding) {
        writes.push({
          kind: "optional",
          statements: [{ name: "search_upsertEmbeddingForPlainText_2", params: embedding }],
        });
      }
    }
    return writes;
  }

  private async upsertMessageSearchIndex(
    thread: NormalizedThreadInput,
    message: NormalizedMailboxMessage,
  ): Promise<void> {
    const sender = [message.from?.name, message.from?.email].filter(Boolean).join(" ");
    const body = `${message.snippet || ""}\n${message.bodyHtml ? stripHtml(message.bodyHtml) : message.body || ""}`;
    try {
      await this.sql.run("upsertMessageSearchIndex_1", [message.id]);
      await this.sql.run("upsertMessageSearchIndex_2", [
        message.id,
        thread.id,
        message.id,
        message.subject || thread.subject,
        sender,
        body,
      ]);
    } catch {
      // FTS is optional; mailbox search falls back to row scanning.
    }
    try {
      await MailboxAgentSearchService.upsertEmbeddingForPlainText(this.sql, {
        recordType: "message",
        recordId: message.id,
        accountId: thread.accountId,
        threadId: thread.id,
        messageId: message.id,
        subject: message.subject || thread.subject,
        sender,
        body,
      });
    } catch {
      // Semantic search is additive.
    }
  }

  private async ensureMailboxSearchIndexBackfilled(): Promise<void> {
    if (this.mailboxSearchIndexBackfillAttempted) return;
    this.mailboxSearchIndexBackfillAttempted = true;

    try {
      const messageRows = (await this.sql.all("ensureMailboxSearchIndexBackfilled_1", [])) as Array<
        Pick<
          MailboxMessageRow,
          | "id"
          | "thread_id"
          | "from_name"
          | "from_email"
          | "subject"
          | "snippet"
          | "body_text"
          | "body_html"
        > & { thread_subject: string }
      >;
      for (const row of messageRows) {
        const bodyHtml = decryptMailboxValue(row.body_html || "");
        const bodyText = decryptMailboxValue(row.body_text || "");
        await this.sql.run("insertMessageSearchRow", [
          row.id,
          row.thread_id,
          row.id,
          row.subject || row.thread_subject,
          [row.from_name, row.from_email].filter(Boolean).join(" "),
          `${row.snippet || ""}\n${bodyHtml ? stripHtml(bodyHtml) : bodyText || ""}`,
        ]);
      }

      const attachmentRows = (await this.sql.all(
        "ensureMailboxSearchIndexBackfilled_2",
        [],
      )) as MailboxAttachmentRow[];
      for (const row of attachmentRows) {
        await this.upsertAttachmentSearchIndex(row.id);
      }
    } catch {
      // FTS is optional; mailbox search falls back to row scanning.
    }
  }

  private async upsertMessageAttachments(
    thread: NormalizedThreadInput,
    message: NormalizedMailboxMessage,
    now: number,
  ): Promise<void> {
    const nextAttachments = message.attachments || [];
    const nextIds = new Set(nextAttachments.map((attachment) => attachment.id));
    const existingRows = (await this.sql.all("upsertMessageAttachments_1", [message.id])) as Array<{
      id: string;
    }>;
    for (const existing of existingRows) {
      if (nextIds.has(existing.id)) continue;
      try {
        await this.sql.run("upsertMessageAttachments_2", [existing.id]);
      } catch {
        // Optional FTS table may be unavailable.
      }
      try {
        await this.sql.run("upsertMessageAttachments_3", [existing.id]);
      } catch {
        // Semantic search index is additive.
      }
      await this.sql.run("upsertMessageAttachments_4", [existing.id]);
      await this.sql.run("upsertMessageAttachments_5", [existing.id]);
    }

    for (const attachment of nextAttachments) {
      await this.sql.run("upsertMessageAttachments_6", [
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
      ]);
      await this.upsertAttachmentSearchIndex(attachment.id);
    }
  }

  private async upsertAttachmentSearchIndex(attachmentId: string): Promise<void> {
    const row = (await this.sql.get("getMailboxAttachment_1", [attachmentId])) as
      | MailboxAttachmentRow
      | undefined;
    if (!row) return;
    const attachmentText = decryptMailboxValue(row.text_content || "") || "";
    try {
      await this.sql.run("upsertMessageAttachments_2", [row.id]);
      await this.sql.run("upsertAttachmentSearchIndex_1", [
        row.id,
        row.thread_id,
        row.message_id,
        row.id,
        row.filename,
        attachmentText,
      ]);
    } catch {
      // FTS is optional.
    }
    try {
      await MailboxAgentSearchService.upsertEmbeddingForPlainText(this.sql, {
        recordType: "attachment",
        recordId: row.id,
        threadId: row.thread_id,
        messageId: row.message_id,
        attachmentId: row.id,
        attachmentFilename: row.filename,
        attachmentText,
      });
    } catch {
      // Semantic search is additive.
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

  private chooseMailboxClassifierModel(): {
    providerType: string;
    modelKey: string;
    modelId: string;
  } | null {
    try {
      const selection = LLMProviderFactory.resolveTaskModelSelection(undefined, {
        forceProfile: "cheap",
        allowProfileRouting: true,
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
      const todayBucket = normalizeTodayBucket(
        parsed.todayBucket,
        deriveTodayBucket({
          category: validCategory,
          domainCategory,
          needsReply: parsed.needsReply === true,
          priorityScore: clampScore(Number(parsed.priorityScore ?? 0)),
          urgencyScore: clampScore(Number(parsed.urgencyScore ?? 0)),
          cleanupCandidate: parsed.cleanupCandidate === true,
          handled: parsed.handled === true,
          text: `${parsed.rationale || ""} ${Array.isArray(parsed.labels) ? parsed.labels.join(" ") : ""}`,
        }),
      );
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
        rationale:
          typeof parsed.rationale === "string"
            ? normalizeWhitespace(parsed.rationale, 220)
            : undefined,
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
    const existing = (await this.sql.get("classifyThreadWithLLM_1", [thread.id])) as
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

    mailboxLogger.info("Mailbox classifier model selected", {
      providerType: modelSelection.providerType,
      modelKey: modelSelection.modelKey,
      modelId: modelSelection.modelId,
    });

    const provider = LLMProviderFactory.createProvider({
      type: modelSelection.providerType as LLMProviderType,
      model: modelSelection.modelId,
    });
    const workspaceId =
      (await this.resolveThreadWorkspaceId(thread.accountId)) ||
      (await this.resolveDefaultWorkspaceId());
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
      recordLlmCallError(
        {
          workspaceId,
          sourceKind: "mailbox_classification",
          sourceId: thread.id,
          providerType: provider.type,
          modelKey: modelSelection.modelKey,
          modelId: modelSelection.modelId,
        },
        error,
      );
      return mailboxClassificationFallback(snapshot);
    }
  }

  private async persistThreadClassification(
    threadId: string,
    result: MailboxClassificationResult,
    fingerprint: string,
    modelKey: string | null,
    existingState: MailboxClassificationState,
    rawJson?: string,
  ): Promise<void> {
    const now = Date.now();
    await this.sql.run("persistThreadClassification_1", [
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
    ]);
  }

  private async classifyThreadById(
    threadId: string,
    options?: { force?: boolean; preserveBackfill?: boolean },
  ): Promise<boolean> {
    const detail = await this.getThreadCore(threadId);
    if (!detail) return false;
    const snapshot = this.buildClassificationSnapshot(detail);
    const fingerprint = mailboxClassificationFingerprint(snapshot);
    const existing = (await this.sql.get("classifyThreadWithLLM_1", [threadId])) as
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
    await this.persistThreadClassification(
      threadId,
      result,
      fingerprint,
      modelSelection?.modelKey || null,
      existing?.classification_state || "pending",
      JSON.stringify(result),
    );

    await this.refreshThreadProposals({
      id: detail.id,
      subject: detail.subject,
      needsReply: result.needsReply,
      cleanupCandidate: result.cleanupCandidate,
      staleFollowup: result.staleFollowup,
      category: result.category,
    });
    await this.upsertPrimaryContact({
      ...detail,
      needsReply: result.needsReply,
    } as unknown as NormalizedThreadInput);
    const primaryContact = detail.participants[0];
    await this.emitMailboxEvent({
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
    const account = (await this.sql.get("classifyMailboxThreadsForAccount_1", [accountId])) as
      | { id: string; classification_initial_batch_at: number | null }
      | undefined;
    if (!account) {
      return { accountId, scannedThreads: 0, reclassifiedThreads: 0 };
    }

    const canBackfill =
      options?.includeBackfill === true || !account.classification_initial_batch_at;
    const includeAll = options?.force === true && options?.includeBackfill === true;
    const rows = includeAll
      ? ((await this.sql.all("classifyMailboxThreadsForAccount_2", [accountId, limit])) as Array<{
          id: string;
        }>)
      : await this.sql.all<{ id: string }>("classificationCandidatesInStates", [
          accountId,
          JSON.stringify(canBackfill ? ["pending", "backfill_pending"] : ["pending"]),
          limit,
        ]);

    let reclassifiedThreads = 0;
    for (const row of rows) {
      const updated = await this.classifyThreadById(row.id, {
        force: options?.force,
      });
      if (updated) reclassifiedThreads += 1;
    }

    if (!account.classification_initial_batch_at && canBackfill) {
      await this.sql.run("reclassifyAccount_1", [Date.now(), Date.now(), accountId]);
    }

    return {
      accountId,
      scannedThreads: rows.length,
      reclassifiedThreads,
    };
  }

  private async refreshThreadProposals(
    thread: Pick<
      NormalizedThreadInput,
      "id" | "subject" | "needsReply" | "cleanupCandidate" | "staleFollowup" | "category"
    >,
  ): Promise<void> {
    await this.sql.run("refreshThreadProposals_1", [thread.id]);

    if (thread.needsReply) {
      await this.upsertProposal({
        threadId: thread.id,
        type: "reply",
        title: `Reply to ${thread.subject}`,
        reasoning: "Latest message appears to require a response.",
      });
    }
    if (thread.cleanupCandidate) {
      await this.upsertProposal({
        threadId: thread.id,
        type: "cleanup",
        title: `Clean up ${thread.subject}`,
        reasoning:
          "Hide this thread from the Cowork inbox. Use Archive or Trash if you want to change the server-side mailbox.",
      });
    }
    if (thread.staleFollowup) {
      await this.upsertProposal({
        threadId: thread.id,
        type: "follow_up",
        title: `Follow up on ${thread.subject}`,
        reasoning: "This thread still needs a reply and has gone stale.",
      });
    }
    if (thread.category === "calendar") {
      await this.upsertProposal({
        threadId: thread.id,
        type: "schedule",
        title: `Propose meeting slots for ${thread.subject}`,
        reasoning: "Thread content looks scheduling related.",
      });
    }
  }

  private async upsertPrimaryContact(thread: NormalizedThreadInput): Promise<void> {
    const primary = thread.participants[0];
    if (!primary?.email) return;
    const now = Date.now();
    const company = companyFromEmail(primary.email);
    const sensitiveContent = this.createThreadSensitiveContent([
      thread.subject,
      thread.snippet,
      ...thread.messages.map((message) =>
        message.bodyHtml ? stripHtml(message.bodyHtml) : message.body,
      ),
    ]);
    const learnedFacts = [
      primary.name ? `Name: ${primary.name}` : null,
      company ? `Company: ${company}` : null,
    ].filter((entry): entry is string => Boolean(entry));

    await this.sql.run("upsertPrimaryContact_1", [
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
      (await this.getCommitmentsForThread(thread.id)).filter((item) => item.state !== "done")
        .length,
      now,
      now,
    ]);
  }

  private async getSummaryForThread(threadId: string): Promise<MailboxSummaryCard | null> {
    const row = (await this.sql.get("getSummaryForThread_1", [threadId])) as
      | MailboxSummaryRow
      | undefined;
    if (!row) return null;
    return this.mapSummaryRow(row);
  }

  private async getMessagesForThread(threadId: string): Promise<MailboxMessage[]> {
    const rows = (await this.sql.all("getMessagesForThread_1", [threadId])) as MailboxMessageRow[];
    return rows.map((row) => this.mapMessageRow(row));
  }

  private async getDraftsForThread(threadId: string): Promise<MailboxDraftSuggestion[]> {
    const rows = (await this.sql.all("getDraftsForThread_1", [threadId])) as MailboxDraftRow[];
    return rows.map((row) => this.mapDraftRow(row));
  }

  private async getProposalsForThread(threadId: string): Promise<MailboxActionProposal[]> {
    const rows = (await this.sql.all("getProposalsForThread_1", [
      threadId,
    ])) as MailboxProposalRow[];
    return rows.map((row) => this.mapProposalRow(row));
  }

  private async getCommitmentsForThread(threadId: string): Promise<MailboxCommitment[]> {
    const rows = (await this.sql.all("getCommitmentsForThread_1", [
      threadId,
    ])) as MailboxCommitmentRow[];
    return rows.map((row) => this.mapCommitmentRow(row));
  }

  private async getPrimaryContactMemory(threadId: string): Promise<MailboxContactMemory | null> {
    const thread = (await this.sql.get("getPrimaryContactMemory_1", [threadId])) as
      | { account_id: string; participants_json: string | null }
      | undefined;
    const email = parseJsonArray<MailboxParticipant>(thread?.participants_json).find(
      Boolean,
    )?.email;
    if (!thread?.account_id || !email) return null;
    const row = (await this.sql.get("getPrimaryContactMemory_2", [email])) as
      | MailboxContactRow
      | undefined;
    const insights = await this.getContactInsights(thread.account_id, email);
    if (!row) {
      const participant = parseJsonArray<MailboxParticipant>(thread.participants_json).find(
        Boolean,
      );
      return {
        id: `contact:${email}`,
        accountId: thread.account_id,
        email,
        name: participant?.name,
        company: companyFromEmail(email),
        crmLinks: [],
        learnedFacts: [],
        openCommitments: (await this.getCommitmentsForThread(threadId)).filter(
          (commitment) => commitment.state === "suggested" || commitment.state === "accepted",
        ).length,
        ...insights,
      };
    }
    return {
      ...this.mapContactRow(row),
      ...insights,
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

  private async getContactInsights(
    accountId: string,
    email: string,
  ): Promise<
    Pick<
      MailboxContactMemory,
      | "totalThreads"
      | "totalMessages"
      | "averageResponseHours"
      | "lastOutboundAt"
      | "recentSubjects"
      | "styleSignals"
      | "recentOutboundExample"
      | "responseTendency"
    >
  > {
    const like = `%${email}%`;
    const threadRows = (await this.sql.all("getContactInsights_1", [accountId, like])) as Array<{
      id: string;
      subject: string;
      last_message_at: number;
    }>;

    const messageRows = (await this.sql.all("getContactInsights_2", [accountId, like])) as Array<{
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
      lastOutboundAt: messageRows.filter((row) => row.direction === "outgoing").slice(-1)[0]
        ?.received_at,
      recentSubjects: threadRows
        .map((row) => row.subject)
        .filter(Boolean)
        .slice(0, 3),
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
      averageLength < 220
        ? "Prefers short replies"
        : averageLength > 500
          ? "Often writes with fuller context"
          : null,
      greeting?.startsWith("Hey")
        ? "Usually opens casually"
        : greeting?.startsWith("Hello")
          ? "Usually opens formally"
          : null,
      /^thanks/i.test(signoff)
        ? "Usually signs off with Thanks"
        : /^best/i.test(signoff)
          ? "Usually signs off with Best"
          : null,
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
    const row = (await this.sql.get("getThread_1", [threadId])) as MailboxThreadRow | undefined;
    if (!row) return null;
    return {
      ...(await this.mapThreadRow(row, (await this.getSummaryForThread(threadId)) || undefined)),
      messages: await this.getMessagesForThread(threadId),
    };
  }

  private async resolveThreadWorkspaceId(_accountId?: string): Promise<string | undefined> {
    const agentMail = this.parseAgentMailAccountId(_accountId);
    if (agentMail) {
      const row = (await this.sql.get("resolveThreadWorkspaceId_1", [
        agentMail.podId,
        agentMail.inboxId,
      ])) as { workspace_id: string } | undefined;
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

  private async buildMissionControlCompanyCandidates(
    detail: MailboxThreadDetail,
  ): Promise<MailboxCompanyCandidate[]> {
    const companies = await this.controlPlaneCore.listCompanies();
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
      .filter((candidate) => candidate.confidence >= 0.05)
      .sort((a, b) => b.confidence - a.confidence);

    return scored.slice(0, 5);
  }

  private async buildMissionControlOperatorRecommendations(
    detail: MailboxThreadDetail,
    companyId?: string,
  ): Promise<MailboxOperatorRecommendation[]> {
    const roles = (await this.agentRoleRepo.findAll(false)).filter(
      (role) =>
        role.isActive !== false && (!companyId || !role.companyId || role.companyId === companyId),
    );
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
      /\b(support|customer|service|refund|issue|outage|incident|escalation|complaint|risk)\b/.test(
        text,
      )
        ? "customer_ops"
        : /\b(sales|partnership|pipeline|candidate|recruit|hiring|outbound|lead)\b/.test(text)
          ? "growth"
          : /\b(plan|planning|scope|roadmap|project|blocker|spec|milestone)\b/.test(text)
            ? "planner"
            : "founder_office";

    const scored = roles
      .map((role) => {
        const roleText =
          `${role.name} ${role.displayName} ${role.operatorMandate || ""}`.toLowerCase();
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

  private async persistMissionControlHandoff(input: {
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
  }): Promise<MailboxMissionControlHandoffRecord> {
    const id = randomUUID();
    const now = Date.now();
    await this.sql.run("persistMissionControlHandoff_1", [
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
    ]);
    const row = (await this.sql.get("persistMissionControlHandoff_2", [
      id,
    ])) as MailboxMissionControlHandoffRow;
    return this.mapMissionControlHandoffRow(row);
  }

  private async findActiveMissionControlHandoff(
    threadId: string,
    companyId: string,
    operatorRoleId: string,
  ): Promise<MailboxMissionControlHandoffRecord | null> {
    const rows = (await this.sql.all("findActiveMissionControlHandoff_1", [
      threadId,
      companyId,
      operatorRoleId,
    ])) as MailboxMissionControlHandoffRow[];
    for (const row of rows) {
      const record = await this.mapMissionControlHandoffRow(row);
      if (record.issueStatus === "open") return record;
    }
    return null;
  }

  private async mapMissionControlHandoffRow(
    row: MailboxMissionControlHandoffRow,
  ): Promise<MailboxMissionControlHandoffRecord> {
    const issue = await this.controlPlaneCore.getIssue(row.issue_id);
    const issueStatus: MailboxMissionControlHandoffRecord["issueStatus"] =
      issue?.status === "done" ? "done" : issue?.status === "cancelled" ? "cancelled" : "open";
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
        summary:
          "Google Calendar not connected, using lightweight default availability placeholders.",
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
      options: options.length
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

  private async applyArchive(
    thread: MailboxThreadDetail | (MailboxThreadListItem & { messages: MailboxMessage[] }),
  ): Promise<void> {
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
      await this.getAgentMailClient().updateMessage(
        account.inboxId,
        latestMessage.providerMessageId,
        {
          addLabels: ["archived"],
          removeLabels: ["inbox"],
        },
      );
    } else if (thread.provider === "outlook_graph") {
      const archiveFolder = (await this.listMailboxFolders()).find(
        (folder) => folder.accountId === thread.accountId && folder.role === "archive",
      );
      const latestMessage = [...thread.messages].sort((a, b) => b.receivedAt - a.receivedAt)[0];
      if (!latestMessage || !archiveFolder) {
        throw new Error("Unable to resolve Outlook archive target.");
      }
      await this.microsoftGraphRequest(await this.resolveMicrosoftGraphChannelId(), {
        method: "POST",
        path: `/me/messages/${encodeURIComponent(latestMessage.providerMessageId)}/move`,
        scopes: MICROSOFT_GRAPH_READWRITE_SCOPES,
        body: { destinationId: archiveFolder.providerFolderId },
      });
    } else {
      throw new Error("Archive is not supported for the current IMAP adapter.");
    }

    await this.sql.run("applyArchive_1", [Date.now(), thread.id]);
  }

  private async applyLocalCleanup(
    thread: MailboxThreadDetail | (MailboxThreadListItem & { messages: MailboxMessage[] }),
  ): Promise<void> {
    await this.sql.run("applyArchive_1", [Date.now(), thread.id]);
  }

  private async applyMarkDone(
    thread: MailboxThreadDetail | (MailboxThreadListItem & { messages: MailboxMessage[] }),
  ): Promise<void> {
    const now = Date.now();
    const openCommitments = (await this.sql.all("applyMarkDone_1", [thread.id])) as Array<{
      id: string;
    }>;
    for (const commitment of openCommitments) {
      await this.updateCommitmentState(commitment.id, "done");
    }
    await this.sql.run("applyMarkDone_2", [now, thread.id]);
    await this.updateProposalStatusByThreadAndType(thread.id, "reply", "applied");
    await this.updateProposalStatusByThreadAndType(thread.id, "follow_up", "dismissed");
  }

  private async applyTrash(
    thread: MailboxThreadDetail | (MailboxThreadListItem & { messages: MailboxMessage[] }),
  ): Promise<void> {
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
      await this.getAgentMailClient().updateMessage(
        account.inboxId,
        latestMessage.providerMessageId,
        {
          addLabels: ["trash"],
        },
      );
    } else if (thread.provider === "outlook_graph") {
      const latestMessage = [...thread.messages].sort((a, b) => b.receivedAt - a.receivedAt)[0];
      if (!latestMessage) throw new Error("Unable to resolve Outlook message for trash.");
      await this.microsoftGraphRequest(await this.resolveMicrosoftGraphChannelId(), {
        method: "DELETE",
        path: `/me/messages/${encodeURIComponent(latestMessage.providerMessageId)}`,
        scopes: MICROSOFT_GRAPH_READWRITE_SCOPES,
      });
    } else {
      throw new Error("Trash is not supported for the current IMAP adapter.");
    }

    await this.sql.run("applyArchive_1", [Date.now(), thread.id]);
  }

  private async applyMarkRead(
    thread: MailboxThreadDetail | (MailboxThreadListItem & { messages: MailboxMessage[] }),
  ): Promise<void> {
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
      const channel = await this.channelRepo.findByType("email");
      if (!channel) throw new Error("Email channel is not configured");
      const cfg = (channel.config as Any) || {};
      if (thread.provider === "outlook_graph") {
        await this.applyMicrosoftGraphReadState(channel.id, thread.id, true);
      } else if (asString(cfg.protocol) === "loom") {
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
        await this.applyStandardImapReadState(
          thread.id,
          this.createStandardEmailClient(channel.id, cfg),
          true,
        );
      }
    }

    await this.markThreadReadLocally(thread.id);
  }

  private async markThreadReadLocally(threadId: string): Promise<void> {
    const now = Date.now();
    await this.sql.run("markThreadReadLocally_1", [now, threadId]);
    await this.sql.run("markThreadReadLocally_2", [now, threadId]);
  }

  private async applyMarkUnread(
    thread: MailboxThreadDetail | (MailboxThreadListItem & { messages: MailboxMessage[] }),
  ): Promise<void> {
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
      await this.getAgentMailClient().updateMessage(
        account.inboxId,
        latestMessage.providerMessageId,
        {
          removeLabels: ["read"],
          addLabels: ["unread"],
        },
      );
    } else {
      const channel = await this.channelRepo.findByType("email");
      if (!channel) throw new Error("Email channel is not configured");
      const cfg = (channel.config as Any) || {};
      if (thread.provider === "outlook_graph") {
        await this.applyMicrosoftGraphReadState(channel.id, thread.id, false);
      } else if (asString(cfg.protocol) === "loom") {
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
        await this.applyStandardImapReadState(
          thread.id,
          this.createStandardEmailClient(channel.id, cfg),
          false,
        );
      }
    }

    const targetMessageId = latestMessage?.id || null;
    if (targetMessageId) {
      await this.sql.run("applyMarkUnread_1", [targetMessageId, Date.now(), thread.id]);
    }
    await this.sql.run("applyMarkUnread_2", [Date.now(), thread.id]);
  }

  private async applyMicrosoftGraphReadState(
    channelId: string,
    threadId: string,
    read: boolean,
  ): Promise<void> {
    const rows = (await this.sql.all("applyMicrosoftGraphReadState_1", [threadId])) as Array<
      Pick<MailboxMessageRow, "id" | "provider_message_id" | "metadata_json">
    >;

    for (const row of rows) {
      const metadata = parseMailboxMessageMetadata(row.metadata_json);
      const graphMessageId =
        metadata.microsoftGraphMessageId ||
        (row.id.startsWith("outlook-graph-message:") ? row.provider_message_id : null);
      if (!graphMessageId) continue;
      await this.updateMicrosoftGraphMessageReadState(channelId, graphMessageId, read);
      return;
    }

    for (const row of rows) {
      const metadata = parseMailboxMessageMetadata(row.metadata_json);
      const candidateIds = [metadata.rfcMessageId, row.provider_message_id]
        .filter((value): value is string => Boolean(value))
        .filter((value) => value.includes("@") || value.startsWith("<"));
      for (const messageId of candidateIds) {
        const graphMessageId = await this.resolveMicrosoftGraphMessageIdByInternetMessageId(
          channelId,
          messageId,
        );
        if (!graphMessageId) continue;
        await this.updateMicrosoftGraphMessageReadState(channelId, graphMessageId, read);
        await this.persistResolvedMicrosoftGraphMessageId(row, graphMessageId, messageId);
        mailboxLogger.warn("Recovered Microsoft Graph message id for mailbox read-state update", {
          threadId,
          mailboxMessageId: row.id,
          messageId,
          graphMessageId,
        });
        return;
      }
    }

    throw new Error(
      `Unable to resolve Microsoft Graph message for ${read ? "mark_read" : "mark_unread"}`,
    );
  }

  private async resolveMicrosoftGraphMessageIdByInternetMessageId(
    channelId: string,
    internetMessageId: string,
  ): Promise<string | null> {
    const data = await this.microsoftGraphRequest(channelId, {
      method: "GET",
      path: "/me/messages",
      scopes: MICROSOFT_GRAPH_READWRITE_SCOPES,
      query: {
        $top: "1",
        $select: "id,internetMessageId",
        $filter: `internetMessageId eq '${escapeODataString(internetMessageId)}'`,
      },
    });
    const message = Array.isArray(data?.value) ? data.value[0] : null;
    return asString(message?.id);
  }

  private async updateMicrosoftGraphMessageReadState(
    channelId: string,
    graphMessageId: string,
    read: boolean,
  ): Promise<void> {
    await this.microsoftGraphRequest(channelId, {
      method: "PATCH",
      path: `/me/messages/${encodeURIComponent(graphMessageId)}`,
      scopes: MICROSOFT_GRAPH_READWRITE_SCOPES,
      body: {
        isRead: read,
      },
    });
  }

  private async persistResolvedMicrosoftGraphMessageId(
    row: Pick<MailboxMessageRow, "id" | "metadata_json">,
    microsoftGraphMessageId: string,
    rfcMessageId?: string,
  ): Promise<void> {
    const previous = parseMailboxMessageMetadata(row.metadata_json);
    await this.sql.run("persistResolvedMicrosoftGraphMessageId_1", [
      JSON.stringify({
        ...previous,
        microsoftGraphMessageId,
        rfcMessageId: rfcMessageId || previous.rfcMessageId,
      }),
      Date.now(),
      row.id,
    ]);
  }

  private async applyStandardImapReadState(
    threadId: string,
    client: EmailClient,
    read: boolean,
  ): Promise<void> {
    const rows = (await this.sql.all("applyMicrosoftGraphReadState_1", [threadId])) as Array<
      Pick<MailboxMessageRow, "id" | "provider_message_id" | "metadata_json">
    >;

    for (const row of rows) {
      const uid = this.extractStoredImapUid(row);
      if (uid !== null && Number.isFinite(uid)) {
        if (read) {
          await client.markAsRead(uid);
        } else {
          await client.markAsUnread(uid);
        }
        return;
      }
    }

    for (const row of rows) {
      const metadata = parseMailboxMessageMetadata(row.metadata_json);
      const candidateIds = [metadata.rfcMessageId, row.provider_message_id]
        .filter((value): value is string => Boolean(value))
        .filter((value) => !Number.isFinite(Number(value)));
      for (const messageId of candidateIds) {
        const uid = read
          ? await client.markMessageIdAsRead(messageId)
          : await client.markMessageIdAsUnread(messageId);
        if (uid === null || !Number.isFinite(uid)) continue;
        await this.persistResolvedImapMessageUid(row, uid, messageId);
        mailboxLogger.warn("Recovered legacy IMAP UID for mailbox read-state update", {
          threadId,
          mailboxMessageId: row.id,
          messageId,
          uid,
        });
        return;
      }
    }

    throw new Error(`Unable to resolve IMAP UID for ${read ? "mark_read" : "mark_unread"}`);
  }

  private extractStoredImapUid(
    row: Pick<MailboxMessageRow, "provider_message_id" | "metadata_json">,
  ): number | null {
    const providerUid = Number(row.provider_message_id);
    if (Number.isFinite(providerUid)) {
      return providerUid;
    }
    const metadata = parseMailboxMessageMetadata(row.metadata_json);
    return Number.isFinite(metadata.imapUid) ? metadata.imapUid || null : null;
  }

  private async persistResolvedImapMessageUid(
    row: Pick<MailboxMessageRow, "id" | "metadata_json">,
    uid: number,
    rfcMessageId?: string,
  ): Promise<void> {
    const previous = parseMailboxMessageMetadata(row.metadata_json);
    await this.sql.run("persistResolvedMicrosoftGraphMessageId_1", [
      JSON.stringify({
        ...previous,
        imapUid: uid,
        rfcMessageId: rfcMessageId || previous.rfcMessageId,
      }),
      Date.now(),
      row.id,
    ]);
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
      await this.getAgentMailClient().updateMessage(
        account.inboxId,
        latestMessage.providerMessageId,
        {
          addLabels: [label],
        },
      );
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
    await this.sql.run("applyLabel_1", [JSON.stringify(labels), Date.now(), thread.id]);
  }

  private async applyRemoveLabel(
    thread: MailboxThreadDetail | (MailboxThreadListItem & { messages: MailboxMessage[] }),
    label: string,
  ): Promise<void> {
    if (!label) throw new Error("Missing label for remove label action");
    if (thread.provider === "agentmail") {
      const account = this.parseAgentMailAccountId(thread.accountId);
      const latestMessage = [...thread.messages].sort((a, b) => b.receivedAt - a.receivedAt)[0];
      if (!account || !latestMessage) {
        throw new Error("Unable to resolve AgentMail message for label update.");
      }
      await this.getAgentMailClient().updateMessage(
        account.inboxId,
        latestMessage.providerMessageId,
        {
          removeLabels: [label],
        },
      );
    } else if (thread.provider === "gmail") {
      await gmailRequest(GoogleWorkspaceSettingsManager.loadSettings(), {
        method: "POST",
        path: `/users/me/threads/${encodeURIComponent(thread.providerThreadId)}/modify`,
        body: {
          removeLabelIds: [label],
        },
      });
    } else {
      throw new Error("Remove label is only supported for Gmail- or AgentMail-backed threads.");
    }
    const labels = thread.labels.filter((entry) => entry !== label);
    await this.sql.run("applyLabel_1", [JSON.stringify(labels), Date.now(), thread.id]);
  }

  private async applyMove(
    thread: MailboxThreadDetail | (MailboxThreadListItem & { messages: MailboxMessage[] }),
    folderId: string,
  ): Promise<void> {
    if (!folderId) throw new Error("Missing folder for move action");
    const folder = (await this.listMailboxFolders()).find(
      (entry) => entry.id === folderId || entry.providerFolderId === folderId,
    );
    const target = folder?.providerFolderId || folderId;
    if (thread.provider === "gmail") {
      const addLabelIds = target === "archive" ? [] : [target];
      const removeLabelIds = target === "inbox" ? [] : ["INBOX"];
      await gmailRequest(GoogleWorkspaceSettingsManager.loadSettings(), {
        method: "POST",
        path: `/users/me/threads/${encodeURIComponent(thread.providerThreadId)}/modify`,
        body: { addLabelIds, removeLabelIds },
      });
    } else if (thread.provider === "outlook_graph") {
      const message = [...thread.messages].sort((a, b) => b.receivedAt - a.receivedAt)[0];
      if (!message) throw new Error("Unable to resolve Outlook message for move.");
      await this.microsoftGraphRequest(await this.resolveMicrosoftGraphChannelId(), {
        method: "POST",
        path: `/me/messages/${encodeURIComponent(message.providerMessageId)}/move`,
        scopes: MICROSOFT_GRAPH_READWRITE_SCOPES,
        body: { destinationId: target },
      });
    } else {
      throw new Error("Move is only supported for Gmail and Microsoft Graph mailboxes.");
    }
    await this.sql.run("applyAction_1", [Date.now(), thread.id]);
  }

  private async applySendDraft(
    thread: MailboxThreadDetail | (MailboxThreadListItem & { messages: MailboxMessage[] }),
    draftId?: string,
    override?: { subject?: string; body?: string },
  ): Promise<void> {
    const drafts = await this.getDraftsForThread(thread.id);
    const draft = draftId ? drafts.find((entry) => entry.id === draftId) : drafts[0];
    if (!draft) throw new Error("Draft not found");

    const recipient = thread.participants[0]?.email;
    if (!recipient) throw new Error("No recipient found for draft");

    const subject = override?.subject?.trim() || draft.subject;
    const body = override?.body ?? draft.body;

    if (subject !== draft.subject || body !== draft.body) {
      await this.sql.run("applySendDraft_1", [subject, body, Date.now(), draft.id]);
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
      await this.getAgentMailClient().replyAllMessage(
        account.inboxId,
        latestInbound.providerMessageId,
        {
          text: body,
          subject,
        },
      );
    } else {
      const channel = await this.channelRepo.findByType("email");
      if (!channel) throw new Error("Email channel is not configured");
      const cfg = (channel.config as Any) || {};
      const client = this.createStandardEmailClient(channel.id, cfg);
      await client.sendEmail({
        to: recipient,
        subject,
        text: body,
      });
    }

    await this.sql.run("applySendDraft_2", [draft.id]);
    await this.sql.run("applySendDraft_3", [Date.now(), thread.id]);
    await this.updateProposalStatusByThreadAndType(thread.id, "reply", "applied");
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
      await this.getAgentMailClient().replyAllMessage(
        account.inboxId,
        latestInbound.providerMessageId,
        {
          text: body,
          subject,
        },
      );
    } else {
      const channel = await this.channelRepo.findByType("email");
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
      await this.sql.run("applySendMessage_1", [Date.now(), thread.id]);
      await this.updateProposalStatusByThreadAndType(thread.id, "reply", "applied");
    }
  }

  private async applyDiscardDraft(
    thread: MailboxThreadDetail | (MailboxThreadListItem & { messages: MailboxMessage[] }),
    draftId?: string,
  ): Promise<void> {
    const drafts = await this.getDraftsForThread(thread.id);
    const draft = draftId ? drafts.find((entry) => entry.id === draftId) : drafts[0];
    if (!draft) throw new Error("Draft not found");

    await this.sql.run("applySendDraft_2", [draft.id]);

    await this.updateProposalStatusByThreadAndType(thread.id, "reply", "dismissed");
  }

  private async applyScheduleEvent(
    thread: MailboxThreadDetail | (MailboxThreadListItem & { messages: MailboxMessage[] }),
    proposalId?: string,
  ): Promise<void> {
    if (!GoogleWorkspaceSettingsManager.loadSettings().enabled) {
      throw new Error("Google Calendar must be connected before creating schedule events.");
    }
    const proposal = proposalId
      ? (await this.getProposalsForThread(thread.id)).find((entry) => entry.id === proposalId)
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
        attendees: thread.participants
          .slice(0, 1)
          .map((participant) => ({ email: participant.email })),
      },
    });

    await this.updateProposalStatusByThreadAndType(thread.id, "schedule", "applied");
  }

  private async updateProposalStatus(
    proposalId: string,
    status: MailboxProposalStatus,
  ): Promise<void> {
    await this.sql.run("updateProposalStatus_1", [status, Date.now(), proposalId]);
  }

  private async updateProposalStatusByThreadAndType(
    threadId: string,
    type: MailboxProposalType,
    status: MailboxProposalStatus,
  ): Promise<void> {
    await this.sql.run("updateProposalStatusByThreadAndType_1", [
      status,
      Date.now(),
      threadId,
      type,
    ]);
  }

  private async threadIdFromProposal(proposalId?: string): Promise<string | undefined> {
    if (!proposalId) return undefined;
    const row = (await this.sql.get("threadIdFromProposal_1", [proposalId])) as
      | { thread_id: string }
      | undefined;
    return row?.thread_id;
  }

  private async updateContactOpenCommitments(threadId: string): Promise<void> {
    const contact = await this.getPrimaryContactMemory(threadId);
    if (!contact) return;
    const openCount = (await this.getCommitmentsForThread(threadId)).filter(
      (item) => item.state === "suggested" || item.state === "accepted",
    ).length;
    await this.sql.run("updateContactOpenCommitments_1", [openCount, Date.now(), contact.email]);
  }

  private async upsertProposal(input: {
    threadId: string;
    type: MailboxProposalType;
    title: string;
    reasoning: string;
    preview?: Record<string, unknown>;
  }): Promise<void> {
    const existing = (await this.sql.get("upsertProposal_1", [input.threadId, input.type])) as
      | { id: string }
      | undefined;
    const now = Date.now();
    if (existing?.id) {
      await this.sql.run("upsertProposal_2", [
        input.title,
        input.reasoning,
        input.preview ? JSON.stringify(input.preview) : null,
        now,
        existing.id,
      ]);
      return;
    }

    await this.sql.run("upsertProposal_3", [
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
    ]);
  }

  private hasEmailChannel(): boolean {
    const channel = this.channelStore.findByType("email");
    return Boolean(channel?.enabled);
  }

  private isMicrosoftEmailOAuthConfig(config: Any): boolean {
    if (asString(config.authMethod) !== "oauth") return false;
    if (asString(config.oauthProvider) === "microsoft") return true;
    return Boolean(
      asString(config.oauthClientId) &&
      asString(config.refreshToken) &&
      isMicrosoftConsumerEmailAddress(asString(config.email) || undefined),
    );
  }

  private async microsoftGraphRequest(
    channelId: string,
    options: {
      method: "GET" | "POST" | "PATCH" | "DELETE";
      path: string;
      query?: Record<string, string | number | boolean | undefined>;
      body?: unknown;
      headers?: Record<string, string>;
      scopes?: readonly string[];
    },
  ): Promise<Any> {
    const token = await this.getMicrosoftGraphAccessToken(channelId, options.scopes);
    const url = new URL(options.path.replace(/^\/+/, ""), `${MICROSOFT_GRAPH_API_BASE}/`);
    for (const [key, value] of Object.entries(options.query || {})) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }

    const response = await fetch(url.toString(), {
      method: options.method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(options.headers || {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const rawText = typeof response.text === "function" ? await response.text() : "";
    const data = rawText ? parseJsonObject(rawText) : undefined;
    if (!response.ok) {
      const graphMessage =
        asString((data as Any)?.error?.message) ||
        asString((data as Any)?.message) ||
        response.statusText ||
        "Microsoft Graph request failed";
      if (response.status === 401 || response.status === 403) {
        throw new Error(
          `Microsoft Outlook permission failed (${response.status}): ${graphMessage}. Reconnect the Outlook email channel so CoWork can request Microsoft Graph Mail.ReadWrite access.`,
        );
      }
      throw new Error(`Microsoft Graph error ${response.status}: ${graphMessage}`);
    }
    return data || {};
  }

  private async getMicrosoftGraphAccessToken(
    channelId: string,
    requiredScopes: readonly string[] = MICROSOFT_GRAPH_READWRITE_SCOPES,
  ): Promise<string> {
    const channel = await this.channelRepo.findById(channelId);
    if (!channel || channel.type !== "email") {
      throw new Error("Email channel not found");
    }

    const config = (channel.config as Any) || {};
    if (!this.isMicrosoftEmailOAuthConfig(config)) {
      throw new Error("Email channel is not configured for Microsoft Outlook OAuth");
    }

    const accessToken = asString(config.microsoftGraphAccessToken) || asString(config.accessToken);
    const tokenExpiresAt =
      asNumber(config.microsoftGraphTokenExpiresAt) ?? asNumber(config.tokenExpiresAt);
    const tokenScopes = Array.isArray(config.microsoftGraphTokenScopes)
      ? (config.microsoftGraphTokenScopes as string[])
      : Array.isArray(config.scopes)
        ? (config.scopes as string[])
        : undefined;
    const now = Date.now();
    if (
      accessToken &&
      (!tokenExpiresAt || now < tokenExpiresAt - 2 * 60 * 1000) &&
      microsoftScopesIncludeAll(tokenScopes, requiredScopes)
    ) {
      return accessToken;
    }

    const oauthClientId = asString(config.oauthClientId);
    const refreshToken = asString(config.refreshToken);
    if (accessToken && (!tokenExpiresAt || now < tokenExpiresAt - 2 * 60 * 1000) && !refreshToken) {
      return accessToken;
    }
    if (!oauthClientId || !refreshToken) {
      throw new Error("Reconnect the Outlook email channel so CoWork can sync Outlook read state.");
    }

    const refreshed = await refreshMicrosoftEmailAccessToken({
      clientId: oauthClientId,
      clientSecret: asString(config.oauthClientSecret) || undefined,
      refreshToken,
      tenant: asString(config.oauthTenant) || MICROSOFT_EMAIL_DEFAULT_TENANT,
      scopes: [...requiredScopes],
    });
    const refreshedScopes = normalizeMicrosoftEmailReadScopes(refreshed.scopes || requiredScopes);

    const nextConfig = {
      ...config,
      microsoftGraphAccessToken: refreshed.accessToken,
      microsoftGraphTokenExpiresAt: refreshed.expiresIn
        ? Date.now() + refreshed.expiresIn * 1000
        : tokenExpiresAt,
      microsoftGraphTokenScopes: refreshedScopes,
      refreshToken: refreshed.refreshToken || refreshToken,
      scopes: normalizeMicrosoftEmailReadScopes(
        refreshed.scopes || (config.scopes as string[] | undefined),
      ),
    };
    await this.channelRepo.update(channelId, { config: nextConfig });
    return refreshed.accessToken;
  }

  private async getEmailOAuthAccessToken(channelId: string): Promise<string> {
    const channel = await this.channelRepo.findById(channelId);
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
      tokenExpiresAt: refreshed.expiresIn
        ? Date.now() + refreshed.expiresIn * 1000
        : tokenExpiresAt,
      scopes: normalizeMicrosoftEmailReadScopes(
        refreshed.scopes || (config.scopes as string[] | undefined),
      ),
    };
    await this.channelRepo.update(channelId, { config: nextConfig });
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

  private async getMailboxSyncHealth(accounts: MailboxAccount[]): Promise<MailboxSyncHealth[]> {
    const queueRows = (await this.sql.all("getMailboxSyncHealth_1", [])) as Array<{
      account_id: string | null;
      status: string;
      count: number;
    }>;
    const draftRows = (await this.sql.all("getMailboxSyncHealth_2", [])) as Array<{
      account_id: string;
      status: string;
      count: number;
    }>;

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

  private async listMailboxFolders(): Promise<MailboxFolder[]> {
    const rows = (await this.sql.all("listMailboxFolders_1", [])) as MailboxFolderRow[];
    const persisted = rows.map((row) => this.mapMailboxFolderRow(row));
    const existingKeys = new Set(persisted.map((folder) => `${folder.accountId}:${folder.role}`));
    const synthetic: MailboxFolder[] = [];
    const accounts = (await this.sql.all("listMailboxFolders_2", [])) as MailboxAccountRow[];
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
    for (const account of await this.filterVisibleMailboxAccountRows(accounts)) {
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

  private async listMailboxLabels(): Promise<MailboxLabel[]> {
    const rows = (await this.sql.all("listMailboxLabels_1", [])) as MailboxLabelRow[];
    return rows.map((row) => this.mapMailboxLabelRow(row));
  }

  private async listMailboxIdentities(): Promise<MailboxIdentity[]> {
    const rows = (await this.sql.all("listMailboxIdentities_1", [])) as MailboxIdentityRow[];
    const identities = rows.map((row) => this.mapMailboxIdentityRow(row));
    const existingAccounts = new Set(identities.map((identity) => identity.accountId));
    const accounts = (await this.sql.all("listMailboxFolders_2", [])) as MailboxAccountRow[];
    const now = Date.now();
    return [
      ...identities,
      ...(await this.filterVisibleMailboxAccountRows(accounts))
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

  private async listMailboxSignatures(): Promise<MailboxSignature[]> {
    const rows = (await this.sql.all("listMailboxSignatures_1", [])) as MailboxSignatureRow[];
    return rows.map((row) => this.mapMailboxSignatureRow(row));
  }

  private async listMailboxComposeDrafts(): Promise<MailboxComposeDraft[]> {
    const rows = (await this.sql.all("listMailboxComposeDrafts_1", [])) as MailboxComposeDraftRow[];
    return rows.map((row) => this.mapMailboxComposeDraftRow(row));
  }

  private async listMailboxQueuedActions(): Promise<MailboxQueuedAction[]> {
    const rows = (await this.sql.all("listMailboxQueuedActions_1", [])) as MailboxQueuedActionRow[];
    return rows.map((row) => this.mapMailboxQueuedActionRow(row));
  }

  private async listMailboxOutgoingMessages(): Promise<MailboxOutgoingMessage[]> {
    const rows = (await this.sql.all(
      "listMailboxOutgoingMessages_1",
      [],
    )) as MailboxOutgoingMessageRow[];
    return rows.map((row) => this.mapMailboxOutgoingMessageRow(row));
  }

  private async getMailboxClientSettings(): Promise<MailboxClientState["settings"]> {
    const row = (await this.sql.get("getMailboxClientSettings_1", [])) as
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

  private async getMailboxComposeDraft(draftId: string): Promise<MailboxComposeDraft | null> {
    const row = (await this.sql.get("getMailboxComposeDraft_1", [draftId])) as
      | MailboxComposeDraftRow
      | undefined;
    return row ? this.mapMailboxComposeDraftRow(row) : null;
  }

  private async getMailboxOutgoingMessage(id: string): Promise<MailboxOutgoingMessage | null> {
    const row = (await this.sql.get("getMailboxOutgoingMessage_1", [id])) as
      | MailboxOutgoingMessageRow
      | undefined;
    return row ? this.mapMailboxOutgoingMessageRow(row) : null;
  }

  private async getMailboxQueuedAction(actionId: string): Promise<MailboxQueuedAction | null> {
    const row = (await this.sql.get("getMailboxQueuedAction_1", [actionId])) as
      | MailboxQueuedActionRow
      | undefined;
    return row ? this.mapMailboxQueuedActionRow(row) : null;
  }

  private async enqueueMailboxAction(input: {
    accountId?: string;
    threadId?: string;
    draftId?: string;
    type: MailboxQueuedAction["type"];
    payload: Record<string, unknown>;
    nextAttemptAt?: number;
    undoOfActionId?: string;
  }): Promise<MailboxQueuedAction> {
    const now = Date.now();
    const id = randomUUID();
    await this.sql.run("enqueueMailboxAction_1", [
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
    ]);
    return (await this.getMailboxQueuedAction(id))!;
  }

  private async processMailboxQueuedAction(action: MailboxQueuedAction): Promise<void> {
    const now = Date.now();
    await this.sql.run("processMailboxQueuedAction_1", [now, action.id]);

    if (action.type === "send") {
      await this.executeQueuedDraftSend(action);
    } else if (action.type === "undo") {
      await this.sql.run("processMailboxQueuedAction_2", [Date.now(), action.id]);
    } else if (action.threadId) {
      await this.executeQueuedThreadAction(action);
    } else {
      throw new Error(`Mailbox queued action ${action.type} is missing required target data.`);
    }
  }

  private async markMailboxQueuedActionFailed(
    row: MailboxQueuedActionRow,
    error: unknown,
  ): Promise<void> {
    const attempts = row.attempts + 1;
    const terminal = attempts >= MAILBOX_OUTBOX_MAX_ATTEMPTS;
    const message = error instanceof Error ? error.message : String(error);
    const nextAttemptAt = terminal
      ? null
      : Date.now() + Math.min(60_000 * 2 ** Math.max(attempts - 1, 0), 30 * 60_000);
    await this.sql.run("markMailboxQueuedActionFailed_1", [
      terminal ? "failed" : "queued",
      attempts,
      nextAttemptAt,
      message,
      Date.now(),
      row.id,
    ]);
    if (row.draft_id) {
      await this.sql.run("markMailboxQueuedActionFailed_2", [message, Date.now(), row.draft_id]);
      await this.sql.run("markMailboxQueuedActionFailed_3", [message, Date.now(), row.draft_id]);
    }
  }

  private async markMailboxSendOutcomeUnknown(actionId: string, draftId: string): Promise<void> {
    await this.sql.unit("mailbox_markSendOutcomeUnknown", [
      actionId,
      draftId,
      MAILBOX_SEND_OUTCOME_UNKNOWN_MESSAGE,
      Date.now(),
    ]);
  }

  private async recoverInterruptedMailboxSends(): Promise<void> {
    await this.sql.unit("mailbox_recoverInterruptedSends", [
      MAILBOX_SEND_OUTCOME_UNKNOWN_MESSAGE,
      Date.now(),
    ]);
  }

  private async executeQueuedDraftSend(action: MailboxQueuedAction): Promise<void> {
    if (!action.draftId) throw new Error("Queued send is missing draft id.");
    const draft = await this.getMailboxComposeDraft(action.draftId);
    if (!draft) throw new Error("Mailbox compose draft not found");
    const outgoingId = asString(action.payload.outgoingId);
    const now = Date.now();
    await this.sql.run("executeQueuedDraftSend_1", [now, draft.id]);
    if (outgoingId) {
      await this.sql.run("executeQueuedDraftSend_2", [now, outgoingId]);
    }

    const result = await this.sendComposeDraftThroughProvider(draft);
    try {
      await this.sql.run("executeQueuedDraftSend_3", [
        result.providerDraftId || null,
        Date.now(),
        draft.id,
      ]);
      if (outgoingId) {
        await this.sql.run("executeQueuedDraftSend_4", [
          result.providerMessageId || null,
          Date.now(),
          outgoingId,
        ]);
      }
      await this.applyPostSendLocalState(draft, result.providerMessageId);
      await this.sql.run("processMailboxQueuedAction_2", [Date.now(), action.id]);
    } catch {
      throw new MailboxSendOutcomeUnknownError();
    }
  }

  private async executeQueuedThreadAction(action: MailboxQueuedAction): Promise<void> {
    const thread = await this.getThread(action.threadId!);
    if (!thread) throw new Error("Mailbox thread not found");
    switch (action.type) {
      case "move":
        await this.applyMove(thread, asString(action.payload.folderId) || "");
        break;
      case "remove_label":
        await this.applyRemoveLabel(
          thread,
          asString(action.payload.labelId) || asString(action.payload.label) || "",
        );
        break;
      case "snooze":
      case "waiting_on":
        break;
      default:
        throw new Error(`Unsupported queued mailbox action: ${action.type}`);
    }
    await this.sql.run("processMailboxQueuedAction_2", [Date.now(), action.id]);
  }

  private async sendComposeDraftThroughProvider(
    draft: MailboxComposeDraft,
  ): Promise<{ providerMessageId?: string; providerDraftId?: string }> {
    const account = await this.getMailboxAccount(draft.accountId);
    if (!account) throw new Error("Mailbox account not found");
    const providerThreadId = draft.threadId
      ? await this.getProviderThreadId(draft.threadId)
      : undefined;
    const attachments = await this.readComposeDraftAttachments(draft);
    if (account.provider === "gmail") {
      const raw = this.buildRawMimeMessage(draft, attachments);
      let providerDraftId = draft.providerDraftId;
      if (!providerDraftId) {
        const draftResult = await gmailRequest(GoogleWorkspaceSettingsManager.loadSettings(), {
          method: "POST",
          path: "/users/me/drafts",
          body: {
            message: {
              raw,
              threadId: draft.mode === "forward" ? undefined : providerThreadId,
            },
          },
        });
        providerDraftId = asString(draftResult.data?.id) || undefined;
        if (!providerDraftId) throw new Error("Gmail did not return a draft id.");
        await this.sql.run("persistMailboxProviderDraftId_1", [
          providerDraftId,
          Date.now(),
          draft.id,
        ]);
      }
      let sendResult: Awaited<ReturnType<typeof gmailRequest>>;
      try {
        sendResult = await gmailRequest(GoogleWorkspaceSettingsManager.loadSettings(), {
          method: "POST",
          path: "/users/me/drafts/send",
          body: { id: providerDraftId },
        });
      } catch {
        throw new MailboxSendOutcomeUnknownError();
      }
      return {
        providerDraftId,
        providerMessageId: asString(sendResult.data?.id) || undefined,
      };
    }
    if (account.provider === "outlook_graph" || account.backend === "microsoft_graph") {
      const channelId = await this.resolveMicrosoftGraphChannelId();
      let graphDraftId = draft.providerDraftId;
      if (!graphDraftId) {
        const graphDraft = await this.microsoftGraphCreateDraft(draft, attachments);
        graphDraftId = asString(graphDraft?.id) || undefined;
        if (!graphDraftId) throw new Error("Microsoft Graph did not return a draft id.");
        await this.sql.run("persistMailboxProviderDraftId_1", [graphDraftId, Date.now(), draft.id]);
      }
      try {
        await this.microsoftGraphRequest(channelId, {
          method: "POST",
          path: `/me/messages/${encodeURIComponent(graphDraftId)}/send`,
          scopes: MICROSOFT_GRAPH_SEND_SCOPES,
        });
      } catch {
        throw new MailboxSendOutcomeUnknownError();
      }
      return { providerDraftId: graphDraftId, providerMessageId: graphDraftId };
    }
    if (account.provider === "agentmail") {
      try {
        return await this.sendAgentMailDraft(draft);
      } catch {
        throw new MailboxSendOutcomeUnknownError();
      }
    }
    const channel = await this.channelRepo.findByType("email");
    if (!channel) throw new Error("Email channel is not configured");
    const client = this.createStandardEmailClient(channel.id, (channel.config as Any) || {});
    let providerMessageId: string | undefined;
    try {
      providerMessageId = await client.sendEmail({
        to: draft.to.map((recipient) => recipient.email),
        cc: draft.cc.map((recipient) => recipient.email),
        bcc: draft.bcc.map((recipient) => recipient.email),
        subject: draft.subject,
        text: draft.bodyText,
        html: draft.bodyHtml,
        attachments,
      });
    } catch {
      throw new MailboxSendOutcomeUnknownError();
    }
    return { providerMessageId };
  }

  private async microsoftGraphCreateDraft(
    draft: MailboxComposeDraft,
    attachments: EmailAttachment[],
  ): Promise<Any> {
    const toRecipients = draft.to.map((recipient) => this.toGraphRecipient(recipient));
    const ccRecipients = draft.cc.map((recipient) => this.toGraphRecipient(recipient));
    const bccRecipients = draft.bcc.map((recipient) => this.toGraphRecipient(recipient));
    return this.microsoftGraphRequest(await this.resolveMicrosoftGraphChannelId(), {
      method: "POST",
      path: "/me/messages",
      scopes: MICROSOFT_GRAPH_SEND_SCOPES,
      body: {
        subject: draft.subject,
        body: {
          contentType: draft.bodyHtml ? "HTML" : "Text",
          content: draft.bodyHtml || draft.bodyText,
        },
        toRecipients,
        ccRecipients,
        bccRecipients,
        attachments: attachments.map((attachment) => ({
          "@odata.type": "#microsoft.graph.fileAttachment",
          name: attachment.filename,
          contentType: attachment.contentType || "application/octet-stream",
          contentBytes: (attachment.content || Buffer.alloc(0)).toString("base64"),
        })),
      },
    });
  }

  private toGraphRecipient(recipient: MailboxRecipientInput): Record<string, unknown> {
    return {
      emailAddress: {
        address: recipient.email,
        name: recipient.name || recipient.email,
      },
    };
  }

  private async sendAgentMailDraft(
    draft: MailboxComposeDraft,
  ): Promise<{ providerMessageId?: string }> {
    if (!draft.threadId || draft.mode === "new" || draft.mode === "forward") {
      throw new Error("AgentMail supports reply-all from an existing thread only.");
    }
    const thread = await this.getThread(draft.threadId);
    const account = this.parseAgentMailAccountId(draft.accountId);
    const latestInbound = thread?.messages
      .filter((message) => message.direction === "incoming")
      .sort((a, b) => b.receivedAt - a.receivedAt)[0];
    if (!account || !latestInbound) {
      throw new Error("Unable to resolve AgentMail reply target.");
    }
    const result = await this.getAgentMailClient().replyAllMessage(
      account.inboxId,
      latestInbound.providerMessageId,
      {
        text: draft.bodyText,
        html: draft.bodyHtml,
        subject: draft.subject,
      },
    );
    return { providerMessageId: asString(result?.id) || latestInbound.providerMessageId };
  }

  private async normalizeComposeAttachmentInput(
    input: MailboxDraftAttachmentInput,
    workspaceId?: string,
  ): Promise<MailboxComposeDraft["attachments"][number]> {
    const rawPath = asString(input.path);
    if (!rawPath || !path.isAbsolute(rawPath)) {
      throw new Error("Mailbox draft attachments must use an absolute local file path.");
    }
    const realPath = fs.realpathSync(rawPath);
    const stat = fs.statSync(realPath);
    if (!stat.isFile()) {
      throw new Error("Mailbox draft attachment must be a file.");
    }
    await this.assertMailboxAttachmentPathAllowed(realPath, workspaceId);
    if (stat.size > MAILBOX_COMPOSE_ATTACHMENT_MAX_BYTES) {
      throw new Error(
        `Mailbox draft attachment exceeds ${MAILBOX_COMPOSE_ATTACHMENT_MAX_BYTES} bytes.`,
      );
    }
    const filename = asString(input.filename) || path.basename(realPath);
    return {
      id: randomUUID(),
      filename,
      mimeType: asString(input.mimeType) || guessMimeType(filename),
      size: stat.size,
      localPath: realPath,
      uploadStatus: "local",
    };
  }

  private async resolveComposeDraftWorkspaceId(
    draft: MailboxComposeDraft,
  ): Promise<string | undefined> {
    if (draft.workspaceId) return draft.workspaceId;
    if (draft.threadId) {
      const row = (await this.sql.get("reclassifyThread_1", [draft.threadId])) as
        | { account_id: string }
        | undefined;
      const workspaceId = row ? await this.resolveThreadWorkspaceId(row.account_id) : undefined;
      if (workspaceId) return workspaceId;
    }
    const accountWorkspaceId = await this.resolveThreadWorkspaceId(draft.accountId);
    return accountWorkspaceId || (await this.resolveDefaultWorkspaceId());
  }

  private async resolveComposeDraftWorkspaceIdForCreate(
    accountId: string,
    threadId?: string,
  ): Promise<string | undefined> {
    if (threadId) {
      const row = (await this.sql.get("reclassifyThread_1", [threadId])) as
        | { account_id: string }
        | undefined;
      const workspaceId = row ? await this.resolveThreadWorkspaceId(row.account_id) : undefined;
      if (workspaceId) return workspaceId;
    }
    return (
      (await this.resolveThreadWorkspaceId(accountId)) || (await this.resolveDefaultWorkspaceId())
    );
  }

  private async assertMailboxAttachmentPathAllowed(
    realPath: string,
    workspaceId?: string,
  ): Promise<void> {
    const workspace = workspaceId ? await this.workspaceRepo.findById(workspaceId) : undefined;
    if (!workspace) {
      throw new Error("Mailbox draft attachment workspace could not be resolved.");
    }
    const access = evaluateWorkspaceFilesystemAccess(workspace, realPath, "read");
    if (access.decision !== "allow") {
      const reason =
        access.reason === "outside_workspace"
          ? "outside the draft workspace"
          : access.reason === "profile_filesystem_outside"
            ? "outside the active access profile"
            : access.reason;
      throw new Error(`Mailbox draft attachment access denied: ${reason} (${access.reason})`);
    }
  }

  private async readComposeDraftAttachments(
    draft: MailboxComposeDraft,
  ): Promise<EmailAttachment[]> {
    const workspaceId = await this.resolveComposeDraftWorkspaceId(draft);
    const attachments: EmailAttachment[] = [];
    for (const attachment of draft.attachments) {
      if (!attachment.localPath) continue;
      const realPath = fs.realpathSync(attachment.localPath);
      // The access check reads the workspace through the async storage facade; it must
      // settle before the file is read.
      await this.assertMailboxAttachmentPathAllowed(realPath, workspaceId);
      const stat = fs.statSync(realPath);
      if (!stat.isFile()) throw new Error(`Draft attachment is not a file: ${attachment.filename}`);
      if (stat.size > MAILBOX_COMPOSE_ATTACHMENT_MAX_BYTES) {
        throw new Error(`Draft attachment is too large: ${attachment.filename}`);
      }
      attachments.push({
        filename: attachment.filename,
        contentType: attachment.mimeType || guessMimeType(attachment.filename),
        size: stat.size,
        content: fs.readFileSync(realPath),
      });
    }
    return attachments;
  }

  private buildRawMimeMessage(draft: MailboxComposeDraft, attachments: EmailAttachment[]): string {
    const strip = (value: string) => value.replace(/[\r\n]/g, "");
    const boundary = `cowork-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const headers = [
      draft.to.length
        ? `To: ${draft.to.map((recipient) => strip(recipient.email)).join(", ")}`
        : null,
      draft.cc.length
        ? `Cc: ${draft.cc.map((recipient) => strip(recipient.email)).join(", ")}`
        : null,
      draft.bcc.length
        ? `Bcc: ${draft.bcc.map((recipient) => strip(recipient.email)).join(", ")}`
        : null,
      `Subject: ${strip(draft.subject)}`,
      "MIME-Version: 1.0",
      attachments.length
        ? `Content-Type: multipart/mixed; boundary="${boundary}"`
        : 'Content-Type: text/plain; charset="UTF-8"',
    ].filter((entry): entry is string => Boolean(entry));
    const body = attachments.length
      ? [
          `--${boundary}`,
          'Content-Type: text/plain; charset="UTF-8"',
          "Content-Transfer-Encoding: 7bit",
          "",
          draft.bodyText,
          ...attachments.flatMap((attachment) => [
            `--${boundary}`,
            `Content-Type: ${strip(attachment.contentType || "application/octet-stream")}; name="${strip(attachment.filename)}"`,
            "Content-Transfer-Encoding: base64",
            `Content-Disposition: attachment; filename="${strip(attachment.filename)}"`,
            "",
            (attachment.content || Buffer.alloc(0))
              .toString("base64")
              .replace(/(.{76})/g, "$1\r\n"),
          ]),
          `--${boundary}--`,
          "",
        ].join("\r\n")
      : draft.bodyText;
    return Buffer.from([...headers, "", body].join("\r\n"))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

  private async getMailboxAccount(accountId: string): Promise<MailboxAccount | null> {
    const row = (await this.sql.get("getMailboxAccount_1", [accountId])) as
      | MailboxAccountRow
      | undefined;
    return row ? this.mapAccountRow(row) : null;
  }

  private async requireMailboxAccount(accountId: string): Promise<void> {
    if (
      typeof accountId !== "string" ||
      !accountId.trim() ||
      accountId !== accountId.trim() ||
      accountId.length > 512
    )
      throw new Error("A valid mailbox account is required for scoped reads");
    if (!(await this.getMailboxAccount(accountId)))
      throw new Error("The selected mailbox account is unavailable");
  }

  private async getProviderThreadId(threadId: string): Promise<string | undefined> {
    const row = (await this.sql.get("getProviderThreadId_1", [threadId])) as
      | { provider_thread_id: string }
      | undefined;
    return row?.provider_thread_id;
  }

  private async refreshGmailNavigation(accountId: string): Promise<void> {
    const result = await gmailRequest(GoogleWorkspaceSettingsManager.loadSettings(), {
      method: "GET",
      path: "/users/me/labels",
    });
    const labels = Array.isArray(result.data?.labels) ? result.data.labels : [];
    const now = Date.now();
    for (const label of labels) {
      const providerLabelId = asString(label?.id);
      const name = asString(label?.name);
      if (!providerLabelId || !name) continue;
      const role = this.gmailLabelRole(providerLabelId, name);
      if (role) {
        await this.upsertMailboxFolder({
          accountId,
          providerFolderId: providerLabelId,
          name,
          role,
          unreadCount: asNumber(label?.messagesUnread) ?? undefined,
          totalCount: asNumber(label?.messagesTotal) ?? undefined,
          now,
        });
      } else {
        await this.upsertMailboxLabel({
          accountId,
          providerLabelId,
          name,
          unreadCount: asNumber(label?.messagesUnread) ?? undefined,
          totalCount: asNumber(label?.messagesTotal) ?? undefined,
          now,
        });
      }
    }
  }

  private async refreshMicrosoftGraphNavigation(
    channelId: string,
    accountId: string,
  ): Promise<void> {
    const result = await this.microsoftGraphRequest(channelId, {
      method: "GET",
      path: "/me/mailFolders",
      scopes: MICROSOFT_GRAPH_READWRITE_SCOPES,
      query: { $top: 100 },
    });
    const folders = Array.isArray(result?.value) ? result.value : [];
    const now = Date.now();
    for (const folder of folders) {
      const providerFolderId = asString(folder?.id);
      const name = asString(folder?.displayName);
      if (!providerFolderId || !name) continue;
      await this.upsertMailboxFolder({
        accountId,
        providerFolderId,
        name,
        role: this.microsoftFolderRole(name),
        unreadCount: asNumber(folder?.unreadItemCount) ?? undefined,
        totalCount: asNumber(folder?.totalItemCount) ?? undefined,
        now,
      });
    }
  }

  private async upsertMailboxFolder(input: {
    accountId: string;
    providerFolderId: string;
    name: string;
    role: MailboxFolder["role"];
    unreadCount?: number;
    totalCount?: number;
    now: number;
  }): Promise<void> {
    const id = `${input.accountId}:folder:${input.providerFolderId}`;
    await this.sql.run("upsertMailboxFolder_1", [
      id,
      input.accountId,
      input.providerFolderId,
      input.name,
      input.role,
      input.unreadCount ?? null,
      input.totalCount ?? null,
      input.now,
      input.now,
    ]);
  }

  private async upsertMailboxLabel(input: {
    accountId: string;
    providerLabelId: string;
    name: string;
    unreadCount?: number;
    totalCount?: number;
    now: number;
  }): Promise<void> {
    const id = `${input.accountId}:label:${input.providerLabelId}`;
    await this.sql.run("upsertMailboxLabel_1", [
      id,
      input.accountId,
      input.providerLabelId,
      input.name,
      input.unreadCount ?? null,
      input.totalCount ?? null,
      input.now,
      input.now,
    ]);
  }

  private gmailLabelRole(id: string, name: string): MailboxFolder["role"] | null {
    const normalized = `${id} ${name}`.toLowerCase();
    if (normalized.includes("inbox")) return "inbox";
    if (normalized.includes("sent")) return "sent";
    if (normalized.includes("draft")) return "drafts";
    if (normalized.includes("trash")) return "trash";
    if (normalized.includes("spam")) return "spam";
    if (normalized.includes("all_mail") || normalized.includes("all mail")) return "archive";
    return null;
  }

  private microsoftFolderRole(name: string): MailboxFolder["role"] {
    const normalized = name.toLowerCase();
    if (normalized.includes("inbox")) return "inbox";
    if (normalized.includes("sent")) return "sent";
    if (normalized.includes("draft")) return "drafts";
    if (normalized.includes("archive")) return "archive";
    if (normalized.includes("deleted") || normalized.includes("trash")) return "trash";
    if (normalized.includes("junk") || normalized.includes("spam")) return "spam";
    return "custom";
  }

  private async resolveMicrosoftGraphChannelId(): Promise<string> {
    const channel = await this.channelRepo.findByType("email");
    if (!channel || !this.isMicrosoftEmailOAuthConfig((channel.config as Any) || {})) {
      throw new Error(
        "Microsoft Graph mailbox requires an Outlook email channel connected with OAuth.",
      );
    }
    return channel.id;
  }

  private async applyPostSendLocalState(
    draft: MailboxComposeDraft,
    providerMessageId?: string,
  ): Promise<void> {
    const now = Date.now();
    if (draft.threadId) {
      await this.sql.run("applyPostSendLocalState_1", [
        randomUUID(),
        draft.threadId,
        providerMessageId || `local-outgoing-${now}`,
        (await this.getMailboxAccount(draft.accountId))?.address || "",
        JSON.stringify(draft.to),
        JSON.stringify(draft.cc),
        JSON.stringify(draft.bcc),
        draft.subject,
        normalizeWhitespace(draft.bodyText, 180),
        encryptMailboxValue(draft.bodyText),
        now,
        JSON.stringify({ source: "mailbox_outbox", draftId: draft.id }),
        now,
        now,
      ]);
      await this.sql.run("applyPostSendLocalState_2", [
        now,
        now,
        draft.mode === "forward" ? 1 : 0,
        draft.mode === "forward" ? 1 : 0,
        draft.mode === "forward" ? 1 : 0,
        draft.threadId,
      ]);
      if (draft.mode !== "forward") {
        await this.updateProposalStatusByThreadAndType(draft.threadId, "reply", "applied");
      }
    }
  }

  private async resolveComposeAccountId(accountId?: string, threadId?: string): Promise<string> {
    if (accountId) return accountId;
    if (threadId) {
      const row = (await this.sql.get("reclassifyThread_1", [threadId])) as
        | { account_id: string }
        | undefined;
      if (row?.account_id) return row.account_id;
    }
    const firstAccount = (await this.sql.get("resolveComposeAccountId_1", [])) as
      | { id: string }
      | undefined;
    if (!firstAccount?.id) throw new Error("Connect a mailbox account before composing.");
    return firstAccount.id;
  }

  private buildReplyRecipients(
    thread: MailboxThreadDetail | null,
    replyAll: boolean,
  ): MailboxRecipientInput[] {
    if (!thread) return [];
    const latestIncoming = [...thread.messages]
      .reverse()
      .find((message) => message.direction === "incoming");
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
    return trimmed.toLowerCase().startsWith(prefix.toLowerCase())
      ? trimmed
      : `${prefix} ${trimmed}`;
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
    const metadata = parseJsonObject(row.metadata_json);
    const workspaceId = asString(metadata.workspaceId) || undefined;
    return {
      id: row.id,
      accountId: row.account_id,
      workspaceId,
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

  private async threadMatchesQuery(row: MailboxThreadRow, query: string): Promise<boolean> {
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
    const attachmentRows = (await this.sql.all("threadMatchesQuery_1", [row.id])) as Array<{
      filename: string;
      text_content: string | null;
    }>;
    if (
      attachmentRows.some((attachment) =>
        `${attachment.filename} ${decryptMailboxValue(attachment.text_content || "")}`
          .toLowerCase()
          .includes(needle),
      )
    ) {
      return true;
    }

    return (await this.getMessagesForThread(row.id)).some((message) => {
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

  private async threadMatchesAttachmentQuery(threadId: string, query: string): Promise<boolean> {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;

    const attachmentRows = (await this.sql.all("threadMatchesQuery_1", [threadId])) as Array<{
      filename: string;
      text_content: string | null;
    }>;
    return attachmentRows.some((attachment) =>
      `${attachment.filename} ${decryptMailboxValue(attachment.text_content || "")}`
        .toLowerCase()
        .includes(needle),
    );
  }

  /** Map rows with their summaries, in order (DB6: each lookup awaits the port). */
  private async mapThreadRowsWithSummaries(
    rows: MailboxThreadRow[],
  ): Promise<MailboxThreadListItem[]> {
    const items: MailboxThreadListItem[] = [];
    for (const row of rows) {
      items.push(
        await this.mapThreadRow(row, (await this.getSummaryForThread(row.id)) ?? undefined),
      );
    }
    return items;
  }

  private async mapThreadRow(
    row: MailboxThreadRow,
    summary?: MailboxSummaryCard | null,
  ): Promise<MailboxThreadListItem> {
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
      attachments: await this.getAttachmentSummariesForThread(row.id),
      classificationState: row.classification_state,
    };
  }

  private async getAttachmentSummariesForThread(
    threadId: string,
    limit = 6,
  ): Promise<MailboxAttachmentSummary[]> {
    const rows = (await this.sql.all("getAttachmentSummariesForThread_1", [
      threadId,
      Math.min(Math.max(limit, 1), 20),
    ])) as Array<{
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
      preview: row.preview_json
        ? (JSON.parse(row.preview_json) as Record<string, unknown>)
        : undefined,
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

  private async ensureFollowUpTaskForCommitment(
    row: MailboxCommitmentRow,
    metadata: MailboxCommitmentMetadata,
  ): Promise<Task | null> {
    if (metadata.followUpTaskId) {
      const existing = await this.taskRepo.findById(metadata.followUpTaskId);
      if (existing) return existing;
    }

    const thread = (await this.sql.get("ensureFollowUpTaskForCommitment_1", [row.thread_id])) as
      | { id: string; subject: string; participants_json: string | null }
      | undefined;
    const workspaceId = await this.resolveFollowUpWorkspaceId();
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
      row.source_excerpt
        ? `Source excerpt: ${decryptMailboxValue(row.source_excerpt) || ""}`
        : null,
      "Track this as a real follow-up item and close it when the commitment is complete.",
    ].filter((part): part is string => Boolean(part));

    const task = await this.taskRepo.create({
      title,
      prompt: promptParts.join("\n"),
      rawPrompt: promptParts.join("\n"),
      userPrompt: promptParts.join("\n"),
      status: "pending",
      workspaceId,
      source: "manual",
      agentConfig: taskAgentConfigForCreation(undefined, PermissionSettingsManager.loadSettings()),
    });

    await this.sql.run("ensureFollowUpTaskForCommitment_2", [
      JSON.stringify({
        ...metadata,
        followUpTaskId: task.id,
        followUpTaskCreatedAt: Date.now(),
        followUpTaskWorkspaceId: workspaceId,
      }),
      Date.now(),
      row.id,
    ]);

    return task;
  }

  private async recordMailboxTriageFeedback(
    threadId: string,
    feedbackKind: string,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    const workspaceId = await this.resolveDefaultWorkspaceId();
    if (!workspaceId) return;
    const id = randomUUID();
    const now = Date.now();
    try {
      await this.sql.run("recordMailboxTriageFeedback_1", [
        id,
        workspaceId,
        threadId,
        feedbackKind,
        payload ? JSON.stringify(payload) : null,
        now,
      ]);
      await this.pruneMailboxTriageFeedback(workspaceId);
    } catch {
      // Best-effort
    }
  }

  async listMailboxSnippets(): Promise<MailboxSnippetRecord[]> {
    const workspaceId = await this.resolveDefaultWorkspaceId();
    if (!workspaceId) return [];
    const rows = (await this.sql.all("listMailboxSnippets_1", [workspaceId])) as Array<{
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

  async upsertMailboxSnippet(
    input: MailboxSnippetInput & { id?: string },
  ): Promise<MailboxSnippetRecord> {
    const workspaceId = await this.resolveDefaultWorkspaceId();
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
    const existing = (await this.sql.get("upsertMailboxSnippet_1", [id, workspaceId])) as
      | { id: string }
      | undefined;
    try {
      if (existing) {
        await this.sql.run("upsertMailboxSnippet_2", [
          shortcut,
          body,
          input.subjectHint?.trim() || null,
          now,
          id,
          workspaceId,
        ]);
      } else {
        await this.sql.run("upsertMailboxSnippet_3", [
          id,
          workspaceId,
          shortcut,
          body,
          input.subjectHint?.trim() || null,
          now,
          now,
        ]);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("UNIQUE constraint failed: mailbox_snippets")) {
        throw new Error(
          `A snippet with the shortcut "${shortcut}" already exists in this workspace.`,
        );
      }
      throw err;
    }
    const row = (await this.sql.get("upsertMailboxSnippet_4", [id, workspaceId])) as {
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

  async deleteMailboxSnippet(id: string): Promise<boolean> {
    const workspaceId = await this.resolveDefaultWorkspaceId();
    if (!workspaceId) return false;
    const result = await this.sql.run("deleteMailboxSnippet_1", [id, workspaceId]);
    return result.changes > 0;
  }

  async listMailboxSavedViews(): Promise<MailboxSavedViewRecord[]> {
    const workspaceId = await this.resolveDefaultWorkspaceId();
    if (!workspaceId) return [];
    const rows = (await this.sql.all("listMailboxSavedViews_1", [workspaceId])) as Array<{
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
      (await this.sql.get("reclassifyThread_1", [input.seedThreadId])) as
        | { account_id: string }
        | undefined
    )?.account_id;
    const workspaceId =
      (await this.resolveThreadWorkspaceId(seedAccountId || "")) ||
      (await this.resolveDefaultWorkspaceId());
    if (!workspaceId) {
      return { threadIds: [] };
    }
    const seed = await this.getThreadCore(input.seedThreadId);
    if (!seed) {
      return { threadIds: [] };
    }
    const summary = await this.getSummaryForThread(input.seedThreadId);
    const seedSummaryText = stripMailboxSummaryHtmlArtifacts(summary?.summary || seed.snippet);
    const seedTokens = new Set(
      [input.name, input.instructions, seed.subject, seed.snippet, seedSummaryText]
        .join(" ")
        .toLowerCase()
        .split(/[^a-z0-9]+/i)
        .map((token) => token.trim())
        .filter((token) => token.length >= 3)
        .slice(0, 120),
    );
    const candidateRows = (await this.sql.all("previewMailboxLabelSimilar_1", [
      seed.accountId,
      input.seedThreadId,
    ])) as Array<{
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
    const validIds = await this.filterValidMailboxThreadIds(result.threadIds, seed.accountId);
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
    const workspaceId = await this.resolveDefaultWorkspaceId();
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
          (await this.sql.get("reclassifyThread_1", [input.seedThreadId.trim()])) as
            | { account_id: string }
            | undefined
        )?.account_id
      : undefined;
    const rawIds = [...input.threadIds];
    if (input.seedThreadId?.trim()) {
      rawIds.push(input.seedThreadId.trim());
    }
    const validThreadIds = await this.filterValidMailboxThreadIds(rawIds, seedAccountId);
    if (validThreadIds.length === 0) {
      throw new Error("Saved views need at least one valid thread. Preview again before saving.");
    }
    const id = randomUUID();
    const now = Date.now();
    const showIn = input.showInInbox !== false ? 1 : 0;
    await this.sql.run("createMailboxSavedView_1", [
      id,
      workspaceId,
      name,
      instructions,
      input.seedThreadId?.trim() || null,
      showIn,
      now,
      now,
    ]);
    for (const threadId of validThreadIds) {
      await this.sql.run("addSavedViewThread", [id, threadId, 1]);
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

  async deleteMailboxSavedView(viewId: string): Promise<boolean> {
    const workspaceId = await this.resolveDefaultWorkspaceId();
    if (!workspaceId) return false;
    const result = await this.sql.run("deleteMailboxSavedView_1", [viewId, workspaceId]);
    return result.changes > 0;
  }

  async getMailboxQuickReplySuggestions(
    threadId: string,
  ): Promise<MailboxQuickReplySuggestionsResult> {
    const detail = await this.getThreadCore(threadId);
    if (!detail) return { suggestions: [] };
    if (getMailboxNoReplySender(detail.messages, detail.participants)) {
      return { suggestions: [] };
    }
    const workspaceId =
      (await this.resolveThreadWorkspaceId(detail.accountId)) ||
      (await this.resolveDefaultWorkspaceId());
    if (!workspaceId) return { suggestions: [] };
    const summary = await this.getSummaryForThread(threadId);
    const summaryText = stripMailboxSummaryHtmlArtifacts(summary?.summary || detail.snippet);
    const latest =
      detail.messages.filter((m) => m.direction === "incoming").slice(-1)[0] ||
      detail.messages[detail.messages.length - 1];
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
    const workspaceId = await this.resolveDefaultWorkspaceId();
    if (!workspaceId) {
      throw new Error("No workspace for mailbox automation");
    }
    const row = (await this.sql.get("createReviewScheduleForSavedView_1", [
      viewId,
      workspaceId,
    ])) as { id: string; name: string; instructions: string } | undefined;
    if (!row) {
      throw new Error("Saved view not found");
    }
    try {
      return await MailboxAutomationRegistry.createSchedule({
        workspaceId,
        name: `Inbox view review: ${row.name}`,
        description: row.instructions,
        kind: "reminder",
        schedule: {
          kind: "cron",
          expr: "0 9 * * 1",
          tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
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

  private async resolveFollowUpWorkspaceId(): Promise<string | null> {
    const workspaces = await this.workspaceRepo.findAll();
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

// Each call is one mailbox operation for the statement burst gate (DB6).
bindStatementContext(MailboxService.prototype, "MailboxService");
