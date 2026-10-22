import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserWorkbenchDock } from "../BrowserWorkbenchDock";

// Exercise the dock's layout lifecycle without requiring a browser or a native
// webview. The app's live artifact smoke test covers the editor's draft state.
const hooks = vi.hoisted(() => {
  let cursor = 0;
  let slots: Array<{ value?: unknown; deps?: unknown[]; cleanup?: () => void }> = [];
  let effects: Array<() => void> = [];
  return {
    reset() {
      cursor = 0;
      slots = [];
      effects = [];
    },
    begin() {
      cursor = 0;
    },
    commit() {
      const pending = effects;
      effects = [];
      pending.forEach((effect) => effect());
    },
    dispose() {
      slots.forEach((slot) => slot.cleanup?.());
    },
    useRef(value: unknown) {
      return (slots[cursor++] ??= { value: { current: value } }).value;
    },
    useState(value: unknown) {
      const slot = (slots[cursor++] ??= { value });
      return [
        slot.value,
        (next: unknown) => {
          slot.value = typeof next === "function" ? next(slot.value) : next;
        },
      ];
    },
    useLayoutEffect(effect: () => (() => void) | undefined, deps: unknown[]) {
      const slot = (slots[cursor++] ??= {});
      if (!slot.deps || deps.some((value, index) => !Object.is(value, slot.deps?.[index]))) {
        slot.deps = deps;
        effects.push(() => {
          slot.cleanup?.();
          slot.cleanup = effect();
        });
      }
    },
  };
});

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useRef: hooks.useRef,
  useState: hooks.useState,
  useLayoutEffect: hooks.useLayoutEffect,
}));

let observerCallback: () => void;
let frames: Array<() => void>;
let disconnect: ReturnType<typeof vi.fn>;
let observe: ReturnType<typeof vi.fn>;
let removeWindowListener: ReturnType<typeof vi.fn>;
let removeDocumentListener: ReturnType<typeof vi.fn>;

const editor = React.createElement("div", { contentEditable: true }, "Unsaved draft");
const parent = {
  getBoundingClientRect: () => ({ left: 20, top: 10 }),
  clientLeft: 2,
  clientTop: 3,
  scrollLeft: 5,
  scrollTop: 8,
};
const dock = { offsetParent: parent };

function render(mode: "sidebar" | "fullscreen", slot: HTMLElement | null) {
  hooks.begin();
  const result = BrowserWorkbenchDock({ mode, slot, children: editor });
  result.props.ref.current = dock;
  hooks.commit();
  return result;
}

beforeEach(() => {
  hooks.reset();
  frames = [];
  disconnect = vi.fn();
  observe = vi.fn();
  removeWindowListener = vi.fn();
  removeDocumentListener = vi.fn();
  vi.stubGlobal("window", {
    scrollX: 0,
    scrollY: 0,
    addEventListener: vi.fn(),
    removeEventListener: removeWindowListener,
  });
  vi.stubGlobal("document", {
    documentElement: {},
    addEventListener: vi.fn(),
    removeEventListener: removeDocumentListener,
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        observerCallback = callback;
      }
      observe = observe;
      disconnect = disconnect;
    },
  );
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => frames.push(callback));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});

afterEach(() => {
  hooks.dispose();
  vi.unstubAllGlobals();
});

describe("persistent workbench dock", () => {
  it("fits an artifact sidebar slot in a bordered, scrolled containing block", () => {
    const slot = {
      getBoundingClientRect: () => ({ left: 340, top: 70, width: 410, height: 690 }),
      parentElement: {},
    } as unknown as HTMLElement;

    render("sidebar", slot);
    const result = render("sidebar", slot);

    expect(result.props.style).toEqual({ left: 323, top: 65, width: 410, height: 690 });
    expect(result.props.className).not.toContain("is-unplaced");
    expect(result.props.children).toBe(editor);
  });

  it("tracks resized sidebar slots and keeps the editor when returning to full view", () => {
    let width = 420;
    const slot = {
      getBoundingClientRect: () => ({ left: 340, top: 70, width, height: 690 }),
      parentElement: {},
    } as unknown as HTMLElement;
    render("sidebar", slot);

    width = 560;
    observerCallback();
    frames.splice(0).forEach((frame) => frame());
    expect(render("sidebar", slot).props.style?.width).toBe(560);

    const fullView = render("fullscreen", null);
    expect(fullView.props.className).toContain("is-fullscreen");
    expect(fullView.props.style).toBeUndefined();
    expect(fullView.props.children).toBe(editor);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(removeWindowListener).toHaveBeenCalledWith("resize", expect.any(Function));
    expect(removeDocumentListener).toHaveBeenCalledWith(
      "transitionend",
      expect.any(Function),
      true,
    );

    render("sidebar", slot);
    expect(render("sidebar", slot).props.style?.width).toBe(560);
  });

  it("hides a dock until the new sidebar slot is mounted", () => {
    const result = render("sidebar", null);
    expect(result.props.className).toContain("is-unplaced");
  });
});
