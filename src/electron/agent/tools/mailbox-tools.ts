import Database from "better-sqlite3";
import { Workspace } from "../../../shared/types";
import { AgentDaemon } from "../daemon";
import { MailboxService } from "../../mailbox/MailboxService";
import type {
  MailboxComposeDraftInput,
  MailboxComposeMode,
  MailboxProvider,
  MailboxRecipientInput,
} from "../../../shared/mailbox";

type MailboxAction =
  | "sync"
  | "list_threads"
  | "get_thread"
  | "summarize_thread"
  | "generate_draft"
  | "extract_commitments"
  | "propose_cleanup"
  | "propose_followups"
  | "schedule_reply"
  | "research_contact"
  | "apply_action"
  | "review_bulk_action"
  | "create_compose_frame";

interface MailboxActionInput {
  action: MailboxAction;
  account_id?: string;
  thread_id?: string;
  mode?: MailboxComposeMode;
  query?: string;
  category?: string;
  needs_reply?: boolean;
  cleanup_candidate?: boolean;
  limit?: number;
  tone?: "concise" | "warm" | "direct" | "executive";
  include_availability?: boolean;
  proposal_id?: string;
  draft_id?: string;
  type?:
    | "cleanup"
    | "follow_up"
    | "archive"
    | "trash"
    | "mark_read"
    | "label"
    | "send_draft"
    | "discard_draft"
    | "schedule_event"
    | "dismiss_proposal";
  label?: string;
  to?: MailboxRecipientInput[] | string[];
  cc?: MailboxRecipientInput[] | string[];
  bcc?: MailboxRecipientInput[] | string[];
  subject?: string;
  body_text?: string;
  body_html?: string;
}

const MUTATING_ACTION_TYPES = new Set([
  "archive",
  "trash",
  "mark_read",
  "label",
  "send_draft",
  "discard_draft",
  "schedule_event",
]);

function normalizeComposeMode(mode: MailboxActionInput["mode"]): MailboxComposeMode {
  return mode === "reply" || mode === "reply_all" || mode === "forward" ? mode : "new";
}

function normalizeRecipientInput(value: unknown): MailboxRecipientInput[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const recipients = value
    .map((item) => {
      if (typeof item === "string") {
        const email = item.trim();
        return email ? { email } : null;
      }
      if (item && typeof item === "object") {
        const record = item as Record<string, unknown>;
        const email = typeof record.email === "string" ? record.email.trim() : "";
        if (!email) return null;
        const name = typeof record.name === "string" ? record.name.trim() : "";
        return { ...(name ? { name } : {}), email };
      }
      return null;
    })
    .filter((recipient): recipient is MailboxRecipientInput => recipient !== null);
  return recipients.length > 0 ? recipients : undefined;
}

function providerForAccount(
  accountId: string,
  accounts: Array<{ id: string; provider: MailboxProvider }>,
): MailboxProvider {
  return accounts.find((account) => account.id === accountId)?.provider || "gmail";
}

export class MailboxTools {
  private mailboxService: MailboxService;

  constructor(
    private workspace: Workspace,
    private daemon: AgentDaemon,
    private taskId: string,
    db: Database.Database,
  ) {
    this.mailboxService = new MailboxService(db);
  }

  setWorkspace(workspace: Workspace): void {
    this.workspace = workspace;
  }

  isAvailable(): boolean {
    return this.mailboxService.isAvailable();
  }

  async executeAction(input: MailboxActionInput): Promise<Any> {
    const action = input.action;
    if (!action) throw new Error('Missing required "action" parameter');

    this.daemon.logEvent(this.taskId, "tool_call", {
      tool: "mailbox_action",
      action,
      thread_id: input.thread_id,
    });

    let data: Any;
    switch (action) {
      case "sync":
        data = await this.mailboxService.sync(input.limit);
        break;
      case "list_threads":
        data = await this.mailboxService.listThreads({
          query: input.query,
          category: (input.category as Any) || "all",
          needsReply: input.needs_reply,
          cleanupCandidate: input.cleanup_candidate,
          limit: input.limit,
        });
        break;
      case "get_thread":
        if (!input.thread_id) throw new Error("Missing thread_id for get_thread");
        data = await this.mailboxService.getThread(input.thread_id);
        break;
      case "summarize_thread":
        if (!input.thread_id) throw new Error("Missing thread_id for summarize_thread");
        data = await this.mailboxService.summarizeThread(input.thread_id);
        break;
      case "generate_draft":
        if (!input.thread_id) throw new Error("Missing thread_id for generate_draft");
        data = await this.mailboxService.generateDraft(input.thread_id, {
          tone: input.tone,
          includeAvailability: input.include_availability,
        });
        break;
      case "extract_commitments":
        if (!input.thread_id) throw new Error("Missing thread_id for extract_commitments");
        data = await this.mailboxService.extractCommitments(input.thread_id);
        break;
      case "propose_cleanup":
        data = await this.mailboxService.proposeCleanup(input.limit);
        break;
      case "propose_followups":
        data = await this.mailboxService.proposeFollowups(input.limit);
        break;
      case "schedule_reply":
        if (!input.thread_id) throw new Error("Missing thread_id for schedule_reply");
        data = await this.mailboxService.scheduleReply(input.thread_id);
        break;
      case "research_contact":
        if (!input.thread_id) throw new Error("Missing thread_id for research_contact");
        data = await this.mailboxService.researchContact(input.thread_id);
        break;
      case "review_bulk_action":
        if (input.type !== "cleanup" && input.type !== "follow_up") {
          throw new Error('review_bulk_action requires type "cleanup" or "follow_up"');
        }
        data = await this.mailboxService.reviewBulkAction({
          type: input.type,
          limit: input.limit,
        });
        break;
      case "create_compose_frame": {
        const draftInput: MailboxComposeDraftInput = {
          accountId: input.account_id,
          threadId: input.thread_id,
          mode: normalizeComposeMode(input.mode),
          subject: input.subject,
          bodyText: input.body_text,
          bodyHtml: input.body_html,
          to: normalizeRecipientInput(input.to),
          cc: normalizeRecipientInput(input.cc),
          bcc: normalizeRecipientInput(input.bcc),
        };
        const draft = await this.mailboxService.createMailboxDraft(draftInput);
        const state = await this.mailboxService.getMailboxClientState();
        const provider = providerForAccount(draft.accountId, state.accounts);
        this.daemon.logEvent(this.taskId, "assistant_message", {
          message: "Here's a draft you can review and send.",
          inlineFrames: [
            {
              kind: "mail_compose",
              draftId: draft.id,
              accountId: draft.accountId,
              provider,
              mode: draft.mode,
              origin: "assistant_generated",
              status: draft.status,
            },
          ],
          source: "mailbox_compose_frame",
        });
        data = { draft };
        break;
      }
      case "apply_action":
        if (!input.type) throw new Error("Missing type for apply_action");
        if (MUTATING_ACTION_TYPES.has(input.type)) {
          const approved = await this.daemon.requestApproval(
            this.taskId,
            "external_service",
            "Apply mailbox action",
            {
              thread_id: input.thread_id,
              proposal_id: input.proposal_id,
              action_type: input.type,
              label: input.label,
            },
          );
          if (!approved) {
            throw new Error("User denied mailbox action");
          }
        }
        data = await this.mailboxService.applyAction({
          proposalId: input.proposal_id,
          threadId: input.thread_id,
          type: input.type as Any,
          label: input.label,
          draftId: input.draft_id,
        });
        break;
      default:
        throw new Error(`Unsupported action: ${action}`);
    }

    this.daemon.logEvent(this.taskId, "tool_result", {
      tool: "mailbox_action",
      action,
      ok: true,
    });

    return {
      success: true,
      action,
      data,
    };
  }
}
