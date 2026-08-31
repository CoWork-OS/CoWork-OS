import { normalizeBrowserUrl } from "../../browser/browser-session-manager";

type AnyRecord = Record<string, unknown>;

export interface BrowserUseDomainApprovalDetails {
  kind: "browser_use_domain_access";
  tool: string;
  params: unknown;
  url: string;
  origin: string;
  domain: string;
  permissionInput: {
    url: string;
  };
  browserSessionId?: string;
}

interface BrowserUseApprovalTargetArgs {
  toolName: string;
  input?: unknown;
  currentUrl?: string | null;
}

function asRecord(value: unknown): AnyRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as AnyRecord) : {};
}

function readString(value: unknown, key: string): string {
  const raw = asRecord(value)[key];
  return typeof raw === "string" ? raw.trim() : "";
}

function parseHttpTarget(rawUrl: unknown): { url: string; origin: string; domain: string } | null {
  const normalizedUrl = normalizeBrowserUrl(rawUrl);
  if (!normalizedUrl) return null;
  try {
    const parsed = new URL(normalizedUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return {
      url: normalizedUrl,
      origin: parsed.origin,
      domain: parsed.hostname.toLowerCase(),
    };
  } catch {
    return null;
  }
}

const UNKNOWN_TARGET_NAVIGATION_TOOLS = new Set(["browser_back", "browser_forward"]);

export function isBrowserUseToolName(toolName: string): boolean {
  return String(toolName || "")
    .trim()
    .toLowerCase()
    .startsWith("browser_");
}

export function resolveBrowserUseApprovalTarget({
  toolName,
  input,
  currentUrl,
}: BrowserUseApprovalTargetArgs): { url: string; origin: string; domain: string } | null {
  const normalizedToolName = String(toolName || "")
    .trim()
    .toLowerCase();
  if (!isBrowserUseToolName(normalizedToolName)) return null;
  if (normalizedToolName === "browser_navigate") {
    return parseHttpTarget(readString(input, "url"));
  }
  if (UNKNOWN_TARGET_NAVIGATION_TOOLS.has(normalizedToolName)) {
    return null;
  }
  return parseHttpTarget(currentUrl || "");
}

export function buildBrowserUseDomainApprovalDetails(
  args: BrowserUseApprovalTargetArgs,
): BrowserUseDomainApprovalDetails | null {
  const target = resolveBrowserUseApprovalTarget(args);
  if (!target) return null;
  const sessionId = readString(args.input, "session_id");
  return {
    kind: "browser_use_domain_access",
    tool: args.toolName,
    params: args.input ?? null,
    url: target.url,
    origin: target.origin,
    domain: target.domain,
    permissionInput: {
      url: target.url,
    },
    ...(sessionId ? { browserSessionId: sessionId } : {}),
  };
}
