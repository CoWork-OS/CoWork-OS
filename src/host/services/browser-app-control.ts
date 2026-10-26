/**
 * Operator controls for the browser app: one-use sign-in links, status, and signing every
 * browser out. The desktop app and the headless daemon share them, through the Settings pane,
 * IPC, and admin-scope Control Plane methods that `cowork web` calls.
 */
import { Methods } from "../../electron/control-plane/protocol";
import { buildBrowserAppSignInUrl, browserAppUrl } from "../../shared/browser-app-link";
import type { PairingCode, WebApplication } from "../web/WebApplication";

/** A listener serving the browser app and the address browsers reach it at. */
export interface BrowserAppListener {
  /** Origin a browser opens, such as `http://127.0.0.1:3847` or the HTTPS proxy's origin. */
  origin: string;
  /** Mount audience; sign-in codes and sessions are bound to it. */
  audience: string;
}

export interface BrowserAppAccess {
  /** The browser application, or null while it is turned off on this host. */
  getApplication(): WebApplication | null;
  /** The listener a new sign-in link should point at, or null when none serves the app. */
  resolveListener(): BrowserAppListener | null;
  /** Says how to turn the browser app on, for this host's kind. */
  offMessage: string;
  /** Says how to get a listener running, when the app is on but none serves it. */
  noListenerMessage: string;
}

export interface BrowserAppSignInLink {
  /** Opens the app and signs this browser in. Works once, until `expiresAt`. */
  url: string;
  /** The app's plain address, safe to show and share. */
  appUrl: string;
  expiresAt: number;
}

export interface BrowserAppStatus {
  enabled: boolean;
  /** The app's plain address when a listener serves it. */
  appUrl?: string;
  /** True when browsers reach the app through an HTTPS proxy, from other devices too. */
  remote: boolean;
  signedInBrowsers: number;
}

function enabledApplication(access: BrowserAppAccess): WebApplication {
  const application = access.getApplication();
  if (!application?.enabled) throw new Error(access.offMessage);
  return application;
}

function servingListener(
  access: BrowserAppAccess,
  application: WebApplication,
): BrowserAppListener | null {
  const listener = access.resolveListener();
  return listener && application.isMounted(listener.audience) ? listener : null;
}

export function createBrowserAppSignInLink(access: BrowserAppAccess): BrowserAppSignInLink {
  const application = enabledApplication(access);
  const listener = servingListener(access, application);
  if (!listener) throw new Error(access.noListenerMessage);
  const { code, expiresAt } = application.createPairingCode(listener.audience);
  return {
    url: buildBrowserAppSignInUrl(listener.origin, code),
    appUrl: browserAppUrl(listener.origin),
    expiresAt,
  };
}

export function getBrowserAppStatus(access: BrowserAppAccess): BrowserAppStatus {
  const application = access.getApplication();
  if (!application?.enabled) return { enabled: false, remote: false, signedInBrowsers: 0 };
  const listener = servingListener(access, application);
  return {
    enabled: true,
    ...(listener ? { appUrl: browserAppUrl(listener.origin) } : {}),
    remote: application.getPublicOrigin() !== null,
    signedInBrowsers: application.countSessions(),
  };
}

/** Ends every browser session on every listener; open sockets and terminals close with them. */
export function signOutBrowserApp(access: BrowserAppAccess): { signedOut: number } {
  const application = access.getApplication();
  if (!application?.enabled) return { signedOut: 0 };
  return { signedOut: application.revokeSessions() };
}

interface AdminScopedClient {
  hasScope(scope: string): boolean;
}

interface MethodRegistry {
  registerMethod(
    method: string,
    handler: (client: AdminScopedClient, params?: unknown) => Promise<unknown>,
  ): void;
}

function requireAdmin(client: AdminScopedClient): void {
  if (!client.hasScope("admin")) throw new Error("Admin scope is required.");
}

/**
 * Registers the browser app methods on a Control Plane server. They stay registered while the
 * app is off and answer with how to turn it on, so `cowork web` can say what to do.
 */
export function registerBrowserAppControlMethods(
  server: MethodRegistry,
  access: BrowserAppAccess,
): void {
  // Kept for scripts written against the preview: a bare code for this Control Plane listener.
  server.registerMethod(Methods.WEB_PAIR, async (client): Promise<PairingCode> => {
    requireAdmin(client);
    return enabledApplication(access).createPairingCode("control-plane");
  });
  server.registerMethod(Methods.WEB_SIGN_IN_LINK, async (client) => {
    requireAdmin(client);
    return createBrowserAppSignInLink(access);
  });
  server.registerMethod(Methods.WEB_STATUS, async (client) => {
    requireAdmin(client);
    return getBrowserAppStatus(access);
  });
  server.registerMethod(Methods.WEB_SIGN_OUT, async (client) => {
    requireAdmin(client);
    return signOutBrowserApp(access);
  });
}

/** `http://host:port` for a loopback listener; IPv6 hosts get brackets. */
export function loopbackListenerOrigin(host: string, port: number): string {
  const bare = host.replace(/^\[|\]$/g, "");
  return `http://${bare.includes(":") ? `[${bare}]` : bare}:${port}`;
}
