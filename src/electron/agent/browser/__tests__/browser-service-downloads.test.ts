import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chromium } from "playwright";
import { BrowserService } from "../browser-service";
import { FakeContext, FakePage, createFakeBrowser } from "./fake-playwright";

vi.mock("playwright", () => ({ chromium: { launch: vi.fn() } }));

function fakeDownload(suggestedFilename: string, content = "a,b\n1,2\n", saveDelayMs = 0) {
  return {
    suggestedFilename: () => suggestedFilename,
    url: () => "https://example.com/export?token=secret-value",
    saveAs: vi.fn(async (target: string) => {
      if (saveDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, saveDelayMs));
      fs.writeFileSync(target, content);
    }),
    cancel: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };
}

let context: FakeContext;
let workspaceDir: string;
let externalDir: string;

beforeEach(() => {
  context = new FakeContext();
  vi.mocked(chromium.launch).mockResolvedValue(createFakeBrowser(context) as Any);
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-downloads-ws-"));
  externalDir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-downloads-ext-"));
});

afterEach(() => {
  fs.rmSync(workspaceDir, { recursive: true, force: true });
  fs.rmSync(externalDir, { recursive: true, force: true });
});

function workspaceWith(permissions: Record<string, unknown> = {}): Any {
  return {
    id: "workspace-1",
    path: workspaceDir,
    permissions: {
      read: true,
      write: true,
      delete: false,
      network: true,
      shell: false,
      ...permissions,
    },
  };
}

async function openService(
  workspace: Any = workspaceWith(),
): Promise<{ service: BrowserService; page: FakePage }> {
  const service = new BrowserService(workspace, { headless: true, popupGraceMs: 0 });
  await service.navigate("https://example.com/reports");
  return { service, page: context.pagesList[0] };
}

describe("BrowserService headless downloads", () => {
  it("saves a download into the workspace downloads folder and reports it", async () => {
    const { service, page } = await openService();
    const download = fakeDownload("report.csv");
    page.onClick = () => {
      page.emit("download", download);
    };

    const result = await service.click("#export");

    const saved = path.join(workspaceDir, "downloads", "report.csv");
    expect(fs.readFileSync(saved, "utf8")).toBe("a,b\n1,2\n");
    expect(result.downloads?.[0]).toMatchObject({
      status: "saved",
      suggestedFilename: "report.csv",
      path: path.join("downloads", "report.csv"),
      size: 8,
      tabId: "tab-1",
    });
    expect(result.downloads?.[0].url).not.toContain("secret-value");
    expect(service.listDownloads()).toHaveLength(1);
  });

  it("keeps traversal names inside the downloads folder and never overwrites", async () => {
    const { service, page } = await openService();
    page.emit("download", fakeDownload("../../.bashrc"));
    page.emit("download", fakeDownload("report.csv"));
    page.emit("download", fakeDownload("report.csv"));

    const result = await service.press("Tab");

    expect(result.downloads?.map((entry) => entry.path)).toEqual([
      path.join("downloads", "bashrc"),
      path.join("downloads", "report.csv"),
      path.join("downloads", "report (1).csv"),
    ]);
    expect(fs.existsSync(path.join(workspaceDir, ".bashrc"))).toBe(false);
  });

  it("rejects a download whose folder resolves outside the workspace", async () => {
    fs.symlinkSync(externalDir, path.join(workspaceDir, "downloads"));
    // Even unrestricted file access does not let untrusted page content land outside.
    const { service, page } = await openService(workspaceWith({ unrestrictedFileAccess: true }));
    const download = fakeDownload("payload.sh");
    page.emit("download", download);

    const result = await service.press("Tab");

    expect(result.downloads?.[0]).toMatchObject({ status: "rejected" });
    expect(result.downloads?.[0].error).toContain("outside the workspace");
    expect(download.saveAs).not.toHaveBeenCalled();
    expect(download.cancel).toHaveBeenCalled();
    expect(fs.readdirSync(externalDir)).toEqual([]);
  });

  it("rejects downloads when the workspace cannot be written", async () => {
    const { service, page } = await openService(workspaceWith({ write: false }));
    const download = fakeDownload("report.csv");
    page.emit("download", download);

    const result = await service.press("Tab");

    expect(result.downloads?.[0]).toMatchObject({ status: "rejected" });
    expect(result.downloads?.[0].error).toContain("workspace_write_disabled");
    expect(download.saveAs).not.toHaveBeenCalled();
  });

  it("finishes saving a download before closing the browser context", async () => {
    const { service, page } = await openService();
    page.emit("download", fakeDownload("slow.zip", "zip", 30));

    await service.close();

    expect(fs.readFileSync(path.join(workspaceDir, "downloads", "slow.zip"), "utf8")).toBe("zip");
    expect(context.closed).toBe(true);
    expect(service.listDownloads()[0]).toMatchObject({ status: "saved", size: 3 });
  });
});
