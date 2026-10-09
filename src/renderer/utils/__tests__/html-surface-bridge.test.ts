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
});
