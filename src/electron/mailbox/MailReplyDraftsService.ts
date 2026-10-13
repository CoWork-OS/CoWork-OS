/**
 * Reply drafts on Today (opt-in, off by default). A few times an hour it drafts replies,
 * at most MAIL_REPLY_DRAFTS_PER_DAY a day, to threads that need one, and saves each as an
 * ordinary compose draft. Today shows the drafts; sending goes through the outbox, whose
 * delay is the undo window, and undoing returns the draft to editing.
 *
 * Card actions only act on drafts this service prepared, looked up by id in its own state.
 */
import {
  getMailboxNoReplySender,
  type MailboxComposeDraft,
  type MailboxComposeDraftInput,
  type MailboxOutgoingMessage,
  type MailboxSyncStatus,
  type MailboxThreadDetail,
  type MailboxThreadListItem,
  type MailboxListThreadsInput,
} from "../../shared/mailbox";
import {
  MAIL_REPLY_DRAFTS_PER_DAY,
  type MailReplyDraftCard,
  type MailReplyDraftOutcome,
} from "../../shared/mail-reply-drafts";
import type { MailboxReplyDraftResult } from "./mailbox-inbox-product-llm";

export interface MailReplyDraftsState {
  enabled: boolean;
  /** Until when Today's "Draft replies?" offer stays hidden. */
  offerHiddenUntil?: number;
  /** Drafts prepared in the last week, so a thread isn't drafted twice. */
  prepared: Array<{
    draftId: string;
    threadId: string;
    subject: string;
    sender: string;
    at: number;
  }>;
  /** Threads not to draft for a while: the user discarded the draft, or no reply fits. */
  hiddenThreads: Record<string, number>;
}

export interface MailReplyDraftsDeps {
  mailbox: {
    getSyncStatus(): Promise<Pick<MailboxSyncStatus, "accounts" | "needsReplyCount">>;
    listThreads(input: MailboxListThreadsInput): Promise<MailboxThreadListItem[]>;
    getThread(threadId: string): Promise<MailboxThreadDetail | null>;
    createMailboxDraft(input: MailboxComposeDraftInput): Promise<MailboxComposeDraft>;
    getMailboxDraft(draftId: string): Promise<MailboxComposeDraft | null>;
    sendMailboxDraft(draftId: string): Promise<MailboxOutgoingMessage>;
    cancelMailboxDraftSend(draftId: string): Promise<boolean>;
    discardMailboxDraft(draftId: string): Promise<boolean>;
  };
  writeReply(input: {
    threadId: string;
    subject: string;
    userAddress: string;
    messages: Array<{ from: string; incoming: boolean; at: number; body: string }>;
  }): Promise<MailboxReplyDraftResult>;
  loadState(): MailReplyDraftsState | undefined;
  saveState(state: MailReplyDraftsState): void;
  /** Called after a run that drafted something, so Today can show it. */
  onPrepared?: (count: number) => void;
  now?: () => number;
}

const DAY = 24 * 60 * 60 * 1000;
/** Prepared drafts are shown for three days, and remembered for a week. */
const SHOW_MS = 3 * DAY;
const REMEMBER_MS = 7 * DAY;
const HIDE_THREAD_MS = 14 * DAY;
const HIDE_OFFER_MS = 14 * DAY;
const CANDIDATE_LIMIT = 25;
/** Drafts the user can still edit and send: waiting, or a send that failed. */
const EDITABLE: ReadonlySet<MailboxComposeDraft["status"]> = new Set([
  "local",
  "provider",
  "failed",
]);

const EMPTY_STATE: MailReplyDraftsState = { enabled: false, prepared: [], hiddenThreads: {} };

function startOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function stripReplyPrefix(subject: string): string {
  return subject.replace(/^\s*((re|aw|sv|fwd?):\s*)+/i, "").trim() || "(no subject)";
}

function personLabel(person: { name?: string; email: string } | undefined): string {
  return person?.name?.trim() || person?.email || "Someone";
}

export class MailReplyDraftsService {
  private drafting: Promise<number> | null = null;

  constructor(private readonly deps: MailReplyDraftsDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private state(): MailReplyDraftsState {
    const stored = this.deps.loadState();
    return {
      ...EMPTY_STATE,
      ...stored,
      prepared: Array.isArray(stored?.prepared) ? stored.prepared : [],
      hiddenThreads: stored?.hiddenThreads ?? {},
    };
  }

  /** Saves the state with expired entries dropped. */
  private save(state: MailReplyDraftsState): void {
    const now = this.now();
    const hiddenThreads: Record<string, number> = {};
    for (const [threadId, until] of Object.entries(state.hiddenThreads)) {
      if (until > now) hiddenThreads[threadId] = until;
    }
    this.deps.saveState({
      ...state,
      prepared: state.prepared.filter((entry) => entry.at > now - REMEMBER_MS),
      hiddenThreads,
    });
  }

  isEnabled(): boolean {
    return this.state().enabled;
  }

  setEnabled(enabled: boolean): void {
    this.save({ ...this.state(), enabled });
    if (enabled) void this.draftReplies().catch(() => 0);
  }

  dismissOffer(): void {
    this.save({ ...this.state(), offerHiddenUntil: this.now() + HIDE_OFFER_MS });
  }

  /** Whether Today should offer to turn drafting on: mail is connected and some needs a reply. */
  async shouldOffer(): Promise<boolean> {
    const state = this.state();
    if (state.enabled || (state.offerHiddenUntil ?? 0) > this.now()) return false;
    const status = await this.deps.mailbox.getSyncStatus();
    return (
      status.needsReplyCount > 0 &&
      status.accounts.some((account) => account.status !== "disconnected")
    );
  }

  /**
   * Drafts replies until today's allowance is used. Returns how many it drafted. One run at
   * a time; a model error ends the run so a broken setup isn't retried thread by thread.
   */
  draftReplies(): Promise<number> {
    if (!this.drafting) {
      this.drafting = this.runDrafting()
        .then((count) => {
          if (count > 0) this.deps.onPrepared?.(count);
          return count;
        })
        .finally(() => {
          this.drafting = null;
        });
    }
    return this.drafting;
  }

  private async runDrafting(): Promise<number> {
    let state = this.state();
    if (!state.enabled) return 0;
    const now = this.now();
    const today = startOfDay(now);
    let remaining =
      MAIL_REPLY_DRAFTS_PER_DAY - state.prepared.filter((entry) => entry.at >= today).length;
    if (remaining <= 0) return 0;

    const { accounts } = await this.deps.mailbox.getSyncStatus();
    const addresses = new Map(accounts.map((account) => [account.id, account.address]));
    const drafted = new Set(state.prepared.map((entry) => entry.threadId));
    const candidates = (
      await this.deps.mailbox.listThreads({
        needsReply: true,
        mailboxView: "inbox",
        sortBy: "priority",
        limit: CANDIDATE_LIMIT,
      })
    ).filter(
      (thread) =>
        thread.needsReply &&
        !thread.handled &&
        !thread.hasSensitiveContent &&
        !drafted.has(thread.id) &&
        (state.hiddenThreads[thread.id] ?? 0) <= now,
    );

    let count = 0;
    for (const candidate of candidates) {
      if (remaining <= 0) break;
      const thread = await this.deps.mailbox.getThread(candidate.id);
      if (!thread || thread.sensitiveContent?.hasSensitiveContent) continue;
      const latest = thread.messages[thread.messages.length - 1];
      // Already answered, or nothing to answer.
      if (!latest || latest.direction !== "incoming") continue;
      if (getMailboxNoReplySender(thread.messages, thread.participants)) continue;

      const result = await this.deps.writeReply({
        threadId: thread.id,
        subject: thread.subject,
        userAddress: addresses.get(thread.accountId) ?? "",
        messages: thread.messages.slice(-4).map((message) => ({
          from: personLabel(message.from),
          incoming: message.direction === "incoming",
          at: message.receivedAt,
          body: message.body || message.snippet,
        })),
      });
      if ("error" in result) break;
      state = this.state();
      if ("skip" in result) {
        state.hiddenThreads[thread.id] = now + HIDE_THREAD_MS;
        this.save(state);
        continue;
      }
      const draft = await this.deps.mailbox.createMailboxDraft({
        mode: "reply",
        threadId: thread.id,
        accountId: thread.accountId,
        bodyText: result.body,
      });
      if (draft.to.length === 0) {
        // Nobody to reply to: don't leave an empty draft behind.
        await this.deps.mailbox.discardMailboxDraft(draft.id);
        state.hiddenThreads[thread.id] = now + HIDE_THREAD_MS;
        this.save(state);
        continue;
      }
      state.prepared.push({
        draftId: draft.id,
        threadId: thread.id,
        subject: stripReplyPrefix(thread.subject),
        sender: personLabel(latest.from),
        at: this.now(),
      });
      this.save(state);
      remaining -= 1;
      count += 1;
    }
    return count;
  }

  /**
   * Prepared drafts still waiting: editable, recent, and their thread still needs a reply.
   * Turning drafting off stops new drafts; the ones already made stay until sent or discarded.
   */
  async list(): Promise<MailReplyDraftCard[]> {
    const state = this.state();
    const now = this.now();
    const recent = state.prepared.filter((entry) => entry.at > now - SHOW_MS);
    if (recent.length === 0) return [];
    const threads = new Map(
      (
        await this.deps.mailbox.listThreads({ needsReply: true, mailboxView: "inbox", limit: 100 })
      ).map((thread) => [thread.id, thread]),
    );
    const cards: MailReplyDraftCard[] = [];
    for (const entry of recent) {
      const thread = threads.get(entry.threadId);
      if (!thread || thread.handled) continue;
      const draft = await this.deps.mailbox.getMailboxDraft(entry.draftId);
      if (!draft || !EDITABLE.has(draft.status)) continue;
      cards.push({
        draftId: draft.id,
        threadId: entry.threadId,
        accountId: draft.accountId,
        provider: thread.provider,
        subject: entry.subject,
        to: draft.to.map(personLabel),
        sender: entry.sender,
        bodyText: draft.bodyText,
        createdAt: entry.at,
        ...(draft.status === "failed"
          ? { failed: draft.latestError || "The mail server didn't take it." }
          : {}),
      });
    }
    return cards.sort((a, b) => b.createdAt - a.createdAt);
  }

  private prepared(draftId: string): MailReplyDraftsState["prepared"][number] | undefined {
    return this.state().prepared.find((entry) => entry.draftId === draftId);
  }

  /** Queues the draft in the outbox; it goes out after the send delay unless undone. */
  async send(draftId: string): Promise<MailReplyDraftOutcome> {
    if (!this.prepared(draftId)) {
      return { ok: false, reason: "not_found", message: "That draft isn't one of today's." };
    }
    const draft = await this.deps.mailbox.getMailboxDraft(draftId);
    if (!draft || !EDITABLE.has(draft.status)) {
      return { ok: false, reason: "gone", message: "That draft was already sent or removed." };
    }
    try {
      const outgoing = await this.deps.mailbox.sendMailboxDraft(draftId);
      return { ok: true, ...(outgoing.sendAfter ? { sendAfter: outgoing.sendAfter } : {}) };
    } catch (error) {
      return {
        ok: false,
        reason: "failed",
        message: error instanceof Error ? error.message : "It couldn't be sent.",
      };
    }
  }

  /** Takes back a send that hasn't gone out; the draft can be edited again. */
  async undoSend(draftId: string): Promise<MailReplyDraftOutcome> {
    if (!this.prepared(draftId)) {
      return { ok: false, reason: "not_found", message: "That draft isn't one of today's." };
    }
    return (await this.deps.mailbox.cancelMailboxDraftSend(draftId))
      ? { ok: true }
      : { ok: false, reason: "too_late", message: "It's already on its way." };
  }

  /** Discards the draft and doesn't draft that thread again for a while. */
  async discard(draftId: string): Promise<MailReplyDraftOutcome> {
    const entry = this.prepared(draftId);
    if (!entry) {
      return { ok: false, reason: "not_found", message: "That draft isn't one of today's." };
    }
    await this.deps.mailbox.discardMailboxDraft(draftId);
    const state = this.state();
    state.hiddenThreads[entry.threadId] = this.now() + HIDE_THREAD_MS;
    this.save(state);
    return { ok: true };
  }
}
