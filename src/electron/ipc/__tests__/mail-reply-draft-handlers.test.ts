import { afterEach, describe, expect, it, vi } from "vitest";

const handle = vi.fn();
vi.mock("electron", () => ({ ipcMain: { handle: (...args: unknown[]) => handle(...args) } }));

import { IPC_CHANNELS } from "../../../shared/types";
import {
  createMailReplyDraftIpcHandlers,
  setupMailReplyDraftHandlers,
  type MailReplyDraftIpcDeps,
} from "../mail-reply-draft-handlers";

const DRAFT = "22222222-2222-4222-8222-222222222222";

function setup(overrides: Partial<MailReplyDraftIpcDeps> = {}) {
  const deps = {
    drafts: {
      send: vi.fn(async () => ({ ok: true as const, sendAfter: 123 })),
      undoSend: vi.fn(async () => ({ ok: true as const })),
      discard: vi.fn(async () => ({ ok: true as const })),
      setEnabled: vi.fn(() => true),
      dismissOffer: vi.fn(() => true),
    },
    onChanged: vi.fn(),
    checkRateLimit: vi.fn(),
    ...overrides,
  };
  return { deps, handlers: createMailReplyDraftIpcHandlers(deps) };
}

afterEach(() => handle.mockReset());

describe("reply draft IPC", () => {
  it("takes only a draft id, and signals the queue after a change", async () => {
    const { deps, handlers } = setup();
    const send = handlers[IPC_CHANNELS.MAIL_REPLY_DRAFT_SEND];
    await expect(send(DRAFT)).resolves.toEqual({ ok: true, sendAfter: 123 });
    expect(deps.drafts.send).toHaveBeenCalledWith(DRAFT);
    expect(deps.checkRateLimit).toHaveBeenCalledWith(IPC_CHANNELS.MAIL_REPLY_DRAFT_SEND);
    expect(deps.onChanged).toHaveBeenCalledOnce();
    for (const bad of ["", "draft-1", 42, { draftId: DRAFT }]) {
      await expect(send(bad)).rejects.toThrow();
    }
    expect(deps.drafts.send).toHaveBeenCalledOnce();
  });

  it("doesn't signal a change that didn't happen", async () => {
    const { deps, handlers } = setup();
    deps.drafts.undoSend.mockResolvedValueOnce({
      ok: false,
      reason: "too_late",
      message: "It's already on its way.",
    } as never);
    await expect(handlers[IPC_CHANNELS.MAIL_REPLY_DRAFT_UNDO_SEND](DRAFT)).resolves.toMatchObject({
      ok: false,
      reason: "too_late",
    });
    expect(deps.onChanged).not.toHaveBeenCalled();
  });

  it("turns drafting on or off with a boolean only", async () => {
    const { deps, handlers } = setup();
    const setEnabled = handlers[IPC_CHANNELS.MAIL_REPLY_DRAFTS_SET_ENABLED];
    await expect(setEnabled(true)).resolves.toEqual({ ok: true });
    expect(deps.drafts.setEnabled).toHaveBeenCalledWith(true);
    await expect(setEnabled("yes")).rejects.toThrow();
    await expect(
      handlers[IPC_CHANNELS.MAIL_REPLY_DRAFTS_DISMISS_OFFER](undefined),
    ).resolves.toEqual({ ok: true });
    await expect(handlers[IPC_CHANNELS.MAIL_REPLY_DRAFTS_DISMISS_OFFER]("x")).rejects.toThrow();
    expect(deps.drafts.dismissOffer).toHaveBeenCalledOnce();
  });

  it("only answers the main app window's top frame", async () => {
    const assertTrustedSender = vi.fn((event: { trusted?: boolean }) => {
      if (!event.trusted) throw new Error("Mailbox access is restricted to the main app window");
    });
    const { deps } = setup({ assertTrustedSender: assertTrustedSender as never });
    setupMailReplyDraftHandlers(deps);
    const registered = new Map(
      handle.mock.calls.map(([channel, fn]) => [channel as string, fn as Function]),
    );
    const send = registered.get(IPC_CHANNELS.MAIL_REPLY_DRAFT_SEND)!;
    expect(() => send({ senderFrame: { parent: {} }, trusted: true }, DRAFT)).toThrow("app window");
    expect(() => send({ senderFrame: { parent: null } }, DRAFT)).toThrow("main app window");
    await expect(
      send({ senderFrame: { parent: null }, trusted: true }, DRAFT),
    ).resolves.toMatchObject({ ok: true });
    expect(deps.drafts.send).toHaveBeenCalledOnce();
  });
});
