import { describe, expect, it, vi } from "vitest";
import { primeMacSafeStorageContext } from "../mac-safe-storage-bootstrap";

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
