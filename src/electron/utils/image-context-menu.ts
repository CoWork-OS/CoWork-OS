import {
  Menu,
  type ContextMenuParams,
  type MenuItemConstructorOptions,
  type WebContents,
} from "electron";

/**
 * Menu items for right-clicking an image in an app window. Returns an empty
 * list when the click was not on a loaded image.
 */
export function buildImageContextMenuTemplate(
  contents: Pick<WebContents, "copyImageAt" | "downloadURL">,
  params: Pick<ContextMenuParams, "mediaType" | "hasImageContents" | "srcURL" | "x" | "y">,
  clipboard: { writeText: (text: string) => void },
): MenuItemConstructorOptions[] {
  if (params.mediaType !== "image" || !params.hasImageContents) return [];

  const items: MenuItemConstructorOptions[] = [
    {
      label: "Copy Image",
      click: () => contents.copyImageAt(params.x, params.y),
    },
  ];

  // Inline data: URLs can be megabytes long; only offer the address for real URLs.
  if (/^(https?|file):/i.test(params.srcURL)) {
    items.push({
      label: "Copy Image Address",
      click: () => clipboard.writeText(params.srcURL),
    });
  }

  if (params.srcURL) {
    items.push({ type: "separator" });
    items.push({
      label: "Save Image As…",
      click: () => contents.downloadURL(params.srcURL),
    });
  }

  return items;
}

/**
 * Electron shows no context menu by default, so images in app windows can't be
 * copied with a right-click. Attach a native image menu to top-level windows only;
 * webviews (browser workbench, canvas) keep their own handling.
 */
export function attachImageContextMenu(
  contents: WebContents,
  clipboard: { writeText: (text: string) => void },
): void {
  if (contents.getType() !== "window") return;
  contents.on("context-menu", (_event, params) => {
    const template = buildImageContextMenuTemplate(contents, params, clipboard);
    if (template.length === 0) return;
    Menu.buildFromTemplate(template).popup();
  });
}
