import type { HostCapabilityName } from "../../shared/host-api/contracts";

export const BROWSER_HOST_UNSUPPORTED_ACTION_EVENT = "cowork-browser-unsupported-action";

/** The renderer runs in a browser session against a host, not in the desktop app. */
export function isBrowserHost(): boolean {
  return typeof window !== "undefined" && window.coworkBrowserHost === true;
}

/** Native desktop always has its preload; a browser exposes the host's reviewed methods. */
export function hasHostMethod(method: string): boolean {
  if (typeof window === "undefined" || window.coworkBrowserHost !== true) return true;
  return Object.prototype.hasOwnProperty.call(
    window.coworkBrowserHostInfo?.desktopMethods ?? {},
    method,
  );
}

export function hasHostMethods(...methods: string[]): boolean {
  return methods.every(hasHostMethod);
}

/** Host capabilities describe whole workflows whose APIs may span several methods. */
export function hasHostCapability(capability: HostCapabilityName): boolean {
  if (typeof window === "undefined" || window.coworkBrowserHost !== true) return true;
  return window.coworkBrowserHostInfo?.capabilities?.[capability]?.available === true;
}

export function getHostCapabilityReason(capability: HostCapabilityName): string | undefined {
  if (typeof window === "undefined" || window.coworkBrowserHost !== true) return undefined;
  const status = window.coworkBrowserHostInfo?.capabilities?.[capability];
  if (status?.available === false) return status.reason;
  if (status?.available === true) return undefined;
  return "This workflow is not available in this browser session.";
}
