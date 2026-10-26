import type { BrowserHostFolderApi } from "../../shared/host-api/host-folders";
import type { Workspace } from "../../shared/types";
import { hasHostMethods, isBrowserHost } from "./browser-capabilities";

/**
 * A browser session cannot open the native folder dialog. When the host serves
 * its folder methods, the shared app opens the host folder picker instead.
 */
export function hasBrowserHostFolderPicker(): boolean {
  return isBrowserHost() && hasHostMethods("listHostFolders", "openHostFolderWorkspace");
}

/** The bridge maps these names to the host's `desktop.*` folder methods. */
export function getBrowserHostFolderApi(): BrowserHostFolderApi {
  return window.electronAPI as unknown as BrowserHostFolderApi;
}

type FolderPickerOpener = (options: { startWorkspaceId?: string }) => Promise<Workspace | null>;

let folderPickerOpener: FolderPickerOpener | null = null;

/** The mounted picker registers itself here; the returned function unregisters it. */
export function registerBrowserHostFolderPicker(opener: FolderPickerOpener): () => void {
  folderPickerOpener = opener;
  return () => {
    if (folderPickerOpener === opener) folderPickerOpener = null;
  };
}

/**
 * Open the host folder picker and resolve with the chosen folder's workspace
 * (added when the folder is not one yet), or null when the user cancels.
 */
export function chooseBrowserHostFolderWorkspace(
  options: { startWorkspaceId?: string } = {},
): Promise<Workspace | null> {
  if (!hasBrowserHostFolderPicker() || !folderPickerOpener) {
    return Promise.reject(new Error("Choosing a host folder is not available in this session."));
  }
  return folderPickerOpener(options);
}
