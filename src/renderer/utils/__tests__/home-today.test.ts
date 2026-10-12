import { describe, expect, it } from "vitest";
import type { AttentionItem } from "../../../shared/attention";
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
      attention: [item("question:q1", { kind: "question", taskId: "t9" })],
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
      primary: { label: "Review", action: { type: "open-session", taskId: "t1" } },
    });
  });

  it("keeps your own local sessions free of chips", () => {
    expect(cardForAttention(item("t2"), NOW)).toMatchObject({
      source: "Your session",
      chips: [],
      primary: { label: "Reply", action: { type: "open-session", taskId: "t2" } },
    });
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
