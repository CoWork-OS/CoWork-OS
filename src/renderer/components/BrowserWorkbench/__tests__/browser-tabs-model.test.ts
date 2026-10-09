import { describe, expect, it } from "vitest";
import {
  type BrowserTabsState,
  browserTabsReducer,
  createInitialBrowserTabsState,
  MAX_LIVE_BROWSER_TABS,
  restoreBrowserTabs,
  serializeBrowserTabs,
} from "../browser-tabs-model";

function open(state: BrowserTabsState, id: string, extra: Record<string, unknown> = {}) {
  return browserTabsReducer(state, { type: "open", id, url: `https://${id}.example/`, ...extra });
}

describe("browser tabs model", () => {
  it("opens, activates and closes tabs, falling back to a neighbor", () => {
    let state = createInitialBrowserTabsState("https://start.example/");
    const first = state.activeTabId;
    state = open(state, "b");
    state = open(state, "c");
    expect(state.tabs.map((tab) => tab.id)).toEqual([first, "b", "c"]);
    expect(state.activeTabId).toBe("c");

    state = browserTabsReducer(state, { type: "activate", id: "b" });
    expect(state.activeTabId).toBe("b");
    state = browserTabsReducer(state, { type: "close", id: "b" });
    expect(state.tabs.map((tab) => tab.id)).toEqual([first, "c"]);
    expect(state.activeTabId).toBe("c");
  });

  it("opens background tabs without switching and places page-opened tabs after the opener", () => {
    let state = createInitialBrowserTabsState("https://a.example/");
    const opener = state.activeTabId;
    state = open(state, "z");
    state = browserTabsReducer(state, { type: "activate", id: opener });
    state = open(state, "child-1", { openerTabId: opener, background: true });
    state = open(state, "child-2", { openerTabId: opener, background: true });
    expect(state.activeTabId).toBe(opener);
    expect(state.tabs.map((tab) => tab.id)).toEqual([opener, "child-1", "child-2", "z"]);
  });

  it("returns to the opener when a page-opened tab closes", () => {
    let state = createInitialBrowserTabsState("https://a.example/");
    const opener = state.activeTabId;
    state = open(state, "other");
    state = open(state, "child", { openerTabId: opener });
    state = browserTabsReducer(state, { type: "close", id: "child" });
    expect(state.activeTabId).toBe(opener);
  });

  it("keeps a new-tab page when the last tab closes and can reopen it", () => {
    let state = createInitialBrowserTabsState("https://a.example/");
    state = browserTabsReducer(state, { type: "close", id: state.activeTabId });
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0].url).toBe("");
    state = browserTabsReducer(state, { type: "reopenClosed" });
    expect(state.tabs.find((tab) => tab.id === state.activeTabId)?.url).toBe("https://a.example/");
  });

  it("discards the least recently used tabs beyond the live limit and revives on activate", () => {
    let state = createInitialBrowserTabsState("https://0.example/");
    const first = state.activeTabId;
    const start = Date.now() + 1_000;
    for (let index = 1; index <= MAX_LIVE_BROWSER_TABS; index += 1) {
      state = browserTabsReducer(state, {
        type: "open",
        id: `t${index}`,
        url: `https://${index}.example/`,
        now: start + index,
      });
    }
    expect(state.tabs.filter((tab) => !tab.discarded)).toHaveLength(MAX_LIVE_BROWSER_TABS);
    const discarded = state.tabs.find((tab) => tab.discarded);
    expect(discarded?.id).toBe(first);

    state = browserTabsReducer(state, { type: "activate", id: first, now: start + 100 });
    const revived = state.tabs.find((tab) => tab.id === first)!;
    expect(revived.discarded).toBe(false);
    expect(revived.generation).toBe(1);
    expect(revived.initialUrl).toBe("https://0.example/");
    expect(state.tabs.filter((tab) => !tab.discarded)).toHaveLength(MAX_LIVE_BROWSER_TABS);
  });

  it("remounts a crashed tab at its last URL", () => {
    let state = createInitialBrowserTabsState("https://a.example/");
    const id = state.activeTabId;
    state = browserTabsReducer(state, {
      type: "update",
      id,
      patch: { url: "https://a.example/page", crashed: "crashed" },
    });
    state = browserTabsReducer(state, { type: "reloadCrashed", id });
    const tab = state.tabs[0];
    expect(tab.crashed).toBeUndefined();
    expect(tab.generation).toBe(1);
    expect(tab.initialUrl).toBe("https://a.example/page");
  });

  it("restores web tabs from session storage and drops anything else", () => {
    let state = createInitialBrowserTabsState("https://a.example/");
    state = open(state, "b");
    state = browserTabsReducer(state, {
      type: "update",
      id: "b",
      patch: { url: "https://b.example/next", title: "B" },
    });
    state = browserTabsReducer(state, { type: "open", id: "local", url: "file:///tmp/x.html" });
    state = browserTabsReducer(state, { type: "activate", id: "b" });

    const restored = restoreBrowserTabs(serializeBrowserTabs(state));
    expect(restored?.tabs.map((tab) => [tab.url, tab.initialUrl])).toEqual([
      ["https://a.example/", "https://a.example/"],
      ["https://b.example/next", "https://b.example/next"],
    ]);
    expect(restored?.activeTabId).toBe("b");

    expect(restoreBrowserTabs("not json")).toBeNull();
    expect(
      restoreBrowserTabs(
        JSON.stringify({
          version: 1,
          activeTabId: "x",
          tabs: [{ id: "bad id!", url: "https://x/" }],
        }),
      ),
    ).toBeNull();
  });

  it("pins tabs to the front, places tabs to the right and closes many at once", () => {
    let state = createInitialBrowserTabsState("https://a.example/");
    const first = state.activeTabId;
    state = open(state, "b");
    state = open(state, "c");
    state = browserTabsReducer(state, { type: "togglePin", id: "c" });
    expect(state.tabs.map((tab) => [tab.id, tab.pinned])).toEqual([
      ["c", true],
      [first, false],
      ["b", false],
    ]);

    state = browserTabsReducer(state, {
      type: "open",
      id: "dup",
      url: "https://a.example/",
      afterTabId: first,
    });
    expect(state.tabs.map((tab) => tab.id)).toEqual(["c", first, "dup", "b"]);

    state = browserTabsReducer(state, { type: "activate", id: "b" });
    state = browserTabsReducer(state, { type: "closeMany", ids: [first, "dup", "b"] });
    expect(state.tabs.map((tab) => tab.id)).toEqual(["c"]);
    expect(state.activeTabId).toBe("c");
    expect(state.closed.map((entry) => entry.url)).toHaveLength(3);
  });
});
