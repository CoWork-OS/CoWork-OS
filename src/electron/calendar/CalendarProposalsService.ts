/**
 * Today's calendar cards: proposals built from upcoming events and due commitments
 * (shared/calendar-proposals.ts), the ones the user already dismissed or accepted, and the
 * changes accepting one makes. Every change re-reads the calendar first and re-derives the
 * proposal by id, so a card can never act on stale or renderer-supplied details.
 */
import {
  buildCalendarProposals,
  findFreeSlot,
  isSlotFree,
  type CalendarCommitment,
  type CalendarProposal,
  type CalendarWorkday,
} from "../../shared/calendar-proposals";
import type { CalendarService } from "./CalendarService";

export interface CalendarProposalsState {
  /** Proposal id -> until when it stays hidden. */
  hidden: Record<string, number>;
}

export interface CalendarProposalsDeps {
  calendar: Pick<CalendarService, "isConnected" | "listUpcoming" | "createHold" | "declineEvent">;
  /** Open commitments due soon (the user's own and mailbox ones). */
  listCommitments: () => Promise<CalendarCommitment[]> | CalendarCommitment[];
  loadState: () => CalendarProposalsState | undefined;
  saveState: (state: CalendarProposalsState) => void;
  workday?: CalendarWorkday;
  now?: () => number;
}

export type CalendarProposalOutcome =
  | { ok: true; kind: CalendarProposal["kind"] }
  | { ok: false; reason: "not_connected" | "gone" | "not_allowed" | "failed"; message: string };

const DAY = 24 * 60 * 60 * 1000;
/** A dismissed or accepted proposal stays hidden this long (its id names the event times). */
const HIDE_MS = 14 * DAY;
const HOLD_MAX_MS = 3 * 60 * 60 * 1000;
const HOLD_HORIZON_MS = 7 * DAY;

export class CalendarProposalsService {
  constructor(private readonly deps: CalendarProposalsDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private hiddenIds(): Set<string> {
    const now = this.now();
    const hidden = this.deps.loadState()?.hidden ?? {};
    return new Set(Object.entries(hidden).flatMap(([id, until]) => (until > now ? [id] : [])));
  }

  private hide(id: string): void {
    const now = this.now();
    const current = this.deps.loadState()?.hidden ?? {};
    const hidden: Record<string, number> = {};
    for (const [key, until] of Object.entries(current)) if (until > now) hidden[key] = until;
    hidden[id] = now + HIDE_MS;
    this.deps.saveState({ hidden });
  }

  /** The proposals to show; none when no calendar is connected. */
  async list(opts: { fresh?: boolean } = {}): Promise<CalendarProposal[]> {
    if (!this.deps.calendar.isConnected()) return [];
    const [events, commitments] = await Promise.all([
      this.deps.calendar.listUpcoming(3, opts),
      this.deps.listCommitments(),
    ]);
    return buildCalendarProposals({
      events,
      commitments,
      now: this.now(),
      workday: this.deps.workday,
      skip: this.hiddenIds(),
    });
  }

  dismiss(id: string): void {
    this.hide(id);
  }

  /**
   * Does what the card offered: books a focus hold, or declines the second of two
   * conflicting events. Meeting prep has no calendar change: the card starts a task, and
   * this records the proposal as handled.
   */
  async accept(id: string): Promise<CalendarProposalOutcome> {
    if (!this.deps.calendar.isConnected()) {
      return { ok: false, reason: "not_connected", message: "No calendar is connected." };
    }
    let proposal: CalendarProposal | undefined;
    try {
      proposal = (await this.list({ fresh: true })).find((item) => item.id === id);
    } catch {
      return { ok: false, reason: "failed", message: "Your calendar couldn't be read." };
    }
    if (!proposal) {
      return { ok: false, reason: "gone", message: "This no longer applies to your calendar." };
    }
    try {
      if (proposal.kind === "focus_hold") {
        await this.deps.calendar.createHold({
          title: `Focus: ${proposal.title}`,
          start: proposal.start,
          end: proposal.end,
        });
      } else if (proposal.kind === "conflict") {
        if (!proposal.canDeclineSecond) {
          return {
            ok: false,
            reason: "not_allowed",
            message: "You organize that event, so it can't be declined here.",
          };
        }
        await this.deps.calendar.declineEvent(proposal.second.eventId);
      }
    } catch (error) {
      return {
        ok: false,
        reason: "failed",
        message: error instanceof Error ? error.message : "The calendar change didn't go through.",
      };
    }
    this.hide(id);
    return { ok: true, kind: proposal.kind };
  }

  /** The first free 90 minutes in the next three working days, for a suggestion's hold. */
  async suggestedHold(): Promise<{ start: number; end: number } | null> {
    if (!this.deps.calendar.isConnected()) return null;
    const now = this.now();
    const events = await this.deps.calendar.listUpcoming(3);
    return findFreeSlot(events, now + 30 * 60 * 1000, now + 3 * DAY, 90, this.deps.workday);
  }

  /**
   * Books a hold the user accepted from a suggestion card, after checking the time they
   * saw is still free, in the future, within a week and at most three hours long.
   */
  async bookHold(hold: {
    title: string;
    start: number;
    end: number;
  }): Promise<CalendarProposalOutcome> {
    if (!this.deps.calendar.isConnected()) {
      return { ok: false, reason: "not_connected", message: "No calendar is connected." };
    }
    const now = this.now();
    if (
      !Number.isFinite(hold.start) ||
      !Number.isFinite(hold.end) ||
      hold.start < now ||
      hold.end <= hold.start ||
      hold.end - hold.start > HOLD_MAX_MS ||
      hold.start > now + HOLD_HORIZON_MS
    ) {
      return { ok: false, reason: "not_allowed", message: "That time can't be held." };
    }
    let events;
    try {
      events = await this.deps.calendar.listUpcoming(8, { fresh: true });
    } catch {
      return { ok: false, reason: "failed", message: "Your calendar couldn't be read." };
    }
    if (!isSlotFree(events, hold)) {
      return { ok: false, reason: "gone", message: "That time isn't free any more." };
    }
    try {
      await this.deps.calendar.createHold(hold);
    } catch (error) {
      return {
        ok: false,
        reason: "failed",
        message: error instanceof Error ? error.message : "The calendar change didn't go through.",
      };
    }
    return { ok: true, kind: "focus_hold" };
  }
}
