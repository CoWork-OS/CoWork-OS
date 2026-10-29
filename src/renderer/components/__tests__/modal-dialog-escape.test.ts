import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useModalDialog } from "../ModalDialog";

// The suite has no DOM, so run the hook's layout effect inline against a small
// fake document; the Escape, focus and stacking logic under test is the real one.
const hooks = vi.hoisted(() => ({ cleanups: [] as Array<() => void> }));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useRef: <T>(current: T) => ({ current }),
  useLayoutEffect: (effect: () => void | (() => void)) => {
    const cleanup = effect();
    if (cleanup) hooks.cleanups.push(cleanup);
  },
}));

type KeyListener = (event: FakeKeyEvent) => void;
type FakeKeyEvent = {
  key: string;
  shiftKey: boolean;
  defaultPrevented: boolean;
  preventDefault: () => void;
  stopImmediatePropagation: () => void;
};

const fakeDocument = {
  activeElement: null as FakeElement | null,
  listeners: new Map<string, KeyListener[]>(),
  addEventListener(type: string, listener: KeyListener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  },
  removeEventListener(type: string, listener: KeyListener) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((other) => other !== listener),
    );
  },
};

class FakeElement {
  tabIndex = 0;
  isConnected = true;
  constructor(private readonly items: FakeElement[] = []) {}
  focus() {
    fakeDocument.activeElement = this;
  }
  contains(node: unknown): boolean {
    return node === this || this.items.some((item) => item.contains(node));
  }
  querySelectorAll() {
    return this.items;
  }
  matches() {
    return false;
  }
  closest() {
    return null;
  }
  getClientRects() {
    return [{}];
  }
}

function press(key: string): FakeKeyEvent {
  let stopped = false;
  const event: FakeKeyEvent = {
    key,
    shiftKey: false,
    defaultPrevented: false,
    preventDefault: () => {
      event.defaultPrevented = true;
    },
    stopImmediatePropagation: () => {
      stopped = true;
    },
  };
  for (const listener of fakeDocument.listeners.get("keydown") ?? []) {
    if (stopped) break;
    listener(event);
  }
  return event;
}

function open(dialog: FakeElement, onClose: () => void): () => void {
  const before = hooks.cleanups.length;
  useModalDialog({ current: dialog as unknown as HTMLElement }, onClose);
  const cleanup = hooks.cleanups[before];
  return () => {
    hooks.cleanups.splice(hooks.cleanups.indexOf(cleanup), 1);
    cleanup();
  };
}

beforeEach(() => {
  fakeDocument.activeElement = null;
  fakeDocument.listeners.clear();
  vi.stubGlobal("document", fakeDocument);
  vi.stubGlobal("HTMLElement", FakeElement);
});

afterEach(() => {
  for (const cleanup of hooks.cleanups.splice(0).reverse()) cleanup();
  vi.unstubAllGlobals();
});

describe("useModalDialog", () => {
  it("moves focus in, closes on Escape and gives focus back to the opener", () => {
    const opener = new FakeElement();
    opener.focus();
    const back = new FakeElement();
    const onClose = vi.fn();

    const close = open(new FakeElement([back, new FakeElement()]), onClose);
    expect(fakeDocument.activeElement).toBe(back);

    const escape = press("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(escape.defaultPrevented).toBe(true);
    expect(press("Enter").defaultPrevented).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);

    close();
    expect(fakeDocument.activeElement).toBe(opener);
    press("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes only the top window when one opens over another", () => {
    const closeProfile = vi.fn();
    const closeReview = vi.fn();
    open(new FakeElement([new FakeElement()]), closeProfile);
    const closeReviewWindow = open(new FakeElement([new FakeElement()]), closeReview);

    press("Escape");
    expect(closeReview).toHaveBeenCalledTimes(1);
    expect(closeProfile).not.toHaveBeenCalled();

    closeReviewWindow();
    press("Escape");
    expect(closeProfile).toHaveBeenCalledTimes(1);
    expect(closeReview).toHaveBeenCalledTimes(1);
  });
});
