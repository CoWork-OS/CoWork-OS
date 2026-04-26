import type {
  MailboxComposeDraft,
  MailboxFolder,
  MailboxLabel,
  MailboxProvider,
  MailboxProviderBackend,
  MailboxProviderCapability,
  MailboxQueuedActionType,
  MailboxThreadDetail,
} from "../../shared/mailbox";

export interface MailboxProviderClient {
  readonly accountId: string;
  readonly provider: MailboxProvider;
  readonly backend: MailboxProviderBackend;
  readonly capabilities: readonly MailboxProviderCapability[];

  listFolders?(): Promise<MailboxFolder[]>;
  listLabels?(): Promise<MailboxLabel[]>;
  searchProviderHistory?(query: string, limit: number): Promise<MailboxThreadDetail[]>;
  sendDraft?(draft: MailboxComposeDraft): Promise<{ providerMessageId?: string; threadId?: string }>;
  saveDraft?(draft: MailboxComposeDraft): Promise<{ providerDraftId?: string }>;
  deleteDraft?(draft: MailboxComposeDraft): Promise<void>;
  applyThreadAction?(
    action: Exclude<MailboxQueuedActionType, "send" | "undo">,
    input: { threadId: string; payload?: Record<string, unknown> },
  ): Promise<void>;
  fetchAttachmentBytes?(attachmentId: string): Promise<Buffer>;
}

export function resolveMailboxProviderBackend(input: {
  provider: MailboxProvider;
  capabilities?: readonly string[];
}): MailboxProviderBackend {
  if (input.provider === "gmail") return "gmail_api";
  if (input.provider === "agentmail") return "agentmail";
  if (input.provider === "outlook_graph") return "microsoft_graph";
  if (input.capabilities?.includes("microsoft_graph")) return "microsoft_graph";
  return "imap_smtp";
}

export function getMailboxProviderCapabilities(backend: MailboxProviderBackend): MailboxProviderCapability[] {
  switch (backend) {
    case "gmail_api":
      return [
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
      ];
    case "microsoft_graph":
      return [
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
        "folders",
        "move",
        "undo_send",
      ];
    case "imap_smtp":
      return [
        "sync",
        "send",
        "reply_all",
        "forward",
        "mark_read",
        "mark_unread",
        "folders",
      ];
    case "agentmail":
      return [
        "sync",
        "send",
        "provider_drafts",
        "reply_all",
        "forward",
        "attachments_download",
        "archive",
        "trash",
        "mark_read",
        "mark_unread",
        "labels",
      ];
  }
}

export function mergeMailboxCapabilities(
  stored: readonly string[] | undefined,
  backend: MailboxProviderBackend,
): MailboxProviderCapability[] {
  const known = new Set<MailboxProviderCapability>(getMailboxProviderCapabilities(backend));
  for (const capability of stored || []) {
    if (isMailboxProviderCapability(capability)) known.add(capability);
  }
  return Array.from(known);
}

function isMailboxProviderCapability(value: string): value is MailboxProviderCapability {
  return [
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
    "folders",
    "move",
    "snooze",
    "undo_send",
  ].includes(value);
}
