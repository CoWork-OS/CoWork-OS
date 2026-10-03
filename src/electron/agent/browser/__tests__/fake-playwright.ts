import { EventEmitter } from "events";

/**
 * Minimal Playwright page/context doubles for BrowserService tests. They emit the same events
 * Playwright does ("page", "close", "dialog", "download", "console", ...), so the service's
 * listeners can be exercised without launching a browser.
 */

export type FakeRouteHandler = (route: FakeRoute) => Promise<void> | void;

export interface FakeRoute {
  request: () => { url: () => string };
  abort: (reason?: string) => Promise<void>;
  continue: () => Promise<void>;
}

/** Runs a request URL through a route handler and reports what the handler decided. */
export async function routeRequest(
  handler: FakeRouteHandler,
  url: string,
): Promise<"aborted" | "continued" | "none"> {
  let outcome: "aborted" | "continued" | "none" = "none";
  await handler({
    request: () => ({ url: () => url }),
    abort: async () => {
      outcome = "aborted";
    },
    continue: async () => {
      outcome = "continued";
    },
  });
  return outcome;
}

export class FakeLocator {
  constructor(
    private readonly page: FakePage,
    readonly selector: string,
  ) {}

  async waitFor(): Promise<void> {}
  async scrollIntoViewIfNeeded(): Promise<void> {}
  async click(): Promise<void> {
    await this.page.onClick(this.selector);
  }
  async fill(): Promise<void> {}
  async type(): Promise<void> {}
  async textContent(): Promise<string> {
    return this.selector;
  }
  async count(): Promise<number> {
    return this.page.missingSelectors.has(this.selector) ? 0 : 1;
  }
  async setInputFiles(files: string | string[]): Promise<void> {
    if (this.page.missingSelectors.has(this.selector)) {
      const error = new Error(`Timeout 1000ms exceeded waiting for ${this.selector}`);
      error.name = "TimeoutError";
      throw error;
    }
    this.page.uploads.push({ selector: this.selector, files: ([] as string[]).concat(files) });
  }
  first(): FakeLocator {
    return this;
  }
}

export class FakePage extends EventEmitter {
  closed = false;
  routes: FakeRouteHandler[] = [];
  openerPage: FakePage | null = null;
  missingSelectors = new Set<string>();
  uploads: Array<{ selector: string; files: string[] }> = [];
  /** Called by locator.click(); tests replace it to open popups, dialogs or downloads. */
  onClick: (selector: string) => Promise<void> | void = () => undefined;
  keyboard = { press: async (_key: string) => undefined };

  constructor(
    public urlValue = "about:blank",
    public titleValue = "",
  ) {
    super();
  }

  url(): string {
    return this.urlValue;
  }
  async title(): Promise<string> {
    return this.titleValue;
  }
  isClosed(): boolean {
    return this.closed;
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", this);
  }
  async route(_pattern: string, handler: FakeRouteHandler): Promise<void> {
    this.routes.push(handler);
  }
  async opener(): Promise<FakePage | null> {
    return this.openerPage;
  }
  setDefaultTimeout(): void {}
  setDefaultNavigationTimeout(): void {}
  async waitForLoadState(): Promise<void> {}
  async waitForTimeout(): Promise<void> {}
  async bringToFront(): Promise<void> {}
  async goto(url: string): Promise<{ status: () => number }> {
    this.urlValue = url;
    return { status: () => 200 };
  }
  locator(selector: string): FakeLocator {
    return new FakeLocator(this, selector);
  }
  async evaluate(): Promise<unknown> {
    return null;
  }
  async $(): Promise<null> {
    return null;
  }
  async $$(): Promise<unknown[]> {
    return [];
  }
}

export class FakeContext extends EventEmitter {
  pagesList: FakePage[] = [];
  routes: FakeRouteHandler[] = [];
  closed = false;

  pages(): FakePage[] {
    return this.pagesList.filter((page) => !page.closed);
  }
  async newPage(): Promise<FakePage> {
    return this.openPage("about:blank");
  }
  async route(_pattern: string, handler: FakeRouteHandler): Promise<void> {
    this.routes.push(handler);
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  /** Simulates a page opened by the site (window.open, target=_blank, OAuth popup). */
  openPage(url: string, opener: FakePage | null = null, title = ""): FakePage {
    const page = new FakePage(url, title);
    page.openerPage = opener;
    this.pagesList.push(page);
    this.emit("page", page);
    return page;
  }
}

export function createFakeBrowser(context: FakeContext) {
  return {
    newContext: async () => context,
    contexts: () => [context],
    close: async () => undefined,
  };
}
