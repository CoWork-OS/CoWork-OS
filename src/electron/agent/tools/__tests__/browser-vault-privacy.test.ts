import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserTools } from "../browser-tools";
import { BuiltinToolsSettingsManager } from "../builtin-settings";
import * as credentials from "../../../browser/credentials/browser-credential-service";
import {
  beginPrivateSurface,
  privateCaptureGuard,
} from "../../../browser/credentials/private-capture-guard";
import { BrowserWorkbenchService } from "../../../browser/browser-workbench-service";

afterEach(() => vi.restoreAllMocks());

function tools(workbench: Any = {}) {
  vi.spyOn(BuiltinToolsSettingsManager, "getComputerUseAutomationSettings").mockReturnValue({
    browserAutomationMode: "visible",
  } as Any);
  const daemon = {
    logEvent: vi.fn(),
    registerArtifact: vi.fn(),
    requestApproval: vi.fn(async () => true),
  };
  return {
    daemon,
    browser: new BrowserTools(
      {
        id: "w",
        path: os.tmpdir(),
        permissions: { read: true, write: true, network: true },
      } as Any,
      daemon as Any,
      "t",
      {
        getSession: () => ({ taskId: "t", sessionId: "default" }),
        getTabs: () => [],
        isPausedByUser: () => false,
        ...workbench,
      } as Any,
    ),
  };
}

describe("private browser release boundaries", () => {
  it("does not evaluate a page script after private input begins during target resolution", async () => {
    const executeJavaScript = vi.fn();
    const service = new BrowserWorkbenchService();
    (service as Any).getWebContents = async () => {
      const close = beginPrivateSurface();
      close();
      return { executeJavaScript };
    };
    await expect(
      service.evaluate("t", "document.body.textContent", undefined, privateCaptureGuard()),
    ).rejects.toThrow(/Private browser input/);
    expect(executeJavaScript).not.toHaveBeenCalled();
  });
  it("invalidates a capture even when a private prompt has already closed", () => {
    const check = privateCaptureGuard();
    const close = beginPrivateSurface();
    close();
    expect(check).toThrow(/Private browser input/);
    expect(privateCaptureGuard()).not.toThrow();
  });
  it("rechecks browser privacy after selector waits before capturing", async () => {
    const screenshot = vi.fn();
    const { browser } = tools({
      screenshot,
      getContent: async () => ({ url: "https://shop.example" }),
      waitForSelector: async () => {
        const close = beginPrivateSurface();
        close();
        return { success: true };
      },
    });
    await expect(
      browser.executeTool("browser_screenshot", { require_selector: "#ready" }),
    ).rejects.toThrow(/Private browser input/);
    expect(screenshot).not.toHaveBeenCalled();
  });
  it("discards a browser capture interrupted by private input before writing a file", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-capture-race-"));
    try {
      const image = {
        toPNG: vi.fn(() => Buffer.from("private pixels")),
        getSize: () => ({ width: 1, height: 1 }),
      };
      const service = new BrowserWorkbenchService();
      (service as Any).getWebContents = async () => ({
        capturePage: async () => {
          const close = beginPrivateSurface();
          close();
          return image;
        },
      });
      await expect(
        service.screenshot({
          taskId: "t",
          workspacePath: directory,
          filename: "blocked.png",
          assertCaptureAllowed: privateCaptureGuard(),
        }),
      ).rejects.toThrow(/Private browser input/);
      expect(image.toPNG).not.toHaveBeenCalled();
      expect(await fs.readdir(directory)).toEqual([]);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
  it("requires a fresh payment decision and forwards cancellation to the approval service", async () => {
    const abort = new AbortController();
    vi.spyOn(credentials, "getBrowserCredentialService").mockReturnValue({
      hasPrompt: () => false,
      hasPrivateSurface: () => false,
      execute: async (_task: unknown, _input: unknown, approve: Any) => ({
        success: await approve(
          { id: "card", label: "Card ending 1111", kind: "payment" },
          "https://shop.example",
        ),
      }),
    } as Any);
    const { browser, daemon } = tools();
    expect(
      await browser.executeTool(
        "browser_vault",
        { action: "fill", handle: "card" },
        { signal: abort.signal },
      ),
    ).toMatchObject({ success: true });
    expect(daemon.requestApproval).toHaveBeenCalledWith(
      "t",
      "browser",
      expect.any(String),
      expect.objectContaining({
        kind: "browser_payment_fill",
        handle: "card",
        origin: "https://shop.example",
      }),
      { allowAutoApprove: false, noStandingApproval: true, signal: abort.signal },
    );
  });
});
