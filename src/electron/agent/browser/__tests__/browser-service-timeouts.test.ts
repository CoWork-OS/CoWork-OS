import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserService } from "../browser-service";
import { BROWSER_ACTION_TIMEOUT_MS, BROWSER_WAIT_TIMEOUT_MS } from "../browser-timeouts";

function timeoutError(message: string): Error {
  const error = new Error(message);
  error.name = "TimeoutError";
  return error;
}

interface FakeLocatorOptions {
  /** Resolves or rejects each waitFor call in order; the last entry repeats. */
  waitFor: Array<"ok" | Error>;
  count?: number;
  /** Resolves or rejects each click call in order; the last entry repeats. */
  click?: Array<"ok" | Error>;
}

function createFakePage(options: FakeLocatorOptions) {
  const waitForTimeouts: number[] = [];
  const clickTimeouts: number[] = [];
  let waitForCalls = 0;
  let clickCalls = 0;
  const pick = <T>(list: T[], index: number): T => list[Math.min(index, list.length - 1)];

  const locator = {
    waitFor: vi.fn(async ({ timeout }: { timeout: number }) => {
      waitForTimeouts.push(timeout);
      const outcome = pick(options.waitFor, waitForCalls++);
      if (outcome !== "ok") throw outcome;
    }),
    scrollIntoViewIfNeeded: vi.fn(async () => undefined),
    click: vi.fn(async ({ timeout }: { timeout: number }) => {
      clickTimeouts.push(timeout);
      const outcome = pick(options.click || ["ok"], clickCalls++);
      if (outcome !== "ok") throw outcome;
    }),
    fill: vi.fn(async () => undefined),
    type: vi.fn(async () => undefined),
    textContent: vi.fn(async () => "Submit"),
    count: vi.fn(async () => options.count ?? 0),
  };

  const page: Any = {
    url: () => "https://example.com/form",
    locator: vi.fn(() => locator),
    waitForTimeout: vi.fn(async () => undefined),
    waitForSelector: vi.fn(async () => null),
    screenshot: vi.fn(async () => Buffer.from("")),
    viewportSize: () => ({ width: 1280, height: 720 }),
    evaluate: vi.fn(async () => "Submit form"),
  };

  return { page, locator, waitForTimeouts, clickTimeouts };
}

describe("BrowserService action timeouts", () => {
  let workspaceDir: string;
  let workspace: Any;

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-timeouts-"));
    workspace = {
      id: "workspace-1",
      path: workspaceDir,
      permissions: { read: true, write: true, delete: false, network: true, shell: false },
    };
  });

  afterEach(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  function createService(page: Any, options: Record<string, unknown> = {}): BrowserService {
    // Same options BrowserTools uses: a long budget for launch and navigation.
    const service = new BrowserService(workspace, { headless: true, timeout: 90_000, ...options });
    (service as Any).page = page;
    (service as Any).context = {};
    return service;
  }

  it("fails a missing selector once, within the short action budget, with candidates", async () => {
    const { page, locator, waitForTimeouts } = createFakePage({
      waitFor: [timeoutError("locator.waitFor: Timeout 15000ms exceeded.")],
      count: 0,
    });
    const service = createService(page);
    const navLinks = Array.from({ length: 9 }, (_, index) => ({
      role: "link",
      name: `Section ${index + 1}`,
      selector: `a[href="/section-${index + 1}"]`,
    }));
    vi.spyOn(service as Any, "getInteractiveElements").mockResolvedValue([
      ...navLinks,
      { role: "textbox", name: "Email", selector: 'input[name="email"]', type: "email" },
      { role: "button", name: "Submit", selector: "#submit-btn" },
    ]);

    const result = await service.click("#submit");

    expect(result.success).toBe(false);
    expect(locator.waitFor).toHaveBeenCalledTimes(1);
    expect(waitForTimeouts[0]).toBeLessThanOrEqual(BROWSER_ACTION_TIMEOUT_MS);
    expect(waitForTimeouts[0]).toBeGreaterThan(BROWSER_ACTION_TIMEOUT_MS - 1_000);
    expect(locator.click).not.toHaveBeenCalled();
    expect(result.error).toContain('No element matches selector "#submit"');
    expect(result.error).toContain("#submit-btn");
    // The closest match leads, then other controls, then a few links.
    expect(result.candidates?.slice(0, 2)).toEqual([
      { role: "button", name: "Submit", selector: "#submit-btn" },
      { role: "textbox", name: "Email", selector: 'input[name="email"]', type: "email" },
    ]);
    expect(result.candidates).toHaveLength(8);
    expect(result.url).toBe("https://example.com/form");
  });

  it("does not retry when a matching element never becomes actionable", async () => {
    const { page, locator } = createFakePage({
      waitFor: [timeoutError("locator.waitFor: Timeout 15000ms exceeded.")],
      count: 1,
    });
    const service = createService(page);

    const result = await service.fill("#email", "a@example.com");

    expect(result.success).toBe(false);
    expect(locator.waitFor).toHaveBeenCalledTimes(1);
    expect(result.error).toContain("Timeout 15000ms exceeded");
  });

  it("still retries a transient detach once inside the same budget", async () => {
    const { page, locator, clickTimeouts } = createFakePage({
      waitFor: ["ok"],
      click: [new Error("locator.click: Element is not attached to the DOM"), "ok"],
    });
    const service = createService(page);

    const result = await service.click("#submit");

    expect(result.success).toBe(true);
    expect(locator.click).toHaveBeenCalledTimes(2);
    expect(Math.max(...clickTimeouts)).toBeLessThanOrEqual(BROWSER_ACTION_TIMEOUT_MS);
  });

  it("honours an explicit timeout_ms for slow elements", async () => {
    const { page, waitForTimeouts } = createFakePage({ waitFor: ["ok"] });
    const service = createService(page);

    await service.click("#slow", 40_000);

    expect(waitForTimeouts[0]).toBeGreaterThan(39_000);
    expect(waitForTimeouts[0]).toBeLessThanOrEqual(40_000);
  });

  it("gives browser_wait its documented default instead of the navigation budget", async () => {
    const { page } = createFakePage({ waitFor: ["ok"] });
    const service = createService(page);

    await service.waitForSelector("#results");

    expect(page.waitForSelector).toHaveBeenCalledWith("#results", {
      timeout: BROWSER_WAIT_TIMEOUT_MS,
    });
  });
});
