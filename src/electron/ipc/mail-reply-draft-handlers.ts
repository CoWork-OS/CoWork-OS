/**
 * Reply drafts on Today: send (through the outbox), undo a send, discard, and turn drafting
 * on or off. Card actions name a draft by id; the service acts only on drafts it prepared.
 */
import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import { IPC_CHANNELS } from "../../shared/types";
import type { MailReplyDraftsService } from "../mailbox/MailReplyDraftsService";
import { RATE_LIMIT_CONFIGS, rateLimiter } from "../utils/rate-limiter";
import { UUIDSchema, validateInput } from "../utils/validation";

const EnabledSchema = z.boolean();

export interface MailReplyDraftIpcDeps {
  drafts: Pick<
    MailReplyDraftsService,
    "send" | "undoSend" | "discard" | "setEnabled" | "dismissOffer"
  >;
  onChanged?: () => void;
  checkRateLimit?: (channel: string) => void;
  /** Throws unless the call comes from the main app window, as other mailbox calls do. */
  assertTrustedSender?: (event: IpcMainInvokeEvent) => void;
}

const CHANNELS = [
  IPC_CHANNELS.MAIL_REPLY_DRAFT_SEND,
  IPC_CHANNELS.MAIL_REPLY_DRAFT_UNDO_SEND,
  IPC_CHANNELS.MAIL_REPLY_DRAFT_DISCARD,
  IPC_CHANNELS.MAIL_REPLY_DRAFTS_SET_ENABLED,
  IPC_CHANNELS.MAIL_REPLY_DRAFTS_DISMISS_OFFER,
] as const;

function defaultRateLimit(channel: string): void {
  if (!rateLimiter.check(channel)) {
    const resetSec = Math.ceil(rateLimiter.getResetTime(channel) / 1000);
    throw new Error(`Rate limit exceeded. Try again in ${resetSec} seconds.`);
  }
}

type Handler = (...args: unknown[]) => Promise<unknown>;

/** The handlers by channel, independent of Electron (tests call them directly). */
export function createMailReplyDraftIpcHandlers(
  deps: MailReplyDraftIpcDeps,
): Record<string, Handler> {
  const limit = deps.checkRateLimit ?? defaultRateLimit;
  const changed = <T extends { ok: boolean }>(outcome: T): T => {
    if (outcome.ok) deps.onChanged?.();
    return outcome;
  };
  return {
    [IPC_CHANNELS.MAIL_REPLY_DRAFT_SEND]: async (raw) => {
      limit(IPC_CHANNELS.MAIL_REPLY_DRAFT_SEND);
      return changed(await deps.drafts.send(validateInput(UUIDSchema, raw, "draft id")));
    },
    [IPC_CHANNELS.MAIL_REPLY_DRAFT_UNDO_SEND]: async (raw) => {
      limit(IPC_CHANNELS.MAIL_REPLY_DRAFT_UNDO_SEND);
      return changed(await deps.drafts.undoSend(validateInput(UUIDSchema, raw, "draft id")));
    },
    [IPC_CHANNELS.MAIL_REPLY_DRAFT_DISCARD]: async (raw) => {
      limit(IPC_CHANNELS.MAIL_REPLY_DRAFT_DISCARD);
      return changed(await deps.drafts.discard(validateInput(UUIDSchema, raw, "draft id")));
    },
    [IPC_CHANNELS.MAIL_REPLY_DRAFTS_SET_ENABLED]: async (raw) => {
      limit(IPC_CHANNELS.MAIL_REPLY_DRAFTS_SET_ENABLED);
      return changed({ ok: deps.drafts.setEnabled(validateInput(EnabledSchema, raw, "enabled")) });
    },
    [IPC_CHANNELS.MAIL_REPLY_DRAFTS_DISMISS_OFFER]: async (raw) => {
      limit(IPC_CHANNELS.MAIL_REPLY_DRAFTS_DISMISS_OFFER);
      if (raw !== undefined) throw new Error("Dismissing the offer takes no arguments");
      return changed({ ok: deps.drafts.dismissOffer() });
    },
  };
}

export function setupMailReplyDraftHandlers(deps: MailReplyDraftIpcDeps): void {
  for (const channel of CHANNELS) {
    rateLimiter.configure(channel, RATE_LIMIT_CONFIGS.limited);
  }
  const handlers = createMailReplyDraftIpcHandlers(deps);
  for (const [channel, handle] of Object.entries(handlers)) {
    // These send mail or change what CoWork does with it: only the app's own window may ask.
    ipcMain.handle(channel, (event, raw: unknown) => {
      if (!event.senderFrame || event.senderFrame.parent !== null) {
        throw new Error("Reply drafts are only available to the app window");
      }
      deps.assertTrustedSender?.(event);
      return handle(raw);
    });
  }
}
