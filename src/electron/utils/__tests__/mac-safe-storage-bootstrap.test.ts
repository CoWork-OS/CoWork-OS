import { describe, expect, it, vi } from "vitest";
import {
  keychainMismatchMessage,
  primeMacSafeStorageContext,
  shouldAdoptNewKeychainKey,
} from "../mac-safe-storage-bootstrap";

describe("primeMacSafeStorageContext", () => {
  it("loads and closes a hidden BrowserWindow before macOS safeStorage use", async () => {
    const events: string[] = [];
    const loadURL = vi.fn(async () => {
      events.push("load");
    });
    const destroy = vi.fn(() => {
      events.push("destroy");
    });
    const createBootstrapWindow = vi.fn(() => ({ loadURL, destroy }));

    await expect(primeMacSafeStorageContext("darwin", createBootstrapWindow)).resolves.toBe(true);

    expect(createBootstrapWindow).toHaveBeenCalledOnce();
    expect(loadURL).toHaveBeenCalledWith("data:text/html,<html><body></body></html>");
    expect(events).toEqual(["load", "destroy"]);
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("does not create a window on other platforms", async () => {
    const createBootstrapWindow = vi.fn(() => ({ loadURL: vi.fn(), destroy: vi.fn() }));

    await expect(primeMacSafeStorageContext("linux", createBootstrapWindow)).resolves.toBe(false);
    expect(createBootstrapWindow).not.toHaveBeenCalled();
  });
});

describe("mock-keychain launches", () => {
  it("never adopt the mock key over real settings, even when asked", () => {
    expect(shouldAdoptNewKeychainKey("1", true)).toBe(false);
    expect(shouldAdoptNewKeychainKey("1", false)).toBe(true);
    expect(shouldAdoptNewKeychainKey(undefined, false)).toBe(false);
  });

  it("say why settings are unreadable and how to launch with the real keychain", () => {
    const message = keychainMismatchMessage(true, "COWORK_ACCEPT_NEW_KEYCHAIN_KEY");
    expect(message).toContain("--use-mock-keychain");
    expect(message).toContain("executablePath");
    expect(message).toContain("is ignored");
    expect(keychainMismatchMessage(false, "COWORK_ACCEPT_NEW_KEYCHAIN_KEY")).toContain(
      "COWORK_ACCEPT_NEW_KEYCHAIN_KEY=1",
    );
  });
});
