/**
 * Right-click menu for pages in the in-app browser.
 *
 * Electron shows no context menu by default, so this builds the native menu a
 * browser has: navigation, links, images, selection and editing (with
 * spellcheck). Actions that open a URL go through the workbench service, which
 * checks the owning session's access policy; external links only open http(s).
 * Actions that need the renderer (search, ask CoWork, annotate, screenshot) are
 * sent to it as context actions.
 */

import type { MenuItemConstructorOptions } from "electron";
import type { BrowserTabOwner } from "./browser-session-manager";

export type BrowserContextAction =
  | { kind: "search"; text: string }
  | { kind: "ask"; text: string; url: string }
  | { kind: "annotate"; x: number; y: number }
  | { kind: "screenshot" };

export type BrowserContextMenuParams = {
  x: number;
  y: number;
  linkURL?: string;
  linkText?: string;
  srcURL?: string;
  mediaType?: string;
  hasImageContents?: boolean;
  selectionText?: string;
  isEditable?: boolean;
  editFlags?: {
    canUndo?: boolean;
    canRedo?: boolean;
    canCut?: boolean;
    canCopy?: boolean;
    canPaste?: boolean;
    canSelectAll?: boolean;
  };
  misspelledWord?: string;
  dictionarySuggestions?: string[];
  pageURL?: string;
};

export type BrowserContextMenuDeps = {
  owner: BrowserTabOwner;
  contents: {
    canGoBack?: () => boolean;
    canGoForward?: () => boolean;
    goBack?: () => void;
    goForward?: () => void;
    reload?: () => void;
    copyImageAt?: (x: number, y: number) => void;
    inspectElement?: (x: number, y: number) => void;
    replaceMisspelling?: (word: string) => void;
    undo?: () => void;
    redo?: () => void;
    cut?: () => void;
    copy?: () => void;
    paste?: () => void;
    selectAll?: () => void;
    session?: { addWordToSpellCheckerDictionary?: (word: string) => boolean };
    navigationHistory?: {
      canGoBack?: () => boolean;
      canGoForward?: () => boolean;
      goBack?: () => void;
      goForward?: () => void;
    };
  };
  writeText: (text: string) => void;
  openTab: (url: string, background: boolean) => void;
  openExternal: (url: string) => void;
  sendAction: (action: BrowserContextAction) => void;
  /** Download an image into the task workspace's downloads folder. */
  saveToWorkspace?: (url: string) => void;
  searchLabel?: string;
  /** Settings > Browser developer mode: adds Inspect Element. */
  developerMode?: boolean;
};

function isWebUrl(value: string | undefined): value is string {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

function truncate(text: string, max: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

function canNavigate(deps: BrowserContextMenuDeps, direction: "back" | "forward"): boolean {
  const history = deps.contents.navigationHistory;
  if (direction === "back") {
    return Boolean(history?.canGoBack?.() ?? deps.contents.canGoBack?.());
  }
  return Boolean(history?.canGoForward?.() ?? deps.contents.canGoForward?.());
}

function navigate(deps: BrowserContextMenuDeps, direction: "back" | "forward"): void {
  const history = deps.contents.navigationHistory;
  if (direction === "back") {
    if (history?.goBack) history.goBack();
    else deps.contents.goBack?.();
  } else if (history?.goForward) {
    history.goForward();
  } else {
    deps.contents.goForward?.();
  }
}

/** Build the menu for one right-click. Pure apart from the callbacks in `deps`. */
export function buildBrowserContextMenuTemplate(
  params: BrowserContextMenuParams,
  deps: BrowserContextMenuDeps,
): MenuItemConstructorOptions[] {
  const sections: MenuItemConstructorOptions[][] = [];
  const selection = (params.selectionText || "").trim();
  const flags = params.editFlags || {};

  if (params.isEditable && params.misspelledWord) {
    const suggestions = (params.dictionarySuggestions || []).slice(0, 5);
    sections.push([
      ...(suggestions.length > 0
        ? suggestions.map((suggestion): MenuItemConstructorOptions => ({
            label: suggestion,
            click: () => deps.contents.replaceMisspelling?.(suggestion),
          }))
        : [{ label: "No spelling suggestions", enabled: false }]),
      {
        label: "Add to Dictionary",
        click: () =>
          deps.contents.session?.addWordToSpellCheckerDictionary?.(params.misspelledWord || ""),
      },
    ]);
  }

  if (isWebUrl(params.linkURL)) {
    const link = params.linkURL;
    sections.push([
      { label: "Open Link in New Tab", click: () => deps.openTab(link, false) },
      { label: "Open Link in Background Tab", click: () => deps.openTab(link, true) },
      { label: "Open Link in Browser", click: () => deps.openExternal(link) },
      { label: "Copy Link Address", click: () => deps.writeText(link) },
    ]);
  }

  if (params.mediaType === "image" && params.hasImageContents) {
    const image: MenuItemConstructorOptions[] = [
      { label: "Copy Image", click: () => deps.contents.copyImageAt?.(params.x, params.y) },
    ];
    if (isWebUrl(params.srcURL)) {
      const src = params.srcURL;
      image.push(
        { label: "Copy Image Address", click: () => deps.writeText(src) },
        { label: "Open Image in New Tab", click: () => deps.openTab(src, false) },
      );
    }
    const saveTo = deps.saveToWorkspace;
    if (saveTo && (isWebUrl(params.srcURL) || /^data:image\//i.test(params.srcURL || ""))) {
      const src = params.srcURL as string;
      image.push({ label: "Save Image to Workspace", click: () => saveTo(src) });
    }
    sections.push(image);
  }

  if (params.isEditable) {
    sections.push([
      { label: "Undo", enabled: flags.canUndo !== false, click: () => deps.contents.undo?.() },
      { label: "Redo", enabled: flags.canRedo !== false, click: () => deps.contents.redo?.() },
      { type: "separator" },
      { label: "Cut", enabled: flags.canCut !== false, click: () => deps.contents.cut?.() },
      { label: "Copy", enabled: flags.canCopy !== false, click: () => deps.contents.copy?.() },
      { label: "Paste", enabled: flags.canPaste !== false, click: () => deps.contents.paste?.() },
      {
        label: "Select All",
        enabled: flags.canSelectAll !== false,
        click: () => deps.contents.selectAll?.(),
      },
    ]);
  } else if (selection) {
    sections.push([{ label: "Copy", click: () => deps.contents.copy?.() }]);
  }

  if (selection) {
    const short = truncate(selection, 32);
    sections.push([
      {
        label: `Search ${deps.searchLabel || "the web"} for "${short}"`,
        click: () => deps.sendAction({ kind: "search", text: selection.slice(0, 2000) }),
      },
      {
        label: "Ask CoWork About This",
        click: () =>
          deps.sendAction({
            kind: "ask",
            text: selection.slice(0, 4000),
            url: params.pageURL || "",
          }),
      },
    ]);
  }

  if (!params.isEditable && !selection && !params.linkURL) {
    sections.push([
      {
        label: "Back",
        enabled: canNavigate(deps, "back"),
        click: () => navigate(deps, "back"),
      },
      {
        label: "Forward",
        enabled: canNavigate(deps, "forward"),
        click: () => navigate(deps, "forward"),
      },
      { label: "Reload", click: () => deps.contents.reload?.() },
    ]);
  }

  // Workbench tabs only: popups are not under the annotation layer.
  if (deps.owner.kind === "tab") {
    sections.push([
      {
        label: "Annotate This Element",
        click: () => deps.sendAction({ kind: "annotate", x: params.x, y: params.y }),
      },
      { label: "Take Screenshot", click: () => deps.sendAction({ kind: "screenshot" }) },
    ]);
  }

  if (deps.developerMode && deps.contents.inspectElement) {
    sections.push([
      {
        label: "Inspect Element",
        click: () => deps.contents.inspectElement?.(params.x, params.y),
      },
    ]);
  }

  const template: MenuItemConstructorOptions[] = [];
  for (const section of sections) {
    if (section.length === 0) continue;
    if (template.length > 0) template.push({ type: "separator" });
    template.push(...section);
  }
  return template;
}
