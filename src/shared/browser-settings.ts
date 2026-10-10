/** Settings > Browser: preferences of the in-app browser. */

export type BrowserSearchEngine = "google" | "bing" | "duckduckgo" | "brave" | "kagi";
export type BrowserDownloadLocation = "system" | "workspace" | "ask";
export type BrowserAgentPermission = "ask" | "allow" | "block";
/** "webview": tabs are <webview> elements in the app window; "native": main-process WebContentsViews. */
export type BrowserEngine = "webview" | "native";

export interface BrowserSettings {
  searchEngine: BrowserSearchEngine;
  /** Where downloads you start go; downloads CoWork starts always go to the workspace. */
  downloadLocation: BrowserDownloadLocation;
  /** Reopen the workbench's tabs when it is opened again for a task. */
  restoreTabs: boolean;
  /** Present the bundled Chrome's user agent (takes effect after restarting the app). */
  chromeCompatibleUserAgent: boolean;
  /** Open web links from the conversation in the in-app browser instead of the system browser. */
  openChatLinksInBrowser: boolean;
  /** Record pages visited in the in-app browser. */
  historyEnabled: boolean;
  /** What CoWork may do when it downloads a file while driving the browser. */
  agentDownloads: BrowserAgentPermission;
  /** What CoWork may do when it uploads a workspace file to a page. */
  agentUploads: BrowserAgentPermission;
  /** Full DevTools access: Inspect element, and CoWork's page script, storage and trace tools. */
  developerMode: boolean;
  /** Experimental: native tab views that stay alive when the browser closes. */
  browserEngine: BrowserEngine;
}

/** What the organization's admin policy decides for the in-app browser (read-only for users). */
export interface BrowserSettingsPolicy {
  /** Developer mode is set by policy; the toggle shows the forced value. */
  developerModeLocked: boolean;
  /** Site permissions denied without a prompt. */
  blockedSitePermissions: string[];
}

/** Settings as returned to Settings > Browser, with the admin policy applied. */
export type BrowserSettingsState = BrowserSettings & { policy?: BrowserSettingsPolicy };

export const DEFAULT_BROWSER_SETTINGS: BrowserSettings = {
  searchEngine: "google",
  downloadLocation: "system",
  restoreTabs: true,
  chromeCompatibleUserAgent: true,
  openChatLinksInBrowser: true,
  historyEnabled: true,
  agentDownloads: "ask",
  agentUploads: "ask",
  developerMode: false,
  browserEngine: "webview",
};

const SEARCH_ENGINES = new Set(["google", "bing", "duckduckgo", "brave", "kagi"]);
const DOWNLOAD_LOCATIONS = new Set(["system", "workspace", "ask"]);
const AGENT_PERMISSIONS = new Set(["ask", "allow", "block"]);
const BROWSER_ENGINES = new Set(["webview", "native"]);

/** Fill defaults and drop invalid values (settings arrive from storage and the renderer). */
export function normalizeBrowserSettings(value: unknown): BrowserSettings {
  const input = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const pick = <T extends string>(key: keyof BrowserSettings, allowed: Set<string>): T =>
    (typeof input[key] === "string" && allowed.has(input[key] as string)
      ? input[key]
      : DEFAULT_BROWSER_SETTINGS[key]) as T;
  const flag = (key: keyof BrowserSettings): boolean =>
    typeof input[key] === "boolean"
      ? (input[key] as boolean)
      : (DEFAULT_BROWSER_SETTINGS[key] as boolean);
  return {
    searchEngine: pick<BrowserSearchEngine>("searchEngine", SEARCH_ENGINES),
    downloadLocation: pick<BrowserDownloadLocation>("downloadLocation", DOWNLOAD_LOCATIONS),
    restoreTabs: flag("restoreTabs"),
    chromeCompatibleUserAgent: flag("chromeCompatibleUserAgent"),
    openChatLinksInBrowser: flag("openChatLinksInBrowser"),
    historyEnabled: flag("historyEnabled"),
    agentDownloads: pick<BrowserAgentPermission>("agentDownloads", AGENT_PERMISSIONS),
    agentUploads: pick<BrowserAgentPermission>("agentUploads", AGENT_PERMISSIONS),
    developerMode: flag("developerMode"),
    browserEngine: pick<BrowserEngine>("browserEngine", BROWSER_ENGINES),
  };
}

/** Full DevTools access tools: offered to the agent only in developer mode (Settings > Browser). */
export const DEVELOPER_MODE_BROWSER_TOOLS: ReadonlySet<string> = new Set([
  "browser_evaluate",
  "browser_storage",
  "browser_trace_start",
  "browser_trace_stop",
]);

export type BrowserDataType = "cookies" | "cache" | "storage" | "history";

export interface BrowserSitePermissionEntry {
  origin: string;
  permission: string;
  decision: "allow" | "block";
}
