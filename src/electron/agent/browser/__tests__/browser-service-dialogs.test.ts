import { beforeEach, describe, expect, it, vi } from "vitest";
import { chromium } from "playwright";
import { BrowserService } from "../browser-service";
import { FakeContext, FakePage, createFakeBrowser } from "./fake-playwright";

vi.mock("playwright", () => ({ chromium: { launch: vi.fn() } }));

const workspace = {
  id: "workspace-1",
  path: "/tmp",
  permissions: { read: true, write: true, delete: false, network: true, shell: false },
} as Any;

function fakeDialog(type: string, message: string, defaultValue = "") {
  return {
    type: () => type,
    message: () => message,
    defaultValue: () => defaultValue,
    accept: vi.fn(async (_promptText?: string) => undefined),
    dismiss: vi.fn(async () => undefined),
  };
}

let context: FakeContext;

beforeEach(() => {
  context = new FakeContext();
  vi.mocked(chromium.launch).mockResolvedValue(createFakeBrowser(context) as Any);
});

async function openService(): Promise<{ service: BrowserService; page: FakePage }> {
  const service = new BrowserService(workspace, { headless: true, popupGraceMs: 0 });
  await service.navigate("https://example.com/items");
  return { service, page: context.pagesList[0] };
}

describe("BrowserService headless dialogs", () => {
  it("dismisses a confirm() instead of accepting it and reports it on the action", async () => {
    const { service, page } = await openService();
    const dialog = fakeDialog("confirm", "Delete all items?");
    page.onClick = () => {
      page.emit("dialog", dialog);
    };

    const result = await service.click("#delete");

    expect(dialog.dismiss).toHaveBeenCalledTimes(1);
    expect(dialog.accept).not.toHaveBeenCalled();
    expect(result.dialog).toMatchObject({
      type: "confirm",
      message: "Delete all items?",
      action: "dismissed",
      tabId: "tab-1",
    });
  });

  it("accepts only the next dialog after the agent decides to, with prompt text", async () => {
    const { service, page } = await openService();
    const dialogs = [
      fakeDialog("prompt", "Type the project name", "draft"),
      fakeDialog("confirm", "Delete again?"),
    ];
    let index = 0;
    page.onClick = () => {
      page.emit("dialog", dialogs[index++]);
    };

    const armed = service.armNextDialog({ accept: true, promptText: "my-project" });
    expect(armed.nextDialog).toEqual({ action: "accept", promptText: "my-project" });

    const accepted = await service.click("#rename");
    expect(dialogs[0].accept).toHaveBeenCalledWith("my-project");
    expect(accepted.dialog).toMatchObject({
      type: "prompt",
      action: "accepted",
      defaultValue: "draft",
    });

    // One-shot: the following dialog is dismissed again.
    const second = await service.click("#delete");
    expect(dialogs[1].dismiss).toHaveBeenCalled();
    expect(dialogs[1].accept).not.toHaveBeenCalled();
    expect(second.dialog?.action).toBe("dismissed");
  });

  it("expires an accept decision when the next action opens no dialog", async () => {
    const { service, page } = await openService();
    service.armNextDialog({ accept: true });

    const unrelated = await service.click("#harmless");
    expect(unrelated.dialogDecisionExpired).toBe(true);

    const dialog = fakeDialog("confirm", "Delete?");
    page.onClick = () => {
      page.emit("dialog", dialog);
    };
    await service.click("#delete");
    expect(dialog.dismiss).toHaveBeenCalled();
    expect(dialog.accept).not.toHaveBeenCalled();
  });

  it("redacts secrets in dialog messages and reports dialogs raised between actions", async () => {
    const { service, page } = await openService();
    page.emit("dialog", fakeDialog("alert", "Session expired: token=abc123"));

    const result = await service.press("Escape");

    expect(result.dialog?.message).toBe("Session expired: token=[REDACTED]");
    expect(service.getLastDialog()?.type).toBe("alert");
  });
});
