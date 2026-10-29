import { afterEach, describe, expect, it, vi } from "vitest";
import { fitComposerMenuWidth } from "../composer-menu-fit";

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
