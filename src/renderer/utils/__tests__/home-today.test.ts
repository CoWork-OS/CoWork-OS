import { describe, expect, it } from "vitest";
import {
  attentionFromCalendarProposal,
  attentionFromMailReplyDraft,
  attentionMailReplyOffer,
  type AttentionItem,
} from "../../../shared/attention";
import type { CalendarProposal } from "../../../shared/calendar-proposals";
import { EMPTY_HOME_SESSIONS, type HomeSessions } from "../home-sessions";
import {
  EMPTY_HOME_TODAY,
  buildHomeToday,
  cardForAttention,
  commitmentDueState,
  homeGreeting,
  homeStatusLine,
} from "../home-today";

const NOW = new Date(2026, 9, 12, 9, 0).getTime();
const HOUR = 60 * 60 * 1000;

function item(id: string, overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id,
    kind: "session",
    state: "Response needed",
    title: `Item ${id}`,
    createdAt: NOW - HOUR,
    urgent: true,
    actor: { kind: "you", name: "You" },
    origin: { kind: "you", label: "You started it" },
    place: { kind: "local", label: "This Mac" },
    taskId: id,
    ref: { type: "task", taskId: id },
    ...overrides,
  };
}

const approval = item("approval:a1", {
  kind: "approval",
  state: "Approval needed",
  title: "Run npm publish",
  detail: "Release is paused until you decide.",
  taskId: "t1",
  risk: "high",
  actor: { kind: "agent", name: "Ops bot" },
  origin: { kind: "schedule", label: "Started by a schedule" },
  place: { kind: "remote", label: "Mac mini", deviceId: "n1" },
  ref: { type: "approval", approvalId: "a1", taskId: "t1" },
});

const suggestion = (id: string, urgent: boolean) =>
  item(`suggestion:${id}`, {
    kind: "suggestion",
    state: urgent ? "Needs you" : "Suggested",
    title: `Suggestion **${id}**`,
    detail: "Because it matters.",
    prompt: `Do ${id}`,
    urgent,
    suggestionType: "follow_up",
    taskId: undefined,
    ref: { type: "suggestion", suggestionId: id, workspaceId: "ws" },
  });

const sessions: HomeSessions = {
  needsYou: [{ id: "t9", title: "Draft the memo", updatedAt: NOW - HOUR, attention: "Paused" }],
  handled: [{ id: "h1", title: "Morning inbox sweep", updatedAt: NOW - 2 * HOUR }],
};

describe("buildHomeToday", () => {
  it("returns the shared empty value when there is nothing", () => {
    expect(buildHomeToday({ attention: [], sessions: EMPTY_HOME_SESSIONS, now: NOW })).toBe(
      EMPTY_HOME_TODAY,
    );
  });

  it("adds waiting sessions the queue has not covered yet, ranked with the rest", () => {
    const today = buildHomeToday({
      attention: [suggestion("urgent", true), approval, suggestion("calm", false)],
      sessions,
      now: NOW,
    });
    expect(today.needsYou.map((card) => card.id)).toEqual([
      "approval:a1",
      "session:t9",
      "suggestion:urgent",
    ]);
    expect(today.idea?.id).toBe("suggestion:calm");
    expect(today.handled.map((row) => row.id)).toEqual(["handled:h1"]);
  });

  it("does not repeat a session the queue already has an item for", () => {
    const today = buildHomeToday({
      attention: [
        item("question:q1", {
          kind: "question",
          taskId: "t9",
          ref: { type: "input_request", requestId: "q1", taskId: "t9" },
        }),
      ],
      sessions,
      now: NOW,
    });
    expect(today.needsYou.map((card) => card.id)).toEqual(["question:q1"]);
  });

  it("never lists a session as handled while the queue says it waits", () => {
    const today = buildHomeToday({
      attention: [item("approval:a9", { kind: "approval", taskId: "h1" })],
      sessions,
      now: NOW,
    });
    expect(today.handled).toEqual([]);
  });

  it("hides cards the user already acted on and keeps the rows they left", () => {
    const today = buildHomeToday({
      attention: [approval],
      sessions: EMPTY_HOME_SESSIONS,
      now: NOW,
      resolved: new Set(["approval:a1"]),
      actedRows: [{ id: "acted:x", title: "Pay the invoice", outcome: "Marked done", at: NOW }],
    });
    expect(today.needsYou).toEqual([]);
    expect(today.handled.map((row) => row.id)).toEqual(["acted:x"]);
  });
});

describe("cardForAttention", () => {
  it("shows who asks, what started it, where it runs and its risk", () => {
    expect(cardForAttention(approval, NOW)).toMatchObject({
      source: "Ops bot",
      state: "Approval needed",
      title: "Run npm publish",
      why: "Release is paused until you decide.",
      chips: [
        { kind: "origin", label: "Started by a schedule" },
        { kind: "place", label: "Mac mini" },
        { kind: "risk", label: "High risk" },
      ],
      // Review shows the approval's own dialog here; the session stays one click away.
      primary: {
        label: "Review",
        action: { type: "review-approval", approvalId: "a1", taskId: "t1" },
      },
      secondary: { label: "Open session", action: { type: "open-session", taskId: "t1" } },
    });
  });

  it("answers a question with plain options right on the card", () => {
    const question = (choices?: AttentionItem["choices"]) =>
      item("question:q1", {
        kind: "question",
        state: "Question",
        title: "Which region should I deploy to?",
        taskId: "t5",
        ref: { type: "input_request", requestId: "q1", taskId: "t5" },
        ...(choices ? { choices } : {}),
      });
    const card = cardForAttention(
      question({
        questionId: "region",
        options: [{ label: "us-east", description: "Closest to most users" }, { label: "eu-west" }],
      }),
      NOW,
    );
    expect(card?.choices).toEqual([
      {
        label: "us-east",
        hint: "Closest to most users",
        action: {
          type: "answer-question",
          requestId: "q1",
          questionId: "region",
          optionLabel: "us-east",
        },
      },
      {
        label: "eu-west",
        action: {
          type: "answer-question",
          requestId: "q1",
          questionId: "region",
          optionLabel: "eu-west",
        },
      },
    ]);
    expect(card?.primary).toEqual({
      label: "Open session",
      action: { type: "open-session", taskId: "t5" },
    });
    // Without plain options it is answered in the session, as before.
    const plain = cardForAttention(question(), NOW);
    expect(plain?.choices).toBeUndefined();
    expect(plain?.primary).toEqual({
      label: "Answer",
      action: { type: "open-session", taskId: "t5" },
    });
  });

  it("keeps your own local sessions free of chips", () => {
    expect(cardForAttention(item("t2"), NOW)).toMatchObject({
      source: "Your session",
      chips: [],
      primary: { label: "Reply", action: { type: "open-session", taskId: "t2" } },
    });
  });

  it("says why a session stopped, and never claims a question it doesn't have", () => {
    const timedOut = cardForAttention(
      item("t", { detail: "Its approval request timed out, so it stopped before that step." }),
      NOW,
    );
    expect(timedOut?.why).toBe("Its approval request timed out, so it stopped before that step.");
    expect(timedOut?.primary).toMatchObject({ label: "Reply" });
    const unknown = cardForAttention(item("u"), NOW);
    expect(unknown?.why).toBe("It stopped and is waiting for you before it can go on.");
    expect(unknown?.why).not.toMatch(/question/i);
  });

  it("lists commitments memory closed with the handled rows, newest first, with undo", () => {
    const closed = item("memory_change:c1", {
      kind: "memory_change",
      state: "Closed for you",
      title: "Send the signed SOW",
      detail: "Closed: the SOW was sent on Monday.",
      createdAt: NOW - 2 * HOUR,
      urgent: false,
      taskId: undefined,
      workspaceId: "ws",
      ref: { type: "memory_change", changeId: "c1", workspaceId: "ws" },
    });
    const today = buildHomeToday({
      attention: [closed],
      sessions: {
        ...EMPTY_HOME_SESSIONS,
        handled: [{ id: "s1", title: "Weekly digest", updatedAt: NOW - HOUR }],
      },
      now: NOW,
    });
    expect(today.needsYou).toEqual([]);
    expect(today.handled).toEqual([
      expect.objectContaining({ id: "handled:s1", outcome: "Done" }),
      {
        id: "memory_change:c1",
        title: "Send the signed SOW",
        outcome: "Closed for you",
        at: NOW - 2 * HOUR,
        undo: { workspaceId: "ws", changeId: "c1" },
        detail: "Closed: the SOW was sent on Monday.",
      },
    ]);
    expect(homeStatusLine(today)).toBe("Nothing needs you. The rest is handled.");
    // Once undone, the row gives way to the one the action left.
    const undone = buildHomeToday({
      attention: [closed],
      sessions: EMPTY_HOME_SESSIONS,
      now: NOW,
      resolved: new Set(["memory_change:c1"]),
      actedRows: [
        {
          id: "acted:memory_change:c1",
          title: "Send the signed SOW",
          outcome: "Reopened",
          at: NOW,
        },
      ],
    });
    expect(undone.handled.map((row) => row.outcome)).toEqual(["Reopened"]);
  });

  it("opens the automation for a waiting flow step", () => {
    const card = cardForAttention(
      item("flow_approval:s1", {
        kind: "flow_approval",
        state: "Approval needed",
        title: "Weekly report is waiting for your approval",
        actor: { kind: "flow", name: "Weekly report" },
        origin: { kind: "flow", label: "Automation" },
        taskId: undefined,
        ref: { type: "workflow_step", routineId: "r1", runId: "run1", stepId: "s1" },
      }),
      NOW,
    );
    expect(card).toMatchObject({
      icon: "flow",
      source: "Weekly report",
      chips: [{ kind: "origin", label: "Automation" }],
      primary: { label: "Review", action: { type: "open-routine", routineId: "r1" } },
    });
  });

  it("lets a commitment be marked done or drafted into the composer", () => {
    const card = cardForAttention(
      item("commitment:c1", {
        kind: "commitment",
        title: "Send the proposal",
        dueAt: NOW - 2 * HOUR,
        origin: { kind: "memory", label: "Something you said you'd do" },
        taskId: undefined,
        ref: { type: "commitment", commitmentId: "c1" },
      }),
      NOW,
    );
    expect(card).toMatchObject({
      source: "Commitment",
      state: "Overdue",
      chips: [],
      primary: { action: { type: "complete-commitment", commitmentId: "c1" } },
      secondary: {
        action: {
          type: "draft-prompt",
          prompt: "Help me finish this commitment: Send the proposal",
        },
      },
    });
  });

  it("shows the exact prompt a suggestion will run", () => {
    expect(cardForAttention(suggestion("x", true), NOW)).toMatchObject({
      source: "Follow-up",
      title: "Suggestion x",
      preview: { label: "Will run", text: "Do x" },
      primary: { label: "Start", action: { type: "start-suggestion", prompt: "Do x" } },
      secondary: { label: "Not now", action: { type: "snooze-suggestion", suggestionId: "x" } },
    });
  });
});

describe("calendar cards", () => {
  const at = (day: number, hour: number, minute = 0) =>
    new Date(2026, 9, day, hour, minute).getTime();
  const calendarItem = (proposal: CalendarProposal) =>
    attentionFromCalendarProposal(proposal, { localLabel: "This Mac", agentNames: new Map() });
  const event = (eventId: string, start: number, end: number, htmlLink?: string) => ({
    eventId,
    title: `Event ${eventId}`,
    start,
    end,
    ...(htmlLink ? { htmlLink } : {}),
  });
  const clock = (timestamp: number) =>
    new Date(timestamp).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

  it("offers to hold free time before a commitment is due", () => {
    const card = cardForAttention(
      calendarItem({
        kind: "focus_hold",
        id: "hold:c1",
        title: "Send the SOW",
        commitmentId: "c1",
        dueAt: at(13, 17),
        start: at(12, 12),
        end: at(12, 13, 30),
      }),
      NOW,
    );
    expect(card).toMatchObject({
      icon: "calendar_hold",
      source: "Calendar",
      chips: [],
      state: "Suggested hold",
      title: "Send the SOW",
      offer: true,
      why: `It's due by ${clock(at(13, 17))} tomorrow. You're free today ${clock(at(12, 12))}–${clock(at(12, 13, 30))}.`,
      primary: {
        label: `Hold ${clock(at(12, 12))} today`,
        action: { type: "accept-calendar", proposalId: "hold:c1", done: "Time held" },
      },
      secondary: { label: "Not now", action: { type: "dismiss-calendar", proposalId: "hold:c1" } },
    });
    expect(card?.primary.hint).toMatch(/private/);
  });

  it("declines the later event of a conflict only when the user was invited to it", () => {
    const conflict = (canDeclineSecond: boolean, link?: string): CalendarProposal => ({
      kind: "conflict",
      id: "conflict:a:b",
      first: event("a", at(12, 13), at(12, 14)),
      second: event("b", at(12, 13, 30), at(12, 14, 30), link),
      canDeclineSecond,
    });
    const declinable = cardForAttention(calendarItem(conflict(true, "https://cal/b")), NOW);
    expect(declinable).toMatchObject({
      icon: "calendar_conflict",
      state: "Conflict",
      title: "Event a overlaps Event b",
      primary: {
        label: "Decline Event b",
        action: { type: "accept-calendar", proposalId: "conflict:a:b", done: "Declined" },
      },
      secondary: { label: "Keep both", action: { type: "dismiss-calendar" } },
      more: [{ label: "Open in Calendar", action: { type: "open-link", url: "https://cal/b" } }],
    });
    expect(declinable?.offer).toBeUndefined();
    expect(declinable?.primary.hint).toMatch(/organizer/);

    const ownWithLink = cardForAttention(calendarItem(conflict(false, "https://cal/b")), NOW);
    expect(ownWithLink?.primary).toEqual({
      label: "Open in Calendar",
      action: { type: "open-link", url: "https://cal/b" },
    });
    expect(ownWithLink?.secondary?.label).toBe("Keep both");
    const ownNoLink = cardForAttention(calendarItem(conflict(false)), NOW);
    expect(ownNoLink?.primary).toMatchObject({
      label: "Got it",
      action: { type: "dismiss-calendar" },
    });
    expect(ownNoLink?.secondary).toBeUndefined();
  });

  it("shows the prep prompt before it runs", () => {
    const card = cardForAttention(
      calendarItem({
        kind: "meeting_prep",
        id: "prep:e:1",
        event: event("e", at(12, 15), at(12, 16)),
        attendees: ["Ana", "Ben", "Cy", "Di"],
      }),
      NOW,
    );
    expect(card).toMatchObject({
      icon: "calendar_prep",
      state: "Meeting soon",
      offer: true,
      why: `It starts today at ${clock(at(12, 15))} with Ana, Ben, Cy and 1 more.`,
      preview: { label: "Will run" },
      primary: {
        label: "Prepare",
        action: { type: "prepare-meeting", proposalId: "prep:e:1", title: "Prep: Event e" },
      },
      secondary: { label: "Not now", action: { type: "dismiss-calendar" } },
    });
    const action = card?.primary.action;
    expect(action?.type === "prepare-meeting" && action.prompt).toContain(
      `at ${clock(at(12, 15))} today.\n`,
    );
    expect(action?.type === "prepare-meeting" && action.prompt).toContain(
      "\ntitle: Event e\nguests: Ana, Ben, Cy, Di\n",
    );
    expect(card?.preview?.text).toBe(action?.type === "prepare-meeting" ? action.prompt : "");
  });

  it("offers a suggestion about making time the free stretch the queue found", () => {
    const card = cardForAttention(
      { ...suggestion("t1", false), calendarHold: { start: at(13, 10), end: at(13, 11, 30) } },
      NOW,
    );
    expect(card?.more?.[0]).toMatchObject({
      label: `Hold ${clock(at(13, 10))} tomorrow`,
      action: {
        type: "hold-for-suggestion",
        workspaceId: "ws",
        suggestionId: "t1",
        start: at(13, 10),
        end: at(13, 11, 30),
      },
    });
  });

  it("shows offers with the cards without counting them as needing the user", () => {
    const prep = cardForAttention(
      calendarItem({
        kind: "meeting_prep",
        id: "prep:e:1",
        event: event("e", at(12, 15), at(12, 16)),
        attendees: ["Ana"],
      }),
      NOW,
    )!;
    const decision = cardForAttention(approval, NOW)!;
    expect(homeStatusLine({ needsYou: [prep], idea: null, handled: [] })).toBe(
      "Nothing needs you right now.",
    );
    expect(homeStatusLine({ needsYou: [decision, prep], idea: null, handled: [] })).toBe(
      "1 thing needs you.",
    );
  });
});

describe("mail reply cards", () => {
  const context = { localLabel: "This Mac", agentNames: new Map<string, string>() };
  const draft = {
    draftId: "d1",
    threadId: "t1",
    accountId: "gmail:me@example.com",
    provider: "gmail" as const,
    subject: "Q3 proposal",
    to: ["Dana <dana@example.com>", "Lee", "Kim", "Ray"],
    copies: 2,
    attachments: 1,
    sender: "Dana",
    bodyText: "Thanks Dana, sending it Friday.",
    createdAt: NOW - 60_000,
  };

  it("shows the whole reply and who it goes to before Send", () => {
    const card = cardForAttention(attentionFromMailReplyDraft(draft, context), NOW);
    expect(card).toMatchObject({
      icon: "mail_reply",
      source: "Mail",
      state: "Reply drafted",
      title: "Q3 proposal",
      why: "Dana is waiting on a reply.",
      chips: [],
      preview: {
        label: "To Dana <dana@example.com>, Lee, Kim and 1 more · 2 more in copy · 1 attachment",
        text: "Thanks Dana, sending it Friday.",
      },
      mailDraft: { draftId: "d1", bodyText: "Thanks Dana, sending it Friday." },
      primary: { label: "Send", action: { type: "send-mail-draft", draftId: "d1" } },
      secondary: { label: "Edit", action: { type: "edit-mail-draft", draftId: "d1" } },
    });
    expect(card?.offer).toBeUndefined();
    expect(card?.primary.hint).toMatch(/undo/);
    expect(card?.more?.map((button) => button.action)).toEqual([
      { type: "discard-mail-draft", draftId: "d1" },
      { type: "set-mail-drafts", enabled: false },
    ]);
  });

  it("says when a reply couldn't be sent, as a new card", () => {
    const item = attentionFromMailReplyDraft({ ...draft, failed: "Gmail refused it." }, context);
    expect(item.id).toBe("mail_reply:d1:failed");
    expect(cardForAttention(item, NOW)).toMatchObject({
      state: "Not sent",
      why: "It couldn't be sent: Gmail refused it.",
      primary: { label: "Send again", action: { type: "send-mail-draft", draftId: "d1" } },
    });
  });

  it("offers Undo on a reply in the outbox, unless this view's row already does", () => {
    const sending = attentionFromMailReplyDraft({ ...draft, sendingUntil: NOW + 30_000 }, context);
    expect(sending).toMatchObject({ id: "mail_reply:d1:sending", urgent: false });
    expect(cardForAttention(sending, NOW)).toMatchObject({
      state: "Sending",
      offer: true,
      primary: { label: "Undo send", action: { type: "undo-mail-send", draftId: "d1" } },
    });
    const row = {
      id: "acted:mail_reply:d1",
      title: "Q3 proposal",
      outcome: "Sent",
      at: NOW,
      undoSend: { cardId: "mail_reply:d1", draftId: "d1", until: NOW + 30_000 },
    };
    const today = buildHomeToday({
      attention: [sending],
      sessions: EMPTY_HOME_SESSIONS,
      now: NOW,
      actedRows: [row],
    });
    expect(today.needsYou).toEqual([]);
  });

  it("lets a retrying send be stopped, without counting it as needing the user", () => {
    const item = attentionFromMailReplyDraft(
      { ...draft, failed: "Timed out.", retrying: true },
      context,
    );
    expect(item).toMatchObject({ id: "mail_reply:d1:retrying", urgent: false });
    expect(cardForAttention(item, NOW)).toMatchObject({
      state: "Retrying",
      why: "It couldn't be sent yet: Timed out. It will try again.",
      offer: true,
      primary: { label: "Cancel send", action: { type: "undo-mail-send", draftId: "d1" } },
    });
  });

  it("warns when a newer message arrived after the reply was drafted", () => {
    const item = attentionFromMailReplyDraft({ ...draft, outdated: true }, context);
    expect(cardForAttention(item, NOW)).toMatchObject({
      state: "Out of date",
      why: "A newer message arrived after this was drafted. Read it before sending.",
      primary: { label: "Send" },
    });
  });

  it("drops the Sent row when the reply comes back unsent", () => {
    const sentRow = {
      id: "acted:mail_reply:d1",
      title: "Q3 proposal",
      outcome: "Sent",
      at: NOW,
      undoSend: { cardId: "mail_reply:d1", draftId: "d1", until: NOW - 1 },
    };
    const today = buildHomeToday({
      attention: [attentionFromMailReplyDraft({ ...draft, failed: "Refused." }, context)],
      sessions: EMPTY_HOME_SESSIONS,
      now: NOW,
      resolved: new Set(["mail_reply:d1"]),
      actedRows: [sentRow],
    });
    expect(today.needsYou.map((card) => card.id)).toEqual(["mail_reply:d1:failed"]);
    expect(today.handled).toEqual([]);
  });

  it("offers to start drafting without counting it as needing the user", () => {
    const offer = cardForAttention(attentionMailReplyOffer(NOW, context), NOW)!;
    expect(offer).toMatchObject({
      offer: true,
      primary: { label: "Turn on", action: { type: "set-mail-drafts", enabled: true } },
      secondary: { label: "Not now", action: { type: "dismiss-mail-offer" } },
    });
    const reply = cardForAttention(attentionFromMailReplyDraft(draft, context), NOW)!;
    expect(homeStatusLine({ needsYou: [reply, offer], idea: null, handled: [] })).toBe(
      "1 thing needs you.",
    );
  });
});

describe("commitmentDueState", () => {
  it("offers Edit and Dismiss on suggestions, and Add as commitment on follow-ups", () => {
    const followUp = cardForAttention(suggestion("f1", false), NOW);
    expect(followUp?.more?.map((button) => button.label)).toEqual([
      "Edit",
      "Add as commitment",
      "Dismiss",
    ]);
    expect(followUp?.more?.[0].action).toEqual({
      type: "edit-suggestion",
      workspaceId: "ws",
      suggestionId: "f1",
      prompt: "Do f1",
    });
    const insight = cardForAttention(
      { ...suggestion("i1", false), suggestionType: "insight" },
      NOW,
    );
    expect(insight?.more?.map((button) => button.label)).toEqual(["Edit", "Dismiss"]);
  });

  it("names the day relative to now", () => {
    expect(commitmentDueState(NOW - HOUR, NOW)).toBe("Overdue");
    expect(commitmentDueState(NOW + 2 * HOUR, NOW)).toBe("Due today");
    expect(commitmentDueState(NOW + 20 * HOUR, NOW)).toBe("Due tomorrow");
  });
});

describe("homeGreeting", () => {
  it("follows the time of day and adds the name when known", () => {
    expect(homeGreeting(new Date(2026, 9, 12, 8), "Mesut")).toBe("Good morning, Mesut");
    expect(homeGreeting(new Date(2026, 9, 12, 14))).toBe("Good afternoon");
    expect(homeGreeting(new Date(2026, 9, 12, 23), " ")).toBe("Good evening");
  });
});

describe("homeStatusLine", () => {
  const card = cardForAttention(approval, NOW)!;
  it("counts what needs the user and notes when the rest is handled", () => {
    expect(homeStatusLine({ needsYou: [card], idea: null, handled: [] })).toBe(
      "1 thing needs you.",
    );
    expect(
      homeStatusLine({
        needsYou: [card, card],
        idea: null,
        handled: [{ id: "h", title: "x", outcome: "Done", at: NOW }],
      }),
    ).toBe("2 things need you. The rest is handled.");
    expect(homeStatusLine(EMPTY_HOME_TODAY)).toBeNull();
  });
});
