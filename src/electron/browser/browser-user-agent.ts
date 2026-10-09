/**
 * User agent for the in-app browser partitions.
 *
 * Electron's default user agent names Electron and the app, and some sites
 * (Google sign-in among them) refuse embedded browsers on that basis. The
 * workbench presents the user agent of the Chrome build Electron ships, in the
 * reduced form Chrome itself sends (major version only, fixed OS tokens).
 */

const PLATFORM_TOKENS: Record<string, string> = {
  darwin: "Macintosh; Intel Mac OS X 10_15_7",
  win32: "Windows NT 10.0; Win64; x64",
  linux: "X11; Linux x86_64",
};

export function buildChromeCompatibleUserAgent(
  platform: string = process.platform,
  chromeVersion: string = process.versions.chrome || "",
): string {
  const platformToken = PLATFORM_TOKENS[platform] || PLATFORM_TOKENS.linux;
  const major = /^(\d+)/.exec(String(chromeVersion || ""))?.[1] || "120";
  return (
    `Mozilla/5.0 (${platformToken}) AppleWebKit/537.36 (KHTML, like Gecko) ` +
    `Chrome/${major}.0.0.0 Safari/537.36`
  );
}

const userAgentSessions = new WeakSet<object>();

/** Apply the Chrome-compatible user agent to a browser partition once. */
export function applyBrowserUserAgent(electronSession: Any, enabled = true): void {
  if (!enabled || !electronSession || typeof electronSession.setUserAgent !== "function") return;
  if (userAgentSessions.has(electronSession)) return;
  userAgentSessions.add(electronSession);
  electronSession.setUserAgent(buildChromeCompatibleUserAgent());
}
