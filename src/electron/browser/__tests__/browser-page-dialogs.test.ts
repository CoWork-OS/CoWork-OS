import { describe, expect, it, vi } from "vitest";
import { BrowserSessionManager, type BrowserPageDialogEvent } from "../browser-session-manager";

/** A manager with one registered tab whose CDP commands are recorded. */
async function setup() {
  const manager = new BrowserSessionManager();
  const sendCommand = vi.fn(async () => ({}));
  (manager as Any).getWebContents = async () => ({ id: 31 });
  (manager as Any).sendCommand = sendCommand;
  await manager.registerElectronWorkbenchSession({ taskId: "t", tabId: "a", webContentsId: 31 });
  const events: BrowserPageDialogEvent[] = [];
  manager.setPageDialogListener((event) => events.push(event));
  const cdp = (method: string, params: Any) =>
    (manager as Any).recordDebuggerEvent(31, method, params);
  return { manager, sendCommand, events, cdp };
}

describe("page dialogs while CoWork's debugger is attached", () => {
  it("reports an open confirm to the workbench and answers it", async () => {
    const { manager, sendCommand, events, cdp } = await setup();
    cdp("Page.javascriptDialogOpening", {
      type: "confirm",
      message: "Delete this draft?",
      url: "https://forms.example/page",
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      taskId: "t",
      tabId: "a",
      kind: "tab",
      state: "open",
      type: "confirm",
      message: "Delete this draft?",
      origin: "https://forms.example",
    });
    const dialogId = events[0].dialogId;

    await expect(
      manager.respondToPageDialog({
        taskId: "t",
        tabId: "a",
        dialogId: "dialog-x-1",
        accept: true,
      }),
    ).resolves.toBe(false);
    await expect(
      manager.respondToPageDialog({
        taskId: "t",
        tabId: "a",
        dialogId,
        accept: true,
      }),
    ).resolves.toBe(true);
    expect(sendCommand).toHaveBeenCalledWith({ id: 31 }, "Page.handleJavaScriptDialog", {
      accept: true,
    });

    cdp("Page.javascriptDialogClosed", { result: true });
    expect(events[1]).toMatchObject({ dialogId, state: "closed" });
    // Closed: a late answer does nothing.
    await expect(
      manager.respondToPageDialog({ taskId: "t", tabId: "a", dialogId, accept: false }),
    ).resolves.toBe(false);
  });

  it("leaves beforeunload to the unload guard", async () => {
    const { events, cdp } = await setup();
    cdp("Page.javascriptDialogOpening", { type: "beforeunload", message: "" });
    expect(events).toEqual([]);
  });
});
