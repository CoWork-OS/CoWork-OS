/**
 * Reply drafts on Today (opt-in, off by default). A few times an hour it drafts replies,
 * at most MAIL_REPLY_DRAFTS_PER_DAY a day, to threads that need one, and saves each as an
 * ordinary compose draft. Today shows the drafts; sending goes through the outbox, whose
 * delay is the undo window, and undoing returns the draft to editing.
 *
 * Card actions only act on drafts this service prepared, looked up by id in its own state.
 * That guards against UI mistakes; the general mailbox IPC can already act on any draft.
 */
import {
  getMailboxNoReplySender,
  type MailboxComposeDraft,
  type MailboxComposeDraftInput,
  type MailboxOutgoingMessage,
  type MailboxRecipientInput,
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
    /** The thread's latest message when drafted; a newer one makes the draft out of date. */
    lastMessageAt?: number;
  }>;
  /** Threads not to draft for a while: the user discarded the draft, or no reply fits. */
  hiddenThreads: Record<string, number>;
}

export interface MailReplyDraftsDeps {
  mailbox: {
    getSyncStatus(): Promise<Pick<MailboxSyncStatus, "accounts" | "needsReplyCount">>;
    listThreads(input: MailboxListThreadsInput): Promise<MailboxThreadListItem[]>;
    getThread(threadId: string): Promise<MailboxThreadDetail | null>;
    createMailboxDraft(
      input: MailboxComposeDraftInput,
      options?: { source?: "today_reply_draft" },
    ): Promise<MailboxComposeDraft>;
    getMailboxDraft(draftId: string): Promise<MailboxComposeDraft | null>;
    sendMailboxDraft(draftId: string): Promise<MailboxOutgoingMessage>;
    hasActiveDraftSend(draftId: string): Promise<boolean>;
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
  /**
   * Changes the state in one read-modify-write, so a click (Stop, Discard) during a run is
   * never overwritten. False when it couldn't be saved.
   */
  updateState(mutate: (state: MailReplyDraftsState) => MailReplyDraftsState): boolean;
  /** Called after a run that drafted something, so Today can show it. */
  onPrepared?: (count: number) => void;
  now?: () => number;
}

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
/** Prepared drafts are shown for three days, and remembered for a week. */
const SHOW_MS = 3 * DAY;
const REMEMBER_MS = 7 * DAY;
const HIDE_THREAD_MS = 14 * DAY;
const HIDE_OFFER_MS = 14 * DAY;
/** After the model fails (not set up, unreachable), wait this long before trying again. */
const MODEL_BACKOFF_MS = 2 * 60 * MINUTE;
/** The offer's answer is reused this long: it is read with every queue snapshot. */
const OFFER_CACHE_MS = 5 * MINUTE;
const CANDIDATE_LIMIT = 25;
const LIST_LIMIT = 100;
/** Bulk mail that a reply rarely fits. */
const SKIPPED_CATEGORIES: ReadonlySet<MailboxThreadListItem["category"]> = new Set([
  "promotions",
  "updates",
]);
/** Drafts the user can still edit and send: waiting, or a send that failed. */
const EDITABLE: ReadonlySet<MailboxComposeDraft["status"]> = new Set([
  "local",
  "provider",
  "failed",
]);
/** One plain address: no lists, groups or display parts hiding a second recipient. */
const PLAIN_ADDRESS = /^[^\s@,;:<>()"[\]]+@[^\s@,;:<>()"[\]]+\.[^\s@,;:<>()"[\]]+$/;

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

/** "Dana <dana@example.com>", so a display name can't pass for someone else. */
function recipientLabel(person: MailboxRecipientInput): string {
  const name = person.name?.trim();
  return name && name.toLowerCase() !== person.email.toLowerCase()
    ? `${name} <${person.email}>`
    : person.email;
}

function plainRecipients(draft: MailboxComposeDraft): boolean {
  const all = [...draft.to, ...draft.cc, ...draft.bcc];
  return all.length > 0 && all.every((person) => PLAIN_ADDRESS.test(person.email.trim()));
}

function withState(stored: MailReplyDraftsState | undefined): MailReplyDraftsState {
  return {
    ...EMPTY_STATE,
    ...stored,
    prepared: Array.isArray(stored?.prepared) ? stored.prepared : [],
    hiddenThreads: stored?.hiddenThreads ?? {},
  };
}

export class MailReplyDraftsService {
  private drafting: Promise<number> | null = null;
  private modelBackoffUntil = 0;
  private offerCache: { at: number; value: boolean } | null = null;
  /** Drafts being sent right now, so a double click queues one send. */
  private readonly sending = new Set<string>();

  constructor(private readonly deps: MailReplyDraftsDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private state(): MailReplyDraftsState {
    return withState(this.deps.loadState());
  }

  /** Applies a change to the latest state, dropping expired entries. */
  private update(change: (state: MailReplyDraftsState) => MailReplyDraftsState): boolean {
    const now = this.now();
    try {
      return this.deps.updateState((current) => {
        const next = change(withState(current));
        const hiddenThreads: Record<string, number> = {};
        for (const [threadId, until] of Object.entries(next.hiddenThreads)) {
          if (until > now) hiddenThreads[threadId] = until;
        }
        return {
          ...next,
          prepared: next.prepared.filter((entry) => entry.at > now - REMEMBER_MS),
          hiddenThreads,
        };
      });
    } catch {
      return false;
    }
  }

  private hideThread(threadId: string): boolean {
    const until = this.now() + HIDE_THREAD_MS;
    return this.update((state) => ({
      ...state,
      hiddenThreads: { ...state.hiddenThreads, [threadId]: until },
    }));
  }

  isEnabled(): boolean {
    return this.state().enabled;
  }

  setEnabled(enabled: boolean): boolean {
    const saved = this.update((state) => ({ ...state, enabled }));
    this.offerCache = null;
    if (saved && enabled) void this.draftReplies().catch(() => 0);
    return saved;
  }

  dismissOffer(): boolean {
    const until = this.now() + HIDE_OFFER_MS;
    this.offerCache = null;
    return this.update((state) => ({ ...state, offerHiddenUntil: until }));
  }

  /** Whether Today should offer to turn drafting on: mail is connected and some needs a reply. */
  async shouldOffer(): Promise<boolean> {
    const now = this.now();
    const state = this.state();
    if (state.enabled || (state.offerHiddenUntil ?? 0) > now) return false;
    if (this.offerCache && now - this.offerCache.at < OFFER_CACHE_MS) return this.offerCache.value;
    const status = await this.deps.mailbox.getSyncStatus();
    const value =
      status.needsReplyCount > 0 &&
      status.accounts.some((account) => account.status !== "disconnected");
    this.offerCache = { at: now, value };
    return value;
  }

  /**
   * Drafts replies until today's allowance is used. Returns how many it drafted. One run at
   * a time; a model failure ends the run and pauses drafting for a while.
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
    const state = this.state();
    const now = this.now();
    if (!state.enabled || now < this.modelBackoffUntil) return 0;
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
        !SKIPPED_CATEGORIES.has(thread.category) &&
        !drafted.has(thread.id) &&
        (state.hiddenThreads[thread.id] ?? 0) <= now,
    );

    let count = 0;
    for (const candidate of candidates) {
      // Stopped while this run was under way: nothing more is read or drafted.
      if (remaining <= 0 || !this.isEnabled()) break;
      const thread = await this.deps.mailbox.getThread(candidate.id);
      if (!thread || thread.sensitiveContent?.hasSensitiveContent) continue;
      const latest = thread.messages[thread.messages.length - 1];
      // Already answered, or nothing to answer.
      if (!latest || latest.direction !== "incoming") continue;
      if (getMailboxNoReplySender(thread.messages, thread.participants)) continue;
      if (!this.isEnabled()) break;

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
      if ("error" in result) {
        this.modelBackoffUntil = this.now() + MODEL_BACKOFF_MS;
        break;
      }
      // No reply fits, or the thread steered the model off course: set that thread aside.
      if ("skip" in result || "unusable" in result) {
        this.hideThread(thread.id);
        continue;
      }
      if (!this.isEnabled()) break;
      const draft = await this.deps.mailbox.createMailboxDraft(
        { mode: "reply", threadId: thread.id, accountId: thread.accountId, bodyText: result.body },
        { source: "today_reply_draft" },
      );
      if (!plainRecipients(draft)) {
        // Nobody to reply to, or an address that could hide another recipient.
        await this.deps.mailbox.discardMailboxDraft(draft.id);
        this.hideThread(thread.id);
        continue;
      }
      const entry = {
        draftId: draft.id,
        threadId: thread.id,
        subject: stripReplyPrefix(thread.subject),
        sender: personLabel(latest.from),
        at: this.now(),
        lastMessageAt: thread.lastMessageAt,
      };
      if (!this.update((current) => ({ ...current, prepared: [...current.prepared, entry] }))) {
        // Unrecorded drafts would escape the daily cap: undo it and stop.
        await this.deps.mailbox.discardMailboxDraft(draft.id);
        break;
      }
      remaining -= 1;
      count += 1;
    }
    return count;
  }

  /**
   * Prepared drafts still waiting on the user: editable (or in the outbox, still undoable),
   * recent, and their thread still needs a reply. Turning drafting off stops new drafts;
   * the ones already made stay until sent or discarded.
   */
  async list(): Promise<MailReplyDraftCard[]> {
    const state = this.state();
    const now = this.now();
    const recent = state.prepared.filter((entry) => entry.at > now - SHOW_MS);
    if (recent.length === 0) return [];
    const threads = new Map(
      (
        await this.deps.mailbox.listThreads({
          needsReply: true,
          mailboxView: "inbox",
          limit: LIST_LIMIT,
        })
      ).map((thread) => [thread.id, thread]),
    );
    const cards: MailReplyDraftCard[] = [];
    for (const entry of recent) {
      const thread = threads.get(entry.threadId);
      if (!thread || thread.handled) continue;
      const draft = await this.deps.mailbox.getMailboxDraft(entry.draftId);
      if (!draft) continue;
      const queued = draft.status === "queued" || draft.status === "scheduled";
      if (queued && !(draft.sendAfter && draft.sendAfter > now)) continue;
      if (!queued && !EDITABLE.has(draft.status)) continue;
      // A failed send the outbox will try again: shown, but only to stop it.
      const retrying =
        draft.status === "failed" && (await this.deps.mailbox.hasActiveDraftSend(draft.id));
      cards.push({
        draftId: draft.id,
        threadId: entry.threadId,
        accountId: draft.accountId,
        provider: thread.provider,
        subject: entry.subject,
        to: draft.to.map(recipientLabel),
        copies: draft.cc.length + draft.bcc.length,
        attachments: draft.attachments.length,
        sender: entry.sender,
        bodyText: draft.bodyText,
        createdAt: entry.at,
        ...(queued ? { sendingUntil: draft.sendAfter } : {}),
        ...(draft.status === "failed"
          ? { failed: draft.latestError || "The mail server didn't take it." }
          : {}),
        ...(retrying ? { retrying: true } : {}),
        ...(entry.lastMessageAt && thread.lastMessageAt > entry.lastMessageAt
          ? { outdated: true }
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
    if (this.sending.has(draftId)) {
      return { ok: false, reason: "gone", message: "It's already being sent." };
    }
    this.sending.add(draftId);
    try {
      const draft = await this.deps.mailbox.getMailboxDraft(draftId);
      if (!draft || !EDITABLE.has(draft.status)) {
        return { ok: false, reason: "gone", message: "That draft was already sent or removed." };
      }
      if (await this.deps.mailbox.hasActiveDraftSend(draftId)) {
        return { ok: false, reason: "gone", message: "It's already being sent." };
      }
      if (!plainRecipients(draft)) {
        return {
          ok: false,
          reason: "failed",
          message: "Check the recipients in your mailbox drafts before sending.",
        };
      }
      const outgoing = await this.deps.mailbox.sendMailboxDraft(draftId);
      return { ok: true, ...(outgoing.sendAfter ? { sendAfter: outgoing.sendAfter } : {}) };
    } catch (error) {
      return {
        ok: false,
        reason: "failed",
        message: error instanceof Error ? error.message : "It couldn't be sent.",
      };
    } finally {
      this.sending.delete(draftId);
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
    this.hideThread(entry.threadId);
    return { ok: true };
  }
}
