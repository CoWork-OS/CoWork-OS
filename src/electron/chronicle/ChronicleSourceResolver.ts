import { execFile as execFileCallback } from "child_process";
import { promisify } from "util";
import type { ChronicleSourceReference } from "./types";

const execFileAsync = promisify(execFileCallback);

export interface ChronicleFrontmostContext {
  appName: string;
  bundleId: string;
  windowTitle: string;
  /** Unix process id of the frontmost app, when the platform reports it. */
  pid?: number;
  sourceRef?: ChronicleSourceReference | null;
}

function escapeAppleScriptString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function runAppleScript(lines: string[]): Promise<string> {
  const args = lines.flatMap((line) => ["-e", line]);
  const { stdout } = await execFileAsync("osascript", args, {
    encoding: "utf8",
    timeout: 4_000,
    maxBuffer: 512 * 1024,
  });
  return String(stdout || "").trim();
}

async function resolveFrontmostApp(): Promise<{
  appName: string;
  bundleId: string;
  windowTitle: string;
  pid?: number;
}> {
  if (process.platform !== "darwin") {
    return { appName: "Desktop", bundleId: "", windowTitle: "Screen" };
  }
  const output = await runAppleScript([
    'tell application "System Events"',
    "set frontProc to first process whose frontmost is true",
    "set appName to name of frontProc",
    "set bundleId to bundle identifier of frontProc",
    'set windowTitle to ""',
    "try",
    "set windowTitle to name of front window of frontProc",
    "end try",
    "set procId to unix id of frontProc",
    "return appName & linefeed & bundleId & linefeed & windowTitle & linefeed & procId",
    "end tell",
  ]);
  const [appName = "Desktop", bundleId = "", windowTitle = "Screen", procId = ""] =
    output.split(/\r?\n/);
  const pid = Number.parseInt(procId.trim(), 10);
  return {
    appName: appName.trim() || "Desktop",
    bundleId: bundleId.trim(),
    windowTitle: windowTitle.trim() || "Screen",
    ...(Number.isInteger(pid) && pid > 0 ? { pid } : {}),
  };
}

async function resolveBrowserSource(appName: string): Promise<ChronicleSourceReference | null> {
  const safeName = escapeAppleScriptString(appName);
  if (/^safari$/i.test(appName)) {
    const output = await runAppleScript([
      `tell application "${safeName}"`,
      'if (count of windows) is 0 then return ""',
      "set tabUrl to URL of current tab of front window",
      "set tabTitle to name of current tab of front window",
      "return tabUrl & linefeed & tabTitle",
      "end tell",
    ]).catch(() => "");
    const [url = "", title = ""] = output.split(/\r?\n/);
    return url.trim() ? { kind: "url", value: url.trim(), label: title.trim() || undefined } : null;
  }
  if (
    /^(google chrome|google chrome beta|google chrome canary|brave browser|arc|microsoft edge)$/i.test(
      appName,
    )
  ) {
    const output = await runAppleScript([
      `tell application "${safeName}"`,
      'if (count of windows) is 0 then return ""',
      "set tabUrl to URL of active tab of front window",
      "set tabTitle to title of active tab of front window",
      "return tabUrl & linefeed & tabTitle",
      "end tell",
    ]).catch(() => "");
    const [url = "", title = ""] = output.split(/\r?\n/);
    return url.trim() ? { kind: "url", value: url.trim(), label: title.trim() || undefined } : null;
  }
  return null;
}

async function resolveFinderSource(): Promise<ChronicleSourceReference | null> {
  const output = await runAppleScript([
    'tell application "Finder"',
    'if (count of windows) is 0 then return ""',
    "set targetAlias to (target of front window) as alias",
    "return POSIX path of targetAlias",
    "end tell",
  ]).catch(() => "");
  const targetPath = output.trim();
  return targetPath ? { kind: "file", value: targetPath, label: targetPath } : null;
}

export class ChronicleSourceResolver {
  static async resolveFrontmostContext(): Promise<ChronicleFrontmostContext> {
    const base = await resolveFrontmostApp().catch(() => ({
      appName: "Desktop",
      bundleId: "",
      windowTitle: "Screen",
    }));
    const appName = base.appName || "Desktop";
    const sourceRef =
      (await resolveBrowserSource(appName).catch(() => null)) ||
      (appName === "Finder" ? await resolveFinderSource().catch(() => null) : null) ||
      (appName
        ? {
            kind: "app" as const,
            value: base.bundleId || appName,
            label: appName,
          }
        : null);
    return { ...base, sourceRef };
  }
}
