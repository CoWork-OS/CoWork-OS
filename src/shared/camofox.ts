/**
 * Camofox browser provider: the renderer-facing shapes. Camofox is a Firefox-based browser
 * server the user runs on this Mac; CoWork only drives it when the agent asks for
 * `browser_provider: "camofox"`. Its keys stay in the main process; the renderer only
 * learns whether one is stored.
 */

export const CAMOFOX_DEFAULT_SERVER_URL = "http://127.0.0.1:9377";
/** Loopback port of CoWork's network-policy proxy that Camofox must send its traffic through. */
export const CAMOFOX_DEFAULT_PROXY_PORT = 9378;

export interface CamofoxDisplaySettings {
  enabled: boolean;
  /** Camofox server base URL; loopback only. */
  serverUrl: string;
  proxyPort: number;
  /** Keep one Camofox identity per workspace (cookies and logins carry across tasks). */
  persistentIdentity: boolean;
  /** CAMOFOX_ACCESS_KEY is stored (sent as a bearer token on every request; required). */
  accessKeyConfigured: boolean;
  /** CAMOFOX_API_KEY is stored (sent only when loading saved cookies). */
  apiKeyConfigured: boolean;
}

/** Key fields: omitted keeps the stored key, `null` clears it. */
export interface CamofoxSettingsUpdate {
  enabled?: boolean;
  serverUrl?: string;
  proxyPort?: number;
  persistentIdentity?: boolean;
  accessKey?: string | null;
  apiKey?: string | null;
}

export interface CamofoxConnectionResult {
  /** The server answered /health. */
  reachable: boolean;
  /** The server's traffic provably goes through CoWork's policy proxy. */
  proxied?: boolean;
  error?: string;
  /** The command to start Camofox so it passes the check. */
  startCommand?: string;
}

/** User name Camofox sends to CoWork's policy proxy (PROXY_USERNAME). */
export const CAMOFOX_PROXY_USERNAME = "cowork";

/**
 * Camoufox's Firefox connects to 127.0.0.1 and localhost directly even with a proxy set, so
 * a page could reach services on this Mac around CoWork's policy proxy, and CoWork refuses
 * it. Camofox has no setting for Firefox prefs; this plugin, saved in the Camofox folder and
 * enabled in its camofox.config.json, turns the pref on at every browser launch.
 */
export const CAMOFOX_LOOPBACK_PLUGIN_NAME = "cowork-loopback";
export const CAMOFOX_LOOPBACK_PLUGIN_PATH = `plugins/${CAMOFOX_LOOPBACK_PLUGIN_NAME}/index.js`;
export const CAMOFOX_LOOPBACK_PLUGIN_CONFIG = `"${CAMOFOX_LOOPBACK_PLUGIN_NAME}": { "enabled": true }`;
export const CAMOFOX_LOOPBACK_PLUGIN_SOURCE = `// CoWork: send 127.0.0.1 and localhost through the configured proxy like every other address.
export function register(app, ctx) {
  ctx.events.on("browser:launching", ({ options }) => {
    options.firefoxUserPrefs = {
      ...options.firefoxUserPrefs,
      "network.proxy.allow_hijacking_localhost": true,
    };
  });
}
`;

/**
 * How to start Camofox so it listens on loopback only, requires the access key, and browses
 * through CoWork's proxy. The access key stays out of the UI; the user fills it in. The proxy
 * password is a placeholder unless the main process fills it in for "Copy start command".
 */
export function camofoxStartCommand(
  serverUrl: string,
  proxyPort: number,
  proxyPassword = "<proxy password>",
): string {
  let host = "127.0.0.1";
  let port = "9377";
  try {
    const parsed = new URL(serverUrl);
    host = parsed.hostname.replace(/^\[|\]$/g, "") || host;
    port = parsed.port || port;
  } catch {
    // Fall back to Camofox's defaults.
  }
  return (
    `CAMOFOX_BIND_HOST=${host} CAMOFOX_PORT=${port} CAMOFOX_ACCESS_KEY=<your access key> ` +
    `PROXY_HOST=127.0.0.1 PROXY_PORT=${proxyPort} PROXY_USERNAME=${CAMOFOX_PROXY_USERNAME} ` +
    `PROXY_PASSWORD=${proxyPassword} npm start`
  );
}
