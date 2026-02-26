import { Workspace } from "../../../shared/types";
import { AgentDaemon } from "../daemon";
import { GoogleWorkspaceSettingsManager } from "../../settings/google-workspace-manager";
import { gmailRequest } from "../../utils/gmail-api";

type GmailAction =
  | "get_profile"
  | "list_messages"
  | "get_message"
  | "get_thread"
  | "list_labels"
  | "send_message"
  | "trash_message";

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
}

function encodeMessage(raw: string): string {
  return Buffer.from(raw)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function buildRawEmail(input: GmailActionInput): string {
  const headers: string[] = [];
  if (input.to) headers.push(`To: ${input.to}`);
  if (input.cc) headers.push(`Cc: ${input.cc}`);
  if (input.bcc) headers.push(`Bcc: ${input.bcc}`);
  if (input.subject) headers.push(`Subject: ${input.subject}`);
  headers.push("MIME-Version: 1.0");
  headers.push('Content-Type: text/plain; charset="UTF-8"');
  headers.push("Content-Transfer-Encoding: 7bit");

  const body = input.body ?? "";
  const message = `${headers.join("\r\n")}\r\n\r\n${body}`;
  return encodeMessage(message);
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
    return GoogleWorkspaceSettingsManager.loadSettings().enabled;
  }

  private formatAuthError(error: unknown): string | null {
    const message = String((error as Any)?.message ?? "");
    const status = (error as Any)?.status;
    if (status === 401) {
      return "Google Workspace authorization failed (401). Reconnect in Settings > Integrations > Google Workspace.";
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

  async executeAction(input: GmailActionInput): Promise<Any> {
    const settings = GoogleWorkspaceSettingsManager.loadSettings();
    if (!settings.enabled) {
      throw new Error(
        "Google Workspace integration is disabled. Enable it in Settings > Integrations > Google Workspace.",
      );
    }

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
        status: (error as Any)?.status,
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
