import { describe, expect, it } from "vitest";
import { buildSelectorResolverExpression } from "../browser-page-scripts";
import { BrowserSessionManager } from "../browser-session-manager";
import { BrowserWorkbenchService } from "../browser-workbench-service";
import { el, FakeElement, FakeInputElement, FakePage, makeReactControlled } from "./fake-page";

function setup(...body: Parameters<FakePage["mount"]>) {
  const page = new FakePage();
  page.mount(...body);
  const contents = page.contents();
  const manager = new BrowserSessionManager();
  (manager as Any).getWebContents = async () => contents;
  const service = new BrowserWorkbenchService(manager);
  (service as Any).getWebContents = async () => contents;
  (service as Any).sleep = async () => undefined;
  service.registerSession({ taskId: "t", sessionId: "default", webContentsId: 7 });
  return { page, service };
}

function resolve(page: FakePage, selector: string): FakeElement | string {
  return page.evaluate(buildSelectorResolverExpression(selector)) as FakeElement | string;
}

const row = (y: number) => ({ x: 10, y, width: 120, height: 30 });

describe("visible workbench selector resolution", () => {
  it("resolves text= to the deepest matching element, promoted to its button, never <html>", () => {
    const page = new FakePage();
    page.mount(
      el("header", { rect: row(0) }, "Welcome"),
      el("div", { rect: row(40) }, el("span", { rect: row(40) }, "Please Login below")),
      el(
        "button",
        { attrs: { id: "login" }, rect: row(80) },
        el("span", { rect: row(80) }, "Login"),
      ),
    );

    expect((resolve(page, "text=Login") as FakeElement).id).toBe("login");
    expect((resolve(page, "text=Welcome") as FakeElement).tagName).toBe("HEADER");
    expect(resolve(page, "text=Nothing here")).toMatch(/^missing:/);
  });

  it("supports :has-text(), quoted exact text, role= and >> chaining", () => {
    const page = new FakePage();
    page.mount(
      el("button", { attrs: { id: "long" }, rect: row(0) }, "Log in to account"),
      el("button", { attrs: { id: "short" }, rect: row(40) }, "Log in"),
      el("button", { attrs: { id: "icon", "aria-label": "Sign in" }, rect: row(80) }, "→"),
      el(
        "div",
        { attrs: { class: "card" }, rect: row(120) },
        el("h3", { rect: row(120) }, "Basic"),
        el("button", { attrs: { id: "basic-buy" }, rect: row(150) }, "Buy"),
      ),
      el(
        "div",
        { attrs: { class: "card" }, rect: row(200) },
        el("h3", { rect: row(200) }, "Pro"),
        el("button", { attrs: { id: "pro-buy" }, rect: row(230) }, "Buy"),
      ),
    );

    expect((resolve(page, 'button:has-text("account")') as FakeElement).id).toBe("long");
    expect((resolve(page, 'text="Log in"') as FakeElement).id).toBe("short");
    expect((resolve(page, "text=log in") as FakeElement).id).toBe("short");
    expect((resolve(page, 'button:text-is("Log in")') as FakeElement).id).toBe("short");
    expect((resolve(page, 'role=button[name="Sign in"]') as FakeElement).id).toBe("icon");
    expect((resolve(page, 'div.card:has-text("Pro") >> text=Buy') as FakeElement).id).toBe(
      "pro-buy",
    );
    expect((resolve(page, 'div.card:has-text("Pro") button') as FakeElement).id).toBe("pro-buy");
    expect(resolve(page, "button[[")).toMatch(/^invalid:/);
  });

  it("prefers a visible match over a hidden one", () => {
    const page = new FakePage();
    page.mount(
      el("button", { attrs: { id: "hidden" }, rect: row(0), style: { display: "none" } }, "Save"),
      el("button", { attrs: { id: "shown" }, rect: row(40) }, "Save"),
    );
    expect((resolve(page, "text=Save") as FakeElement).id).toBe("shown");
    expect((resolve(page, "button") as FakeElement).id).toBe("shown");
  });
});

describe("visible workbench selector actions", () => {
  it("clicks the Login button for text=Login instead of reporting success on <html>", async () => {
    let clicked = 0;
    const { page, service } = setup(
      el("header", { rect: row(0) }, "Welcome"),
      el("div", { rect: row(40) }, el("span", { rect: row(40) }, "Please Login below")),
      el(
        "button",
        { attrs: { id: "login" }, rect: row(80), onclick: () => (clicked += 1) },
        "Login",
      ),
    );

    const result = await service.click("t", "text=Login");

    expect(result).toMatchObject({ success: true, hitVerified: true, confirmed: "click" });
    expect(clicked).toBe(1);
    expect(page.log).toContain("mousePressed@70,95:login");
  });

  it("clicks Playwright-style selectors instead of throwing SyntaxError", async () => {
    const clicks: string[] = [];
    const { service } = setup(
      el(
        "button",
        { attrs: { id: "cancel" }, rect: row(0), onclick: () => clicks.push("cancel") },
        "Cancel",
      ),
      el(
        "button",
        { attrs: { id: "go" }, rect: row(40), onclick: () => clicks.push("go") },
        "Login now",
      ),
      el(
        "button",
        {
          attrs: { id: "icon", "aria-label": "Sign in" },
          rect: row(80),
          onclick: () => clicks.push("icon"),
        },
        "→",
      ),
    );

    expect(await service.click("t", 'button:has-text("Login")')).toMatchObject({ success: true });
    expect(await service.click("t", 'role=button[name="Sign in"]')).toMatchObject({
      success: true,
    });
    expect(clicks).toEqual(["go", "icon"]);
  });

  it("reports a missing or invalid selector as a failure", async () => {
    const { service } = setup(el("button", { rect: row(0) }, "Save"));
    expect(await service.click("t", "text=Delete")).toMatchObject({
      success: false,
      error: expect.stringContaining("No element matches"),
    });
    expect(await service.click("t", "button[[")).toMatchObject({
      success: false,
      error: expect.stringContaining("Invalid selector"),
    });
  });

  it("fails instead of clicking when an overlay covers the target", async () => {
    let clicked = 0;
    const { service } = setup(
      el("button", { attrs: { id: "buy" }, rect: row(100), onclick: () => (clicked += 1) }, "Buy"),
      el(
        "div",
        {
          attrs: { id: "overlay" },
          rect: { x: 0, y: 0, width: 800, height: 600 },
          fixed: true,
          z: 10,
        },
        "Cookie banner",
      ),
    );

    const result = await service.click("t", "#buy");

    expect(result?.success).toBe(false);
    expect(result?.error).toContain("covered by div#overlay");
    expect(clicked).toBe(0);
  });

  it("scrolls a below-the-fold element into view and clicks it", async () => {
    let clicked = 0;
    const { page, service } = setup(
      el("button", { attrs: { id: "far" }, rect: row(2000), onclick: () => (clicked += 1) }, "Far"),
    );

    const result = await service.click("t", "#far");

    expect(result).toMatchObject({ success: true, confirmed: "click" });
    expect(clicked).toBe(1);
    expect(page.scrollY).toBeGreaterThan(0);
  });

  it("fills a React-controlled input so the component state updates", async () => {
    const { page, service } = setup(el("input", { attrs: { id: "name" }, rect: row(0) }));
    const react = makeReactControlled(page.byId("name") as FakeInputElement);

    expect(await service.fill("t", "#name", "Alice")).toMatchObject({
      success: true,
      value: "Alice",
    });
    expect(react.state()).toBe("Alice");

    expect(await service.fill("t", "#name", "Bob")).toMatchObject({ success: true, value: "Bob" });
    expect(react.state()).toBe("Bob");

    expect(await service.fill("t", "#name", "")).toMatchObject({ success: true, value: "" });
    expect(react.state()).toBe("");
  });

  it("fills a contenteditable editor and reports the real text", async () => {
    const { page, service } = setup(
      el("div", { attrs: { id: "editor", contenteditable: "true" }, rect: row(0) }, "old text"),
    );

    const result = await service.fill("t", "#editor", "Hello body");

    expect(result).toMatchObject({ success: true, value: "Hello body" });
    expect(page.byId("editor").textContent).toBe("Hello body");
  });

  it("reports failure when the field does not keep the value", async () => {
    const { service } = setup(
      el("input", { attrs: { id: "short", maxlength: "3" }, rect: row(0) }),
      el("input", { attrs: { id: "pin", type: "password", maxlength: "2" }, rect: row(40) }),
      el("div", { attrs: { id: "plain" }, rect: row(80) }, "plain"),
    );

    const truncated = await service.fill("t", "#short", "abcdef");
    expect(truncated?.success).toBe(false);
    expect(truncated?.error).toContain('contains "abc"');

    const secret = await service.fill("t", "#pin", "hunter2");
    expect(secret?.success).toBe(false);
    expect(secret?.error).toContain("2 characters");
    expect(secret?.error).not.toContain("hu");

    const notField = await service.fill("t", "#plain", "x");
    expect(notField?.success).toBe(false);
    expect(notField?.error).toContain("not a text field");
  });

  it("types with per-key events so keydown handlers see each character", async () => {
    const { page, service } = setup(el("input", { attrs: { id: "q" }, rect: row(0) }));
    const keys: string[] = [];
    page.byId("q").addEventListener("keydown", (event) => keys.push(String(event.key)));

    const result = await service.type("t", "#q", "ab");

    expect(result).toMatchObject({ success: true, verified: true });
    expect(keys).toEqual(["a", "b"]);
    expect((page.byId("q") as FakeInputElement).value).toBe("ab");
  });

  it("presses Enter with a real key event that submits the focused form", async () => {
    const { page, service } = setup(
      el(
        "form",
        { attrs: { id: "search" }, rect: row(0) },
        el("input", { attrs: { id: "q" }, rect: row(0) }),
      ),
    );
    await service.fill("t", "#q", "hello");

    const result = await service.press("t", "Enter");

    expect(result).toMatchObject({ success: true, key: "Enter" });
    expect(page.submitted).toEqual(["search"]);
  });

  it("rejects keys it cannot express instead of reporting success", async () => {
    const { service } = setup(el("input", { attrs: { id: "q" }, rect: row(0) }));
    expect(await service.press("t", "Hyper+Q")).toMatchObject({
      success: false,
      error: expect.stringContaining("Unsupported key"),
    });
  });
});
