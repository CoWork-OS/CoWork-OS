import { Workspace } from "../../../shared/types";
import { AgentDaemon } from "../daemon";
import { GoogleWorkspaceSettingsManager } from "../../settings/google-workspace-manager";
import { gmailRequest } from "../../utils/gmail-api";
import {
  hasGoogleWorkspaceScopeCoverage,
  hasGoogleWorkspaceTokens,
} from "../../../shared/google-workspace";

type GmailAction =
  | "get_profile"
  | "list_messages"
  | "get_message"
  | "get_thread"
  | "list_labels"
  | "create_draft"
  | "send_message"
  | "reply_to_thread"
  | "archive_thread"
  | "modify_thread_labels"
  | "batch_modify_messages"
  | "trash_message";

type GmailCodexStyleTool =
  | "gmail_search_emails"
  | "gmail_search_email_ids"
  | "gmail_batch_read_email"
  | "gmail_read_email_thread"
  | "gmail_create_draft"
  | "gmail_list_drafts"
  | "gmail_update_draft"
  | "gmail_send_draft"
  | "gmail_send_email"
  | "gmail_apply_labels_to_emails"
  | "gmail_bulk_label_matching_emails"
  | "gmail_forward_emails";

interface GmailActionInput {
  action: GmailAction;
  query?: string;
  page_size?: number;
  page_token?: string;
  label_ids?: string[];
  include_spam_trash?: boolean;
  message_id?: string;
  thread_id?: string;
  format?: "full" | "metadata" | "minimal" | "raw";
  metadata_headers?: string[];
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body?: string;
  raw?: string;
  label_ids_add?: string[];
  label_ids_remove?: string[];
  message_ids?: string[];
}

type GmailHeader = { name?: string; value?: string };
type GmailMessage = {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: {
    mimeType?: string;
    filename?: string;
    headers?: GmailHeader[];
    body?: { data?: string; size?: number; attachmentId?: string };
    parts?: GmailMessage["payload"][];
  };
};
type GmailPayload = NonNullable<GmailMessage["payload"]>;
type RawEmailInput = {
  to?: unknown;
  cc?: unknown;
  bcc?: unknown;
  subject?: unknown;
  body?: unknown;
};

type GmailAttachmentSummary = {
  filename?: string;
  mime_type?: string;
  attachment_id?: string;
  size?: number;
};

const CODEX_STYLE_TOOL_NAMES: GmailCodexStyleTool[] = [
  "gmail_search_emails",
  "gmail_search_email_ids",
  "gmail_batch_read_email",
  "gmail_read_email_thread",
  "gmail_create_draft",
  "gmail_list_drafts",
  "gmail_update_draft",
  "gmail_send_draft",
  "gmail_send_email",
  "gmail_apply_labels_to_emails",
  "gmail_bulk_label_matching_emails",
  "gmail_forward_emails",
];

function encodeMessage(raw: string): string {
  return Buffer.from(raw)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function decodeBody(data?: string): string {
  if (!data) return "";
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf8");
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .trim();
}

function getHeader(message: GmailMessage | undefined, name: string): string | undefined {
  const headers = message?.payload?.headers ?? [];
  const found = headers.find((header) => header.name?.toLowerCase() === name.toLowerCase());
  return found?.value;
}

function collectParts(payload: GmailMessage["payload"] | undefined): GmailPayload[] {
  if (!payload) return [];
  const parts: GmailPayload[] = [payload];
  for (const part of payload.parts ?? []) {
    parts.push(...collectParts(part));
  }
  return parts;
}

function extractBody(message: GmailMessage | undefined): string {
  const parts = collectParts(message?.payload);
  const plain = parts.find((part) => part?.mimeType === "text/plain" && part.body?.data);
  if (plain) return decodeBody(plain.body?.data).trim();
  const html = parts.find((part) => part?.mimeType === "text/html" && part.body?.data);
  if (html) return stripHtml(decodeBody(html.body?.data));
  return "";
}

function extractAttachments(message: GmailMessage | undefined): GmailAttachmentSummary[] {
  return collectParts(message?.payload)
    .filter((part) => part?.filename || part?.body?.attachmentId)
    .map((part) => ({
      filename: part?.filename,
      mime_type: part?.mimeType,
      attachment_id: part?.body?.attachmentId,
      size: part?.body?.size,
    }));
}

function hasAttachments(message: GmailMessage | undefined): boolean {
  return extractAttachments(message).length > 0;
}

function formatMessageSummary(message: GmailMessage, includeBody = false): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    id: message.id,
    message_id: message.id,
    thread_id: message.threadId,
    subject: getHeader(message, "Subject") ?? "",
    from: getHeader(message, "From") ?? "",
    to: getHeader(message, "To") ?? "",
    cc: getHeader(message, "Cc") ?? "",
    date: getHeader(message, "Date") ?? "",
    snippet: message.snippet ?? "",
    label_ids: message.labelIds ?? [],
    internal_date: message.internalDate,
    attachments: extractAttachments(message),
  };
  if (includeBody) {
    summary.body = extractBody(message);
  }
  return summary;
}

function parseCsv(value: unknown): string | undefined {
  if (Array.isArray(value)) return value.filter(Boolean).join(", ");
  return typeof value === "string" ? value : undefined;
}

function encodeBase64MimeBody(value: string): string {
  const encoded = Buffer.from(value, "utf8").toString("base64");
  return encoded.replace(/.{1,76}/g, "$&\r\n").trimEnd();
}

function buildRawEmail(
  input: RawEmailInput,
  extraHeaders: Record<string, string | undefined> = {},
): string {
  const headers: string[] = [];
  const to = parseCsv(input.to);
  const cc = parseCsv(input.cc);
  const bcc = parseCsv(input.bcc);
  const subject = typeof input.subject === "string" ? input.subject : undefined;
  if (to) headers.push(`To: ${to}`);
  if (cc) headers.push(`Cc: ${cc}`);
  if (bcc) headers.push(`Bcc: ${bcc}`);
  if (subject) headers.push(`Subject: ${subject}`);
  for (const [name, value] of Object.entries(extraHeaders)) {
    if (value) headers.push(`${name}: ${value}`);
  }
  headers.push("MIME-Version: 1.0");
  headers.push('Content-Type: text/plain; charset="UTF-8"');
  headers.push("Content-Transfer-Encoding: base64");

  const body = typeof input.body === "string" ? input.body : "";
  const message = `${headers.join("\r\n")}\r\n\r\n${encodeBase64MimeBody(body)}`;
  return encodeMessage(message);
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export class GmailTools {
  constructor(
    private workspace: Workspace,
    private daemon: AgentDaemon,
    private taskId: string,
  ) {}

  setWorkspace(workspace: Workspace): void {
    this.workspace = workspace;
  }

  static isEnabled(): boolean {
    const settings = GoogleWorkspaceSettingsManager.loadSettings();
    return (
      settings.enabled &&
      hasGoogleWorkspaceTokens(settings) &&
      hasGoogleWorkspaceScopeCoverage(settings.scopes, "gmail")
    );
  }

  static isCodexStyleTool(name: string): name is GmailCodexStyleTool {
    return CODEX_STYLE_TOOL_NAMES.includes(name as GmailCodexStyleTool);
  }

  private formatAuthError(error: unknown): string | null {
    const message = String((error as Error)?.message ?? "");
    const status = (error as { status?: number })?.status;
    if (status === 401) {
      return "Google Workspace authorization failed (401). Reconnect in Settings > Integrations > Google Workspace.";
    }
    if (status === 403 && /insufficient authentication scopes/i.test(message)) {
      return "Google Workspace authorization failed (403): Gmail modify scope is missing. Reconnect in Settings > Integrations > Google Workspace and authorize the updated permissions.";
    }
    if (
      /token refresh failed|refresh token not configured|access token not configured|access token expired/i.test(
        message,
      )
    ) {
      return `Google Workspace authorization error: ${message}`;
    }
    return null;
  }

  private async requireApproval(summary: string, details: Record<string, unknown>): Promise<void> {
    const approved = await this.daemon.requestApproval(
      this.taskId,
      "external_service",
      summary,
      details,
    );

    if (!approved) {
      throw new Error("User denied Gmail action");
    }
  }

  private loadEnabledSettings() {
    const settings = GoogleWorkspaceSettingsManager.loadSettings();
    if (!settings.enabled) {
      throw new Error(
        "Google Workspace integration is disabled. Enable it in Settings > Integrations > Google Workspace.",
      );
    }
    return settings;
  }

  private async getMessage(
    settings: ReturnType<typeof GoogleWorkspaceSettingsManager.loadSettings>,
    messageId: string,
    format: "full" | "metadata" | "minimal" | "raw" = "full",
  ): Promise<GmailMessage> {
    const result = await gmailRequest(settings, {
      method: "GET",
      path: `/users/me/messages/${messageId}`,
      query: { format },
    });
    return result.data as GmailMessage;
  }

  private async getThread(
    settings: ReturnType<typeof GoogleWorkspaceSettingsManager.loadSettings>,
    threadId: string,
    maxMessages?: number,
  ): Promise<Record<string, unknown>> {
    const result = await gmailRequest(settings, {
      method: "GET",
      path: `/users/me/threads/${threadId}`,
      query: { format: "full" },
    });
    const messages = ((result.data?.messages ?? []) as GmailMessage[]).slice(
      maxMessages ? -Math.max(1, maxMessages) : undefined,
    );
    return {
      id: result.data?.id,
      thread_id: result.data?.id,
      history_id: result.data?.historyId,
      total_messages: result.data?.messages?.length ?? messages.length,
      messages: messages.map((message) => formatMessageSummary(message, true)),
    };
  }

  private async resolveReplyContext(
    settings: ReturnType<typeof GoogleWorkspaceSettingsManager.loadSettings>,
    replyMessageId?: unknown,
  ): Promise<{ threadId?: string; headers: Record<string, string | undefined> }> {
    if (typeof replyMessageId !== "string" || !replyMessageId.trim()) {
      return { headers: {} };
    }
    const source = await this.getMessage(settings, replyMessageId, "metadata");
    const internetMessageId = getHeader(source, "Message-ID");
    const references = getHeader(source, "References");
    return {
      threadId: source.threadId,
      headers: {
        "In-Reply-To": internetMessageId,
        References: [references, internetMessageId].filter(Boolean).join(" ") || undefined,
      },
    };
  }

  private async resolveLabelIds(
    settings: ReturnType<typeof GoogleWorkspaceSettingsManager.loadSettings>,
    names: unknown,
    createMissing: boolean,
  ): Promise<string[]> {
    if (!Array.isArray(names) || names.length === 0) return [];
    const requestedNames = names.filter(
      (name): name is string => typeof name === "string" && !!name,
    );
    if (requestedNames.length === 0) return [];

    const listResult = await gmailRequest(settings, {
      method: "GET",
      path: "/users/me/labels",
    });
    const labels = (listResult.data?.labels ?? []) as Array<{ id: string; name: string }>;
    const byName = new Map(labels.map((label) => [label.name.toLowerCase(), label]));
    const byId = new Map(labels.map((label) => [label.id.toLowerCase(), label]));
    const resolved: string[] = [];

    for (const labelName of requestedNames) {
      const existing = byName.get(labelName.toLowerCase()) ?? byId.get(labelName.toLowerCase());
      if (existing) {
        resolved.push(existing.id);
        continue;
      }
      if (!createMissing) {
        throw new Error(`Gmail label not found: ${labelName}`);
      }
      const createResult = await gmailRequest(settings, {
        method: "POST",
        path: "/users/me/labels",
        body: {
          name: labelName,
          labelListVisibility: "labelShow",
          messageListVisibility: "show",
        },
      });
      resolved.push(createResult.data?.id);
    }

    return resolved.filter(Boolean);
  }

  async executeCodexStyleTool(name: GmailCodexStyleTool, input: Record<string, Any>): Promise<Any> {
    const settings = this.loadEnabledSettings();

    try {
      switch (name) {
        case "gmail_search_emails": {
          const result = await gmailRequest(settings, {
            method: "GET",
            path: "/users/me/messages",
            query: {
              q: input.query,
              labelIds: input.label_ids,
              maxResults: input.max_results ?? 20,
              pageToken: input.next_page_token,
            },
          });
          const refs = (result.data?.messages ?? []) as Array<{ id: string; threadId: string }>;
          const emails = await Promise.all(
            refs.map((ref) => this.getMessage(settings, ref.id, "metadata")),
          );
          return {
            success: true,
            emails: emails.map((email) => formatMessageSummary(email, false)),
            next_page_token: result.data?.nextPageToken,
            result_size_estimate: result.data?.resultSizeEstimate,
          };
        }
        case "gmail_search_email_ids": {
          const result = await gmailRequest(settings, {
            method: "GET",
            path: "/users/me/messages",
            query: {
              q: input.query,
              labelIds: input.label_ids,
              maxResults: input.max_results ?? 100,
              pageToken: input.next_page_token,
            },
          });
          const refs = (result.data?.messages ?? []) as Array<{ id: string; threadId: string }>;
          return {
            success: true,
            message_ids: refs.map((ref) => ref.id),
            thread_ids: refs.map((ref) => ref.threadId),
            next_page_token: result.data?.nextPageToken,
            result_size_estimate: result.data?.resultSizeEstimate,
          };
        }
        case "gmail_batch_read_email": {
          if (!Array.isArray(input.message_ids) || input.message_ids.length === 0) {
            throw new Error("message_ids is required for gmail_batch_read_email");
          }
          const batchIds = input.message_ids.slice(0, 50);
          const messages = await Promise.all(
            batchIds.map((messageId: string) =>
              this.getMessage(settings, messageId, "full"),
            ),
          );
          return {
            success: true,
            emails: messages.map((message) => formatMessageSummary(message, true)),
          };
        }
        case "gmail_read_email_thread": {
          if (typeof input.id !== "string" || !input.id.trim()) {
            throw new Error("id is required for gmail_read_email_thread");
          }
          const threadId =
            input.id_type === "thread"
              ? input.id
              : (await this.getMessage(settings, input.id, "metadata")).threadId;
          if (!threadId) throw new Error("Unable to resolve Gmail thread id");
          return {
            success: true,
            ...(await this.getThread(settings, threadId, input.max_messages)),
          };
        }
        case "gmail_create_draft": {
          if (input.attachment_files) {
            throw new Error("Gmail draft attachments are not supported by this built-in tool yet");
          }
          const reply = await this.resolveReplyContext(settings, input.reply_message_id);
          const raw = buildRawEmail(
            input as GmailActionInput & Record<string, unknown>,
            reply.headers,
          );
          const result = await gmailRequest(settings, {
            method: "POST",
            path: "/users/me/drafts",
            body: {
              message: {
                raw,
                threadId: reply.threadId,
              },
            },
          });
          return {
            success: true,
            draft_id: result.data?.id,
            message_id: result.data?.message?.id,
            thread_id: result.data?.message?.threadId,
            data: result.data,
          };
        }
        case "gmail_list_drafts": {
          const result = await gmailRequest(settings, {
            method: "GET",
            path: "/users/me/drafts",
            query: {
              maxResults: input.max_results ?? 10,
              pageToken: input.next_page_token,
            },
          });
          const refs = (result.data?.drafts ?? []) as Array<{ id: string }>;
          const drafts = await Promise.all(
            refs.map(async (draft) => {
              const detail = await gmailRequest(settings, {
                method: "GET",
                path: `/users/me/drafts/${draft.id}`,
                query: { format: "metadata" },
              });
              return {
                draft_id: detail.data?.id,
                ...formatMessageSummary(detail.data?.message ?? {}, false),
              };
            }),
          );
          return {
            success: true,
            drafts,
            next_page_token: result.data?.nextPageToken,
            result_size_estimate: result.data?.resultSizeEstimate,
          };
        }
        case "gmail_update_draft": {
          if (typeof input.draft_id !== "string" || !input.draft_id.trim()) {
            throw new Error("draft_id is required for gmail_update_draft");
          }
          const existing = await gmailRequest(settings, {
            method: "GET",
            path: `/users/me/drafts/${input.draft_id}`,
            query: { format: "full" },
          });
          const message = existing.data?.message as GmailMessage;
          if (hasAttachments(message)) {
            throw new Error("Drafts with attachments are not editable through this built-in tool");
          }
          const merged = {
            to: input.to ?? getHeader(message, "To") ?? "",
            cc: input.cc ?? getHeader(message, "Cc") ?? "",
            bcc: input.bcc ?? getHeader(message, "Bcc") ?? "",
            subject: input.subject ?? getHeader(message, "Subject") ?? "",
            body: input.body ?? extractBody(message),
          };
          const raw = buildRawEmail(merged as GmailActionInput & Record<string, unknown>);
          const result = await gmailRequest(settings, {
            method: "PUT",
            path: `/users/me/drafts/${input.draft_id}`,
            body: {
              id: input.draft_id,
              message: {
                raw,
                threadId: message.threadId,
              },
            },
          });
          return {
            success: true,
            draft_id: result.data?.id,
            message_id: result.data?.message?.id,
            thread_id: result.data?.message?.threadId,
            data: result.data,
          };
        }
        case "gmail_send_draft": {
          if (typeof input.draft_id !== "string" || !input.draft_id.trim()) {
            throw new Error("draft_id is required for gmail_send_draft");
          }
          await this.requireApproval("Send an existing Gmail draft", {
            tool: name,
            draft_id: input.draft_id,
          });
          const result = await gmailRequest(settings, {
            method: "POST",
            path: "/users/me/drafts/send",
            body: { id: input.draft_id },
          });
          return { success: true, data: result.data };
        }
        case "gmail_send_email": {
          if (!input.to || (typeof input.to === "string" && !input.to.trim())) {
            throw new Error("'to' is required for gmail_send_email");
          }
          if (input.attachment_files) {
            throw new Error("Gmail send attachments are not supported by this built-in tool yet");
          }
          await this.requireApproval("Send a Gmail message", {
            tool: name,
            to: input.to,
            subject: input.subject,
          });
          const reply = await this.resolveReplyContext(settings, input.reply_message_id);
          const raw = buildRawEmail(
            input as GmailActionInput & Record<string, unknown>,
            reply.headers,
          );
          const result = await gmailRequest(settings, {
            method: "POST",
            path: "/users/me/messages/send",
            body: {
              raw,
              threadId: reply.threadId,
            },
          });
          return { success: true, data: result.data };
        }
        case "gmail_apply_labels_to_emails": {
          if (!Array.isArray(input.message_ids) || input.message_ids.length === 0) {
            throw new Error("message_ids is required for gmail_apply_labels_to_emails");
          }
          const addLabelIds = await this.resolveLabelIds(
            settings,
            input.add_label_names,
            Boolean(input.create_missing_labels),
          );
          const removeLabelIds = await this.resolveLabelIds(settings, input.remove_label_names, false);
          if (addLabelIds.length === 0 && removeLabelIds.length === 0) {
            throw new Error("At least one label name is required");
          }
          await this.requireApproval("Apply Gmail labels to selected messages", {
            tool: name,
            message_ids: input.message_ids,
            add_label_names: input.add_label_names,
            remove_label_names: input.remove_label_names,
          });
          const result = await gmailRequest(settings, {
            method: "POST",
            path: "/users/me/messages/batchModify",
            body: {
              ids: input.message_ids,
              addLabelIds,
              removeLabelIds,
            },
          });
          return { success: true, status: result.status };
        }
        case "gmail_bulk_label_matching_emails": {
          if (typeof input.query !== "string" || !input.query.trim()) {
            throw new Error("query is required for gmail_bulk_label_matching_emails");
          }
          if (typeof input.label_name !== "string" || !input.label_name.trim()) {
            throw new Error("label_name is required for gmail_bulk_label_matching_emails");
          }
          const [labelId] = await this.resolveLabelIds(
            settings,
            [input.label_name],
            Boolean(input.create_label_if_missing),
          );
          await this.requireApproval("Apply a Gmail label to messages matching a search query", {
            tool: name,
            query: input.query,
            label_name: input.label_name,
            archive: input.archive,
          });
          const maxMatches =
            typeof input.max_matches === "number" && Number.isFinite(input.max_matches)
              ? Math.max(1, Math.min(10_000, Math.floor(input.max_matches)))
              : 2_000;
          const messageIds: string[] = [];
          let pageToken: string | undefined;
          do {
            const search = await gmailRequest(settings, {
              method: "GET",
              path: "/users/me/messages",
              query: {
                q: input.query,
                maxResults: 500,
                pageToken,
              },
            });
            const pageIds = ((search.data?.messages ?? []) as Array<{ id: string }>)
              .map((message) => message.id)
              .filter(Boolean);
            messageIds.push(...pageIds.slice(0, Math.max(0, maxMatches - messageIds.length)));
            pageToken = messageIds.length >= maxMatches ? undefined : search.data?.nextPageToken;
          } while (pageToken && messageIds.length < maxMatches);

          for (const ids of chunk(messageIds, 1000)) {
            await gmailRequest(settings, {
              method: "POST",
              path: "/users/me/messages/batchModify",
              body: {
                ids,
                addLabelIds: [labelId],
                removeLabelIds: input.archive ? ["INBOX"] : [],
              },
            });
          }

          return {
            success: true,
            matched_count: messageIds.length,
            label_id: labelId,
            capped: messageIds.length >= maxMatches,
            max_matches: maxMatches,
          };
        }
        case "gmail_forward_emails": {
          if (!input.to || (typeof input.to === "string" && !input.to.trim())) {
            throw new Error("'to' is required for gmail_forward_emails");
          }
          if (!Array.isArray(input.message_ids) || input.message_ids.length === 0) {
            throw new Error("message_ids is required for gmail_forward_emails");
          }
          await this.requireApproval("Forward Gmail messages", {
            tool: name,
            to: input.to,
            message_ids: input.message_ids,
          });
          const sent = [];
          for (const messageId of input.message_ids) {
            const message = await this.getMessage(settings, messageId, "full");
            const subject = getHeader(message, "Subject") ?? "";
            const body = [
              typeof input.note === "string" ? input.note.trim() : "",
              "---------- Forwarded message ----------",
              `From: ${getHeader(message, "From") ?? ""}`,
              `Date: ${getHeader(message, "Date") ?? ""}`,
              `Subject: ${subject}`,
              `To: ${getHeader(message, "To") ?? ""}`,
              "",
              extractBody(message),
            ]
              .filter((line) => line !== undefined)
              .join("\n");
            const raw = buildRawEmail({
              to: input.to,
              cc: input.cc,
              bcc: input.bcc,
              subject: /^fwd?:/i.test(subject) ? subject : `Fwd: ${subject}`,
              body,
            } as GmailActionInput & Record<string, unknown>);
            const result = await gmailRequest(settings, {
              method: "POST",
              path: "/users/me/messages/send",
              body: { raw, threadId: message.threadId },
            });
            sent.push(result.data);
          }
          return { success: true, sent };
        }
        default: {
          const _exhaustive: never = name;
          throw new Error(`Unhandled codex-style Gmail tool: ${_exhaustive}`);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const authMessage = this.formatAuthError(error);
      const finalMessage = authMessage ?? message;
      this.daemon.logEvent(this.taskId, "tool_error", {
        tool: name,
        message: finalMessage,
        status: (error as { status?: number })?.status,
      });
      if (authMessage) throw new Error(authMessage);
      if (error instanceof Error) throw error;
      throw new Error(message);
    }
  }

  async executeAction(input: GmailActionInput): Promise<Any> {
    const settings = this.loadEnabledSettings();

    const action = input.action;
    if (!action) {
      throw new Error('Missing required "action" parameter');
    }

    let result;

    try {
      switch (action) {
        case "get_profile": {
          result = await gmailRequest(settings, {
            method: "GET",
            path: "/users/me/profile",
          });
          break;
        }
        case "list_messages": {
          result = await gmailRequest(settings, {
            method: "GET",
            path: "/users/me/messages",
            query: {
              q: input.query,
              maxResults: input.page_size,
              pageToken: input.page_token,
              includeSpamTrash: input.include_spam_trash,
              labelIds: input.label_ids,
            },
          });
          break;
        }
        case "get_message": {
          if (!input.message_id) throw new Error("Missing message_id for get_message");
          result = await gmailRequest(settings, {
            method: "GET",
            path: `/users/me/messages/${input.message_id}`,
            query: {
              format: input.format,
              metadataHeaders: input.metadata_headers
                ? input.metadata_headers.join(",")
                : undefined,
            },
          });
          break;
        }
        case "get_thread": {
          if (!input.thread_id) throw new Error("Missing thread_id for get_thread");
          result = await gmailRequest(settings, {
            method: "GET",
            path: `/users/me/threads/${input.thread_id}`,
            query: {
              format: input.format,
              metadataHeaders: input.metadata_headers
                ? input.metadata_headers.join(",")
                : undefined,
            },
          });
          break;
        }
        case "list_labels": {
          result = await gmailRequest(settings, {
            method: "GET",
            path: "/users/me/labels",
          });
          break;
        }
        case "send_message": {
          if (!input.raw && !input.to) {
            throw new Error("Missing to for send_message");
          }
          if (!input.raw && !input.body && !input.subject) {
            throw new Error("Missing body or subject for send_message");
          }

          await this.requireApproval("Send a Gmail message", {
            action: "send_message",
            to: input.to,
            subject: input.subject,
          });

          const raw = input.raw || buildRawEmail(input);
          const payload: Record<string, Any> = { raw };
          if (input.thread_id) {
            payload.threadId = input.thread_id;
          }

          result = await gmailRequest(settings, {
            method: "POST",
            path: "/users/me/messages/send",
            body: payload,
          });
          break;
        }
        case "create_draft": {
          if (!input.raw && !input.to) {
            throw new Error("Missing to for create_draft");
          }
          const raw = input.raw || buildRawEmail(input);
          const payload: Record<string, Any> = {
            message: {
              raw,
            },
          };
          if (input.thread_id) {
            payload.message.threadId = input.thread_id;
          }
          result = await gmailRequest(settings, {
            method: "POST",
            path: "/users/me/drafts",
            body: payload,
          });
          break;
        }
        case "reply_to_thread": {
          if (!input.thread_id) throw new Error("Missing thread_id for reply_to_thread");
          if (!input.raw && !input.to) throw new Error("Missing to for reply_to_thread");
          await this.requireApproval("Reply to a Gmail thread", {
            action: "reply_to_thread",
            thread_id: input.thread_id,
            to: input.to,
            subject: input.subject,
          });
          const raw = input.raw || buildRawEmail(input);
          result = await gmailRequest(settings, {
            method: "POST",
            path: "/users/me/messages/send",
            body: {
              raw,
              threadId: input.thread_id,
            },
          });
          break;
        }
        case "archive_thread": {
          if (!input.thread_id) throw new Error("Missing thread_id for archive_thread");
          await this.requireApproval("Archive a Gmail thread", {
            action: "archive_thread",
            thread_id: input.thread_id,
          });
          result = await gmailRequest(settings, {
            method: "POST",
            path: `/users/me/threads/${input.thread_id}/modify`,
            body: {
              removeLabelIds: ["INBOX"],
            },
          });
          break;
        }
        case "modify_thread_labels": {
          if (!input.thread_id) throw new Error("Missing thread_id for modify_thread_labels");
          await this.requireApproval("Modify labels on a Gmail thread", {
            action: "modify_thread_labels",
            thread_id: input.thread_id,
            add: input.label_ids_add,
            remove: input.label_ids_remove,
          });
          result = await gmailRequest(settings, {
            method: "POST",
            path: `/users/me/threads/${input.thread_id}/modify`,
            body: {
              addLabelIds: input.label_ids_add,
              removeLabelIds: input.label_ids_remove,
            },
          });
          break;
        }
        case "batch_modify_messages": {
          if (!input.message_ids?.length) {
            throw new Error("Missing message_ids for batch_modify_messages");
          }
          await this.requireApproval("Batch modify Gmail messages", {
            action: "batch_modify_messages",
            message_ids: input.message_ids,
            add: input.label_ids_add,
            remove: input.label_ids_remove,
          });
          result = await gmailRequest(settings, {
            method: "POST",
            path: "/users/me/messages/batchModify",
            body: {
              ids: input.message_ids,
              addLabelIds: input.label_ids_add,
              removeLabelIds: input.label_ids_remove,
            },
          });
          break;
        }
        case "trash_message": {
          if (!input.message_id) throw new Error("Missing message_id for trash_message");
          await this.requireApproval("Trash a Gmail message", {
            action: "trash_message",
            message_id: input.message_id,
          });
          result = await gmailRequest(settings, {
            method: "POST",
            path: `/users/me/messages/${input.message_id}/trash`,
          });
          break;
        }
        default:
          throw new Error(`Unsupported action: ${action}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const authMessage = this.formatAuthError(error);
      const finalMessage = authMessage ?? message;
      this.daemon.logEvent(this.taskId, "tool_error", {
        tool: "gmail_action",
        action,
        message: finalMessage,
        status: (error as { status?: number })?.status,
      });
      if (authMessage) {
        throw new Error(authMessage);
      }
      if (error instanceof Error) {
        throw error;
      }
      throw new Error(message);
    }

    this.daemon.logEvent(this.taskId, "tool_result", {
      tool: "gmail_action",
      action,
      status: result?.status,
      hasData: result?.data ? true : false,
    });

    return {
      success: true,
      action,
      status: result?.status,
      data: result?.data,
      raw: result?.raw,
    };
  }
}
