import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BROWSER_SETTINGS } from "../../../shared/browser-settings";

// Exercise the real effect bodies and host-capability checks without a DOM. The
// broad browser smoke separately covers mounting, navigation and rendered state.
const hooks = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  states: [] as unknown[],
}));

vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return {
    ...actual,
    useEffect: (effect: () => void | (() => void)) => hooks.effects.push(effect),
    useState: (initial: unknown) => {
      const index = hooks.states.length;
      hooks.states.push(typeof initial === "function" ? initial() : initial);
      return [
        hooks.states[index],
        (next: unknown) => {
          hooks.states[index] = typeof next === "function" ? next(hooks.states[index]) : next;
        },
      ];
    },
    useRef: (value: unknown) => ({ current: value }),
    useCallback: (callback: unknown) => callback,
  };
});

import { useBrowserSettings } from "../useBrowserSettings";
import { useAttentionLoader } from "../useAttentionSnapshot";
import { PrivateBrowserPrompts } from "../../components/BrowserWorkbench/PrivateBrowserPrompt";

const cleanups: Array<() => void> = [];

function mount<T>(render: () => T): T {
  const result = render();
  for (const effect of hooks.effects.splice(0)) {
    const cleanup = effect();
    if (cleanup) cleanups.push(cleanup);
  }
  return result;
}

function installHost(
  methods: Record<string, unknown>,
  advertised = Object.keys(methods),
  browser = true,
) {
  const unsupported = vi.fn((method: string) => {
    throw new Error(`Unsupported proxy method invoked: ${method}`);
  });
  // The browser bridge deliberately returns callable stubs for missing APIs:
  // truthiness, optional chaining and typeof therefore do not detect support.
  const api = new Proxy(methods, {
    get(target, property) {
      if (Object.hasOwn(target, property)) return target[property as string];
      return () => unsupported(String(property));
    },
  });
  const window = Object.assign(new EventTarget(), {
    coworkBrowserHost: browser,
    coworkBrowserHostInfo: {
      desktopMethods: Object.fromEntries(advertised.map((name) => [name, { mutation: false }])),
    },
    electronAPI: api,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  });
  vi.stubGlobal("window", window);
  return { window, unsupported };
}

beforeEach(() => {
  vi.useFakeTimers();
  hooks.effects.length = 0;
  hooks.states.length = 0;
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("browser settings capability boundary", () => {
  it("uses defaults without invoking missing loads or optimistically saving unsupported changes", async () => {
    const { unsupported } = installHost({});
    const result = mount(useBrowserSettings);
    expect(hooks.states).toEqual([DEFAULT_BROWSER_SETTINGS, undefined, true]);
    await expect(result.save({ developerMode: true })).rejects.toThrow("cannot be changed");
    expect(hooks.states[0]).toEqual(DEFAULT_BROWSER_SETTINGS);
    expect(unsupported).not.toHaveBeenCalled();
  });

  it.each([true, false])("loads and saves supported settings (browser=%s)", async (browser) => {
    const settings = {
      ...DEFAULT_BROWSER_SETTINGS,
      searchEngine: "duckduckgo",
      policy: { developerModeLocked: true, blockedSitePermissions: ["camera"] },
    };
    const getBrowserSettings = vi.fn().mockResolvedValue(settings);
    const saveBrowserSettings = vi.fn().mockResolvedValue({
      settings: { ...settings, historyEnabled: false },
    });
    const { window, unsupported } = installHost(
      { getBrowserSettings, saveBrowserSettings },
      browser ? ["getBrowserSettings", "saveBrowserSettings"] : [],
      browser,
    );
    const changed = vi.fn();
    window.addEventListener("cowork:browser-settings-changed", changed);
    const result = mount(useBrowserSettings);
    await vi.advanceTimersByTimeAsync(0);
    expect(getBrowserSettings).toHaveBeenCalledOnce();
    expect(hooks.states[0]).toMatchObject({ searchEngine: "duckduckgo" });
    expect(hooks.states[1]).toEqual(settings.policy);
    expect(hooks.states[2]).toBe(true);
    await result.save({ historyEnabled: false });
    expect(saveBrowserSettings).toHaveBeenCalledExactlyOnceWith({ historyEnabled: false });
    expect(hooks.states[0]).toMatchObject({ historyEnabled: false });
    expect(changed).toHaveBeenCalledOnce();
    expect(unsupported).not.toHaveBeenCalled();
  });

  it("keeps loaded settings unchanged when the host advertises reads but no save", async () => {
    const { unsupported } = installHost({
      getBrowserSettings: vi
        .fn()
        .mockResolvedValue({ ...DEFAULT_BROWSER_SETTINGS, searchEngine: "bing" }),
    });
    const result = mount(useBrowserSettings);
    await vi.advanceTimersByTimeAsync(0);
    await expect(result.save({ searchEngine: "kagi" })).rejects.toThrow("cannot be changed");
    expect(hooks.states[0]).toMatchObject({ searchEngine: "bing" });
    expect(unsupported).not.toHaveBeenCalled();
  });
});

describe("attention capability boundary", () => {
  it("keeps meaningful suggestions and commitments when the shared queue is absent", async () => {
    const listSuggestionsForWorkspaces = vi.fn().mockResolvedValue([
      {
        workspaceId: "workspace-1",
        suggestions: [
          {
            id: "suggestion-1",
            title: "Review notes",
            actionPrompt: "Review the local notes",
            createdAt: Date.now(),
            type: "follow_up",
          },
        ],
      },
    ]);
    const { unsupported } = installHost({
      listWorkspaces: vi
        .fn()
        .mockResolvedValue([
          { id: "workspace-1" },
          { id: "__temp_workspace__scratch", isTemp: true },
        ]),
      listSuggestionsForWorkspaces,
      getDueSoonCommitments: vi.fn().mockResolvedValue({
        items: [{ id: "commitment-1", text: "Send local report", dueAt: Date.now() + 1000 }],
      }),
    });
    mount(() => useAttentionLoader(true));
    await vi.advanceTimersByTimeAsync(0);
    expect(listSuggestionsForWorkspaces).toHaveBeenCalledExactlyOnceWith(["workspace-1"]);
    expect(hooks.states[0]).toMatchObject({
      fromQueue: false,
      failedSources: [],
      items: expect.arrayContaining([
        expect.objectContaining({ id: "suggestion:suggestion-1" }),
        expect.objectContaining({ id: "commitment:commitment-1" }),
      ]),
    });
    expect(unsupported).not.toHaveBeenCalled();
  });

  it("loads the supported queue, reloads on its signal and unsubscribes on cleanup", async () => {
    let signal!: () => void;
    const unsubscribe = vi.fn();
    const listAttention = vi.fn().mockResolvedValue({ items: [], failedSources: ["suggestions"] });
    const onAttentionChanged = vi.fn((listener: () => void) => {
      signal = listener;
      return unsubscribe;
    });
    const { unsupported } = installHost({ listAttention, onAttentionChanged });
    mount(() => useAttentionLoader(true));
    await vi.advanceTimersByTimeAsync(0);
    expect(hooks.states[0]).toEqual({ fromQueue: true, items: [], failedSources: ["suggestions"] });
    expect(onAttentionChanged).toHaveBeenCalledOnce();
    signal();
    await vi.advanceTimersByTimeAsync(250);
    expect(listAttention).toHaveBeenCalledTimes(2);
    cleanups.pop()?.();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(unsupported).not.toHaveBeenCalled();
  });

  it("can read a supported queue without an unavailable subscription", async () => {
    const listAttention = vi.fn().mockResolvedValue({ items: [], failedSources: [] });
    const { unsupported } = installHost({ listAttention });
    mount(() => useAttentionLoader(true));
    await vi.advanceTimersByTimeAsync(0);
    expect(listAttention).toHaveBeenCalledOnce();
    expect(unsupported).not.toHaveBeenCalled();
  });
});

describe("private browser prompt capability boundary", () => {
  it("does not subscribe to or list an absent private vault", async () => {
    const { unsupported } = installHost({});
    expect(mount(PrivateBrowserPrompts)).toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    expect(hooks.states[0]).toEqual([]);
    expect(unsupported).not.toHaveBeenCalled();
  });

  it("loads supported private prompts, refreshes on changes and discards late replies after cleanup", async () => {
    let signal!: () => void;
    const unsubscribe = vi.fn();
    const prompts = [{ id: "private-prompt-1", kind: "login", origin: "https://example.invalid" }];
    const listBrowserVaultPrompts = vi.fn().mockResolvedValueOnce(prompts);
    const onBrowserVaultPromptChanged = vi.fn((listener: () => void) => {
      signal = listener;
      return unsubscribe;
    });
    const { unsupported } = installHost({ listBrowserVaultPrompts, onBrowserVaultPromptChanged });
    mount(PrivateBrowserPrompts);
    await vi.advanceTimersByTimeAsync(0);
    expect(hooks.states[0]).toEqual(prompts);
    let finish!: (value: unknown[]) => void;
    listBrowserVaultPrompts.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    signal();
    expect(listBrowserVaultPrompts).toHaveBeenCalledTimes(2);
    cleanups.pop()?.();
    finish([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(hooks.states[0]).toEqual(prompts);
    expect(unsupported).not.toHaveBeenCalled();
  });

  it("loads supported private prompts even when its optional subscription is absent", async () => {
    const listBrowserVaultPrompts = vi.fn().mockResolvedValue([]);
    const { unsupported } = installHost({ listBrowserVaultPrompts });
    mount(PrivateBrowserPrompts);
    await vi.advanceTimersByTimeAsync(0);
    expect(listBrowserVaultPrompts).toHaveBeenCalledOnce();
    expect(unsupported).not.toHaveBeenCalled();
  });
});
