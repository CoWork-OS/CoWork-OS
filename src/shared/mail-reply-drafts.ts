/**
 * Reply drafts on Today: with the user's opt-in, CoWork drafts a few replies a day to mail
 * that needs a reply. Each is an ordinary compose draft; Today shows it with Send (through
 * the outbox, with its undo window), Edit and Discard. Nothing is sent without a click.
 */
import type { MailboxProvider } from "./mailbox";

/** Drafts prepared per day, at most. */
export const MAIL_REPLY_DRAFTS_PER_DAY = 3;

/** A prepared reply as Today shows it. */
export interface MailReplyDraftCard {
  draftId: string;
  threadId: string;
  accountId: string;
  provider: MailboxProvider;
  /** The thread's subject, without "Re:". */
  subject: string;
  /** Who the reply goes to, as "Name <address>" or the address. */
  to: string[];
  /** How many more people get a copy (cc and bcc). */
  copies: number;
  attachments: number;
  /** Who is waiting on the reply. */
  sender: string;
  bodyText: string;
  createdAt: number;
  /** Set when sending failed: why, so the card can say it wasn't sent. */
  failed?: string;
  /** With `failed`: the outbox will try again on its own. */
  retrying?: boolean;
  /** Set while the reply waits in the outbox: when it goes out (it can be undone until then). */
  sendingUntil?: number;
  /** A newer message arrived in the thread after the reply was drafted. */
  outdated?: boolean;
}

export type MailReplyDraftOutcome =
  | { ok: true; sendAfter?: number }
  | { ok: false; reason: "not_found" | "gone" | "too_late" | "failed"; message: string };
