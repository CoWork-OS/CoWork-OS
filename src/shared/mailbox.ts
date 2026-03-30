export type MailboxProvider = "gmail" | "imap";

export type MailboxThreadSortOrder = "priority" | "recent";
export type MailboxThreadMailboxView = "inbox" | "sent" | "all";

export type MailboxThreadCategory =
  | "priority"
  | "calendar"
  | "follow_up"
  | "promotions"
  | "updates"
  | "personal"
  | "other";

export type MailboxClassificationState = "pending" | "backfill_pending" | "classified" | "error";

export type MailboxPriorityBand = "critical" | "high" | "medium" | "low";

export type MailboxProposalType =
  | "reply"
  | "archive"
  | "trash"
  | "mark_read"
  | "label"
  | "schedule"
  | "follow_up"
  | "cleanup";

export type MailboxProposalStatus = "suggested" | "approved" | "applied" | "dismissed";

export type MailboxCommitmentState = "suggested" | "accepted" | "done" | "dismissed";

export type MailboxAutomationKind = "rule" | "schedule" | "reminder";

export type MailboxAutomationStatus = "active" | "paused" | "error" | "deleted";

export type MailboxConditionOperator =
  | "equals"
  | "not_equals"
  | "contains"
  | "not_contains"
  | "matches"
  | "starts_with"
  | "ends_with"
  | "gt"
  | "lt";

export type MailboxDirection = "incoming" | "outgoing";

export type ContactIdentityHandleType =
  | "email"
  | "slack_user_id"
  | "teams_user_id"
  | "whatsapp_e164"
  | "signal_e164"
  | "imessage_handle"
  | "crm_contact_id";

export type ContactIdentitySuggestionStatus =
  | "suggested"
  | "confirmed"
  | "rejected"
  | "auto_linked";

export type RelationshipTimelineSource =
  | "email"
  | "slack"
  | "teams"
  | "whatsapp"
  | "signal"
  | "imessage"
  | "crm"
  | "commitment"
  | "automation"
  | "handoff";

export type MailboxEventType =
  | "sync_completed"
  | "thread_classified"
  | "thread_summarized"
  | "draft_created"
  | "commitments_extracted"
  | "commitment_updated"
  | "action_applied"
  | "contact_researched"
  | "mission_control_handoff_created";

export interface MailboxParticipant {
  name?: string;
  email: string;
}

export interface MailboxAccount {
  id: string;
  provider: MailboxProvider;
  address: string;
  displayName?: string;
  status: "connected" | "degraded" | "disconnected";
  capabilities: string[];
  lastSyncedAt?: number;
  classificationInitialBatchAt?: number;
}

export interface MailboxSyncStatus {
  connected: boolean;
  primaryProvider?: MailboxProvider;
  accounts: MailboxAccount[];
  lastSyncedAt?: number;
  syncInFlight: boolean;
  syncProgress?: MailboxSyncProgress | null;
  threadCount: number;
  unreadCount: number;
  needsReplyCount: number;
  proposalCount: number;
  commitmentCount: number;
  classificationPendingCount: number;
  statusLabel: string;
}

export interface MailboxSyncProgress {
  phase: "fetching" | "ingesting" | "classifying" | "done" | "error";
  accountId?: string;
  totalThreads: number;
  processedThreads: number;
  totalMessages: number;
  processedMessages: number;
  newThreads: number;
  classifiedThreads: number;
  skippedThreads: number;
  label: string;
  updatedAt: number;
}

export interface MailboxSummaryCard {
  summary: string;
  keyAsks: string[];
  extractedQuestions: string[];
  suggestedNextAction: string;
  updatedAt: number;
}

export interface MailboxDraftSuggestion {
  id: string;
  threadId: string;
  subject: string;
  body: string;
  tone: string;
  rationale: string;
  scheduleNotes?: string;
  createdAt: number;
  updatedAt: number;
}

export interface MailboxActionProposal {
  id: string;
  threadId: string;
  type: MailboxProposalType;
  title: string;
  reasoning: string;
  preview?: Record<string, unknown>;
  status: MailboxProposalStatus;
  createdAt: number;
  updatedAt: number;
}

export interface MailboxCommitment {
  id: string;
  threadId: string;
  messageId?: string;
  title: string;
  dueAt?: number;
  state: MailboxCommitmentState;
  ownerEmail?: string;
  sourceExcerpt?: string;
  followUpTaskId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface MailboxContactMemory {
  id: string;
  accountId: string;
  email: string;
  name?: string;
  company?: string;
  role?: string;
  encryptionPreference?: "required" | "preferred" | "optional";
  policyFlags?: string[];
  crmLinks: string[];
  learnedFacts: string[];
  responseTendency?: string;
  lastInteractionAt?: number;
  openCommitments: number;
  totalThreads?: number;
  totalMessages?: number;
  averageResponseHours?: number;
  lastOutboundAt?: number;
  recentSubjects?: string[];
  styleSignals?: string[];
  recentOutboundExample?: string;
}

export interface ContactIdentityHandle {
  id: string;
  contactIdentityId: string;
  workspaceId: string;
  handleType: ContactIdentityHandleType;
  normalizedValue: string;
  displayValue: string;
  source: "mailbox" | "gateway" | "manual" | "crm" | "kg";
  channelId?: string;
  channelType?: string;
  channelUserId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ContactIdentity {
  id: string;
  workspaceId: string;
  displayName: string;
  primaryEmail?: string;
  companyHint?: string;
  kgEntityId?: string;
  confidence: number;
  createdAt: number;
  updatedAt: number;
  handles: ContactIdentityHandle[];
}

export interface ContactIdentityCandidate {
  id: string;
  workspaceId: string;
  contactIdentityId: string;
  handleType: ContactIdentityHandleType;
  normalizedValue: string;
  displayValue: string;
  source: "mailbox" | "gateway" | "manual" | "crm" | "kg";
  sourceLabel: string;
  channelId?: string;
  channelType?: string;
  channelUserId?: string;
  confidence: number;
  status: ContactIdentitySuggestionStatus;
  reasonCodes: string[];
  createdAt: number;
  updatedAt: number;
}

export interface ContactIdentityResolution {
  identity: ContactIdentity | null;
  confidence: number;
  reasonCodes: string[];
  candidates: ContactIdentityCandidate[];
}

export interface ContactIdentitySearchResult {
  id: string;
  workspaceId: string;
  handleType: ContactIdentityHandleType;
  normalizedValue: string;
  displayValue: string;
  source: "mailbox" | "gateway" | "manual" | "crm" | "kg";
  sourceLabel: string;
  channelId?: string;
  channelType?: string;
  channelUserId?: string;
  linkedIdentityId?: string;
  linkedIdentityName?: string;
  confidence: number;
  reasonCodes: string[];
}

export interface ContactIdentityReplyTarget {
  handleId: string;
  contactIdentityId: string;
  workspaceId: string;
  channelType: "slack" | "teams" | "whatsapp" | "signal" | "imessage";
  channelId: string;
  chatId: string;
  handleType: ContactIdentityHandleType;
  label: string;
  displayValue: string;
  lastMessageAt?: number;
}

export interface RelationshipTimelineEvent {
  id: string;
  contactIdentityId: string;
  source: RelationshipTimelineSource;
  sourceLabel: string;
  direction: "incoming" | "outgoing";
  timestamp: number;
  title: string;
  summary: string;
  rawRef: string;
  threadId?: string;
  chatId?: string;
  sensitive: boolean;
}

export interface RelationshipTimelineQuery {
  threadId?: string;
  contactIdentityId?: string;
  companyHint?: string;
  limit?: number;
  startAt?: number;
  endAt?: number;
}

export interface ChannelPreferenceSummary {
  preferredChannel?: "email" | "slack" | "teams" | "whatsapp" | "signal" | "imessage";
  recommendedReason?: string;
  responseLatencyHours: Partial<Record<"email" | "slack" | "teams" | "whatsapp" | "signal" | "imessage", number>>;
  messageCountByChannel: Partial<Record<"email" | "slack" | "teams" | "whatsapp" | "signal" | "imessage", number>>;
  lastInboundAtByChannel: Partial<Record<"email" | "slack" | "teams" | "whatsapp" | "signal" | "imessage", number>>;
  lastOutboundAtByChannel: Partial<Record<"email" | "slack" | "teams" | "whatsapp" | "signal" | "imessage", number>>;
}

export interface ContactIdentityCoverageStats {
  resolvedMailboxContacts: number;
  unresolvedSlackUsers: number;
  unresolvedTeamsUsers: number;
  unresolvedWhatsAppUsers: number;
  unresolvedSignalUsers: number;
  unresolvedImessageUsers: number;
  resolvedCrmContacts: number;
  suggestedLinks: number;
  confirmedLinks: number;
  rejectedLinks: number;
}

export interface MailboxMessage {
  id: string;
  threadId: string;
  providerMessageId: string;
  direction: MailboxDirection;
  from?: MailboxParticipant;
  to: MailboxParticipant[];
  cc: MailboxParticipant[];
  bcc: MailboxParticipant[];
  subject: string;
  snippet: string;
  body: string;
  bodyHtml?: string;
  receivedAt: number;
  unread: boolean;
}

export interface MailboxThreadListItem {
  id: string;
  accountId: string;
  provider: MailboxProvider;
  providerThreadId: string;
  subject: string;
  snippet: string;
  participants: MailboxParticipant[];
  labels: string[];
  category: MailboxThreadCategory;
  priorityBand: MailboxPriorityBand;
  priorityScore: number;
  urgencyScore: number;
  needsReply: boolean;
  staleFollowup: boolean;
  cleanupCandidate: boolean;
  handled: boolean;
  unreadCount: number;
  messageCount: number;
  lastMessageAt: number;
  hasSensitiveContent?: boolean;
  summary?: MailboxSummaryCard;
  classificationState?: MailboxClassificationState;
}

export interface MailboxResearchResult {
  primaryContact: MailboxParticipant | null;
  company?: string;
  domain?: string;
  crmHints: string[];
  learnedFacts: string[];
  recommendedQueries: string[];
  relationshipSummary?: string;
  styleSignals?: string[];
  recentSubjects?: string[];
  recentOutboundExample?: string;
  nextSteps?: string[];
  relatedEntities?: string[];
  contactIdentityId?: string;
  identityConfidence?: number;
  linkedChannels?: Array<{
    handleId: string;
    handleType: ContactIdentityHandleType;
    label: string;
    channelType?: string;
  }>;
  channelPreference?: ChannelPreferenceSummary;
  unifiedTimeline?: RelationshipTimelineEvent[];
  identityCandidates?: ContactIdentityCandidate[];
  replyTargets?: ContactIdentityReplyTarget[];
}

export interface MailboxThreadDetail extends MailboxThreadListItem {
  messages: MailboxMessage[];
  drafts: MailboxDraftSuggestion[];
  proposals: MailboxActionProposal[];
  commitments: MailboxCommitment[];
  contactMemory?: MailboxContactMemory | null;
  research?: MailboxResearchResult | null;
  sensitiveContent?: MailboxSensitiveContent;
}

export interface MailboxSensitiveContent {
  hasSensitiveContent: boolean;
  categories: Array<"credentials" | "financial" | "pii" | "legal" | "health" | "other">;
  reasons: string[];
}

export interface MailboxEvent {
  id: string;
  fingerprint: string;
  type: MailboxEventType;
  workspaceId: string;
  timestamp: number;
  accountId?: string;
  threadId?: string;
  provider?: MailboxProvider;
  subject?: string;
  summary?: string;
  evidenceRefs: string[];
  payload: Record<string, unknown>;
}

export interface MailboxRuleRecipe {
  name: string;
  description?: string;
  workspaceId?: string;
  threadId?: string;
  source?: "mailbox_event";
  conditions: Array<{
    field: string;
    operator: MailboxConditionOperator;
    value: string;
  }>;
  conditionLogic?: "all" | "any";
  actionType: "create_task" | "wake_agent";
  actionTitle?: string;
  actionPrompt: string;
  agentRoleId?: string;
  cooldownMs?: number;
  enabled?: boolean;
}

export interface MailboxScheduleRecipe {
  name: string;
  description?: string;
  workspaceId?: string;
  threadId?: string;
  kind?: MailboxAutomationKind;
  schedule: import("../electron/cron/types").CronSchedule;
  taskTitle: string;
  taskPrompt: string;
  enabled?: boolean;
}

export interface MailboxAutomationRecord {
  id: string;
  workspaceId: string;
  kind: MailboxAutomationKind;
  status: MailboxAutomationStatus;
  name: string;
  description?: string;
  threadId?: string;
  source: "mailbox_event" | "cron";
  rule?: MailboxRuleRecipe;
  schedule?: MailboxScheduleRecipe;
  backingTriggerId?: string;
  backingCronJobId?: string;
  latestOutcome?: string;
  latestRunAt?: number;
  latestFireAt?: number;
  nextRunAt?: number;
  latestError?: string;
  createdAt: number;
  updatedAt: number;
}

export interface MailboxCompanyCandidate {
  companyId: string;
  name: string;
  slug: string;
  confidence: number;
  reason: string;
  defaultWorkspaceId?: string;
}

export interface MailboxOperatorRecommendation {
  agentRoleId: string;
  displayName: string;
  companyId?: string;
  confidence: number;
  reason: string;
  roleKind?: "customer_ops" | "growth" | "planner" | "founder_office" | "other";
}

export interface MailboxMissionControlHandoffRecord {
  id: string;
  threadId: string;
  workspaceId: string;
  companyId: string;
  companyName: string;
  operatorRoleId: string;
  operatorDisplayName: string;
  issueId: string;
  issueTitle: string;
  issueStatus: "open" | "done" | "cancelled";
  source: "mailbox_handoff";
  latestOutcome?: string;
  latestWakeAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface MailboxMissionControlHandoffPreview {
  threadId: string;
  workspaceId?: string;
  issueTitle: string;
  issueSummary: string;
  companyCandidates: MailboxCompanyCandidate[];
  recommendedCompanyId?: string;
  companyConfirmationRequired: boolean;
  operatorRecommendations: MailboxOperatorRecommendation[];
  recommendedOperatorRoleId?: string;
  sensitiveContentRedacted: boolean;
  evidenceRefs: import("./types").CompanyEvidenceRef[];
  existingHandoffs: MailboxMissionControlHandoffRecord[];
}

export interface MailboxMissionControlHandoffRequest {
  threadId: string;
  companyId: string;
  operatorRoleId: string;
  issueTitle: string;
  issueSummary?: string;
}

export interface MailboxDigest {
  threadCount: number;
  messageCount: number;
  unreadCount: number;
  needsReplyCount: number;
  proposalCount: number;
  commitmentCount: number;
  draftCount: number;
  overdueCommitmentCount: number;
  sensitiveThreadCount: number;
  eventCount: number;
  classificationPendingCount: number;
  lastSyncedAt?: number;
  recentEventTypes: Array<{ type: MailboxEventType; count: number }>;
}

export interface MailboxDigestSnapshot extends MailboxDigest {
  workspaceId: string;
  generatedAt: number;
}

export interface MailboxListThreadsInput {
  accountId?: string;
  query?: string;
  category?: MailboxThreadCategory | "all";
  mailboxView?: MailboxThreadMailboxView;
  unreadOnly?: boolean;
  needsReply?: boolean;
  hasSuggestedProposal?: boolean;
  hasOpenCommitment?: boolean;
  cleanupCandidate?: boolean;
  sortBy?: MailboxThreadSortOrder;
  limit?: number;
}

export interface MailboxSyncResult {
  accounts: MailboxAccount[];
  syncedThreads: number;
  syncedMessages: number;
  lastSyncedAt: number;
}

export interface MailboxReclassifyResult {
  accountId: string;
  scannedThreads: number;
  reclassifiedThreads: number;
}

export interface MailboxReclassifyInput {
  accountId?: string;
  threadId?: string;
  scope?: "thread" | "account" | "backfill";
  limit?: number;
}

export interface MailboxDraftOptions {
  tone?: "concise" | "warm" | "direct" | "executive";
  includeAvailability?: boolean;
  allowNoreplySender?: boolean;
}

export interface MailboxBulkReviewInput {
  type: "cleanup" | "follow_up";
  limit?: number;
}

export interface MailboxBulkReviewResult {
  type: "cleanup" | "follow_up";
  proposals: MailboxActionProposal[];
  count: number;
}

export interface MailboxApplyActionInput {
  proposalId?: string;
  threadId?: string;
  type:
    | "cleanup_local"
    | "archive"
    | "trash"
    | "mark_read"
    | "label"
    | "send_draft"
    | "discard_draft"
    | "schedule_event"
    | "dismiss_proposal";
  label?: string;
  draftId?: string;
  commitmentId?: string;
}

/**
 * Remove junk left at the start of plain text when HTML was stripped (e.g. stray
 * `width="96"` attributes becoming "96 96" before the real sentence on the same line).
 */
export function stripMailboxSummaryHtmlArtifacts(text: string): string {
  let t = String(text || "").trim();
  if (!t) return t;
  // `m`: line starts — strips "96 96 …" when junk is on the same line as real prose.
  t = t.replace(/^(\d{1,4})(\s+\d{1,4})+\s*/gm, "").trim();
  return t;
}

export function normalizeMailboxEmailAddress(value?: string | null): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return "";
  const match = raw.match(/<([^>]+)>/);
  return (match?.[1] || raw).trim().toLowerCase();
}

export function isMailboxNoReplyAddress(value?: string | null): boolean {
  const normalized = normalizeMailboxEmailAddress(value);
  if (!normalized) return false;
  const [localPart = ""] = normalized.split("@");
  return /(^|[._+-])(no[._-]?reply|donotreply|do[._-]?not[._-]?reply)(?=$|[._+-])/i.test(localPart);
}

export function getMailboxNoReplySender(
  messages: Array<Pick<MailboxMessage, "direction" | "from">>,
  participants: Array<Pick<MailboxParticipant, "email" | "name">> = [],
): MailboxParticipant | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const email = normalizeMailboxEmailAddress(message?.from?.email);
    if (message?.direction === "incoming" && isMailboxNoReplyAddress(email)) {
      return {
        email,
        name: message.from?.name,
      };
    }
  }

  for (const participant of participants) {
    const email = normalizeMailboxEmailAddress(participant?.email);
    if (isMailboxNoReplyAddress(email)) {
      return {
        email,
        name: participant?.name,
      };
    }
  }

  return null;
}
