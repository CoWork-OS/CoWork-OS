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

let context: FakeContext;

beforeEach(() => {
  context = new FakeContext();
  vi.mocked(chromium.launch).mockResolvedValue(createFakeBrowser(context) as Any);
});

async function openService(): Promise<{ service: BrowserService; page: FakePage }> {
  const service = new BrowserService(workspace, { headless: true, popupGraceMs: 0 });
  await service.navigate("https://example.com/app");
  return { service, page: context.pagesList[0] };
}

function consoleMessage(type: string, text: string) {
  return { type: () => type, text: () => text };
}

function request(url: string, method = "GET", resourceType = "fetch", errorText?: string) {
  return {
    url: () => url,
    method: () => method,
    resourceType: () => resourceType,
    failure: () => (errorText ? { errorText } : null),
  };
}

describe("BrowserService headless console and network capture", () => {
  it("captures console messages and page errors with secrets redacted", async () => {
    const { service, page } = await openService();
    page.emit("console", consoleMessage("log", "ready"));
    page.emit("console", consoleMessage("error", "auth failed: Authorization: Bearer abc.def"));
    page.emit("pageerror", new Error("Login failed, password=hunter2 rejected"));

    const log = service.getConsoleLog();

    expect(log.dropped).toBe(0);
    expect(log.entries.map((entry) => [entry.level, entry.text])).toEqual([
      ["log", "ready"],
      ["error", "auth failed: Authorization=[REDACTED]"],
      ["error", "Login failed, password=[REDACTED] rejected"],
    ]);
    expect(log.entries[2].source).toBe("pageerror");
    expect(log.entries[0]).toMatchObject({ tabId: "tab-1", url: "https://example.com/app" });
  });

  it("captures finished and failed requests with secret query parameters redacted", async () => {
    const { service, page } = await openService();
    const ok = request("https://api.example.com/items?access_token=abc", "POST");
    page.emit("response", { url: () => ok.url(), status: () => 500, request: () => ok });
    page.emit(
      "requestfailed",
      request("https://blocked.example/x.js", "GET", "script", "net::ERR_BLOCKED_BY_CLIENT"),
    );

    const log = service.getNetworkLog();

    expect(log.entries[0]).toMatchObject({
      method: "POST",
      status: 500,
      resourceType: "fetch",
      tabId: "tab-1",
    });
    expect(log.entries[0].url).not.toContain("abc");
    expect(log.entries[1]).toMatchObject({
      failed: true,
      errorText: "net::ERR_BLOCKED_BY_CLIENT",
      resourceType: "script",
    });
  });

  it("keeps a bounded ring buffer and counts what it dropped", async () => {
    const { service, page } = await openService();
    for (let index = 0; index < 130; index += 1) {
      page.emit("console", consoleMessage("log", `message ${index}`));
    }

    const log = service.getConsoleLog();

    expect(log.entries).toHaveLength(120);
    expect(log.dropped).toBe(10);
    expect(log.entries[0].text).toBe("message 10");
    expect(service.getDiagnosticsSummary().console).toMatchObject({ count: 130 });
  });
});
