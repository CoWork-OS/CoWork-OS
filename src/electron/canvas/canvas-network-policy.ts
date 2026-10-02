import type { Workspace } from "../../shared/types";
import { evaluateNetworkPolicy } from "../security/network-policy";

/** Resolve the owning task's live policy for every request, including restored windows. */
export function isCanvasRequestAllowed(
  sessionId: string,
  url: string,
  workspace: Workspace | undefined,
  approvedOrigins: ReadonlySet<string> = new Set(),
): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "canvas:") return parsed.hostname === sessionId;
    if (["about:", "data:", "blob:"].includes(parsed.protocol)) return true;
    // WebSockets follow the same policy as their HTTP(S) counterpart origin.
    if (parsed.protocol === "ws:") parsed.protocol = "http:";
    else if (parsed.protocol === "wss:") parsed.protocol = "https:";
    if (!workspace || !["http:", "https:"].includes(parsed.protocol)) return false;
    if (
      workspace.permissions?.accessNetworkMode === "on-request" &&
      !approvedOrigins.has(parsed.origin)
    )
      return false;
    return (
      evaluateNetworkPolicy({
        url: parsed.toString(),
        toolName: "canvas_open_url",
        networkEnabled: workspace.permissions?.network,
        accessNetworkMode: workspace.permissions?.accessNetworkMode,
        profileDomainRules: workspace.permissions?.accessDomainRules,
      }).action === "allow"
    );
  } catch {
    return false;
  }
}

export function installCanvasNetworkGuards(
  sessionId: string,
  contents: import("electron").WebContents,
  resolveWorkspace: () => Workspace | undefined,
  approvedOrigins: (workspace: Workspace | undefined) => ReadonlySet<string> = () => new Set(),
): void {
  const allowed = (url: string) => {
    try {
      const workspace = resolveWorkspace();
      return isCanvasRequestAllowed(sessionId, url, workspace, approvedOrigins(workspace));
    } catch {
      return false;
    }
  };
  contents.session.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
    callback({ cancel: !allowed(details.url) });
  });
  contents.on("will-navigate", (event, url) => {
    if (!allowed(url)) event.preventDefault();
  });
  contents.on("will-redirect", (event, url) => {
    if (!allowed(url)) event.preventDefault();
  });
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
}
