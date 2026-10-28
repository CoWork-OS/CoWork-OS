import { describe, expect, it, vi } from "vitest";
import { reuseDesktopViewer } from "../desktop-viewer-window";

function viewer(state: { minimized?: boolean; destroyed?: boolean; url?: string } = {}) {
  const calls: string[] = [];
  const window = {
    isDestroyed: vi.fn(() => state.destroyed ?? false),
    isMinimized: vi.fn(() => state.minimized ?? false),
    restore: vi.fn(() => calls.push("restore")),
    show: vi.fn(() => calls.push("show")),
    focus: vi.fn(() => calls.push("focus")),
    loadURL: vi.fn(async () => {
      calls.push("loadURL");
    }),
    webContents: { getURL: vi.fn(() => state.url ?? "http://127.0.0.1:6080/vnc.html") },
  };
  return { window, calls };
}

describe("reuseDesktopViewer", () => {
  it("restores a minimized viewer before showing and focusing it", async () => {
    const { window, calls } = viewer({ minimized: true });

    await expect(reuseDesktopViewer(window, "http://127.0.0.1:6080/vnc.html")).resolves.toBe(true);

    expect(calls).toEqual(["restore", "show", "focus"]);
  });

  it("shows and focuses a visible viewer without restoring it", async () => {
    const { window, calls } = viewer();

    await expect(reuseDesktopViewer(window, "http://127.0.0.1:6080/vnc.html")).resolves.toBe(true);

    expect(calls).toEqual(["show", "focus"]);
  });

  it("reloads a changed viewer URL before bringing the window forward", async () => {
    const { window, calls } = viewer({ minimized: true, url: "http://127.0.0.1:6080/old.html" });

    await reuseDesktopViewer(window, "http://127.0.0.1:6080/vnc.html?view_only=1");

    expect(window.loadURL).toHaveBeenCalledWith("http://127.0.0.1:6080/vnc.html?view_only=1");
    expect(calls).toEqual(["loadURL", "restore", "show", "focus"]);
  });

  it("does not reuse a missing or destroyed viewer", async () => {
    const { window, calls } = viewer({ destroyed: true });

    await expect(reuseDesktopViewer(undefined, "http://127.0.0.1:6080/vnc.html")).resolves.toBe(
      false,
    );
    await expect(reuseDesktopViewer(window, "http://127.0.0.1:6080/vnc.html")).resolves.toBe(false);
    expect(calls).toEqual([]);
  });
});
