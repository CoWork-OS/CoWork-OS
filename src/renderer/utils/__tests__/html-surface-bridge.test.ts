import { describe, expect, it, vi } from "vitest";
import { HtmlSurfaceBridgeHost } from "../html-surface-bridge";

const nonce = "0123456789abcdef0123456789abcdef";

function setup() {
  const frame = { postMessage: vi.fn() };
  const callbacks = { onResize: vi.fn(), onState: vi.fn(), onError: vi.fn() };
  let now = 1000;
  const host = new HtmlSurfaceBridgeHost(
    () => frame,
    nonce,
    callbacks,
    () => now,
  );
  const message = (type: string, payload: unknown, extra: Record<string, unknown> = {}) => ({
    source: frame,
    data: { coworkSurface: 1, nonce, type, payload, ...extra },
  });
  return { frame, callbacks, host, message, tick: (ms: number) => (now += ms) };
}

describe("HtmlSurfaceBridgeHost", () => {
  it("acts on valid messages from its own frame", () => {
    const { host, callbacks, message } = setup();
    expect(host.handle(message("resize", { height: 12000 }))).toBe(true);
    expect(callbacks.onResize).toHaveBeenCalledWith(2400);
    expect(host.handle(message("state.set", { state: { goal: 5 } }))).toBe(true);
    expect(callbacks.onState).toHaveBeenCalledWith({ goal: 5 });
  });

  it("ignores other windows, wrong nonces and malformed payloads", () => {
    const { host, callbacks, message } = setup();
    expect(host.handle({ ...message("resize", { height: 100 }), source: {} })).toBe(false);
    expect(host.handle(message("resize", { height: 100 }, { nonce: "f".repeat(32) }))).toBe(false);
    expect(host.handle(message("state.set", { state: { nested: { a: 1 } } }))).toBe(false);
    expect(host.handle(message("navigate", { url: "https://example.com" }))).toBe(false);
    expect(callbacks.onResize).not.toHaveBeenCalled();
    expect(callbacks.onState).not.toHaveBeenCalled();
  });

  it("drops a flood of messages until the next second", () => {
    const { host, callbacks, message, tick } = setup();
    for (let index = 0; index < 100; index += 1)
      host.handle(message("resize", { height: 100 + index }));
    expect(callbacks.onResize).toHaveBeenCalledTimes(40);
    tick(1000);
    expect(host.handle(message("resize", { height: 300 }))).toBe(true);
  });

  it("sends init and theme messages carrying the nonce", () => {
    const { host, frame } = setup();
    host.init({ state: { goal: 1 }, theme: "dark", css: null, autosize: true });
    host.setTheme({ theme: "light", css: ":root{}" });
    expect(frame.postMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ type: "init", nonce, coworkSurface: 1 }),
      "*",
    );
    expect(frame.postMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ type: "theme", payload: { theme: "light", css: ":root{}" } }),
      "*",
    );
  });

  it("passes page actions to the app and answers them over the bridge", () => {
    const frame = { postMessage: vi.fn() };
    const onAction = vi.fn();
    const host = new HtmlSurfaceBridgeHost(() => frame, nonce, {
      onResize: vi.fn(),
      onState: vi.fn(),
      onAction,
    });
    const data = (payload: unknown) => ({
      source: frame,
      data: { coworkSurface: 1, nonce, type: "action", payload },
    });
    expect(host.handle(data({ id: 1, action: { prompt: "Book it" } }))).toBe(true);
    expect(onAction).toHaveBeenCalledWith(1, { prompt: "Book it" });
    // Anything but a prompt or a link is dropped before it reaches the app.
    expect(host.handle(data({ id: 2, action: { run: "ls" } }))).toBe(false);
    expect(host.handle(data({ id: 3, action: { prompt: "a", open: "https://a.com" } }))).toBe(
      false,
    );
    host.actionResult(1, true);
    expect(frame.postMessage).toHaveBeenLastCalledWith(
      { coworkSurface: 1, type: "action.result", nonce, payload: { id: 1, ok: true } },
      "*",
    );
  });

  it("refuses actions where the view offers none", () => {
    const { host, frame, message } = setup();
    expect(host.handle(message("action", { id: 7, action: { open: "https://a.com" } }))).toBe(true);
    expect(frame.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "action.result", payload: { id: 7, ok: false } }),
      "*",
    );
  });
});
