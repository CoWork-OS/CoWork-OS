/** Settings > Browser: preferences of the in-app browser. */

import type { ThemeMode } from "./types";

export type BrowserSearchEngine = "google" | "bing" | "duckduckgo" | "brave" | "kagi";
export type BrowserDownloadLocation = "system" | "workspace" | "ask";
export type BrowserAgentPermission = "ask" | "allow" | "block";
/** "webview": tabs are <webview> elements in the app window; "native": main-process WebContentsViews. */
export type BrowserEngine = "webview" | "native";
export type BrowserColorScheme = "light" | "dark";

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
  /** How CoWork identifies itself on requests it makes for you (web fetch, HTTP, navigation). */
  declaredAgent: DeclaredAgentSettings;
  /** null follows the app's light/dark theme until the user explicitly chooses one. */
  colorScheme: BrowserColorScheme | null;
}

/**
 * Declared agent identity (opt-in). When on, web_fetch and http_request send an honest
 * CoWork-OS user agent instead of a browser's, except to the listed domains, and when a key
 * directory origin is set every agent request over https carries a Web Bot Auth signature.
 */
/** The public key directory to host, why it cannot be shown, or null when there is no key. */
export type AgentIdentityDirectoryResult =
  | { keyid: string; directory: string }
  | { error: string }
  | null;

export interface DeclaredAgentSettings {
  enabled: boolean;
  /** https origin serving /.well-known/http-message-signatures-directory; "" when not set. */
  signatureAgent: string;
  /** Domains (and their subdomains) that still get the browser-compatible user agent. */
  compatibleUserAgentDomains: string[];
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
  browserEngine: "native",
  declaredAgent: { enabled: false, signatureAgent: "", compatibleUserAgentDomains: [] },
  colorScheme: null,
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
    declaredAgent: normalizeDeclaredAgentSettings(input.declaredAgent),
    colorScheme:
      input.colorScheme === "light" || input.colorScheme === "dark" ? input.colorScheme : null,
  };
}

/**
 * The color scheme browser pages get: the user's browser choice, else the app's own theme.
 * null (the app on "system") needs no override, since pages already follow the OS like the app.
 */
export function resolveBrowserColorScheme(
  choice: BrowserColorScheme | null,
  appThemeMode: ThemeMode,
): BrowserColorScheme | null {
  if (choice) return choice;
  return appThemeMode === "light" || appThemeMode === "dark" ? appThemeMode : null;
}

const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** An https origin (no path, query or credentials), or "" when the value is not one. */
export function normalizeHttpsOrigin(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password) return "";
    if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) return "";
    // Sites fetch the directory from here: a public DNS name, never localhost or an IP literal.
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost") || !DOMAIN_PATTERN.test(host)) {
      return "";
    }
    return url.origin;
  } catch {
    return "";
  }
}

export function normalizeDeclaredAgentSettings(value: unknown): DeclaredAgentSettings {
  const input = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const domains = Array.isArray(input.compatibleUserAgentDomains)
    ? input.compatibleUserAgentDomains
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim().toLowerCase().replace(/^\*\./, ""))
        .filter((entry) => DOMAIN_PATTERN.test(entry))
    : [];
  return {
    enabled: input.enabled === true,
    signatureAgent: normalizeHttpsOrigin(input.signatureAgent),
    compatibleUserAgentDomains: [...new Set(domains)].slice(0, 100),
  };
}

/** Whether a host is one of the domains (or a subdomain of one). */
export function hostMatchesDomains(host: string, domains: readonly string[]): boolean {
  const normalized = host.toLowerCase().replace(/\.$/, "");
  return domains.some((domain) => normalized === domain || normalized.endsWith(`.${domain}`));
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
