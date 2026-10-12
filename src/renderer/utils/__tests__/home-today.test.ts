import { describe, expect, it } from "vitest";
import { EMPTY_HOME_SESSIONS, type HomeSessions } from "../home-sessions";
import {
  EMPTY_HOME_TODAY,
  buildHomeToday,
  commitmentDueState,
  homeGreeting,
  homeStatusLine,
  type HomeTodaySuggestion,
} from "../home-today";

const NOW = new Date(2026, 9, 12, 9, 0).getTime();
const HOUR = 60 * 60 * 1000;

function suggestion(id: string, overrides: Partial<HomeTodaySuggestion> = {}): HomeTodaySuggestion {
  return {
    id,
    type: "follow_up",
    title: `Suggestion ${id}`,
    description: `Because **${id}** matters.`,
    actionPrompt: `Do ${id}`,
    confidence: 0.7,
    createdAt: NOW - HOUR,
    expiresAt: NOW + 24 * HOUR,
    dismissed: false,
    actedOn: false,
    workspaceId: "ws",
    ...overrides,
  } as HomeTodaySuggestion;
}

const sessions: HomeSessions = {
  needsYou: [
    { id: "t1", title: "Deploy preview", updatedAt: NOW - HOUR, attention: "Approval needed" },
  ],
  handled: [{ id: "t2", title: "Morning inbox sweep", updatedAt: NOW - 2 * HOUR }],
};

describe("buildHomeToday", () => {
  it("returns the shared empty value when there is nothing", () => {
    expect(
      buildHomeToday({ sessions: EMPTY_HOME_SESSIONS, suggestions: [], commitments: [], now: NOW }),
    ).toBe(EMPTY_HOME_TODAY);
  });

  it("orders sessions, then due commitments, then urgent suggestions", () => {
    const today = buildHomeToday({
      sessions,
      suggestions: [suggestion("calm"), suggestion("urgent", { urgency: "high" })],
      commitments: [{ id: "c1", text: "Send the Q3 proposal to Dana", dueAt: NOW + 3 * HOUR }],
      now: NOW,
    });
    expect(today.needsYou.map((card) => card.id)).toEqual([
      "session:t1",
      "commitment:c1",
      "suggestion:urgent",
    ]);
    expect(today.idea?.id).toBe("suggestion:calm");
    expect(today.handled).toEqual([
      {
        id: "handled:t2",
        title: "Morning inbox sweep",
        outcome: "Done",
        at: NOW - 2 * HOUR,
        taskId: "t2",
      },
    ]);
  });

  it("makes each card a single decision through an existing path", () => {
    const today = buildHomeToday({
      sessions,
      suggestions: [suggestion("urgent", { recommendedDelivery: "nudge" })],
      commitments: [{ id: "c1", text: "Send the proposal", dueAt: NOW - 2 * HOUR }],
      now: NOW,
    });
    const [session, commitment, nudge] = today.needsYou;
    expect(session.primary).toEqual({
      label: "Review",
      action: { type: "open-session", taskId: "t1" },
    });
    expect(commitment.state).toBe("Overdue");
    expect(commitment.primary.action).toEqual({ type: "complete-commitment", commitmentId: "c1" });
    expect(commitment.secondary?.action).toEqual({
      type: "draft-prompt",
      prompt: "Help me finish this commitment: Send the proposal",
    });
    expect(nudge.why).toBe("Because urgent matters.");
    expect(nudge.preview).toEqual({ label: "Will run", text: "Do urgent" });
    expect(nudge.primary.action).toMatchObject({ type: "start-suggestion", prompt: "Do urgent" });
    expect(nudge.secondary?.action).toMatchObject({
      type: "snooze-suggestion",
      suggestionId: "urgent",
    });
  });

  it("leaves out suggestions with nothing to run and cards the user already resolved", () => {
    const today = buildHomeToday({
      sessions,
      suggestions: [suggestion("info", { actionPrompt: undefined, urgency: "high" })],
      commitments: [],
      now: NOW,
      resolved: new Set(["session:t1"]),
      actedRows: [{ id: "acted:c9", title: "Pay the invoice", outcome: "Marked done", at: NOW }],
    });
    expect(today.needsYou).toEqual([]);
    expect(today.idea).toBeNull();
    expect(today.handled.map((row) => row.id)).toEqual(["acted:c9", "handled:t2"]);
  });
});

describe("commitmentDueState", () => {
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
  const card = buildHomeToday({ sessions, suggestions: [], commitments: [], now: NOW }).needsYou[0];
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
