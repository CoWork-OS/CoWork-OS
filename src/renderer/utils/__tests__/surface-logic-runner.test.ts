import { describe, expect, it, vi } from "vitest";
import { SurfaceLogicChannel } from "../surface-logic-runner";

const nonce = "0123456789abcdef0123456789abcdef";

describe("SurfaceLogicChannel", () => {
  const setup = () => {
    const frame = { postMessage: vi.fn() };
    const channel = new SurfaceLogicChannel(() => frame, nonce);
    const message = (data: Record<string, unknown>) => ({
      source: frame,
      data: { coworkLogic: 1, nonce, ...data },
    });
    return { frame, channel, message };
  };

  it("delivers results for a loaded surface and becomes ready on hello's answer", async () => {
    const { channel, message, frame } = setup();
    channel.hello();
    expect(frame.postMessage).toHaveBeenCalledWith({ coworkLogic: 1, nonce, type: "hello" }, "*");
    expect(channel.handle(message({ type: "ready" }))).toBe(true);
    await expect(channel.whenReady()).resolves.toBe(true);
    const listener = vi.fn();
    channel.load("logic-1", "function compute(){return {}}", listener);
    channel.run("logic-1", 1, { years: 5 });
    expect(frame.postMessage).toHaveBeenLastCalledWith(
      { coworkLogic: 1, nonce, type: "run", id: "logic-1", seq: 1, state: { years: 5 } },
      "*",
    );
    channel.handle(message({ type: "result", id: "logic-1", seq: 1, json: '{"total":3}' }));
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ json: '{"total":3}' }));
  });

  it("ignores other windows, wrong nonces and unknown message types", () => {
    const { channel, message } = setup();
    const listener = vi.fn();
    channel.load("logic-1", "x", listener);
    expect(channel.handle({ ...message({ type: "ready" }), source: {} })).toBe(false);
    expect(
      channel.handle(
        message({ type: "result", id: "logic-1", seq: 1, json: "1", nonce: "f".repeat(32) }),
      ),
    ).toBe(false);
    expect(channel.handle(message({ type: "navigate", id: "logic-1" }))).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });
});
