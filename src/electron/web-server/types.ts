/**
 * Web Access types — hosted mode for browser-based access.
 */

export interface WebAccessConfig {
  enabled: boolean;
  port: number;
  host: string;
  token: string;
  allowedOrigins: string[];
  /** Serve the full desktop app to browsers at `/app/`, behind one-use sign-in links. */
  browserApp: boolean;
  /**
   * HTTPS origin of a proxy on this computer (such as Tailscale Serve) that forwards to this
   * listener, so browsers on other devices can sign in. Empty keeps the app on this computer.
   */
  publicOrigin: string;
}

export const DEFAULT_WEB_ACCESS_CONFIG: WebAccessConfig = {
  enabled: false,
  port: 3847,
  host: "127.0.0.1",
  token: "",
  allowedOrigins: ["http://localhost:3847"],
  browserApp: false,
  publicOrigin: "",
};

export interface WebAccessRoute {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  ipcChannel: string;
  extractParams?: (req: Any) => Any;
}

export interface WebAccessStatus {
  running: boolean;
  browserApplication: boolean;
  /** Browsers signed in to the browser app, on every listener. */
  signedInBrowsers?: number;
  /** The browser app's address when a listener serves it. */
  browserAppUrl?: string;
  /** Why the browser app could not start with the saved settings, if it could not. */
  browserAppError?: string;
  url?: string;
  port?: number;
  connectedClients: number;
  startedAt?: number;
}
