import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow, MenuItemConstructorOptions, PopupOptions } from "electron";
import { popupBrowserToolbarMenu } from "../browser-toolbar-menu";
import type { BrowserToolbarMenuRequest } from "../../../shared/browser-toolbar-menu";

const mock = vi.hoisted(() => ({ build: vi.fn(), popup: vi.fn() }));
vi.mock("electron", () => ({ Menu: { buildFromTemplate: mock.build } }));

const request: BrowserToolbarMenuRequest = {
  x: 120,
  y: 50,
  hasPage: true,
  viewports: [{ label: "Desktop", width: 1440, height: 900 }],
  activeViewport: "Desktop",
  snapshotOverlay: true,
  diagnosticsOpen: false,
};

function setup() {
  const window = {
    webContents: { getZoomFactor: () => 1.5 },
    getContentBounds: () => ({ width: 800, height: 600 }),
  } as BrowserWindow;
  const result = popupBrowserToolbarMenu(window, request);
  const template = mock.build.mock.calls[0][0] as MenuItemConstructorOptions[];
  const options = mock.popup.mock.calls[0][0] as PopupOptions;
  return { result, template, options, window };
}

beforeEach(() => {
  vi.clearAllMocks();
  mock.build.mockReturnValue({ popup: mock.popup });
});

describe("native browser toolbar menu", () => {
  it("opens over the window without capturing, hiding, resizing, or navigating the page", async () => {
    const { result, options, window } = setup();
    expect(options).toMatchObject({ window, x: 180, y: 75 });
    // The only window operations available are reads: no page handoff is necessary.
    options.callback!();
    expect(await result).toBeNull();
  });

  it.each([
    ["Annotate screenshot", "annotate"],
    ["Save screenshot", "screenshot"],
    ["Open in system browser", "external"],
    ["Fit to panel", "fit"],
    ["Desktop (1440 × 900)", "viewport:0"],
    ["Element outlines", "outlines"],
    ["Diagnostics", "diagnostics"],
  ])("returns the selected %s action", async (label, action) => {
    const { result, template, options } = setup();
    template.find((entry) => entry.label === label)!.click!(undefined!, undefined!, undefined!);
    options.callback!();
    expect(await result).toBe(action);
  });

  it("preserves viewport and overlay checkmarks", () => {
    const { template } = setup();
    expect(template.filter((entry) => entry.checked).map((entry) => entry.label)).toEqual([
      "Desktop (1440 × 900)",
      "Element outlines",
    ]);
  });

  it("disables page actions on a new tab", () => {
    void popupBrowserToolbarMenu(
      {
        webContents: { getZoomFactor: () => 1 },
        getContentBounds: () => ({ width: 800, height: 600 }),
      } as BrowserWindow,
      { ...request, hasPage: false },
    );
    const template = mock.build.mock.calls[0][0] as MenuItemConstructorOptions[];
    expect(template.slice(0, 3).every((entry) => entry.enabled === false)).toBe(true);
  });

  it("clamps invalid popup coordinates and ignores malformed viewport entries", () => {
    void popupBrowserToolbarMenu(
      {
        webContents: { getZoomFactor: () => 1 },
        getContentBounds: () => ({ width: 800, height: 600 }),
      } as BrowserWindow,
      {
        ...request,
        x: Infinity,
        y: 900,
        viewports: [null, { label: "Bad", width: -1, height: 5 }] as Any,
      },
    );
    expect(mock.popup.mock.calls[0][0]).toMatchObject({ x: 0, y: 600 });
    expect(
      mock.build.mock.calls[0][0].some((entry: MenuItemConstructorOptions) =>
        entry.label?.startsWith("Bad"),
      ),
    ).toBe(false);
  });
});
