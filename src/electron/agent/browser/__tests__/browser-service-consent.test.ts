import { describe, expect, it } from "vitest";
import { BrowserService } from "../browser-service";

/**
 * Minimal DOM + Playwright-page fake. It supports the selector shapes consent handling uses:
 * tag names, #id, .class, [attr], [attr="value"], Playwright's case-insensitive substring
 * :has-text("..."), and comma-separated selector lists.
 */
interface FakeNode {
  tag: string;
  attrs?: Record<string, string>;
  text?: string;
  hidden?: boolean;
  children?: FakeNode[];
}

function textOf(node: FakeNode): string {
  return [node.text || "", ...(node.children || []).map(textOf)].filter(Boolean).join(" ");
}

function splitSelectorList(selector: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: string | null = null;
  let depth = 0;
  for (const char of selector) {
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "[" || char === "(") {
      depth += 1;
    } else if (char === "]" || char === ")") {
      depth -= 1;
    } else if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function matchesCompound(node: FakeNode, selector: string): boolean {
  const match = /^([a-zA-Z][\w-]*|\*)?(.*)$/.exec(selector);
  if (!match) return false;
  const [, tag, rest] = match;
  if (tag && tag !== "*" && tag.toLowerCase() !== node.tag) return false;
  const attrs = node.attrs || {};
  const tokenPattern = /#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]|:has-text\("([^"]*)"\)/y;
  let index = 0;
  while (index < rest.length) {
    tokenPattern.lastIndex = index;
    const token = tokenPattern.exec(rest);
    if (!token) return false;
    index = tokenPattern.lastIndex;
    const [, id, className, attrName, attrValue, hasText] = token;
    if (id !== undefined && attrs.id !== id) return false;
    if (className !== undefined && !(attrs.class || "").split(/\s+/).includes(className)) {
      return false;
    }
    if (attrName !== undefined) {
      if (!(attrName in attrs)) return false;
      if (attrValue !== undefined && attrs[attrName] !== attrValue) return false;
    }
    if (hasText !== undefined && !textOf(node).toLowerCase().includes(hasText.toLowerCase())) {
      return false;
    }
  }
  return true;
}

function matches(node: FakeNode, selector: string): boolean {
  return splitSelectorList(selector).some((part) => matchesCompound(node, part));
}

function descendants(node: FakeNode): FakeNode[] {
  return (node.children || []).flatMap((child) => [child, ...descendants(child)]);
}

function isVisible(node: FakeNode, ancestors: Map<FakeNode, FakeNode | null>): boolean {
  let current: FakeNode | null | undefined = node;
  while (current) {
    if (current.hidden) return false;
    current = ancestors.get(current);
  }
  return true;
}

function createFakePage(bodyChildren: FakeNode[], url = "https://example.com/") {
  const body: FakeNode = { tag: "body", children: bodyChildren };
  const parents = new Map<FakeNode, FakeNode | null>([[body, null]]);
  const indexParents = (node: FakeNode) => {
    for (const child of node.children || []) {
      parents.set(child, node);
      indexParents(child);
    }
  };
  indexParents(body);

  const clicked: string[] = [];
  const evaluated: unknown[] = [];

  const toHandle = (node: FakeNode): Any => ({
    isVisible: async () => isVisible(node, parents),
    click: async () => {
      clicked.push(textOf(node) || node.attrs?.value || node.tag);
    },
    textContent: async () => textOf(node),
    innerText: async () => textOf(node),
    getAttribute: async (name: string) => node.attrs?.[name] ?? null,
    $: async (selector: string) => {
      const found = descendants(node).find((candidate) => matches(candidate, selector));
      return found ? toHandle(found) : null;
    },
    $$: async (selector: string) =>
      descendants(node)
        .filter((candidate) => matches(candidate, selector))
        .map(toHandle),
    evaluate: async () => undefined,
  });

  const page: Any = {
    url: () => url,
    title: async () => "Example",
    goto: async () => ({ status: () => 200 }),
    waitForTimeout: async () => undefined,
    evaluate: async (script: unknown) => {
      evaluated.push(script);
      return undefined;
    },
    $: async (selector: string) => {
      const found = descendants(body).find((candidate) => matches(candidate, selector));
      return found ? toHandle(found) : null;
    },
    $$: async (selector: string) =>
      descendants(body)
        .filter((candidate) => matches(candidate, selector))
        .map(toHandle),
  };

  return { page, clicked, evaluated };
}

const workspace = {
  id: "workspace-1",
  path: "/tmp",
  permissions: { read: true, write: true, delete: false, network: true, shell: false },
} as Any;

function createService(page: Any, options: Record<string, unknown> = {}): BrowserService {
  const service = new BrowserService(workspace, { headless: true, ...options });
  (service as Any).page = page;
  (service as Any).context = {};
  return service;
}

const oneTrustBanner = (): FakeNode => ({
  tag: "div",
  attrs: { id: "onetrust-banner-sdk" },
  children: [
    { tag: "p", text: "We use cookies to personalise content." },
    {
      tag: "button",
      attrs: { id: "onetrust-accept-btn-handler" },
      text: "Accept All Cookies",
    },
    { tag: "button", attrs: { id: "onetrust-reject-all-handler" }, text: "Reject All" },
  ],
});

describe("BrowserService consent popup handling", () => {
  it("does not click links or ordinary buttons on a page without a consent manager", async () => {
    const { page, clicked } = createFakePage([
      {
        tag: "main",
        children: [
          { tag: "h1", text: "Hotel Aurora" },
          { tag: "button", text: "Book now" },
          { tag: "button", text: "Continue with Google" },
          { tag: "button", text: "Accept invitation" },
          { tag: "button", text: "Decline" },
        ],
      },
      {
        tag: "footer",
        children: [
          { tag: "a", attrs: { href: "#fb" }, text: "Facebook" },
          { tag: "a", attrs: { href: "#cookies" }, text: "Cookie policy" },
          { tag: "a", attrs: { href: "#tokyo" }, text: "Tokyo office" },
          { tag: "a", attrs: { href: "#ok" }, text: "OK" },
        ],
      },
    ]);
    const service = createService(page);

    const result = await service.navigate("https://example.com/");

    expect(clicked).toEqual([]);
    expect(result.consentDismissed).toBeUndefined();
  });

  it("prefers the reject choice inside a OneTrust banner and reports the click", async () => {
    const { page, clicked } = createFakePage([{ tag: "main", text: "Article" }, oneTrustBanner()]);
    const service = createService(page);

    const result = await service.navigate("https://example.com/");

    expect(clicked).toEqual(["Reject All"]);
    expect(result.consentDismissed).toEqual({
      action: "clicked",
      text: "Reject All",
      container: "#onetrust-banner-sdk",
    });
  });

  it("falls back to accept only inside a cookie dialog that offers no reject choice", async () => {
    const { page, clicked } = createFakePage([
      { tag: "main", text: "Docs" },
      {
        tag: "div",
        attrs: { role: "dialog", "aria-label": "Cookie consent" },
        children: [
          { tag: "p", text: "This site uses cookies for analytics." },
          { tag: "button", text: "Manage preferences" },
          { tag: "button", text: "Accept all" },
        ],
      },
    ]);
    const service = createService(page);

    const result = await service.navigate("https://example.com/");

    expect(clicked).toEqual(["Accept all"]);
    expect(result.consentDismissed).toMatchObject({ action: "clicked", text: "Accept all" });
  });

  it("never clicks anchors, even inside a consent container", async () => {
    const { page, clicked } = createFakePage([
      {
        tag: "div",
        attrs: { id: "onetrust-banner-sdk" },
        children: [
          { tag: "p", text: "We use cookies." },
          { tag: "a", attrs: { href: "#accept" }, text: "Accept" },
          { tag: "a", attrs: { href: "#reject" }, text: "Reject all" },
        ],
      },
    ]);
    const service = createService(page);

    const result = await service.navigate("https://example.com/");

    expect(clicked).toEqual([]);
    expect(result.consentDismissed).toBeUndefined();
  });

  it("ignores dialogs that are not about cookies or consent", async () => {
    const { page, clicked } = createFakePage([
      {
        tag: "div",
        attrs: { role: "dialog", "aria-modal": "true" },
        children: [
          { tag: "p", text: "Your session is about to expire." },
          { tag: "button", text: "OK" },
          { tag: "button", text: "Continue" },
        ],
      },
    ]);
    const service = createService(page);

    const result = await service.navigate("https://example.com/");

    expect(clicked).toEqual([]);
    expect(result.consentDismissed).toBeUndefined();
  });

  it("does not click hidden consent buttons", async () => {
    const banner = oneTrustBanner();
    banner.hidden = true;
    const { page, clicked } = createFakePage([banner]);
    const service = createService(page);

    const result = await service.navigate("https://example.com/");

    expect(clicked).toEqual([]);
    expect(result.consentDismissed).toBeUndefined();
  });

  it("leaves consent untouched in persistent profiles and attached real browsers", async () => {
    const profile = createFakePage([oneTrustBanner()]);
    const profileService = createService(profile.page, { userDataDir: "/tmp/profile" });
    const profileResult = await profileService.navigate("https://example.com/");

    const attached = createFakePage([oneTrustBanner()]);
    const attachedService = createService(attached.page);
    (attachedService as Any).isAttached = true;
    const attachedResult = await attachedService.navigate("https://example.com/");

    expect(profile.clicked).toEqual([]);
    expect(profile.evaluated).toEqual([]);
    expect(profileResult.consentDismissed).toBeUndefined();
    expect(attached.clicked).toEqual([]);
    expect(attached.evaluated).toEqual([]);
    expect(attachedResult.consentDismissed).toBeUndefined();
  });
});
