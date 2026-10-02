import { describe, expect, it, vi } from "vitest";
import { BrowserService } from "../browser-service";

const workspace = {
  id: "workspace-1",
  path: "/tmp",
  permissions: { read: true, write: true, delete: false, network: true, shell: false },
} as Any;

const interactive = [
  { role: "button", name: "Download report", selector: "#download" },
  { role: "textbox", name: "Search", selector: 'input[name="q"]', type: "search" },
];

function createService(pageText: { bodyText: string; mainText: string }) {
  const page: Any = {
    url: () => "https://example.com/report",
    title: async () => "Quarterly report",
    evaluate: vi.fn(async () => ({
      ...pageText,
      links: [{ text: "Home", href: "https://example.com/" }],
      forms: [],
    })),
  };
  const service = new BrowserService(workspace, { headless: true });
  (service as Any).page = page;
  (service as Any).context = {};
  vi.spyOn(service as Any, "getInteractiveElements").mockResolvedValue(interactive);
  return service;
}

describe("BrowserService getContent", () => {
  it("returns the whole page text when it fits in one read", async () => {
    const bodyText = "Menu Home Docs Quarterly results The answer is 42. Footer";
    const service = createService({ bodyText, mainText: "Quarterly results The answer is 42." });

    const content = await service.getContent();

    expect(content.text).toBe(bodyText);
    expect(content.textScope).toBe("page");
    expect(content.totalChars).toBe(bodyText.length);
    expect(content.truncated).toBe(false);
    expect(content.nextOffset).toBeUndefined();
    expect(content.interactive).toEqual(interactive);
    expect(content.links).toEqual([{ text: "Home", href: "https://example.com/" }]);
  });

  it("reads the main region first when navigation would crowd it out", async () => {
    const mainText = `The answer is 42. ${"Detailed findings. ".repeat(30)}`.trim();
    const bodyText = `${"Menu category item. ".repeat(900)}${mainText}`;
    const service = createService({ bodyText, mainText });

    const content = await service.getContent();

    expect(content.textScope).toBe("main");
    expect(content.text.startsWith("The answer is 42.")).toBe(true);
    expect(content.pageTextChars).toBe(bodyText.length);
    expect(content.truncated).toBe(false);
  });

  it("paginates long text and reports where to continue", async () => {
    const mainText = "a".repeat(25_000);
    const bodyText = `nav ${mainText} footer`;
    const service = createService({ bodyText, mainText });

    const first = await service.getContent({ maxChars: 10_000 });
    const last = await service.getContent({ offset: 20_000, maxChars: 10_000 });

    expect(first).toMatchObject({
      offset: 0,
      totalChars: 25_000,
      truncated: true,
      nextOffset: 10_000,
    });
    expect(first.text).toHaveLength(10_000);
    expect(last).toMatchObject({ offset: 20_000, totalChars: 25_000, truncated: false });
    expect(last.text).toHaveLength(5_000);
    expect(last.nextOffset).toBeUndefined();
  });

  it("reads the whole page when scope is page", async () => {
    const mainText = "b".repeat(2_000);
    const bodyText = `${"Sidebar fact. ".repeat(1_000)}${mainText}`;
    const service = createService({ bodyText, mainText });

    const content = await service.getContent({ scope: "page" });

    expect(content.textScope).toBe("page");
    expect(content.totalChars).toBe(bodyText.length);
    expect(content.truncated).toBe(true);
    expect(content.nextOffset).toBe(10_000);
  });
});
