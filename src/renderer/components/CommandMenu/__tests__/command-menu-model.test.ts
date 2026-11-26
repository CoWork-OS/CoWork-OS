import { describe, expect, it } from "vitest";
import type { Task, UnifiedRecallResult } from "../../../../shared/types";
import {
  buildActionItems,
  buildCommandMenuSections,
  buildMessageItems,
  buildSessionItems,
  buildSettingItems,
  buildSettingsIndex,
  commandMenuMatchScore,
  flattenCommandMenuSections,
  isCommandMenuShortcut,
  moveCommandMenuSelection,
  normalizeCommandMenuQuery,
  type CommandMenuActionSpec,
  type CommandMenuSettingsEntry,
} from "../command-menu-model";

const actions: CommandMenuActionSpec[] = [
  {
    id: "new",
    title: "New session",
    keywords: ["create"],
    shortcut: "⌘N",
    action: { type: "new-session" },
  },
  { id: "settings", title: "Open Settings", action: { type: "open-settings" } },
  { id: "go-inbox", title: "Go to Inbox", action: { type: "navigate", destination: "inbox" } },
];

function task(id: string, title: string, extra: Partial<Task> = {}): Task {
  return { id, title, prompt: "", updatedAt: 0, ...extra } as Task;
}

const settings: CommandMenuSettingsEntry[] = [
  { tab: "appearance", label: "Appearance", group: "General", terms: ["theme", "dark mode"] },
  { tab: "voice", label: "Voice Mode", group: "General", terms: ["microphone", "speech"] },
  { tab: "mcp", label: "MCP Servers", group: "Skills & Tools", terms: ["connectors"] },
];

function hit(taskId: string | undefined, rank: number, snippet: string): UnifiedRecallResult {
  return {
    sourceType: "message",
    objectId: `${taskId}:e`,
    timestamp: rank,
    rank,
    snippet,
    taskId,
    title: `Title ${taskId}`,
    metadata: { eventType: "user_message", conversationId: `c-${taskId}` },
  };
}

describe("query matching", () => {
  it("normalizes case and whitespace", () => {
    expect(normalizeCommandMenuQuery("  Open   SETTINGS ")).toBe("open settings");
  });

  it("needs every token and ranks title matches above other text", () => {
    expect(commandMenuMatchScore("Open Settings", "", "open set")).toBe(4);
    expect(commandMenuMatchScore("Open Settings", "", "settings")).toBe(3);
    expect(commandMenuMatchScore("Open Settings", "", "tting")).toBe(2);
    expect(commandMenuMatchScore("Open Settings", "preferences", "pref")).toBe(1);
    expect(commandMenuMatchScore("Open Settings", "preferences", "open missing")).toBe(0);
    expect(commandMenuMatchScore("Anything", "", "")).toBe(1);
  });
});

describe("actions", () => {
  it("finds an action by title or keyword and keeps its shortcut", () => {
    expect(buildActionItems(actions, "create", 5)).toEqual([
      {
        kind: "action",
        id: "action:new",
        title: "New session",
        shortcut: "⌘N",
        action: { type: "new-session" },
      },
    ]);
    expect(buildActionItems(actions, "inbox", 5).map((item) => item.title)).toEqual([
      "Go to Inbox",
    ]);
  });

  it("lists actions in their given order with no query, up to the limit", () => {
    expect(buildActionItems(actions, "", 2).map((item) => item.title)).toEqual([
      "New session",
      "Open Settings",
    ]);
  });
});

describe("sessions", () => {
  const tasks = [
    task("t1", "Quarterly report", { updatedAt: 10, sidebarPromptPreview: "Draft the Q3 numbers" }),
    task("t2", "Fix login bug", { updatedAt: 30, resultSummary: "Patched the report exporter" }),
    task("t3", "Report on churn", { updatedAt: 20 }),
  ];

  it("shows the most recently updated sessions with no query", () => {
    expect(buildSessionItems(tasks, "", 2).map((item) => item.id)).toEqual([
      "session:t2",
      "session:t3",
    ]);
  });

  it("ranks a title match above a match in the summary, newest first within a rank", () => {
    expect(buildSessionItems(tasks, "report", 5).map((item) => item.id)).toEqual([
      "session:t3",
      "session:t1",
      "session:t2",
    ]);
  });

  it("finds a session by its prompt preview or its id and shows the preview", () => {
    const [byPrompt] = buildSessionItems(tasks, "q3 numbers", 5);
    expect(byPrompt).toMatchObject({
      kind: "session",
      taskId: "t1",
      subtitle: "Draft the Q3 numbers",
    });
    expect(buildSessionItems(tasks, "t2", 5).map((item) => item.id)).toEqual(["session:t2"]);
  });

  it("names an untitled session and omits a subtitle that repeats the title", () => {
    const [item] = buildSessionItems([task("t9", "  ", { prompt: "" })], "", 5);
    expect(item).toMatchObject({ title: "Untitled session" });
    const [same] = buildSessionItems([task("t8", "Hello", { prompt: "hello" })], "", 5);
    expect(same.subtitle).toBeUndefined();
  });
});

describe("settings", () => {
  it("builds the index from sidebar items and their search terms", () => {
    const index = buildSettingsIndex(
      [
        { tab: "voice", label: "Voice Mode", group: "General" },
        { tab: "tray", label: "Menu Bar", group: "General", macOnly: true },
      ],
      { voice: [{ terms: ["microphone"] }, { terms: ["speech"] }] },
      false,
    );
    expect(index).toEqual([
      { tab: "voice", label: "Voice Mode", group: "General", terms: ["microphone", "speech"] },
    ]);
  });

  it("finds a section by label, group or search term", () => {
    expect(buildSettingItems(settings, "voice", 5)[0]).toMatchObject({
      kind: "setting",
      tab: "voice",
      subtitle: "General",
    });
    expect(buildSettingItems(settings, "dark mode", 5).map((item) => item.id)).toEqual([
      "setting:appearance",
    ]);
    expect(buildSettingItems(settings, "tools", 5).map((item) => item.id)).toEqual(["setting:mcp"]);
  });
});

describe("messages", () => {
  it("keeps one row per session with its best hit and drops hits without a session", () => {
    const items = buildMessageItems(
      [
        hit("a", 3, "later **match**"),
        hit("b", 2, "b text"),
        hit("a", 1, "best `match`\nline"),
        hit(undefined, 0, "orphan"),
      ],
      5,
    );
    expect(items.map((item) => item.id)).toEqual(["message:a", "message:b"]);
    expect(items[0]).toMatchObject({
      kind: "message",
      taskId: "a",
      title: "Title a",
      subtitle: "best match line",
    });
  });
});

describe("message titles", () => {
  it("uses the session's name when the session is loaded", () => {
    const results = [hit("a", 1, "found here"), hit("b", 2, "and here")];
    const items = buildMessageItems(results, 5, new Map([["a", "Budget review"]]));
    expect(items.map((item) => item.title)).toEqual(["Budget review", "Title b"]);
  });
});

describe("activity rows", () => {
  it("leaves out hits that are not from the conversation index", () => {
    const activity: UnifiedRecallResult = {
      ...hit("a", 0, "Model routing updated Budget review"),
      metadata: { activityType: "model_routing" },
    };
    expect(
      buildMessageItems([activity, hit("b", 1, "real text")], 5).map((item) => item.id),
    ).toEqual(["message:b"]);
  });
});

describe("sections", () => {
  const sources = {
    actions,
    tasks: [task("t1", "Voice memo notes", { updatedAt: 5 })],
    settings,
    messages: [hit("m1", 1, "talked about voice")],
  };

  it("shows actions and recent sessions before anything is typed", () => {
    const sections = buildCommandMenuSections({ ...sources, scope: "all", query: "" });
    expect(sections.map((section) => [section.id, section.label])).toEqual([
      ["actions", "Actions"],
      ["sessions", "Recent sessions"],
    ]);
  });

  it("adds settings and messages once there is a query, and drops empty sections", () => {
    const sections = buildCommandMenuSections({ ...sources, scope: "all", query: "voice" });
    expect(sections.map((section) => section.id)).toEqual(["settings", "sessions", "messages"]);
    expect(flattenCommandMenuSections(sections).map((item) => item.id)).toEqual([
      "setting:voice",
      "session:t1",
      "message:m1",
    ]);
  });

  it("limits a scope to its own section and lists every setting there without a query", () => {
    const only = buildCommandMenuSections({ ...sources, scope: "settings", query: "" });
    expect(only.map((section) => section.id)).toEqual(["settings"]);
    expect(only[0].items).toHaveLength(3);
    expect(buildCommandMenuSections({ ...sources, scope: "messages", query: "" })).toEqual([]);
  });

  it("caps each section in the combined view", () => {
    const many = Array.from({ length: 20 }, (_, index) =>
      task(`s${index}`, `Session ${index}`, { updatedAt: index }),
    );
    const sections = buildCommandMenuSections({
      ...sources,
      tasks: many,
      scope: "all",
      query: "session",
    });
    expect(sections.find((section) => section.id === "sessions")?.items).toHaveLength(6);
    const single = buildCommandMenuSections({
      ...sources,
      tasks: many,
      scope: "sessions",
      query: "session",
    });
    expect(single[0].items).toHaveLength(20);
  });
});

describe("keyboard", () => {
  it("wraps the selection at both ends", () => {
    expect(moveCommandMenuSelection(0, -1, 3)).toBe(2);
    expect(moveCommandMenuSelection(2, 1, 3)).toBe(0);
    expect(moveCommandMenuSelection(1, 1, 3)).toBe(2);
    expect(moveCommandMenuSelection(0, 1, 0)).toBe(0);
  });

  it("recognises Cmd+K and Ctrl+K only without other modifiers", () => {
    const base = { key: "k", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };
    expect(isCommandMenuShortcut({ ...base, metaKey: true })).toBe(true);
    expect(isCommandMenuShortcut({ ...base, key: "K", ctrlKey: true })).toBe(true);
    expect(isCommandMenuShortcut(base)).toBe(false);
    expect(isCommandMenuShortcut({ ...base, metaKey: true, shiftKey: true })).toBe(false);
    expect(isCommandMenuShortcut({ ...base, metaKey: true, altKey: true })).toBe(false);
    expect(isCommandMenuShortcut({ ...base, key: "j", metaKey: true })).toBe(false);
  });
});
