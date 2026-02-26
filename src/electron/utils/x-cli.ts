/**
 * X/Twitter CLI helpers (bird)
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { XConnectionTestResult, XSettingsData } from "../../shared/types";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 20000;
const MAX_OUTPUT_BYTES = 1024 * 1024; // 1MB

function sanitizeTokenList(values?: string[]): string[] {
  if (!values || values.length === 0) return [];
  return values
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .filter((value) => /^[a-zA-Z0-9._-]+$/.test(value));
}

function parseJsonSafe(text: string): Any | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Try to parse from first JSON token
    const objIndex = trimmed.indexOf("{");
    const arrIndex = trimmed.indexOf("[");
    const startIndex =
      objIndex === -1 ? arrIndex : arrIndex === -1 ? objIndex : Math.min(objIndex, arrIndex);
    if (startIndex >= 0) {
      const sliced = trimmed.slice(startIndex);
      try {
        return JSON.parse(sliced);
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

function buildGlobalArgs(settings: XSettingsData, json: boolean): string[] {
  const args: string[] = [];

  if (settings.authMethod === "manual") {
    if (!settings.authToken || !settings.ct0) {
      throw new Error("Missing auth_token or ct0. Add them in Settings > X (Twitter).");
    }
    args.push("--auth-token", settings.authToken, "--ct0", settings.ct0);
  } else {
    const sources = sanitizeTokenList(settings.cookieSource);
    const cookieSources = sources.length > 0 ? sources : ["chrome"];
    for (const source of cookieSources) {
      args.push("--cookie-source", source);
    }
    if (settings.chromeProfile) {
      args.push("--chrome-profile", settings.chromeProfile);
    }
    if (settings.chromeProfileDir) {
      args.push("--chrome-profile-dir", settings.chromeProfileDir);
    }
    if (settings.firefoxProfile) {
      args.push("--firefox-profile", settings.firefoxProfile);
    }
  }

  if (settings.timeoutMs) {
    args.push("--timeout", String(settings.timeoutMs));
  }
  if (settings.cookieTimeoutMs) {
    args.push("--cookie-timeout", String(settings.cookieTimeoutMs));
  }
  if (settings.quoteDepth !== undefined) {
    args.push("--quote-depth", String(settings.quoteDepth));
  }
  if (json) {
    args.push("--json");
  }

  return args;
}

export interface XCommandResult {
  stdout: string;
  stderr: string;
  data?: Any;
}

export async function runBirdCommand(
  settings: XSettingsData,
  args: string[],
  options?: { json?: boolean; timeoutMs?: number },
): Promise<XCommandResult> {
  const useJson = options?.json !== false;
  const timeoutMs = options?.timeoutMs ?? settings.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const globalArgs = buildGlobalArgs(settings, useJson);
  const fullArgs = [...globalArgs, ...args];

  try {
    const { stdout, stderr } = await execFileAsync("bird", fullArgs, {
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
    });

    const outText = typeof stdout === "string" ? stdout.trim() : "";
    const errText = typeof stderr === "string" ? stderr.trim() : "";

    return {
      stdout: outText,
      stderr: errText,
      data: useJson ? parseJsonSafe(outText) : undefined,
    };
  } catch (error: Any) {
    const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
    const stdout = typeof error?.stdout === "string" ? error.stdout.trim() : "";
    const baseMessage = error?.message || "bird command failed";
    const detail = stderr || stdout;
    const combined = `${baseMessage}${detail ? `: ${detail}` : ""}`;

    if (useJson && /unknown option.*--json/i.test(combined)) {
      return runBirdCommand(settings, args, { ...options, json: false });
    }

    if (error?.code === "ENOENT") {
      throw new Error(
        "bird CLI not found. Install with: `brew install steipete/tap/bird` or `npm install -g @steipete/bird`",
      );
    }

    throw new Error(combined);
  }
}

export async function checkBirdInstalled(): Promise<{ installed: boolean; version?: string }> {
  try {
    const { stdout } = await execFileAsync("bird", ["--version"], {
      timeout: 5000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });
    const text = typeof stdout === "string" ? stdout.trim() : "";
    const version = text.split("\n")[0] || undefined;
    return { installed: true, version };
  } catch (error: Any) {
    if (error?.code === "ENOENT") {
      return { installed: false };
    }
    // If the binary exists but returns a non-zero exit code, treat it as installed.
    return { installed: true };
  }
}

function extractUsername(data: Any, stdout?: string): { username?: string; userId?: string } {
  if (data && typeof data === "object") {
    const username =
      data.username || data.screen_name || data.handle || data.user || data.userName || undefined;
    const userId = data.id || data.user_id || data.userId || undefined;
    if (username || userId) {
      return { username, userId };
    }
  }

  if (stdout) {
    const match = stdout.match(/@([A-Za-z0-9_]+)/);
    if (match) {
      return { username: match[1] };
    }
  }

  return {};
}

export async function testXConnection(settings: XSettingsData): Promise<XConnectionTestResult> {
  try {
    const result = await runBirdCommand(settings, ["whoami"], { json: true });
    const extracted = extractUsername(result.data, result.stdout);
    return {
      success: true,
      username: extracted.username,
      userId: extracted.userId,
    };
  } catch (error: Any) {
    return {
      success: false,
      error: error?.message || "Failed to connect to X",
    };
  }
}
