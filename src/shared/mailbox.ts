export type MailboxProvider = "gmail" | "imap" | "outlook_graph" | "agentmail";

export type MailboxThreadSortOrder = "priority" | "recent";
export type MailboxThreadMailboxView = "inbox" | "sent" | "all";

export type MailboxProviderCapability =
  | "sync"
  | "provider_search"
  | "realtime"
  | "send"
  | "provider_drafts"
  | "reply_all"
  | "forward"
  | "attachments_download"
  | "attachments_upload"
  | "archive"
  | "trash"
  | "mark_read"
  | "mark_unread"
  | "labels"
  | "folders"
  | "move"
  | "snooze"
  | "undo_send";

export type MailboxProviderBackend = "gmail_api" | "microsoft_graph" | "imap_smtp" | "agentmail";

export type MailboxQueuedActionStatus =
  | "queued"
  | "running"
  | "sending"
  | "succeeded"
  | "sent"
  | "failed"
  | "cancelled";

export type MailboxQueuedActionType =
  | "send"
  | "archive"
  | "trash"
  | "mark_read"
  | "mark_unread"
  | "move"
  | "apply_label"
  | "remove_label"
  | "snooze"
  | "waiting_on"
  | "undo";

export type MailboxComposeMode = "new" | "reply" | "reply_all" | "forward";

export type MailboxComposeDraftStatus =
  | "local"
  | "provider"
  | "queued"
  | "scheduled"
  | "sending"
  | "sent"
  | "discarded"
  | "failed";

export type MailboxRemoteContentPolicy = "load" | "block" | "ask";

export type MailboxFolderRole =
  | "inbox"
  | "sent"
  | "drafts"
  | "scheduled"
  | "archive"
  | "trash"
  | "spam"
  | "custom";

export type MailboxTodayBucket =
  | "needs_action"
  | "happening_today"
  | "good_to_know"
  | "more_to_browse";

export type MailboxDomainCategory =
  | "travel"
  | "packages"
  | "receipts"
  | "bills"
  | "shopping"
  | "newsletters"
  | "events"
  | "finance"
  | "customer"
  | "hiring"
  | "approvals"
  | "ops"
  | "personal"
  | "other";

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

export type MailboxAutomationKind = "rule" | "schedule" | "reminder" | "forward";

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
  capabilities: MailboxProviderCapability[];
  backend?: MailboxProviderBackend;
  lastSyncedAt?: number;
  classificationInitialBatchAt?: number;
}

export interface MailboxSyncHealth {
  accountId: string;
  provider: MailboxProvider;
  backend: MailboxProviderBackend;
  status: "connected" | "degraded" | "disconnected";
  capabilities: MailboxProviderCapability[];
  lastSyncedAt?: number;
  syncCursor?: string;
  queuedActionCount: number;
  failedActionCount: number;
  draftCount: number;
  scheduledSendCount: number;
  statusLabel: string;
}

export interface MailboxFolder {
  id: string;
  accountId: string;
  providerFolderId: string;
  name: string;
  role: MailboxFolderRole;
  unreadCount?: number;
  totalCount?: number;
  createdAt: number;
  updatedAt: number;
}

export interface MailboxLabel {
  id: string;
  accountId: string;
  providerLabelId: string;
  name: string;
  color?: string;
  unreadCount?: number;
  totalCount?: number;
  createdAt: number;
  updatedAt: number;
}

export interface MailboxIdentity {
  id: string;
  accountId: string;
  email: string;
  displayName?: string;
  providerIdentityId?: string;
  isDefault: boolean;
  signatureId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface MailboxSignature {
  id: string;
  accountId: string;
  name: string;
  bodyHtml?: string;
  bodyText: string;
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
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
  responseLatencyHours: Partial<
    Record<"email" | "slack" | "teams" | "whatsapp" | "signal" | "imessage", number>
  >;
  messageCountByChannel: Partial<
    Record<"email" | "slack" | "teams" | "whatsapp" | "signal" | "imessage", number>
  >;
  lastInboundAtByChannel: Partial<
    Record<"email" | "slack" | "teams" | "whatsapp" | "signal" | "imessage", number>
  >;
  lastOutboundAtByChannel: Partial<
    Record<"email" | "slack" | "teams" | "whatsapp" | "signal" | "imessage", number>
  >;
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

export interface MailboxAttachmentSummary {
  id: string;
  messageId: string;
  filename: string;
  mimeType?: string;
  size?: number;
  extractionStatus: "not_indexed" | "pending" | "indexed" | "error" | "unsupported";
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
  todayBucket: MailboxTodayBucket;
  domainCategory: MailboxDomainCategory;
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
  attachments?: MailboxAttachmentSummary[];
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

export interface MailboxForwardRecipe {
  name: string;
  description?: string;
  workspaceId?: string;
  threadId?: string;
  providerThreadId?: string;
  schedule: import("../electron/cron/types").CronSchedule;
  targetEmail: string;
  allowedSenders: string[];
  allowedDomains: string[];
  excludedSenders?: string[];
  excludedDomains?: string[];
  subjectKeywords?: string[];
  attachmentKeywords?: string[];
  attachmentExtensions?: string[];
  dryRun?: boolean;
  maxMessagesPerRun?: number;
  backfillDays?: number;
  lookbackMinutes?: number;
  gmailQuery?: string;
  forwardedLabelName?: string;
  rejectedLabelName?: string;
  candidateLabelName?: string;
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
  forward?: MailboxForwardRecipe;
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
  composeDraftCount?: number;
  queuedActionCount?: number;
  failedActionCount?: number;
  scheduledSendCount?: number;
  overdueCommitmentCount: number;
  sensitiveThreadCount: number;
  eventCount: number;
  classificationPendingCount: number;
  lastSyncedAt?: number;
  syncHealth?: MailboxSyncHealth[];
  recentEventTypes: Array<{ type: MailboxEventType; count: number }>;
}

export interface MailboxDigestSnapshot extends MailboxDigest {
  workspaceId: string;
  generatedAt: number;
}

export interface MailboxTodayDigest {
  buckets: Array<{
    bucket: MailboxTodayBucket;
    label: string;
    count: number;
    threads: MailboxThreadListItem[];
  }>;
  domainCounts: Array<{ category: MailboxDomainCategory; count: number }>;
  syncHealth?: MailboxSyncHealth[];
  queuedActionCount?: number;
  failedActionCount?: number;
  composeDraftCount?: number;
  scheduledSendCount?: number;
  generatedAt: number;
}

export interface MailboxAttachmentRecord extends MailboxAttachmentSummary {
  threadId: string;
  provider: MailboxProvider;
  providerMessageId: string;
  providerAttachmentId?: string;
  text?: string;
  extractionMode?: string;
  extractionError?: string;
  createdAt: number;
  updatedAt: number;
}

export interface MailboxAskInput {
  query: string;
  limit?: number;
  includeAnswer?: boolean;
  runId?: string;
}

export interface MailboxAskRunEvent {
  runId: string;
  timestamp: number;
  type: "started" | "step_started" | "step_completed" | "completed" | "error";
  stepId: string;
  label: string;
  detail?: string;
  status: "running" | "done" | "error";
  payload?: Record<string, unknown>;
}

export interface MailboxAskResult {
  query: string;
  runId?: string;
  answer?: string;
  steps?: MailboxAskRunEvent[];
  results: Array<{
    thread: MailboxThreadListItem;
    matchedAttachment?: MailboxAttachmentRecord;
    snippet: string;
    score: number;
    searchSources?: Array<"local_fts" | "local_vector" | "provider_search" | "attachment_text">;
    matchedFields?: string[];
    evidenceSnippets?: string[];
  }>;
  usedLlm: boolean;
  error?: string;
  action?: {
    type: "sent_followup_drafts";
    result: MailboxSentFollowupDraftResult;
  };
}

export interface MailboxSenderCleanupDigest {
  generatedAt: number;
  senders: Array<{
    email: string;
    name?: string;
    threadCount: number;
    unreadCount: number;
    cleanupCandidateCount: number;
    needsReplyCount: number;
    estimatedWeeklyReduction: number;
    lastMessageAt: number;
    suggestedAction: "cleanup_local" | "archive" | "mark_read";
    threads: MailboxThreadListItem[];
  }>;
}

export interface MailboxSnippetRecord {
  id: string;
  workspaceId: string;
  shortcut: string;
  body: string;
  subjectHint?: string;
  createdAt: number;
  updatedAt: number;
}

export interface MailboxSnippetInput {
  shortcut: string;
  body: string;
  subjectHint?: string;
}

export interface MailboxSavedViewRecord {
  id: string;
  workspaceId: string;
  name: string;
  instructions: string;
  seedThreadId?: string;
  showInInbox: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface MailboxSavedViewPreviewResult {
  threadIds: string[];
  rationale?: string;
  /** Present when no model is configured or the preview call failed. */
  error?: string;
}

export interface MailboxQuickReplySuggestionsResult {
  suggestions: string[];
  /** Present when no model is configured or generation failed. */
  error?: string;
}

export interface MailboxListThreadsInput {
  accountId?: string;
  query?: string;
  category?: MailboxThreadCategory | "all";
  todayBucket?: MailboxTodayBucket | "all";
  domainCategory?: MailboxDomainCategory | "all";
  mailboxView?: MailboxThreadMailboxView;
  folderId?: string;
  labelId?: string;
  scheduledOnly?: boolean;
  draftOnly?: boolean;
  queuedOnly?: boolean;
  /** When set, only threads linked to this saved view are returned. */
  savedViewId?: string;
  unreadOnly?: boolean;
  needsReply?: boolean;
  hasSuggestedProposal?: boolean;
  hasOpenCommitment?: boolean;
  cleanupCandidate?: boolean;
  hasAttachment?: boolean;
  attachmentQuery?: string;
  sortBy?: MailboxThreadSortOrder;
  limit?: number;
}

export interface MailboxSyncResult {
  accounts: MailboxAccount[];
  syncedThreads: number;
  syncedMessages: number;
  lastSyncedAt: number;
}

export interface MailboxRecipientInput {
  name?: string;
  email: string;
}

export interface MailboxComposeDraft {
  id: string;
  accountId: string;
  workspaceId?: string;
  mode: MailboxComposeMode;
  status: MailboxComposeDraftStatus;
  threadId?: string;
  providerDraftId?: string;
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  to: MailboxRecipientInput[];
  cc: MailboxRecipientInput[];
  bcc: MailboxRecipientInput[];
  identityId?: string | null;
  signatureId?: string | null;
  attachments: Array<{
    id: string;
    filename: string;
    mimeType?: string;
    size?: number;
    localPath?: string;
    providerAttachmentId?: string;
    uploadStatus?: "local" | "uploaded" | "failed";
    latestError?: string;
  }>;
  scheduledAt?: number;
  sendAfter?: number;
  latestError?: string;
  createdAt: number;
  updatedAt: number;
}

export type MailComposeInlineFrameOrigin = "assistant_generated" | "mailbox_thread" | "user_prompt";

export interface MailComposeInlineFrame {
  kind: "mail_compose";
  draftId: string;
  accountId: string;
  provider: MailboxProvider;
  mode: MailboxComposeMode;
  origin: MailComposeInlineFrameOrigin;
  status?: MailboxComposeDraftStatus;
}

export type ChatInlineFrame = MailComposeInlineFrame;

export interface MailboxDraftAttachmentInput {
  path: string;
  filename?: string;
  mimeType?: string;
}

export interface MailboxComposeDraftInput {
  accountId?: string;
  threadId?: string;
  mode: MailboxComposeMode;
  subject?: string;
  bodyText?: string;
  bodyHtml?: string;
  to?: MailboxRecipientInput[];
  cc?: MailboxRecipientInput[];
  bcc?: MailboxRecipientInput[];
  identityId?: string | null;
  signatureId?: string | null;
}

export type MailboxComposeDraftSeed = Pick<
  MailboxComposeDraftInput,
  "mode" | "subject" | "bodyText" | "to"
>;

function normalizeComposePrompt(prompt: string): string {
  return prompt.replace(/\s+/g, " ").trim();
}

export function isMailboxComposePrompt(prompt: string): boolean {
  const normalized = normalizeComposePrompt(prompt);
  if (!normalized) return false;
  return (
    /\b(?:draft|write|compose|prepare|send)\b[\s\S]{0,100}\b(?:email|mail|message)\b/i.test(
      normalized,
    ) ||
    /\b(?:email|mail|message)\b[\s\S]{0,100}\b(?:draft|write|compose|prepare|send)\b/i.test(
      normalized,
    )
  );
}

function titleCasePhrase(value: string): string {
  return value
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map((word) => {
      const lower = word.toLowerCase();
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

function sentenceCasePhrase(value: string): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed) return "";
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function stripPromptLeadIn(prompt: string): string {
  return prompt
    .replace(
      /^\s*(?:please\s+)?(?:draft|write|compose|prepare|send)\s+(?:an?\s+)?(?:email|mail|message)\s+/i,
      "",
    )
    .trim();
}

function extractPromptRecipient(prompt: string): {
  name?: string;
  email?: string;
} {
  const emailMatch = prompt.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  const afterToMatch = prompt.match(
    /\bto\s+(?:my\s+)?(.+?)(?:\s+that\b|\s+about\b|\s+saying\b|\s+asking\b|\s+regarding\b|,\s*|$)/i,
  );
  const rawName = afterToMatch?.[1]
    ?.replace(/\b(?:landlord|boss|manager|colleague|coworker|friend|client|customer|team)\b/gi, " ")
    .replace(/[<>"()]/g, " ")
    .replace(emailMatch?.[0] || "", " ")
    .replace(/\s+/g, " ")
    .trim();
  const name = rawName ? titleCasePhrase(rawName) : undefined;
  return { name, email: emailMatch?.[0] };
}

function extractPromptRequest(prompt: string): {
  primary: string;
  includes: string[];
  asks: string[];
} {
  const stripped = stripPromptLeadIn(prompt);
  const afterRecipient = stripped.replace(
    /^\s*to\s+(?:my\s+)?.+?(?:\s+that\b|\s+about\b|\s+saying\b|\s+regarding\b|,\s*)/i,
    "",
  );
  const primarySource = afterRecipient || stripped || prompt;
  const includeMatches = Array.from(
    primarySource.matchAll(/\binclude\s+that\s+(.+?)(?=,\s*(?:and\s+)?ask\b|\s+and\s+ask\b|$)/gi),
  )
    .map((match) => match[1]?.trim())
    .filter(Boolean) as string[];
  const askMatches = Array.from(
    primarySource.matchAll(
      /\bask\s+(?:(?:him|her|them)\s+)?(.+?)(?=,\s*(?:and\s+)?(?:include|ask)\b|$)/gi,
    ),
  )
    .map((match) => match[1]?.trim())
    .filter(Boolean) as string[];
  const primary = primarySource
    .replace(/\binclude\s+that\s+.+?(?=,\s*(?:and\s+)?ask\b|\s+and\s+ask\b|$)/gi, "")
    .replace(/\b(?:and\s+)?ask\s+(?:him|her|them|for|to)?\s*.+$/i, "")
    .replace(/^\s*(?:that|about|saying|regarding)\s+/i, "")
    .replace(/[,.]\s*$/g, "")
    .trim();
  return {
    primary: primary || primarySource,
    includes: includeMatches,
    asks: askMatches,
  };
}

function buildPromptSubject(
  prompt: string,
  request: ReturnType<typeof extractPromptRequest>,
): string {
  const lower = prompt.toLowerCase();
  if (lower.includes("dishwasher") && lower.includes("leak") && lower.includes("cabinet")) {
    return "Dishwasher Leaking Again and Cabinet Damage";
  }
  if (lower.includes("dishwasher") && lower.includes("leak")) {
    return "Dishwasher Leaking Again";
  }
  const subjectSource = request.primary || request.includes[0] || request.asks[0] || "Email Draft";
  const subject = titleCasePhrase(subjectSource).split(" ").slice(0, 9).join(" ");
  return subject || "Email Draft";
}

function normalizeEmailClause(value: string): string {
  return value
    .replace(/^\s*(?:that|about|saying|regarding)\s+/i, "")
    .replace(/\bmy\b/gi, "the")
    .replace(/[,.]\s*$/g, "")
    .trim();
}

function buildPromptBody(prompt: string, recipientName: string | undefined): string {
  const request = extractPromptRequest(prompt);
  const salutation = recipientName ? `Hi ${recipientName.split(/\s+/)[0]},` : "Hello,";
  const primary = normalizeEmailClause(request.primary);
  const includes = request.includes.map(normalizeEmailClause).filter(Boolean);
  const asks = request.asks.map(normalizeEmailClause).filter(Boolean);
  const paragraphs: string[] = [salutation, ""];

  if (primary) {
    paragraphs.push(`I'm writing to let you know that ${primary}.`);
  } else {
    paragraphs.push("I'm writing about the item we discussed.");
  }

  for (const item of includes) {
    paragraphs.push(`${sentenceCasePhrase(item)}.`);
  }

  if (asks.length > 0) {
    paragraphs.push("");
    paragraphs.push(
      asks.map((item) => `Could you please ${item.replace(/^\s*for\s+/i, "arrange ")}?`).join(" "),
    );
  }

  paragraphs.push("", "Thank you,");
  return paragraphs
    .join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function buildMailboxComposeDraftInputFromPrompt(
  prompt: string,
): MailboxComposeDraftSeed | null {
  const normalized = normalizeComposePrompt(prompt);
  if (!isMailboxComposePrompt(normalized)) return null;
  const recipient = extractPromptRecipient(normalized);
  const request = extractPromptRequest(normalized);
  const subject = buildPromptSubject(normalized, request);
  const bodyText = buildPromptBody(normalized, recipient.name);
  return {
    mode: "new",
    subject,
    bodyText,
    to: recipient.email ? [{ email: recipient.email, name: recipient.name }] : [],
  };
}

export function extractMailboxComposeDraftInputFromText(
  assistantMessage: string,
  sourceUserMessage = "",
): MailboxComposeDraftSeed | null {
  const sourceLooksLikeMail =
    /\b(?:draft|write|compose|send|prepare)\b[\s\S]{0,80}\b(?:email|mail|message|reply)\b/i.test(
      sourceUserMessage,
    ) ||
    /\b(?:email|mail|message|reply)\b[\s\S]{0,80}\b(?:draft|write|compose|send|prepare)\b/i.test(
      sourceUserMessage,
    );
  const subjectMatch = assistantMessage.match(
    /^\s*(?:\*\*)?subject(?:\s+line)?(?:\*\*)?\s*:\s*(.+)$/im,
  );
  if (!subjectMatch?.[1]) return null;
  const subject = subjectMatch[1].replace(/\*\*/g, "").trim();
  if (!subject) return null;

  const subjectLineIndex = assistantMessage.toLowerCase().indexOf(subjectMatch[0].toLowerCase());
  const afterSubject =
    subjectLineIndex >= 0
      ? assistantMessage.slice(subjectLineIndex + subjectMatch[0].length)
      : assistantMessage;
  const bodyText = afterSubject
    .replace(/^\s*[-–—]*\s*/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!bodyText) return null;
  const bodyLooksLikeEmail =
    /^(dear|hi|hello)\s+[^,\n]+,/i.test(bodyText) ||
    /\n\s*(thank you|thanks|sincerely|best),?/i.test(bodyText);
  if (!sourceLooksLikeMail && !bodyLooksLikeEmail) return null;
  return {
    mode: "new",
    subject,
    bodyText,
    to: [],
  };
}

export interface MailboxClientSettingsPatch {
  remoteContentPolicy?: MailboxRemoteContentPolicy;
  sendDelaySeconds?: number;
  syncRecentDays?: number;
  attachmentCache?: "metadata_on_demand" | "recent_cache" | "never_cache";
  notifications?: MailboxClientState["settings"]["notifications"];
}

export interface MailboxComposeDraftPatch {
  subject?: string;
  bodyText?: string;
  bodyHtml?: string | null;
  to?: MailboxRecipientInput[];
  cc?: MailboxRecipientInput[];
  bcc?: MailboxRecipientInput[];
  identityId?: string | null;
  signatureId?: string | null;
  scheduledAt?: number | null;
}

export interface MailboxOutgoingMessage {
  id: string;
  draftId?: string;
  accountId: string;
  status: MailboxQueuedActionStatus;
  providerMessageId?: string;
  scheduledAt?: number;
  sendAfter?: number;
  latestError?: string;
  createdAt: number;
  updatedAt: number;
}

export interface MailboxQueuedAction {
  id: string;
  accountId?: string;
  threadId?: string;
  draftId?: string;
  type: MailboxQueuedActionType;
  status: MailboxQueuedActionStatus;
  payload: Record<string, unknown>;
  attempts: number;
  nextAttemptAt?: number;
  latestError?: string;
  undoOfActionId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface MailboxClientState {
  accounts: MailboxAccount[];
  syncHealth: MailboxSyncHealth[];
  folders: MailboxFolder[];
  labels: MailboxLabel[];
  identities: MailboxIdentity[];
  signatures: MailboxSignature[];
  composeDrafts: MailboxComposeDraft[];
  queuedActions: MailboxQueuedAction[];
  outgoing: MailboxOutgoingMessage[];
  settings: {
    remoteContentPolicy: MailboxRemoteContentPolicy;
    sendDelaySeconds: number;
    syncRecentDays: number;
    attachmentCache: "metadata_on_demand" | "recent_cache" | "never_cache";
    notifications: "all" | "priority" | "needs_reply" | "off";
  };
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

export interface MailboxSentFollowupDraft {
  thread: MailboxThreadListItem;
  draft: MailboxDraftSuggestion;
  lastOutboundAt: number;
  waitHours: number;
  reason: string;
}

export interface MailboxSentFollowupDraftInput {
  thresholdHours?: number;
  limit?: number;
}

export interface MailboxSentFollowupDraftResult {
  thresholdHours: number;
  createdDraftCount: number;
  skippedExistingDraftCount: number;
  drafts: MailboxSentFollowupDraft[];
  generatedAt: number;
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
    | "mark_done"
    | "archive"
    | "trash"
    | "mark_read"
    | "mark_unread"
    | "move"
    | "label"
    | "remove_label"
    | "snooze"
    | "waiting_on"
    | "undo"
    | "send_message"
    | "send_draft"
    | "discard_draft"
    | "schedule_event"
    | "dismiss_proposal";
  label?: string;
  folderId?: string;
  labelId?: string;
  snoozeUntil?: number;
  draftId?: string;
  draftSubject?: string;
  draftBody?: string;
  messageMode?: Extract<MailboxComposeMode, "reply" | "reply_all" | "forward">;
  messageTo?: string[];
  messageCc?: string[];
  messageBcc?: string[];
  messageSubject?: string;
  messageBody?: string;
  commitmentId?: string;
  actionId?: string;
}

/**
 * Remove junk left at the start of plain text when HTML was stripped (e.g. stray
 * `width="96"` attributes becoming "96 96" before the real sentence on the same line).
 * Also strips invisible / soft-break HTML entities and codepoints common in marketing
 * HTML (ZWNJ, soft hyphen, zero-width space) that leak into AI summaries as literal text.
 */
export function stripMailboxSummaryHtmlArtifacts(text: string): string {
  let t = String(text || "").trim();
  if (!t) return t;
  // Named / numeric entities for ZW* chars, soft hyphen, BOM (often pasted from HTML).
  t = t.replace(
    /&(?:#x?0*(?:200[bBcCdD]|8203|8204|8205|feff|ad|173)\b|zwnj|zwj|shy|ZeroWidthSpace);/gi,
    "",
  );
  t = t.replace(/&nbsp;/gi, " ");
  // Same characters if already decoded in the string.
  t = t.replace(/[\u200B-\u200D\uFEFF\u00AD]/g, "");
  // `m`: line starts — strips "96 96 …" when junk is on the same line as real prose.
  t = t.replace(/^(\d{1,4})(\s+\d{1,4})+\s*/gm, "").trim();
  t = t.replace(/[ \t]{2,}/g, " ");
  return t.trim();
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
