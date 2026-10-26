import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chromium } from "playwright";
import { BrowserService } from "../browser-service";
import { FakeContext, createFakeBrowser, routeRequest } from "./fake-playwright";

vi.mock("playwright", () => ({ chromium: { launch: vi.fn() } }));

let context: FakeContext;
const tempRoots: string[] = [];

beforeEach(() => {
  context = new FakeContext();
  vi.mocked(chromium.launch).mockResolvedValue(createFakeBrowser(context) as Any);
});

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** A workspace page, a sibling stylesheet and a page outside the workspace, all canonical. */
function makeFiles() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "browser-service-local-")));
  tempRoots.push(root);
  const workspaceDir = path.join(root, "workspace");
  const outsideDir = path.join(root, "outside");
  fs.mkdirSync(workspaceDir);
  fs.mkdirSync(outsideDir);
  const pagePath = path.join(workspaceDir, "index.html");
  fs.writeFileSync(pagePath, "<h1>Prototype</h1>");
  fs.writeFileSync(path.join(workspaceDir, "style.css"), "h1 { color: red }");
  const outsidePath = path.join(outsideDir, "secret.html");
  fs.writeFileSync(outsidePath, "<p>secret</p>");
  return {
    pagePath,
    pageUrl: pathToFileURL(pagePath).href,
    siblingUrl: pathToFileURL(path.join(workspaceDir, "style.css")).href,
    outsidePath,
    outsideUrl: pathToFileURL(outsidePath).href,
    service: new BrowserService(
      {
        id: "workspace-1",
        path: workspaceDir,
        permissions: { read: true, write: true, delete: false, network: true, shell: false },
      } as Any,
      { headless: true },
    ),
  };
}

describe("BrowserService local pages", () => {
  it("loads the approved page and refuses every other local file", async () => {
    const { service, pageUrl, siblingUrl, outsideUrl } = makeFiles();

    service.allowLocalFileUrl(pageUrl);
    const result = await service.navigate(`${pageUrl}#approvals`);

    expect(result.url).toBe(`${pageUrl}#approvals`);
    const route = context.routes[0];
    expect(await routeRequest(route, pageUrl)).toBe("continued");
    expect(await routeRequest(route, siblingUrl)).toBe("aborted");
    expect(await routeRequest(route, outsideUrl)).toBe("aborted");
    // Network requests the page makes still go through the network policy.
    expect(await routeRequest(route, "https://example.com/app.js")).toBe("continued");
  });

  it("refuses a local page that was never approved", async () => {
    const { service, pageUrl } = makeFiles();

    await expect(service.navigate(pageUrl)).rejects.toThrow(
      "only a workspace page opened with browser_navigate is reachable",
    );
  });

  it("ignores allowances for files that are not .html pages", async () => {
    const { service, siblingUrl } = makeFiles();

    service.allowLocalFileUrl(siblingUrl);

    await expect(service.navigate(siblingUrl)).rejects.toThrow("Browser access denied");
  });

  it("stops honoring the page once its path is swapped for a symlink", async () => {
    const { service, pagePath, pageUrl, outsidePath } = makeFiles();
    service.allowLocalFileUrl(pageUrl);
    await service.navigate(pageUrl);

    fs.rmSync(pagePath);
    fs.symlinkSync(outsidePath, pagePath);

    expect(await routeRequest(context.routes[0], pageUrl)).toBe("aborted");
    await expect(service.navigate(pageUrl)).rejects.toThrow("Browser access denied");
  });
});
