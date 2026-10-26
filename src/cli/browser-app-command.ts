/**
 * `cowork web`: open the browser app served by the local CoWork host, print a one-use sign-in
 * link for another device, show who is signed in, or sign every browser out.
 */
import { spawn } from "node:child_process";

export const WEB_USAGE = "Usage: cowork web [open|link|status|sign-out] [--print] [--json]";

export const WEB_SUBCOMMANDS = ["open", "link", "status", "sign-out"] as const;
export type WebSubcommand = (typeof WEB_SUBCOMMANDS)[number];

export interface SignInLinkPayload {
  url: string;
  appUrl: string;
  expiresAt: number;
}

export interface BrowserAppStatusPayload {
  enabled: boolean;
  appUrl?: string;
  remote: boolean;
  signedInBrowsers: number;
}

export function isWebSubcommand(value: string): value is WebSubcommand {
  return (WEB_SUBCOMMANDS as readonly string[]).includes(value);
}

export function parseSignInLink(value: unknown): SignInLinkPayload {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  if (
    typeof record.url !== "string" ||
    typeof record.appUrl !== "string" ||
    typeof record.expiresAt !== "number"
  ) {
    throw new Error("The CoWork host did not return a sign-in link.");
  }
  return { url: record.url, appUrl: record.appUrl, expiresAt: record.expiresAt };
}

export function linkLifetime(expiresAt: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((expiresAt - now) / 1000));
  return `It works once, for the next ${seconds} seconds.`;
}

export function formatBrowserAppStatus(status: BrowserAppStatusPayload): string[] {
  if (!status.enabled) {
    return [
      "Browser app: off",
      "Turn it on in CoWork OS under Settings > Web Access > Full app in the browser.",
    ];
  }
  const browsers =
    status.signedInBrowsers === 1 ? "1 browser" : `${status.signedInBrowsers} browsers`;
  return [
    "Browser app: on",
    `Address: ${status.appUrl ?? "no listener is serving it yet"}`,
    `Reach: ${status.remote ? "this computer and other devices, through HTTPS" : "this computer only"}`,
    `Signed in: ${browsers}`,
  ];
}

type Spawn = typeof spawn;

/** AppleScript string literal for a URL (sign-in URLs never carry quotes, but be exact). */
function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function waitForExit(child: ReturnType<Spawn>): Promise<boolean> {
  return new Promise((resolve) => {
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
  });
}

/**
 * Opens a sign-in link in the default browser without putting it on a command line other local
 * accounts can read. macOS: the script goes to `osascript` on stdin and reaches the browser as
 * an Apple Event. Windows: other users cannot read a process's command line. Elsewhere the
 * opener's and the browser's command lines are world-readable, so this returns false and the
 * caller prints the link instead.
 */
export async function openSignInLinkPrivately(
  url: string,
  platform: NodeJS.Platform = process.platform,
  spawnProcess: Spawn = spawn,
): Promise<boolean> {
  if (platform === "darwin") {
    const child = spawnProcess("osascript", ["-"], { stdio: ["pipe", "ignore", "ignore"] });
    const exited = waitForExit(child);
    child.stdin?.end(`open location ${appleScriptString(url)}\n`);
    return exited;
  }
  if (platform === "win32") {
    const child = spawnProcess("rundll32", ["url.dll,FileProtocolHandler", url], {
      stdio: "ignore",
      windowsHide: true,
    });
    return waitForExit(child);
  }
  return false;
}
