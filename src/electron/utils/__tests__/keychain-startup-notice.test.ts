import { afterEach, describe, expect, it, vi } from "vitest";
import { withKeychainStartupNotice } from "../keychain-startup-notice";

describe("withKeychainStartupNotice", () => {
  afterEach(() => vi.useRealTimers());

  it("shows a notice while Keychain is pending and closes it once access resolves", async () => {
    vi.useFakeTimers();
    let resolve!: (value: string) => void;
    const operation = vi.fn(() => new Promise<string>((done) => (resolve = done)));
    const close = vi.fn();
    const show = vi.fn(() => close);
    const result = withKeychainStartupNotice(operation, { enabled: true, show });

    await vi.advanceTimersByTimeAsync(1999);
    expect(show).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(show).toHaveBeenCalledOnce();
    expect(operation).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    resolve("opened");
    await expect(result).resolves.toBe("opened");
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not flash a notice for quick or headless operations", async () => {
    vi.useFakeTimers();
    const show = vi.fn(() => vi.fn());
    await expect(withKeychainStartupNotice(async () => 1, { enabled: true, show })).resolves.toBe(
      1,
    );
    await vi.advanceTimersByTimeAsync(3000);
    await expect(withKeychainStartupNotice(async () => 2, { enabled: false, show })).resolves.toBe(
      2,
    );
    expect(show).not.toHaveBeenCalled();
  });

  it("closes the notice and preserves a Keychain failure", async () => {
    vi.useFakeTimers();
    let reject!: (error: Error) => void;
    const close = vi.fn();
    const result = withKeychainStartupNotice(
      () => new Promise<void>((_resolve, fail) => (reject = fail)),
      { enabled: true, show: () => close },
    );
    const expectation = expect(result).rejects.toThrow("Keychain failed");
    await vi.advanceTimersByTimeAsync(2000);
    reject(new Error("Keychain failed"));
    await expectation;
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not change the operation when the notice itself cannot open", async () => {
    vi.useFakeTimers();
    let resolve!: () => void;
    const onError = vi.fn();
    const result = withKeychainStartupNotice(() => new Promise<void>((done) => (resolve = done)), {
      enabled: true,
      show: () => {
        throw new Error("window failed");
      },
      onError,
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(onError).toHaveBeenCalledOnce();
    resolve();
    await expect(result).resolves.toBeUndefined();
  });
});
