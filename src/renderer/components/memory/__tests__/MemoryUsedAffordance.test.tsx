import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryHubItem } from "../../../../shared/memory-hub-types";
import type { MemoryUsedForTask } from "../../../../shared/memory-used";
import {
  MemoryUsedAffordance,
  MemoryUsedView,
  resolveMemoryUsedEntries,
  type MemoryUsedEntry,
} from "../MemoryUsedAffordance";
import { createMemoryUsedStore } from "../memory-used-store";
import {
  peekMemoryHubFocusWorkspace,
  requestMemoryHubFocus,
  takeMemoryHubFocus,
} from "../memory-hub-focus";

function hubItem(overrides: Partial<MemoryHubItem>): MemoryHubItem {
  return {
    id: "item-1",
    workspaceId: null,
    scope: "global",
    scopeRef: null,
    kind: "preference",
    subjectKey: "preference:0",
    content: "Prefers concise answers",
    source: "user_stated",
    trust: 1,
    confidence: 1,
    status: "active",
    pinned: false,
    private: false,
    reinforcedCount: 0,
    lastUsedAt: null,
    supersedesId: null,
    taskId: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const attribution = (replies: MemoryUsedForTask["replies"], ids: string[]): MemoryUsedForTask => ({
  taskId: "task-1",
  replies,
  replyEventIds: ids,
});

describe("MemoryUsedView", () => {
  const entries: MemoryUsedEntry[] = [
    {
      ref: "memory:item-1",
      lane: "memory",
      itemId: "item-1",
      text: "Prefers concise answers",
      badge: { label: "You said", tone: "success" },
    },
    {
      ref: "archive:a-1",
      lane: "archive",
      text: "Deploy went through staging",
      badge: { label: "Task history", tone: "neutral" },
    },
    {
      ref: "memory:gone",
      lane: "memory",
      itemId: "gone",
      text: "This memory was deleted.",
      badge: { label: "Inferred", tone: "neutral" },
      unavailable: true,
    },
  ];
  const base = {
    count: 3,
    loading: false,
    error: null,
    canOpenHub: true,
    onToggle: () => undefined,
    onOpen: () => undefined,
  };

  it("shows only the count while collapsed", () => {
    const html = renderToStaticMarkup(
      <MemoryUsedView {...base} expanded={false} entries={entries} />,
    );
    expect(html).toContain("Memory used (3)");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Prefers concise answers");
  });

  it("lists facts with their source badge and a Memory Hub link when expanded", () => {
    const html = renderToStaticMarkup(<MemoryUsedView {...base} expanded entries={entries} />);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("settings-badge--success");
    expect(html).toContain("You said");
    expect(html).toContain("Task history");
    expect(html).toContain("memory-used-item--gone");
    // One link: the live fact; not the history note and not the deleted fact.
    expect(html.match(/Open in Memory Hub/g)).toHaveLength(1);
    expect(
      renderToStaticMarkup(
        <MemoryUsedView {...base} expanded entries={entries} canOpenHub={false} />,
      ),
    ).not.toContain("Open in Memory Hub");
  });

  it("renders nothing for a reply that used no memory", () => {
    const store = createMemoryUsedStore(async () => attribution({}, []));
    expect(
      renderToStaticMarkup(
        <MemoryUsedAffordance taskId="task-1" workspaceId="ws-1" eventId="r1" store={store} />,
      ),
    ).toBe("");
  });
});

describe("resolveMemoryUsedEntries", () => {
  it("resolves memory folder lines in one batch and falls back to the file and line", async () => {
    const api = {
      getMemoryItem: vi.fn(),
      readMemoryRepoLines: vi.fn(async (refs: string[]) =>
        refs
          .filter((ref) => ref !== "repo:me.md#L9")
          .map((ref) => ({
            ref,
            text: ref === "repo:MEMORY.md#L3" ? "Prefers concise answers" : "Uses pnpm",
            path: ref.slice(5, ref.indexOf("#")),
            by: ref === "repo:MEMORY.md#L3" ? ("user" as const) : ("agent" as const),
          })),
      ),
    };
    const entries = await resolveMemoryUsedEntries(
      ["repo:MEMORY.md#L3", "repo:workspaces/cowork.md#L5", "repo:me.md#L9"],
      "ws-1",
      api,
    );
    expect(api.readMemoryRepoLines).toHaveBeenCalledTimes(1);
    expect(entries.map((entry) => [entry.lane, entry.badge.label, entry.text])).toEqual([
      ["repo", "Memory folder", "Prefers concise answers"],
      ["repo", "Memory folder", "Uses pnpm (saved by the agent)"],
      ["repo", "Memory folder", "me.md, line 9 in your memory folder."],
    ]);
  });

  it("shows repo refs without the readLines bridge", async () => {
    const entries = await resolveMemoryUsedEntries(["repo:MEMORY.md#L3"], "ws-1", {
      getMemoryItem: vi.fn(),
    });
    expect(entries[0]).toMatchObject({
      lane: "repo",
      text: "MEMORY.md, line 3 in your memory folder.",
    });
  });

  it("resolves facts through the Memory Hub get and history notes in one batch", async () => {
    const api = {
      getMemoryItem: vi.fn(async ({ id }: { id: string }) => {
        if (id === "missing") throw new Error("Memory item not found");
        return {
          item: hubItem({
            id,
            source: id === "inferred" ? "inferred" : "user_stated",
            status: id === "deleted" ? "deleted" : "active",
          }),
          previous: [],
          supersededBy: null,
        };
      }),
      getMemoryDetails: vi.fn(async () => [{ id: "a-1", content: "Deploy  went\nfine" }]),
    };
    const entries = await resolveMemoryUsedEntries(
      [
        "memory:item-1",
        "memory:inferred",
        "memory:deleted",
        "memory:missing",
        "archive:a-1",
        "archive:a-2",
        "external:supermemory",
        "garbage",
      ],
      "ws-1",
      api,
    );
    expect(api.getMemoryDetails).toHaveBeenCalledTimes(1);
    expect(api.getMemoryDetails).toHaveBeenCalledWith({ workspaceId: "ws-1", ids: ["a-1", "a-2"] });
    expect(entries.map((entry) => [entry.ref, entry.badge.label, !!entry.unavailable])).toEqual([
      ["memory:item-1", "You said", false],
      ["memory:inferred", "Inferred", false],
      ["memory:deleted", "You said", true],
      ["memory:missing", "Memory", true],
      ["archive:a-1", "Task history", false],
      ["archive:a-2", "Task history", true],
      ["external:supermemory", "Supermemory", false],
    ]);
    expect(entries[0]).toMatchObject({ itemId: "item-1", text: "Prefers concise answers" });
    expect(entries[4].text).toBe("Deploy went fine");
  });
});

describe("memory used store", () => {
  afterEach(() => vi.useRealTimers());

  it("fetches once per task for the replies that ask, and notifies subscribers", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () =>
      attribution(
        { r1: { eventId: "r1", refs: ["memory:a"], surfaces: ["chat"] } },
        ["r1", "r2"],
      ),
    );
    const store = createMemoryUsedStore(fetcher, { delayMs: 10 });
    const listener = vi.fn();
    store.subscribe(listener);
    store.request("task-1", "ws-1", "r1");
    store.request("task-1", "ws-1", "r2");
    await vi.advanceTimersByTimeAsync(20);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith({ workspaceId: "ws-1", taskId: "task-1" });
    expect(listener).toHaveBeenCalled();
    expect(store.getReply("task-1", "r1")?.refs).toEqual(["memory:a"]);
    expect(store.getReply("task-1", "r2")).toBeNull();

    // Known replies do not refetch; a new reply does, once.
    store.request("task-1", "ws-1", "r1");
    store.request("task-1", "ws-1", "r2");
    await vi.advanceTimersByTimeAsync(20);
    expect(fetcher).toHaveBeenCalledTimes(1);
    store.request("task-1", "ws-1", "r3");
    store.request("task-1", "ws-1", "r3");
    await vi.advanceTimersByTimeAsync(20);
    expect(fetcher).toHaveBeenCalledTimes(2);
    store.request("task-1", "ws-1", "r3");
    await vi.advanceTimersByTimeAsync(20);
    expect(fetcher).toHaveBeenCalledTimes(2);

    store.invalidate("task-1");
    expect(store.getReply("task-1", "r1")).toBeNull();
  });

  it("swallows fetch failures", async () => {
    vi.useFakeTimers();
    const store = createMemoryUsedStore(
      async () => {
        throw new Error("no");
      },
      { delayMs: 1 },
    );
    store.request("task-1", "ws-1", "r1");
    await vi.advanceTimersByTimeAsync(5);
    expect(store.getReply("task-1", "r1")).toBeNull();
  });
});

describe("Memory Hub focus", () => {
  it("hands one focus request to the Memory Hub", () => {
    requestMemoryHubFocus({ itemId: "item-1", query: "  Prefers   concise answers " });
    expect(takeMemoryHubFocus()).toEqual({ itemId: "item-1", query: "Prefers concise answers" });
    expect(takeMemoryHubFocus()).toBeNull();
  });

  it("carries the task's workspace so the Hub switches to it", () => {
    requestMemoryHubFocus({ itemId: "item-1", query: "tea", workspaceId: " ws-2 " });
    expect(peekMemoryHubFocusWorkspace()).toBe("ws-2");
    expect(takeMemoryHubFocus("ws-2")).toEqual({
      itemId: "item-1",
      query: "tea",
      workspaceId: "ws-2",
    });
    expect(peekMemoryHubFocusWorkspace()).toBeNull();

    // A tab showing another workspace drops the request instead of filtering its list.
    requestMemoryHubFocus({ itemId: "item-1", query: "tea", workspaceId: "ws-2" });
    expect(takeMemoryHubFocus("ws-1")).toBeNull();
    expect(takeMemoryHubFocus("ws-2")).toBeNull();
  });
});
