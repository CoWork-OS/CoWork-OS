import * as path from "path";
import { describe, expect, it, vi } from "vitest";
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual, mkdirSync: vi.fn(), existsSync: vi.fn(() => false) };
});
import {
  BrowserDownloadManager,
  isDangerousDownload,
  safeDownloadFilename,
  uniqueDownloadPath,
} from "../browser-download-manager";
import { DEFAULT_BROWSER_SETTINGS, type BrowserSettings } from "../../../shared/browser-settings";

const owner = { taskId: "t", sessionId: "default", tabId: "a", kind: "tab" as const };

function fakeItem(url = "https://files.example/report.pdf", filename = "report.pdf") {
  const listeners = new Map<string, Any>();
  return {
    listeners,
    getURL: () => url,
    getFilename: () => filename,
    getTotalBytes: () => 100,
    getReceivedBytes: () => 100,
    getSavePath: vi.fn(() => ""),
    setSavePath: vi.fn(),
    isPaused: () => false,
    pause: vi.fn(),
    resume: vi.fn(),
    cancel: vi.fn(),
    canResume: () => true,
    on: (event: string, listener: Any) => listeners.set(event, listener),
    once: (event: string, listener: Any) => listeners.set(event, listener),
  };
}

function setup(
  options: {
    settings?: Partial<BrowserSettings>;
    driving?: boolean;
    block?: { reason: string; detail?: string } | null;
    approve?: boolean;
  } = {},
) {
  let willDownload: Any;
  const electronSession = { on: (_event: string, handler: Any) => (willDownload = handler) };
  const service = {
    wasRecentlyDriven: vi.fn(() => options.driving === true),
    isPausedByUser: vi.fn(() => false),
    emitDownload: vi.fn(),
  };
  const manager = {
    findTabOwner: vi.fn((id: number) => (id === 7 ? owner : null)),
    explainUrlBlock: vi.fn(() => options.block ?? null),
    recordDownload: vi.fn(),
  };
  const requestApproval = vi.fn(async () => options.approve === true);
  const downloads = new BrowserDownloadManager({
    service: service as Any,
    manager: manager as Any,
    loadSettings: () => ({ ...DEFAULT_BROWSER_SETTINGS, ...options.settings }),
    resolveWorkspace: () => ({ path: "/ws", permissions: { write: true } as Any }),
    assertWorkspaceWrite: (_workspace, relative) => path.join("/ws", relative),
    requestApproval,
    systemDownloadsDir: () => "/Users/me/Downloads",
    openPath: vi.fn(async () => ""),
    showItemInFolder: vi.fn(),
  });
  downloads.attach(electronSession);
  const start = (item = fakeItem(), contentsId = 7) => {
    const event = { preventDefault: vi.fn() };
    willDownload(event, item, { id: contentsId });
    return { event, item };
  };
  return { downloads, service, manager, requestApproval, start };
}

describe("download helpers", () => {
  it("flags executables, installers, scripts and archives", () => {
    for (const name of [
      "setup.exe",
      "App.dmg",
      "run.sh",
      "x.command",
      "a.tar.gz",
      "b.zip",
      "c.jar",
    ]) {
      expect(isDangerousDownload(name)).toBe(true);
    }
    for (const name of ["report.pdf", "photo.png", "data.csv"]) {
      expect(isDangerousDownload(name)).toBe(false);
    }
  });

  it("makes file names safe and unique", () => {
    expect(safeDownloadFilename("../../etc/passwd")).toBe("passwd");
    expect(safeDownloadFilename('a<b>:"c?.txt')).toBe("a_b___c_.txt");
    expect(safeDownloadFilename("")).toBe("download");
    const taken = new Set(["/d/a.pdf", "/d/a (1).pdf"]);
    expect(uniqueDownloadPath("/d", "a.pdf", (candidate) => taken.has(candidate))).toBe(
      "/d/a (2).pdf",
    );
  });
});

describe("BrowserDownloadManager", () => {
  it("cancels downloads from pages that are not workbench tabs", () => {
    const { start, service } = setup();
    const { event } = start(fakeItem(), 99);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(service.emitDownload).not.toHaveBeenCalled();
  });

  it("saves the user's downloads to the system Downloads folder", () => {
    const { start, service, manager } = setup();
    const { item } = start();
    expect(item.setSavePath).toHaveBeenCalledWith("/Users/me/Downloads/report.pdf");
    expect(service.emitDownload).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "progressing",
        agentInitiated: false,
        filename: "report.pdf",
      }),
    );
    item.listeners.get("done")({}, "completed");
    expect(service.emitDownload).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: "completed" }),
    );
    expect(manager.recordDownload).toHaveBeenLastCalledWith(
      "t",
      "default",
      "a",
      expect.objectContaining({ state: "completed", filename: "report.pdf" }),
    );
  });

  it("shows a save dialog when set to ask", () => {
    const { start } = setup({ settings: { downloadLocation: "ask" } });
    const { item } = start();
    expect(item.setSavePath).not.toHaveBeenCalled();
  });

  it("puts CoWork's downloads in the workspace and waits for approval", async () => {
    const { start, requestApproval } = setup({ driving: true, approve: false });
    const { item } = start();
    expect(item.setSavePath).toHaveBeenCalledWith(path.join("/ws", "downloads", "report.pdf"));
    expect(item.pause).toHaveBeenCalled();
    await vi.waitFor(() => expect(item.cancel).toHaveBeenCalled());
    expect(requestApproval).toHaveBeenCalledWith(
      "t",
      expect.stringContaining("report.pdf"),
      expect.objectContaining({ kind: "browser_download" }),
    );
  });

  it("blocks CoWork downloads when the setting says so, and policy-blocked URLs", () => {
    const blocked = setup({ driving: true, settings: { agentDownloads: "block" } });
    const first = blocked.start();
    expect(first.event.preventDefault).toHaveBeenCalled();
    expect(blocked.service.emitDownload).toHaveBeenCalledWith(
      expect.objectContaining({ state: "blocked" }),
    );

    const policy = setup({ block: { reason: "policy", detail: "profile_domain_denied" } });
    const second = policy.start();
    expect(second.event.preventDefault).toHaveBeenCalled();
    expect(second.item.setSavePath).not.toHaveBeenCalled();
  });

  it("asks before opening a dangerous file", async () => {
    const { start, downloads, service } = setup();
    const { item } = start(fakeItem("https://x.example/setup.dmg", "setup.dmg"));
    item.getSavePath.mockReturnValue("/Users/me/Downloads/setup.dmg");
    item.listeners.get("done")({}, "completed");
    const id = service.emitDownload.mock.calls[0][0].id;
    await expect(downloads.act(id, "open")).resolves.toEqual({
      success: false,
      error: "confirm_dangerous",
    });
    await expect(downloads.act(id, "open", true)).resolves.toEqual({ success: true });
  });

  it("saves an image to the workspace when the user asks from the page menu", () => {
    const { downloads, start, service } = setup();
    downloads.requestWorkspaceSave(7, "https://files.example/photo.png");
    const { item } = start(fakeItem("https://files.example/photo.png", "photo.png"));
    expect(item.setSavePath).toHaveBeenCalledWith(path.join("/ws", "downloads", "photo.png"));
    expect(service.emitDownload).toHaveBeenCalledWith(
      expect.objectContaining({ agentInitiated: false, filename: "photo.png" }),
    );
    // Used once: the next download of the same URL follows the normal setting.
    const next = start(fakeItem("https://files.example/photo.png", "photo.png"));
    expect(next.item.setSavePath).toHaveBeenCalledWith("/Users/me/Downloads/photo.png");
  });
});
