import { beforeEach, describe, expect, it, vi } from "vitest";
import { chromium } from "playwright";
import { BrowserService } from "../browser-service";
import { FakeContext, FakePage, createFakeBrowser, routeRequest } from "./fake-playwright";

vi.mock("playwright", () => ({ chromium: { launch: vi.fn() } }));

const workspace = {
  id: "workspace-1",
  path: "/tmp",
  permissions: {
    read: true,
    write: true,
    delete: false,
    network: true,
    shell: false,
    accessDomainRules: [{ pattern: "blocked.example", access: "deny" }],
  },
} as Any;

let context: FakeContext;

beforeEach(() => {
  context = new FakeContext();
  vi.mocked(chromium.launch).mockResolvedValue(createFakeBrowser(context) as Any);
});

async function openService(): Promise<{ service: BrowserService; main: FakePage }> {
  const service = new BrowserService(workspace, { headless: true });
  await service.navigate("https://example.com/");
  return { service, main: context.pagesList[0] };
}

describe("BrowserService headless tabs", () => {
  it("applies the network policy to every page through a context route", async () => {
    await openService();

    expect(context.routes).toHaveLength(1);
    // A popup's very first request must be covered before any page-level route exists.
    expect(await routeRequest(context.routes[0], "https://blocked.example/login")).toBe("aborted");
    expect(await routeRequest(context.routes[0], "https://example.com/app.js")).toBe("continued");
  });

  it("registers a popup opened by a click, switches to it and reports it", async () => {
    const { service, main } = await openService();
    main.onClick = () => {
      context.openPage("https://accounts.example.com/oauth", main, "Sign in");
    };

    const result = await service.click("#sign-in");

    expect(result.success).toBe(true);
    expect(result.switchedToTab).toMatchObject({
      tabId: "tab-2",
      url: "https://accounts.example.com/oauth",
      title: "Sign in",
      openerTabId: "tab-1",
    });
    expect(service.getUrl()).toBe("https://accounts.example.com/oauth");
    const popup = context.pagesList[1];
    expect(popup.routes).toHaveLength(1);
    expect(await routeRequest(popup.routes[0], "https://blocked.example/")).toBe("aborted");

    const tabs = await service.listTabs();
    expect(tabs.map((tab) => [tab.tabId, tab.active])).toEqual([
      ["tab-1", false],
      ["tab-2", true],
    ]);
  });

  it("does not switch to a popup whose URL the network policy denies", async () => {
    const { service, main } = await openService();
    main.onClick = () => {
      context.openPage("https://blocked.example/", main);
    };

    const result = await service.click("#bad-link");

    expect(result.switchedToTab).toBeUndefined();
    expect(result.newTabs?.[0]).toMatchObject({ tabId: "tab-2", active: false });
    expect(result.newTabs?.[0].error).toContain("Network access denied");
    expect(service.getUrl()).toBe("https://example.com/");
  });

  it("switches and closes tabs, falling back to the opener when the active tab closes", async () => {
    const { service, main } = await openService();
    const popup = context.openPage("https://example.com/report", main, "Report");

    const switched = await service.switchTab("tab-2");
    expect(switched).toMatchObject({ success: true, tab: { tabId: "tab-2", active: true } });
    expect(service.getUrl()).toBe("https://example.com/report");

    // An OAuth popup closing itself returns control to the page that opened it.
    await popup.close();
    expect(service.getUrl()).toBe("https://example.com/");
    expect((await service.listTabs()).map((tab) => tab.tabId)).toEqual(["tab-1"]);

    const missing = await service.switchTab("tab-9");
    expect(missing.success).toBe(false);
  });

  it("closes a tab by id and opens a fresh page when the last tab is gone", async () => {
    const { service } = await openService();

    const closed = await service.closeTab("tab-1");
    expect(closed).toMatchObject({ success: true, closedTabId: "tab-1" });

    await service.navigate("https://example.com/next");
    expect(chromium.launch).toHaveBeenCalledTimes(1);
    expect(service.getUrl()).toBe("https://example.com/next");
    expect((await service.listTabs()).map((tab) => tab.tabId)).toEqual(["tab-2"]);
  });
});
