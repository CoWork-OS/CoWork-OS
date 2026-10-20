import { Menu } from "electron";
import type { BrowserWindow, MenuItemConstructorOptions } from "electron";
import type {
  BrowserToolbarMenuAction,
  BrowserToolbarMenuRequest,
} from "../../shared/browser-toolbar-menu";

/** A native popup draws above WebContentsViews without replacing the live page with a still. */
export function popupBrowserToolbarMenu(
  window: BrowserWindow,
  request: BrowserToolbarMenuRequest,
): Promise<BrowserToolbarMenuAction | null> {
  return new Promise((resolve) => {
    let selected: BrowserToolbarMenuAction | null = null;
    const item = (
      label: string,
      action: BrowserToolbarMenuAction,
      options: Partial<MenuItemConstructorOptions> = {},
    ): MenuItemConstructorOptions => ({
      label,
      ...options,
      click: () => {
        selected = action;
      },
    });
    const template: MenuItemConstructorOptions[] = [
      item("Annotate screenshot", "annotate", { enabled: request.hasPage === true }),
      item("Save screenshot", "screenshot", { enabled: request.hasPage === true }),
      item("Open in system browser", "external", { enabled: request.hasPage === true }),
      { type: "separator" },
      { label: "Page size", enabled: false },
      item("Fit to panel", "fit", { type: "checkbox", checked: request.activeViewport === null }),
    ];
    for (const [index, viewport] of (Array.isArray(request.viewports) ? request.viewports : [])
      .slice(0, 10)
      .entries()) {
      if (!viewport || typeof viewport.label !== "string") continue;
      const width = Number(viewport.width);
      const height = Number(viewport.height);
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
        continue;
      template.push(
        item(
          `${viewport.label.slice(0, 80)} (${Math.round(width)} × ${Math.round(height)})`,
          `viewport:${index}`,
          {
            type: "checkbox",
            checked: request.activeViewport === viewport.label,
          },
        ),
      );
    }
    template.push(
      { type: "separator" },
      item("Element outlines", "outlines", {
        type: "checkbox",
        checked: request.snapshotOverlay === true,
      }),
      item("Diagnostics", "diagnostics", {
        type: "checkbox",
        checked: request.diagnosticsOpen === true,
      }),
    );
    const zoom = window.webContents.getZoomFactor();
    const bounds = window.getContentBounds();
    const coordinate = (value: number, limit: number) =>
      Number.isFinite(value) ? Math.max(0, Math.min(limit, Math.round(value * zoom))) : 0;
    Menu.buildFromTemplate(template).popup({
      window,
      x: coordinate(request.x, bounds.width),
      y: coordinate(request.y, bounds.height),
      callback: () => resolve(selected),
    });
  });
}
