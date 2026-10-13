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
  /** False when the state couldn't be saved. */
  saveState: (state: CalendarProposalsState) => boolean;
  workday?: CalendarWorkday;
  now?: () => number;
}

export type CalendarProposalOutcome =
  | { ok: true; kind: CalendarProposal["kind"] }
  | { ok: false; reason: "not_connected" | "gone" | "not_allowed" | "failed"; message: string };

const DAY = 24 * 60 * 60 * 1000;
/** A dismissed or accepted proposal stays hidden this long (its id names the event times). */
const HIDE_MS = 14 * DAY;
const HOLD_MIN_MS = 15 * 60 * 1000;
const HOLD_MAX_MS = 3 * 60 * 60 * 1000;
const HOLD_HORIZON_MS = 7 * DAY;
/** Hidden ids kept at most; the ones that expire soonest go first. */
const MAX_HIDDEN = 200;

const BUSY: CalendarProposalOutcome = {
  ok: false,
  reason: "failed",
  message: "That's already being done.",
};

export class CalendarProposalsService {
  /** Changes under way (by proposal id, or any suggestion hold), so a double click makes one. */
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: CalendarProposalsDeps) {}

  private async once(
    key: string,
    change: () => Promise<CalendarProposalOutcome>,
  ): Promise<CalendarProposalOutcome> {
    if (this.inFlight.has(key)) return BUSY;
    this.inFlight.add(key);
    try {
      return await change();
    } finally {
      this.inFlight.delete(key);
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private hiddenIds(): Set<string> {
    const now = this.now();
    const hidden = this.deps.loadState()?.hidden ?? {};
    return new Set(Object.entries(hidden).flatMap(([id, until]) => (until > now ? [id] : [])));
  }

  private hide(id: string): boolean {
    const now = this.now();
    const current = this.deps.loadState()?.hidden ?? {};
    const kept = Object.entries(current)
      .filter(([key, until]) => key !== id && until > now)
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_HIDDEN - 1);
    return this.deps.saveState({ hidden: { ...Object.fromEntries(kept), [id]: now + HIDE_MS } });
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

  /** False when it couldn't be saved, so the card would come back. */
  dismiss(id: string): boolean {
    return this.hide(id);
  }

  /**
   * Does what the card offered: books a focus hold, or declines the second of two
   * conflicting events. Meeting prep has no calendar change: the card starts a task, and
   * this records the proposal as handled.
   */
  accept(id: string): Promise<CalendarProposalOutcome> {
    return this.once(`accept:${id}`, () => this.acceptNow(id));
  }

  private async acceptNow(id: string): Promise<CalendarProposalOutcome> {
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
    // The change is made; a card that can't be hidden only comes back, so it isn't a failure.
    try {
      this.hide(id);
    } catch {
      // Shown again on the next read.
    }
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
  bookHold(hold: { title: string; start: number; end: number }): Promise<CalendarProposalOutcome> {
    // One at a time: two holds checked against the same free time would overlap.
    return this.once("hold-for-suggestion", () => this.bookHoldNow(hold));
  }

  private async bookHoldNow(hold: {
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
      hold.end - hold.start < HOLD_MIN_MS ||
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
