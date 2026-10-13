/**
 * Today's calendar cards: accept or dismiss a proposal, and hold time for a suggestion.
 * Inputs are validated here; what to change is always re-derived in the main process from
 * fresh calendar data (CalendarProposalsService), never taken from the renderer.
 */
import { ipcMain } from "electron";
import { z } from "zod";
import { IPC_CHANNELS } from "../../shared/types";
import type {
  CalendarProposalOutcome,
  CalendarProposalsService,
} from "../calendar/CalendarProposalsService";
import { RATE_LIMIT_CONFIGS, rateLimiter } from "../utils/rate-limiter";
import { UUIDSchema, WorkspaceIdSchema, validateInput } from "../utils/validation";

const ProposalIdSchema = z
  .string()
  .min(1)
  .max(400)
  .regex(/^(conflict|hold|prep):[^\s]+$/, "Not a calendar proposal");
const HoldRequestSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    suggestionId: UUIDSchema,
    start: z.number().int().positive(),
    end: z.number().int().positive(),
  })
  .strict();

export interface CalendarIpcDeps {
  proposals: Pick<CalendarProposalsService, "accept" | "dismiss" | "bookHold">;
  /** The stored suggestion's title, or null when it isn't an active suggestion. */
  getSuggestionTitle: (workspaceId: string, suggestionId: string) => Promise<string | null>;
  /** Records the suggestion as acted on once its hold is booked. */
  markSuggestionActedOn: (workspaceId: string, suggestionId: string) => Promise<void>;
  onChanged?: () => void;
  checkRateLimit?: (channel: string) => void;
}

const MUTATING_CHANNELS = [
  IPC_CHANNELS.CALENDAR_PROPOSAL_ACCEPT,
  IPC_CHANNELS.CALENDAR_PROPOSAL_DISMISS,
  IPC_CHANNELS.CALENDAR_HOLD_FOR_SUGGESTION,
] as const;

function defaultRateLimit(channel: string): void {
  if (!rateLimiter.check(channel)) {
    const resetSec = Math.ceil(rateLimiter.getResetTime(channel) / 1000);
    throw new Error(`Rate limit exceeded. Try again in ${resetSec} seconds.`);
  }
}

type Handler = (...args: unknown[]) => Promise<unknown>;

/** The handlers by channel, independent of Electron (tests call them directly). */
export function createCalendarIpcHandlers(deps: CalendarIpcDeps): Record<string, Handler> {
  const limit = deps.checkRateLimit ?? defaultRateLimit;
  return {
    [IPC_CHANNELS.CALENDAR_PROPOSAL_ACCEPT]: async (raw) => {
      limit(IPC_CHANNELS.CALENDAR_PROPOSAL_ACCEPT);
      const id = validateInput(ProposalIdSchema, raw, "calendar proposal");
      const outcome = await deps.proposals.accept(id);
      if (outcome.ok) deps.onChanged?.();
      return outcome;
    },
    [IPC_CHANNELS.CALENDAR_PROPOSAL_DISMISS]: async (raw) => {
      limit(IPC_CHANNELS.CALENDAR_PROPOSAL_DISMISS);
      const id = validateInput(ProposalIdSchema, raw, "calendar proposal");
      if (!deps.proposals.dismiss(id)) return { ok: false };
      deps.onChanged?.();
      return { ok: true };
    },
    [IPC_CHANNELS.CALENDAR_HOLD_FOR_SUGGESTION]: async (raw): Promise<CalendarProposalOutcome> => {
      limit(IPC_CHANNELS.CALENDAR_HOLD_FOR_SUGGESTION);
      const request = validateInput(HoldRequestSchema, raw, "calendar hold");
      const title = await deps.getSuggestionTitle(request.workspaceId, request.suggestionId);
      if (!title) {
        return { ok: false, reason: "gone", message: "That suggestion is no longer active." };
      }
      const outcome = await deps.proposals.bookHold({
        title: `Focus: ${title}`,
        start: request.start,
        end: request.end,
      });
      if (outcome.ok) {
        await deps.markSuggestionActedOn(request.workspaceId, request.suggestionId).catch(() => {});
        deps.onChanged?.();
      }
      return outcome;
    },
  };
}

export function setupCalendarHandlers(deps: CalendarIpcDeps): void {
  for (const channel of MUTATING_CHANNELS) {
    rateLimiter.configure(channel, RATE_LIMIT_CONFIGS.limited);
  }
  const handlers = createCalendarIpcHandlers(deps);
  for (const [channel, handle] of Object.entries(handlers)) {
    // These change the user's calendar: only the app's own top-level window may ask.
    ipcMain.handle(channel, (event, raw: unknown) => {
      if (!event.senderFrame || event.senderFrame.parent !== null) {
        throw new Error("Calendar changes are only available to the app window");
      }
      return handle(raw);
    });
  }
}
