/**
 * How the desktop app decides whether to serve the browser app, and where browsers reach it.
 *
 * Settings > Web Access turns the browser app on. `COWORK_WEB_ENABLED=1` still turns it on
 * without the setting (headless runs and QA scripts), and `COWORK_WEB_PUBLIC_ORIGIN` still
 * overrides the saved public address.
 */
import { isBrowserWebEnabled, webDeploymentFromEnv } from "../../host/services/browser-web-config";
import {
  parseCanonicalPublicOrigin,
  type WebDeploymentPolicy,
} from "../../host/web/WebApplication";
import type { WebAccessConfig } from "./types";

/**
 * A saved public address is for a proxy on this computer (Tailscale Serve, Caddy, nginx), so
 * only loopback peers may claim to be that proxy. Other topologies use the environment.
 */
export const LOCAL_PROXY_ADDRESSES = ["127.0.0.1", "::1"] as const;

export function isDesktopBrowserAppEnabled(
  config: Pick<WebAccessConfig, "browserApp">,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isBrowserWebEnabled(env) || config.browserApp === true;
}

export function desktopBrowserAppDeployment(
  config: Pick<WebAccessConfig, "publicOrigin">,
  env: NodeJS.ProcessEnv = process.env,
): WebDeploymentPolicy {
  if (env.COWORK_WEB_PUBLIC_ORIGIN?.trim()) return webDeploymentFromEnv(env);
  if (!config.publicOrigin) return { mode: "loopback" };
  return {
    mode: "https-proxy",
    publicOrigin: config.publicOrigin,
    trustedProxyAddresses: [...LOCAL_PROXY_ADDRESSES],
  };
}

/**
 * The canonical origin for a public address typed in Settings, or "" when it is blank.
 * Throws with a message for the Settings pane when it is not an HTTPS origin.
 */
export function normalizeBrowserAppPublicOrigin(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new Error("The public address must be text.");
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    // Typed addresses may differ in case or carry a trailing slash; the parts must still be an
    // origin, and the canonical form then has to pass the same check the host applies.
    const typed = new URL(trimmed);
    if (
      typed.username ||
      typed.password ||
      (typed.pathname !== "/" && typed.pathname !== "") ||
      typed.search ||
      typed.hash
    ) {
      throw new Error("not an origin");
    }
    return parseCanonicalPublicOrigin(typed.origin).origin;
  } catch {
    throw new Error("Use an https:// address with no path, such as https://my-mac.example.ts.net");
  }
}

/** Same as normalizeBrowserAppPublicOrigin, but drops an unusable stored value instead. */
export function storedBrowserAppPublicOrigin(value: unknown): string {
  try {
    return normalizeBrowserAppPublicOrigin(value);
  } catch {
    return "";
  }
}
