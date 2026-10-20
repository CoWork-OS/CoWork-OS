import { afterEach, describe, expect, it, vi } from "vitest";
import { afterBrowserPaint, captureBrowserTabFreeze } from "../browser-native-freeze";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => vi.unstubAllGlobals());

describe("native browser overlay handoff", () => {
  it("keeps the live page until the replacement image has loaded and painted", async () => {
    const loaded = deferred<boolean>();
    const painted = deferred<void>();
    const hide = vi.fn();
    const displayImage = vi.fn(() => loaded.promise);
    const afterPaint = vi.fn(() => painted.promise);
    const handoff = captureBrowserTabFreeze({
      capture: async () => "data:image/png;base64,snapshot",
      displayImage,
      afterPaint,
      isCurrent: () => true,
      hide,
    });
    await vi.waitFor(() => expect(displayImage).toHaveBeenCalledOnce());
    expect(hide).not.toHaveBeenCalled();
    expect(afterPaint).not.toHaveBeenCalled();

    loaded.resolve(true);
    await vi.waitFor(() => expect(afterPaint).toHaveBeenCalledOnce());
    expect(hide).not.toHaveBeenCalled();

    painted.resolve();
    await handoff;
    expect(hide).toHaveBeenCalledOnce();
  });

  it.each(["capture", "load", "paint"])(
    "does not hide the page if the menu closes during %s",
    async (stage) => {
      const capture = deferred<string>();
      const load = deferred<boolean>();
      const paint = deferred<void>();
      let current = true;
      const hide = vi.fn();
      const displayImage = vi.fn(() => load.promise);
      const afterPaint = vi.fn(() => paint.promise);
      const handoff = captureBrowserTabFreeze({
        capture: () => capture.promise,
        displayImage,
        afterPaint,
        isCurrent: () => current,
        hide,
      });
      if (stage === "capture") current = false;
      capture.resolve("snapshot");
      if (stage !== "capture") {
        await vi.waitFor(() => expect(displayImage).toHaveBeenCalledOnce());
        if (stage === "load") current = false;
        load.resolve(true);
      }
      if (stage === "paint") {
        await vi.waitFor(() => expect(afterPaint).toHaveBeenCalledOnce());
        current = false;
        paint.resolve();
      }
      await handoff;
      expect(hide).not.toHaveBeenCalled();
    },
  );

  it.each([null, "failed capture", "failed decode"])(
    "keeps the live page on an unavailable screenshot (%s)",
    async (failure) => {
      const hide = vi.fn();
      await captureBrowserTabFreeze({
        capture: async () => {
          if (failure === "failed capture") throw new Error("Capture failed");
          return failure;
        },
        displayImage: async () => false,
        isCurrent: () => true,
        hide,
      });
      expect(hide).not.toHaveBeenCalled();
    },
  );

  it("waits for a paint between animation frames", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("window", {
      requestAnimationFrame: (callback: FrameRequestCallback) => frames.push(callback),
    });
    const done = vi.fn();
    const waiting = afterBrowserPaint().then(done);
    frames.shift()!(0);
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    frames.shift()!(16);
    await waiting;
    expect(done).toHaveBeenCalledOnce();
  });
});
