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
  /** Who the reply goes to, by name or address. */
  to: string[];
  /** Who is waiting on the reply. */
  sender: string;
  bodyText: string;
  createdAt: number;
  /** Set when sending failed: why, so the card can say it wasn't sent. */
  failed?: string;
}

export type MailReplyDraftOutcome =
  | { ok: true; sendAfter?: number }
  | { ok: false; reason: "not_found" | "gone" | "too_late" | "failed"; message: string };
