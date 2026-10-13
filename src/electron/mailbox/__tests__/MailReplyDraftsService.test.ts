import { describe, expect, it, vi } from "vitest";
import type {
  MailboxComposeDraft,
  MailboxMessage,
  MailboxThreadDetail,
  MailboxThreadListItem,
} from "../../../shared/mailbox";
import { MailReplyDraftsService, type MailReplyDraftsState } from "../MailReplyDraftsService";

const at = (day: number, hour: number) => new Date(2026, 9, day, hour).getTime();
const NOW = at(13, 9);
const ACCOUNT = "gmail:me@example.com";

function message(
  threadId: string,
  direction: "incoming" | "outgoing",
  from: string,
): MailboxMessage {
  return {
    id: `${threadId}:m`,
    threadId,
    providerMessageId: "p",
    direction,
    from: { email: from, name: from.split("@")[0] },
    to: [],
    cc: [],
    bcc: [],
    subject: "s",
    snippet: "snippet",
    body: `Body from ${from}`,
    receivedAt: NOW - 3600_000,
    unread: true,
  };
}

function thread(id: string, overrides: Partial<MailboxThreadDetail> = {}): MailboxThreadDetail {
  return {
    id,
    accountId: ACCOUNT,
    provider: "gmail",
    providerThreadId: id,
    subject: `Re: Thread ${id}`,
    snippet: "",
    participants: [{ email: "ana@example.com", name: "Ana" }],
    labels: ["INBOX"],
    category: "primary",
    todayBucket: "needs_action",
    domainCategory: "other",
    priorityBand: "high",
    priorityScore: 80,
    urgencyScore: 50,
    needsReply: true,
    staleFollowup: false,
    cleanupCandidate: false,
    handled: false,
    unreadCount: 1,
    messageCount: 1,
    lastMessageAt: NOW - 3600_000,
    messages: [message(id, "incoming", "ana@example.com")],
    drafts: [],
    proposals: [],
    commitments: [],
    ...overrides,
  } as MailboxThreadDetail;
}

function setup(
  threads: MailboxThreadDetail[],
  options: { state?: Partial<MailReplyDraftsState>; now?: () => number } = {},
) {
  let state: MailReplyDraftsState | undefined = options.state
    ? { enabled: false, prepared: [], hiddenThreads: {}, ...options.state }
    : undefined;
  const drafts = new Map<string, MailboxComposeDraft>();
  let nextId = 0;
  const mailbox = {
    getSyncStatus: vi.fn(async () => ({
      accounts: [
        {
          id: ACCOUNT,
          provider: "gmail" as const,
          address: "me@example.com",
          status: "connected" as const,
          capabilities: [],
        },
      ],
      needsReplyCount: threads.filter((t) => t.needsReply).length,
    })),
    listThreads: vi.fn(async () => threads.filter((t) => t.needsReply) as MailboxThreadListItem[]),
    getThread: vi.fn(async (id: string) => threads.find((t) => t.id === id) ?? null),
    createMailboxDraft: vi.fn(async (input: { threadId?: string; bodyText?: string }) => {
      const id = `00000000-0000-4000-8000-00000000000${nextId++}`;
      const draft = {
        id,
        accountId: ACCOUNT,
        mode: "reply",
        status: "local",
        threadId: input.threadId,
        subject: "Re: x",
        bodyText: input.bodyText ?? "",
        to: input.threadId === "t-empty" ? [] : [{ email: "ana@example.com", name: "Ana" }],
        cc: [],
        bcc: [],
        attachments: [],
        createdAt: NOW,
        updatedAt: NOW,
      } as MailboxComposeDraft;
      drafts.set(id, draft);
      return draft;
    }),
    getMailboxDraft: vi.fn(async (id: string) => drafts.get(id) ?? null),
    sendMailboxDraft: vi.fn(async (id: string) => {
      drafts.get(id)!.status = "queued";
      return {
        id: "out",
        draftId: id,
        accountId: ACCOUNT,
        status: "queued" as const,
        sendAfter: NOW + 30_000,
        createdAt: NOW,
        updatedAt: NOW,
      };
    }),
    cancelMailboxDraftSend: vi.fn(async (id: string) => {
      const draft = drafts.get(id);
      if (!draft || draft.status !== "queued") return false;
      draft.status = "local";
      return true;
    }),
    discardMailboxDraft: vi.fn(async (id: string) => {
      drafts.get(id)!.status = "discarded";
      return true;
    }),
  };
  const writeReply = vi.fn(async (input: { threadId: string }) => ({
    body: `Thanks, I'll look at ${input.threadId}.`,
  }));
  const onPrepared = vi.fn();
  const service = new MailReplyDraftsService({
    mailbox,
    writeReply,
    loadState: () => state,
    saveState: (next) => {
      state = next;
    },
    onPrepared,
    now: options.now ?? (() => NOW),
  });
  return { service, mailbox, writeReply, onPrepared, drafts, state: () => state };
}

describe("MailReplyDraftsService", () => {
  it("drafts nothing until the user turns it on", async () => {
    const { service, writeReply } = setup([thread("t1")]);
    await expect(service.draftReplies()).resolves.toBe(0);
    expect(writeReply).not.toHaveBeenCalled();
    expect(await service.list()).toEqual([]);
  });

  it("offers to turn on when mail needs a reply, until the offer is dismissed", async () => {
    const { service, state } = setup([thread("t1")]);
    await expect(service.shouldOffer()).resolves.toBe(true);
    service.dismissOffer();
    expect(state()?.offerHiddenUntil).toBe(NOW + 14 * 24 * 3600_000);
    await expect(service.shouldOffer()).resolves.toBe(false);
    const none = setup([thread("t1", { needsReply: false })]);
    await expect(none.service.shouldOffer()).resolves.toBe(false);
  });

  it("drafts up to three replies a day, as reply drafts, and lists them", async () => {
    const threads = ["t1", "t2", "t3", "t4"].map((id) => thread(id));
    const { service, mailbox, writeReply, onPrepared, state } = setup(threads, {
      state: { enabled: true },
    });
    await expect(service.draftReplies()).resolves.toBe(3);
    expect(onPrepared).toHaveBeenCalledWith(3);
    expect(mailbox.createMailboxDraft).toHaveBeenCalledWith({
      mode: "reply",
      threadId: "t1",
      accountId: ACCOUNT,
      bodyText: "Thanks, I'll look at t1.",
    });
    expect(writeReply.mock.calls[0][0]).toMatchObject({
      threadId: "t1",
      subject: "Re: Thread t1",
      userAddress: "me@example.com",
      messages: [{ from: "ana", incoming: true, body: "Body from ana@example.com" }],
    });
    expect(state()?.prepared.map((entry) => entry.threadId)).toEqual(["t1", "t2", "t3"]);
    // The day's allowance is used.
    await expect(service.draftReplies()).resolves.toBe(0);

    const cards = await service.list();
    expect(cards.map((card) => card.threadId)).toEqual(["t1", "t2", "t3"]);
    expect(cards[0]).toMatchObject({
      accountId: ACCOUNT,
      provider: "gmail",
      subject: "Thread t1",
      to: ["Ana"],
      sender: "ana",
      bodyText: "Thanks, I'll look at t1.",
    });
  });

  it("starts a new allowance the next day and never drafts a thread twice", async () => {
    let now = NOW;
    const threads = ["t1", "t2", "t3", "t4"].map((id) => thread(id));
    const { service, mailbox } = setup(threads, { state: { enabled: true }, now: () => now });
    await service.draftReplies();
    now = at(14, 9);
    await expect(service.draftReplies()).resolves.toBe(1);
    expect(mailbox.createMailboxDraft).toHaveBeenLastCalledWith(
      expect.objectContaining({ threadId: "t4" }),
    );
  });

  it("skips threads it shouldn't draft for", async () => {
    const threads = [
      thread("handled", { handled: true }),
      thread("sensitive", { hasSensitiveContent: true }),
      thread("answered", { messages: [message("answered", "outgoing", "me@example.com")] }),
      thread("noreply", { messages: [message("noreply", "incoming", "no-reply@vendor.com")] }),
      thread("hidden"),
    ];
    const { service, writeReply } = setup(threads, {
      state: { enabled: true, hiddenThreads: { hidden: NOW + 1000 } },
    });
    await expect(service.draftReplies()).resolves.toBe(0);
    expect(writeReply).not.toHaveBeenCalled();
  });

  it("remembers threads where no reply fits, and leaves no empty draft", async () => {
    const { service, writeReply, mailbox, state } = setup([thread("t-skip"), thread("t-empty")], {
      state: { enabled: true },
    });
    writeReply.mockResolvedValueOnce({ skip: true } as never);
    await expect(service.draftReplies()).resolves.toBe(0);
    expect(mailbox.discardMailboxDraft).toHaveBeenCalledOnce();
    expect(Object.keys(state()!.hiddenThreads).sort()).toEqual(["t-empty", "t-skip"]);
  });

  it("stops the run when the model fails", async () => {
    const { service, writeReply } = setup([thread("t1"), thread("t2")], {
      state: { enabled: true },
    });
    writeReply.mockResolvedValueOnce({ error: "No AI model is set up." } as never);
    await expect(service.draftReplies()).resolves.toBe(0);
    expect(writeReply).toHaveBeenCalledOnce();
  });

  it("hides drafts that were sent, or whose thread no longer needs a reply", async () => {
    const threads = [thread("t1"), thread("t2")];
    const { service, drafts } = setup(threads, { state: { enabled: true } });
    await service.draftReplies();
    const [first] = [...drafts.values()];
    first.status = "queued";
    threads[1].needsReply = false;
    expect(await service.list()).toEqual([]);
  });

  it("brings back a reply whose send failed, with why", async () => {
    const { service, drafts } = setup([thread("t1")], { state: { enabled: true } });
    await service.draftReplies();
    const [draft] = [...drafts.values()];
    draft.status = "failed";
    draft.latestError = "Gmail refused the message.";
    expect(await service.list()).toEqual([
      expect.objectContaining({ draftId: draft.id, failed: "Gmail refused the message." }),
    ]);
    await expect(service.send(draft.id)).resolves.toMatchObject({ ok: true });
  });

  it("keeps drafts already made after drafting is turned off", async () => {
    const { service } = setup([thread("t1")], { state: { enabled: true } });
    await service.draftReplies();
    service.setEnabled(false);
    expect((await service.list()).map((card) => card.threadId)).toEqual(["t1"]);
  });

  it("sends, undoes and discards only drafts it prepared", async () => {
    const { service, mailbox, drafts, state } = setup([thread("t1")], {
      state: { enabled: true },
    });
    await service.draftReplies();
    const [draft] = [...drafts.values()];
    const stranger = "11111111-1111-4111-8111-111111111111";

    await expect(service.send(stranger)).resolves.toMatchObject({ ok: false, reason: "not_found" });
    await expect(service.undoSend(stranger)).resolves.toMatchObject({ reason: "not_found" });
    await expect(service.discard(stranger)).resolves.toMatchObject({ reason: "not_found" });
    expect(mailbox.sendMailboxDraft).not.toHaveBeenCalled();

    await expect(service.send(draft.id)).resolves.toEqual({ ok: true, sendAfter: NOW + 30_000 });
    await expect(service.send(draft.id)).resolves.toMatchObject({ ok: false, reason: "gone" });
    await expect(service.undoSend(draft.id)).resolves.toEqual({ ok: true });
    expect(draft.status).toBe("local");
    await expect(service.undoSend(draft.id)).resolves.toMatchObject({
      ok: false,
      reason: "too_late",
    });

    await expect(service.discard(draft.id)).resolves.toEqual({ ok: true });
    expect(draft.status).toBe("discarded");
    expect(state()?.hiddenThreads).toHaveProperty("t1");
  });

  it("drafts once when asked twice at the same time", async () => {
    const { service, writeReply } = setup([thread("t1")], { state: { enabled: true } });
    const [a, b] = await Promise.all([service.draftReplies(), service.draftReplies()]);
    expect([a, b]).toEqual([1, 1]);
    expect(writeReply).toHaveBeenCalledOnce();
  });
});
