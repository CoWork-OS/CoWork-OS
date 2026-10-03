import { describe, expect, it } from "vitest";
import {
  BrowserSessionManager,
  normalizeBrowserUrl,
  redactBrowserStoragePayload,
  redactBrowserText,
} from "../browser-session-manager";
import { el, FakePage } from "./fake-page";

describe("BrowserSessionManager helpers", () => {
  it("normalizes bare localhost and domain URLs", () => {
    expect(normalizeBrowserUrl("localhost:5173/app")).toBe("http://localhost:5173/app");
    expect(normalizeBrowserUrl("example.com")).toBe("https://example.com");
    expect(normalizeBrowserUrl("https://example.com/a")).toBe("https://example.com/a");
  });

  it("redacts common secret values and query params", () => {
    const redacted = redactBrowserText(
      "Authorization=Bearer abc123 https://example.com?access_token=secret&ok=1 password=hunter2",
    );
    expect(redacted).toContain("Authorization=[REDACTED]");
    expect(redacted).toContain("[REDACTED_PARAM]");
    expect(redacted).toContain("password=[REDACTED]");
    expect(redacted).not.toContain("abc123");
    expect(redacted).not.toContain("hunter2");
  });

  it("redacts secret-like JSON storage keys and JSON string values", () => {
    const redacted = redactBrowserStoragePayload({
      localStorage: {
        token: "abc123",
        profile: JSON.stringify({
          password: "hunter2",
          nested: { apiKey: "key-123" },
        }),
        public: "ok",
      },
      sessionStorage: {
        authToken: "def456",
      },
    });
    const serialized = JSON.stringify(redacted);

    expect(serialized).toContain("[REDACTED]");
    expect(serialized).toContain("ok");
    expect(serialized).not.toContain("abc123");
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("key-123");
    expect(serialized).not.toContain("def456");
  });

  it("enforces disabled profile networking at the visible request boundary", () => {
    const manager = new BrowserSessionManager();
    const isAllowed = (manager as Any).isUrlAllowedWithPolicy.bind(manager);

    expect(
      isAllowed({ networkEnabled: true, accessNetworkMode: "disabled" }, "https://example.com"),
    ).toBe(false);
  });

  it("allows a registered loopback preview without widening remote networking", () => {
    const manager = new BrowserSessionManager();
    const isAllowed = (manager as Any).isUrlAllowedWithPolicy.bind(manager);
    const previewUrl = "http://127.0.0.1:4173";

    expect(isAllowed({ networkEnabled: true, accessNetworkMode: "disabled" }, previewUrl)).toBe(
      false,
    );
    manager.allowLocalPreviewUrl(previewUrl);
    expect(isAllowed({ networkEnabled: true, accessNetworkMode: "disabled" }, previewUrl)).toBe(
      true,
    );
    expect(
      isAllowed({ networkEnabled: true, accessNetworkMode: "disabled" }, "http://127.0.0.1:4174"),
    ).toBe(false);
  });
});

function refSetup(...body: Parameters<FakePage["mount"]>) {
  const page = new FakePage();
  page.mount(...body);
  const contents = page.contents();
  const manager = new BrowserSessionManager();
  manager.registerElectronWorkbenchSession({ taskId: "t", sessionId: "default", webContentsId: 7 });
  (manager as Any).getWebContents = async () => contents;
  return { page, manager };
}

async function refFor(manager: BrowserSessionManager, name: string): Promise<string> {
  const snapshot = await manager.snapshot({ taskId: "t" });
  const node = snapshot?.nodes.find((candidate) => candidate.name === name);
  if (!node) throw new Error(`no snapshot node named ${name}`);
  return node.ref;
}

const mousePresses = (page: FakePage) =>
  page.log.filter((entry) => entry.startsWith("mousePressed"));

describe("BrowserSessionManager ref actions", () => {
  it("rejects a ref whose element was removed after the snapshot instead of clicking old bounds", async () => {
    const { page, manager } = refSetup(
      el(
        "button",
        { attrs: { id: "save" }, rect: { x: 10, y: 100, width: 80, height: 30 } },
        "Save",
      ),
    );
    const ref = await refFor(manager, "Save");
    page.byId("save").remove();
    page.mount(
      el(
        "button",
        { attrs: { id: "delete" }, rect: { x: 10, y: 100, width: 80, height: 30 } },
        "Delete",
      ),
    );

    await expect(manager.clickRef({ taskId: "t", ref })).rejects.toThrow(/Stale browser ref/);
    expect(mousePresses(page)).toEqual([]);
  });

  it("drops refs when the page navigates after the snapshot", async () => {
    const { page, manager } = refSetup(
      el(
        "button",
        { attrs: { id: "save" }, rect: { x: 10, y: 100, width: 80, height: 30 } },
        "Save",
      ),
    );
    const ref = await refFor(manager, "Save");
    page.navigate(
      "https://example.test/other",
      el(
        "button",
        { attrs: { id: "pay" }, rect: { x: 10, y: 100, width: 80, height: 30 } },
        "Pay now",
      ),
    );

    await expect(manager.clickRef({ taskId: "t", ref })).rejects.toThrow(/page navigated/);
    expect(mousePresses(page)).toEqual([]);
  });

  it("scrolls a below-the-fold ref into view and clicks inside the viewport", async () => {
    let clicked = 0;
    const { page, manager } = refSetup(
      el(
        "button",
        {
          attrs: { id: "buy" },
          rect: { x: 10, y: 1500, width: 80, height: 30 },
          onclick: () => (clicked += 1),
        },
        "Add to cart",
      ),
    );
    const snapshot = await manager.snapshot({ taskId: "t" });
    const node = snapshot!.nodes.find((candidate) => candidate.name === "Add to cart")!;
    expect(node.offscreen).toBe(true);

    const result = await manager.clickRef({ taskId: "t", ref: node.ref });

    expect(result).toMatchObject({ success: true, hitVerified: true, confirmed: "click" });
    expect(clicked).toBe(1);
    expect(page.cdpCalls.some((call) => call.method === "DOM.scrollIntoViewIfNeeded")).toBe(true);
    const [, y] = /@(\d+),(\d+)/.exec(mousePresses(page)[0])!.slice(1).map(Number);
    expect(y).toBeLessThan(page.viewport.height);
  });

  it("does not clamp a ref above the viewport onto a sticky header", async () => {
    let headerClicks = 0;
    let saveClicks = 0;
    const { page, manager } = refSetup(
      el(
        "header",
        {
          attrs: { id: "bar" },
          rect: { x: 0, y: 0, width: 800, height: 40 },
          fixed: true,
          z: 5,
          onclick: () => (headerClicks += 1),
        },
        el(
          "a",
          {
            attrs: { href: "#menu" },
            rect: { x: 0, y: 0, width: 80, height: 40 },
            fixed: true,
            z: 5,
          },
          "Menu",
        ),
      ),
      el(
        "button",
        {
          attrs: { id: "save" },
          rect: { x: 10, y: 300, width: 80, height: 30 },
          onclick: () => (saveClicks += 1),
        },
        "Save",
      ),
    );
    page.scrollY = 1200;
    const snapshot = await manager.snapshot({ taskId: "t" });
    const save = snapshot!.nodes.find((candidate) => candidate.name === "Save")!;
    expect(save.bounds?.y).toBeLessThan(0);

    const result = await manager.clickRef({ taskId: "t", ref: save.ref });

    expect(result?.success).toBe(true);
    expect(saveClicks).toBe(1);
    expect(headerClicks).toBe(0);
  });

  it("fails when another element covers the ref target at the click point", async () => {
    let clicked = 0;
    const { page, manager } = refSetup(
      el(
        "button",
        {
          attrs: { id: "save" },
          rect: { x: 10, y: 100, width: 80, height: 30 },
          onclick: () => (clicked += 1),
        },
        "Save",
      ),
    );
    const ref = await refFor(manager, "Save");
    page.mount(
      el(
        "div",
        {
          attrs: { id: "modal" },
          rect: { x: 0, y: 0, width: 800, height: 600 },
          fixed: true,
          z: 10,
        },
        "Session expired",
      ),
    );

    const result = await manager.clickRef({ taskId: "t", ref });

    expect(result?.success).toBe(false);
    expect(result?.error).toContain("covered by div#modal");
    expect(clicked).toBe(0);
    expect(mousePresses(page)).toEqual([]);
  });

  it("reports an element positioned outside the viewport instead of clicking off-screen", async () => {
    const { page, manager } = refSetup(
      el(
        "button",
        {
          attrs: { id: "off" },
          rect: { x: -500, y: 10, width: 80, height: 30 },
          fixed: true,
        },
        "Hidden menu",
      ),
    );
    const ref = await refFor(manager, "Hidden menu");

    const result = await manager.clickRef({ taskId: "t", ref });

    expect(result?.success).toBe(false);
    expect(result?.error).toContain("outside the visible viewport");
    expect(mousePresses(page)).toEqual([]);
  });

  it("fills a ref and fails when the value does not take", async () => {
    const { page, manager } = refSetup(
      el("input", {
        attrs: { id: "zip", "aria-label": "Zip", maxlength: "5" },
        rect: { x: 10, y: 10, width: 120, height: 30 },
      }),
    );
    const ref = await refFor(manager, "Zip");

    expect(await manager.fillRef({ taskId: "t", ref, value: "12345" })).toMatchObject({
      success: true,
      value: "12345",
    });
    const overflow = await manager.fillRef({ taskId: "t", ref, value: "1234567" });
    expect(overflow?.success).toBe(false);
    expect((page.byId("zip") as unknown as { value: string }).value).toBe("12345");
  });
});

describe("BrowserSessionManager snapshot limits", () => {
  function bigPage() {
    const links = Array.from({ length: 200 }, (_, index) =>
      el(
        "a",
        { attrs: { href: `#l${index}` }, rect: { x: 0, y: index * 10, width: 100, height: 10 } },
        `Nav link ${index}`,
      ),
    );
    return refSetup(
      el("nav", {}, ...links),
      el("p", {}, "Some paragraph text here"),
      el("button", { rect: { x: 0, y: 2100, width: 100, height: 30 } }, "Add to cart"),
    );
  }

  it("flags truncation, keeps controls ahead of navigation links, and pages with offset", async () => {
    const { manager } = bigPage();

    const first = await manager.snapshot({ taskId: "t" });

    expect(first?.nodes).toHaveLength(140);
    expect(first).toMatchObject({
      truncated: true,
      totalNodes: 202,
      returnedNodes: 140,
      nextOffset: 140,
    });
    expect(first?.hint).toContain("offset=140");
    expect(first?.nodes.some((node) => node.name === "Add to cart")).toBe(true);
    // StaticText children repeating a link's name are dropped, not counted.
    expect(
      first?.nodes.filter((node) => node.role === "StaticText").map((node) => node.name),
    ).toEqual([]);
    expect(first?.omittedDuplicateText).toBe(201);

    const second = await manager.snapshot({ taskId: "t", offset: first!.nextOffset });
    expect(second?.nodes).toHaveLength(62);
    expect(second?.nextOffset).toBeUndefined();
    expect(second?.nodes.some((node) => node.name === "Some paragraph text here")).toBe(true);

    // Paging continues the snapshot: refs from the first page still resolve.
    const cart = first!.nodes.find((node) => node.name === "Add to cart")!;
    await expect(manager.clickRef({ taskId: "t", ref: cart.ref })).resolves.toMatchObject({
      success: true,
    });
  });

  it("filters by query and interactive_only", async () => {
    const { manager } = bigPage();

    const cart = await manager.snapshot({ taskId: "t", query: "cart" });
    expect(cart?.nodes.map((node) => node.name)).toEqual(["Add to cart"]);
    expect(cart?.truncated).toBe(false);

    const interactive = await manager.snapshot({ taskId: "t", interactiveOnly: true, limit: 400 });
    expect(interactive?.totalNodes).toBe(201);
    expect(interactive?.nodes.some((node) => node.role === "StaticText")).toBe(false);
  });
});
