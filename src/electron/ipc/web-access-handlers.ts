/**
 * Web Access IPC Handlers
 *
 * IPC handlers for the web access mode (browser-based access).
 * Bridges the renderer with WebAccessServer and the browser app controls.
 */

import { ipcMain, shell } from "electron";
import { IPC_CHANNELS } from "../../shared/types";
import { WebAccessServer } from "../web-server/WebAccessServer";
import { WebAccessConfig, WebAccessStatus } from "../web-server/types";
import type { PairingCode } from "../../host/web/WebApplication";
import type {
  BrowserAppSignInLink,
  BrowserAppStatus,
} from "../../host/services/browser-app-control";

export interface BrowserAppIpcControls {
  createPairingCode: () => PairingCode;
  createSignInLink: () => BrowserAppSignInLink;
  signOutAll: () => { signedOut: number };
  getStatus: () => BrowserAppStatus & { error?: string };
}

/** What "Open in browser" did: opened the app, or handed back a link to paste. */
export type OpenBrowserAppResult =
  | { opened: true; appUrl: string }
  | { opened: false; link: BrowserAppSignInLink };

/**
 * Where handing a sign-in link to the default browser keeps it from other local users. macOS
 * delivers it to the browser as an Apple Event and Windows hides other users' command lines;
 * elsewhere the opener's and browser's command lines are readable by every local account, so
 * the link is copied for the user to paste instead.
 */
export function canOpenSignInLinkPrivately(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin" || platform === "win32";
}

function settingsUpdates(value: unknown): Partial<WebAccessConfig> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Partial<WebAccessConfig>;
}

export function setupWebAccessHandlers(
  webAccessServer: WebAccessServer,
  options?: {
    saveSettings?: (settings: WebAccessConfig) => void;
    /** Runs after saved settings are applied, so the browser app can follow them. */
    onSettingsApplied?: (settings: WebAccessConfig) => Promise<void>;
    browserApp?: BrowserAppIpcControls;
    openExternal?: (url: string) => Promise<void>;
    platform?: NodeJS.Platform;
  },
): void {
  const browserApp = options?.browserApp;
  const openExternal = options?.openExternal ?? ((url: string) => shell.openExternal(url));

  ipcMain.handle(IPC_CHANNELS.WEBACCESS_GET_SETTINGS, async (): Promise<WebAccessConfig> => {
    return webAccessServer.getConfig();
  });

  ipcMain.handle(
    IPC_CHANNELS.WEBACCESS_SAVE_SETTINGS,
    async (_: unknown, config: unknown): Promise<WebAccessConfig> => {
      const updated = await webAccessServer.applyConfig(settingsUpdates(config));
      options?.saveSettings?.(updated);
      await options?.onSettingsApplied?.(updated);
      return updated;
    },
  );

  ipcMain.handle(IPC_CHANNELS.WEBACCESS_GET_STATUS, async (): Promise<WebAccessStatus> => {
    const status = webAccessServer.getStatus();
    if (!browserApp) return status;
    const app = browserApp.getStatus();
    const browserAppError = app.error ?? status.browserAppError;
    return {
      ...status,
      signedInBrowsers: app.signedInBrowsers,
      ...(app.appUrl ? { browserAppUrl: app.appUrl } : {}),
      ...(browserAppError ? { browserAppError } : {}),
    };
  });

  ipcMain.handle(IPC_CHANNELS.WEBACCESS_CREATE_PAIRING_CODE, async (): Promise<PairingCode> => {
    if (!browserApp) throw new Error("Browser pairing is disabled.");
    return browserApp.createPairingCode();
  });

  ipcMain.handle(
    IPC_CHANNELS.WEBACCESS_CREATE_SIGN_IN_LINK,
    async (): Promise<BrowserAppSignInLink> => {
      if (!browserApp) throw new Error("Browser pairing is disabled.");
      return browserApp.createSignInLink();
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.WEBACCESS_OPEN_BROWSER_APP,
    async (): Promise<OpenBrowserAppResult> => {
      if (!browserApp) throw new Error("Browser pairing is disabled.");
      const link = browserApp.createSignInLink();
      if (!canOpenSignInLinkPrivately(options?.platform)) return { opened: false, link };
      await openExternal(link.url);
      return { opened: true, appUrl: link.appUrl };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.WEBACCESS_SIGN_OUT_BROWSERS,
    async (): Promise<{ signedOut: number }> => {
      if (!browserApp) return { signedOut: 0 };
      return browserApp.signOutAll();
    },
  );
}
