import { afterEach, describe, expect, it, vi } from "vitest";
import { fitComposerMenuHeight, fitComposerMenuWidth } from "../composer-menu-fit";

type FakeNode = {
  parentElement: FakeNode | null;
  overflowX: string;
  rect: { left: number; right: number };
  getBoundingClientRect: () => { left: number; right: number };
  style: {
    props: Map<string, string>;
    setProperty: (name: string, value: string) => void;
    removeProperty: (name: string) => void;
  };
};

function node(overflowX: string, left: number, right: number, parent: FakeNode | null): FakeNode {
  const props = new Map<string, string>();
  const fake: FakeNode = {
    parentElement: parent,
    overflowX,
    rect: { left, right },
    getBoundingClientRect: () => fake.rect,
    style: {
      props,
      setProperty: (name, value) => void props.set(name, value),
      removeProperty: (name) => void props.delete(name),
    },
  };
  return fake;
}

afterEach(() => vi.unstubAllGlobals());

describe("fitComposerMenuWidth", () => {
  it("caps the menu to the room left in the scrolling chat column", () => {
    // Window 1280px; the chat column ends at 979px because the right panel is open.
    const chat = node("auto", 289, 979, null);
    const composer = node("visible", 313, 955, chat);
    const menu = node("hidden", 414, 1134, composer);
    vi.stubGlobal("window", { innerWidth: 1280 });
    vi.stubGlobal("getComputedStyle", (el: FakeNode) => ({ overflowX: el.overflowX }));

    fitComposerMenuWidth(menu as unknown as HTMLElement);

    expect(menu.style.props.get("--composer-menu-max-width")).toBe("553px");
  });

  it("never goes below a usable width", () => {
    const chat = node("hidden", 0, 500, null);
    const menu = node("hidden", 400, 600, chat);
    vi.stubGlobal("window", { innerWidth: 1280 });
    vi.stubGlobal("getComputedStyle", (el: FakeNode) => ({ overflowX: el.overflowX }));

    fitComposerMenuWidth(menu as unknown as HTMLElement);

    expect(menu.style.props.get("--composer-menu-max-width")).toBe("220px");
  });
});

type FakeBox = {
  parentElement: FakeBox | null;
  overflowY: string;
  rect: { top: number; bottom: number };
  getBoundingClientRect: () => { top: number; bottom: number };
  attrs: Map<string, string>;
  setAttribute: (name: string, value: string) => void;
  removeAttribute: (name: string) => void;
  style: {
    props: Map<string, string>;
    setProperty: (name: string, value: string) => void;
    removeProperty: (name: string) => void;
  };
};

function box(overflowY: string, top: number, bottom: number, parent: FakeBox | null): FakeBox {
  const props = new Map<string, string>();
  const attrs = new Map<string, string>();
  const fake: FakeBox = {
    parentElement: parent,
    overflowY,
    rect: { top, bottom },
    getBoundingClientRect: () => fake.rect,
    attrs,
    setAttribute: (name, value) => void attrs.set(name, value),
    removeAttribute: (name) => void attrs.delete(name),
    style: {
      props,
      setProperty: (name, value) => void props.set(name, value),
      removeProperty: (name) => void props.delete(name),
    },
  };
  return fake;
}

describe("fitComposerMenuHeight", () => {
  const stub = () => {
    vi.stubGlobal("window", { innerHeight: 900 });
    vi.stubGlobal("getComputedStyle", (el: FakeBox) => ({ overflowY: el.overflowY }));
  };

  it("keeps the menu above a low composer and caps it to the room there", () => {
    stub();
    const canvas = box("auto", 48, 890, null);
    const anchor = box("visible", 760, 800, canvas);
    const menu = box("auto", 0, 0, anchor);

    fitComposerMenuHeight(menu as unknown as HTMLElement);

    expect(menu.attrs.has("data-placement")).toBe(false);
    expect(menu.style.props.get("--composer-menu-max-height")).toBe("692px");
  });

  it("opens below a composer that sits near the top of the view", () => {
    // Calm Home with Today cards under the composer: 222px from the top of the window.
    stub();
    const canvas = box("auto", 48, 890, null);
    const anchor = box("visible", 222, 260, canvas);
    const menu = box("auto", 0, 0, anchor);

    fitComposerMenuHeight(menu as unknown as HTMLElement);

    expect(menu.attrs.get("data-placement")).toBe("below");
    expect(menu.style.props.get("--composer-menu-max-height")).toBe("610px");
  });
});
