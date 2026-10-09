import { afterEach, describe, expect, it, vi } from "vitest";
import { scheduleComposerPrediction } from "../useComposerPredictions";
import type { ComposerPrediction } from "../../../shared/composer-predictions";

describe("prediction request lifecycle", () => {
  afterEach(() => vi.useRealTimers());

  it("does not call the provider if typing starts during debounce", async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockResolvedValue(null);
    const cancel = scheduleComposerPrediction(request, vi.fn());
    cancel();
    await vi.advanceTimersByTimeAsync(1000);
    expect(request).not.toHaveBeenCalled();
  });

  it("discards a late prediction after typing, disabling, or switching chats", async () => {
    vi.useFakeTimers();
    let resolve!: (result: ComposerPrediction) => void;
    const request = vi.fn(
      () =>
        new Promise<ComposerPrediction>((done) => {
          resolve = done;
        }),
    );
    const show = vi.fn();
    const cancel = scheduleComposerPrediction(request, show);
    await vi.advanceTimersByTimeAsync(700);
    cancel();
    resolve({ revision: "old", text: "Wrong chat" });
    await Promise.resolve();
    expect(show).not.toHaveBeenCalled();
  });

  it("cancels an in-flight provider request once when the composer changes", async () => {
    vi.useFakeTimers();
    const abort = vi.fn();
    const cancel = scheduleComposerPrediction(() => new Promise(() => {}), vi.fn(), abort);
    await vi.advanceTimersByTimeAsync(700);
    cancel();
    cancel();
    expect(abort).toHaveBeenCalledOnce();
  });

  it("does not send cancel IPC for debounce-only or settled requests", async () => {
    vi.useFakeTimers();
    const abort = vi.fn();
    scheduleComposerPrediction(async () => null, vi.fn(), abort)();
    const cancel = scheduleComposerPrediction(async () => null, vi.fn(), abort);
    await vi.advanceTimersByTimeAsync(700);
    cancel();
    expect(abort).not.toHaveBeenCalled();
  });

  it("shows the settled suggestion without sending any message", async () => {
    vi.useFakeTimers();
    const result = { revision: "current", text: "Explain the tradeoffs" };
    const show = vi.fn();
    scheduleComposerPrediction(async () => result, show);
    await vi.advanceTimersByTimeAsync(700);
    expect(show).toHaveBeenCalledExactlyOnceWith(result);
  });

  it("keeps the composer usable on provider failure", async () => {
    vi.useFakeTimers();
    const show = vi.fn();
    scheduleComposerPrediction(async () => {
      throw new Error("offline");
    }, show);
    await vi.advanceTimersByTimeAsync(700);
    expect(show).not.toHaveBeenCalled();
  });
});
