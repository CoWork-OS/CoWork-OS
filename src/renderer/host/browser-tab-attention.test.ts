import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../../shared/types";
import {
  createFaviconBadge,
  createTabAttentionController,
  formatAttentionReasonTitle,
  formatAttentionTitle,
  isUserAway,
  TAB_ATTENTION_ALTERNATE_MS,
  TAB_ATTENTION_DOT_FALLBACK,
  waitingSessionsFromTasks,
} from "./browser-tab-attention";

type Listener = () => void;

class FakeTarget {
  listeners = new Map<string, Set<Listener>>();
  addEventListener(type: string, listener: Listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: Listener) {
    this.listeners.get(type)?.delete(listener);
  }
  dispatch(type: string) {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
  count() {
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }
}

class FakeLink {
  attrs = new Map<string, string>();
  constructor(href: string | null) {
    if (href !== null) this.attrs.set("href", href);
  }
  get href() {
    return this.attrs.get("href") ?? "";
  }
  getAttribute(name: string) {
    return this.attrs.get(name) ?? null;
  }
  setAttribute(name: string, value: string) {
    this.attrs.set(name, value);
  }
  removeAttribute(name: string) {
    this.attrs.delete(name);
  }
}

class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  src = "";
}

function makeEnv(
  options: { links?: FakeLink[]; noCanvas?: boolean; reducedMotion?: boolean } = {},
) {
  const images: FakeImage[] = [];
  const links = options.links ?? [new FakeLink("/app/icon.png")];
  const context = {
    drawImage: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    fillStyle: "",
  };
  const doc = Object.assign(new FakeTarget(), {
    title: "CoWork OS",
    hidden: false,
    focused: true,
    documentElement: {},
    hasFocus() {
      return this.focused;
    },
    querySelectorAll: vi.fn(() => links),
    createElement: vi.fn((tag: string) => {
      if (tag === "img") {
        const image = new FakeImage();
        images.push(image);
        return image;
      }
      return {
        width: 0,
        height: 0,
        getContext: () => (options.noCanvas ? null : context),
        toDataURL: () => "data:image/png;base64,BADGED",
      };
    }),
  });
  const win = Object.assign(new FakeTarget(), {
    setInterval: (fn: () => void, ms: number) => setInterval(fn, ms) as unknown as number,
    clearInterval: (id: number) => clearInterval(id),
    matchMedia: () => ({ matches: options.reducedMotion === true }),
    getComputedStyle: (): { getPropertyValue: () => string } => ({
      getPropertyValue: () => " #fbbf24 ",
    }),
  });
  return { doc, win, links, images, context };
}

function create(env: ReturnType<typeof makeEnv>) {
  return createTabAttentionController(env.doc as never, env.win as never);
}

const one = new Map([["task-1", "Approval needed"]]);
const three = new Map([
  ["task-1", "Approval needed"],
  ["task-2", "Response needed"],
  ["task-3", "Waiting"],
]);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("waiting sessions from the task list", () => {
  it("keeps top-level sessions that wait on the user, with the reason", () => {
    const task = (overrides: Partial<Task>): Task =>
      ({
        id: "task",
        title: "Fixture",
        prompt: "",
        status: "executing",
        workspaceId: "workspace-1",
        createdAt: 1,
        updatedAt: 1,
        ...overrides,
      }) as Task;
    const waiting = waitingSessionsFromTasks([
      task({ id: "approval", status: "blocked", terminalStatus: "awaiting_approval" }),
      task({ id: "question", status: "paused", terminalStatus: "needs_user_action" }),
      task({ id: "running" }),
      task({ id: "done", status: "completed" }),
      task({ id: "child", status: "blocked", parentTaskId: "approval" }),
    ]);
    expect([...waiting]).toEqual([
      ["approval", "Approval needed"],
      ["question", "Response needed"],
    ]);
  });
});

describe("tab attention titles", () => {
  it("formats the counted and reason titles", () => {
    expect(formatAttentionTitle("CoWork OS", 0)).toBe("CoWork OS");
    expect(formatAttentionTitle("CoWork OS", 1)).toBe("(1) CoWork OS");
    expect(formatAttentionTitle("CoWork OS", 12)).toBe("(12) CoWork OS");
    expect(formatAttentionReasonTitle("CoWork OS", one)).toBe("Approval needed · CoWork OS");
    expect(formatAttentionReasonTitle("CoWork OS", three)).toBe("Needs you · CoWork OS");
    expect(formatAttentionReasonTitle("CoWork OS", new Map([["t", " "]]))).toBe(
      "Needs you · CoWork OS",
    );
  });

  it("treats a hidden or unfocused document as away", () => {
    expect(isUserAway({ hidden: false, hasFocus: () => true })).toBe(false);
    expect(isUserAway({ hidden: true, hasFocus: () => true })).toBe(true);
    expect(isUserAway({ hidden: false, hasFocus: () => false })).toBe(true);
  });
});

describe("tab attention controller", () => {
  it("shows a steady count while the user is present, for zero, one and many", () => {
    const env = makeEnv();
    env.doc.title = "My host";
    const controller = create(env);

    controller.update(new Map());
    expect(env.doc.title).toBe("My host");
    controller.update(one);
    expect(env.doc.title).toBe("(1) My host");
    controller.update(three);
    expect(env.doc.title).toBe("(3) My host");
    vi.advanceTimersByTime(TAB_ATTENTION_ALTERNATE_MS * 3);
    expect(env.doc.title).toBe("(3) My host");
    controller.dispose();
  });

  it("alternates with the reason for tasks that wait while away, and stops on return", () => {
    const env = makeEnv();
    const controller = create(env);

    env.doc.hidden = true;
    env.doc.dispatch("visibilitychange");
    controller.update(one);
    expect(env.doc.title).toBe("(1) CoWork OS");
    vi.advanceTimersByTime(TAB_ATTENTION_ALTERNATE_MS);
    expect(env.doc.title).toBe("Approval needed · CoWork OS");
    vi.advanceTimersByTime(TAB_ATTENTION_ALTERNATE_MS);
    expect(env.doc.title).toBe("(1) CoWork OS");
    vi.advanceTimersByTime(TAB_ATTENTION_ALTERNATE_MS);

    controller.update(three);
    expect(env.doc.title).toBe("Needs you · CoWork OS");

    env.doc.hidden = false;
    env.win.dispatch("focus");
    expect(env.doc.title).toBe("(3) CoWork OS");
    vi.advanceTimersByTime(TAB_ATTENTION_ALTERNATE_MS * 4);
    expect(env.doc.title).toBe("(3) CoWork OS");
    controller.dispose();
  });

  it("keeps a steady count for tasks the user already saw, and flashes only the new one", () => {
    const env = makeEnv();
    const controller = create(env);
    controller.update(one);

    env.doc.hidden = true;
    env.doc.dispatch("visibilitychange");
    vi.advanceTimersByTime(TAB_ATTENTION_ALTERNATE_MS * 3);
    expect(env.doc.title).toBe("(1) CoWork OS");

    controller.update(
      new Map([
        ["task-1", "Approval needed"],
        ["task-2", "Response needed"],
      ]),
    );
    vi.advanceTimersByTime(TAB_ATTENTION_ALTERNATE_MS);
    expect(env.doc.title).toBe("Response needed · CoWork OS");

    // Coming back marks everything seen; leaving again stays steady.
    env.doc.hidden = false;
    env.doc.dispatch("visibilitychange");
    env.doc.hidden = true;
    env.doc.dispatch("visibilitychange");
    vi.advanceTimersByTime(TAB_ATTENTION_ALTERNATE_MS * 3);
    expect(env.doc.title).toBe("(2) CoWork OS");
    controller.dispose();
  });

  it("flashes again when a task stops waiting and waits again while away", () => {
    const env = makeEnv();
    const controller = create(env);
    controller.update(one);
    env.doc.hidden = true;
    env.doc.dispatch("visibilitychange");
    controller.update(new Map());
    controller.update(one);
    vi.advanceTimersByTime(TAB_ATTENTION_ALTERNATE_MS);
    expect(env.doc.title).toBe("Approval needed · CoWork OS");
    controller.dispose();
  });

  it("alternates when another app has focus (blur)", () => {
    const env = makeEnv();
    const controller = create(env);
    env.doc.focused = false;
    env.win.dispatch("blur");
    controller.update(three);
    vi.advanceTimersByTime(TAB_ATTENTION_ALTERNATE_MS);
    expect(env.doc.title).toBe("Needs you · CoWork OS");
    controller.dispose();
  });

  it("never alternates under reduced motion", () => {
    const env = makeEnv({ reducedMotion: true });
    const controller = create(env);
    env.doc.hidden = true;
    controller.update(one);
    vi.advanceTimersByTime(TAB_ATTENTION_ALTERNATE_MS * 5);
    expect(env.doc.title).toBe("(1) CoWork OS");
    controller.dispose();
  });

  it("restores the base title at zero and on dispose, and removes its listeners", () => {
    const env = makeEnv();
    const controller = create(env);
    env.doc.hidden = true;
    controller.update(three);
    vi.advanceTimersByTime(TAB_ATTENTION_ALTERNATE_MS);
    controller.update(new Map());
    expect(env.doc.title).toBe("CoWork OS");
    vi.advanceTimersByTime(TAB_ATTENTION_ALTERNATE_MS * 3);
    expect(env.doc.title).toBe("CoWork OS");

    controller.update(one);
    expect(env.doc.title).toBe("(1) CoWork OS");
    controller.dispose();
    expect(env.doc.title).toBe("CoWork OS");
    expect(env.doc.count() + env.win.count()).toBe(0);
    vi.advanceTimersByTime(TAB_ATTENTION_ALTERNATE_MS * 3);
    expect(env.doc.title).toBe("CoWork OS");
  });

  it("badges the favicon while tasks wait and restores every link at zero", () => {
    const links = [new FakeLink("/app/icon.png"), new FakeLink("/app/icon-32.png")];
    const env = makeEnv({ links });
    const controller = create(env);
    controller.update(one);
    expect(env.images).toHaveLength(1);
    expect(env.images[0].src).toBe("/app/icon.png");
    env.images[0].onload?.();
    expect(links.map((link) => link.href)).toEqual([
      "data:image/png;base64,BADGED",
      "data:image/png;base64,BADGED",
    ]);
    expect(env.context.fillStyle).toBe("#fbbf24");

    controller.update(new Map());
    expect(links.map((link) => link.href)).toEqual(["/app/icon.png", "/app/icon-32.png"]);

    // A second round reuses the drawn icon, and dispose restores too.
    controller.update(three);
    expect(env.images).toHaveLength(1);
    expect(links[0].href).toBe("data:image/png;base64,BADGED");
    controller.dispose();
    expect(links.map((link) => link.href)).toEqual(["/app/icon.png", "/app/icon-32.png"]);
  });

  it("ignores an icon that finishes loading after the count went back to zero", () => {
    const env = makeEnv();
    const controller = create(env);
    controller.update(one);
    controller.update(new Map());
    env.images[0].onload?.();
    expect(env.links[0].href).toBe("/app/icon.png");
    controller.dispose();
  });
});

describe("favicon badge", () => {
  it("fails quietly without a canvas context or icon link", () => {
    const env = makeEnv({ noCanvas: true });
    const badge = createFaviconBadge(env.doc as never, env.win as never);
    badge.show();
    expect(() => env.images[0].onload?.()).not.toThrow();
    expect(env.links[0].href).toBe("/app/icon.png");
    badge.clear();

    const bare = makeEnv({ links: [] });
    const empty = createFaviconBadge(bare.doc as never, bare.win as never);
    expect(() => empty.show()).not.toThrow();
    expect(bare.images).toHaveLength(0);
  });

  it("falls back to a constant dot colour when the token is unreadable", () => {
    const env = makeEnv();
    env.win.getComputedStyle = () => ({ getPropertyValue: () => "" });
    const badge = createFaviconBadge(env.doc as never, env.win as never);
    badge.show();
    env.images[0].onload?.();
    expect(env.context.fillStyle).toBe(TAB_ATTENTION_DOT_FALLBACK);
    badge.clear();
  });
});
