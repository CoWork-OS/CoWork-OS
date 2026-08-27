import { SecureSettingsRepository } from "../../database/SecureSettingsRepository";

type FetchLike = typeof fetch;

type BrowserUseCloudClientOptions = {
  baseUrl?: string;
  fetchImpl?: FetchLike;
  sleep?: (delayMs: number) => Promise<void>;
  maxRetries?: number;
};

export interface BrowserUseCloudSettings {
  enabled?: boolean;
  apiKey?: string;
  defaultProxyCountryCode?: string | null;
  defaultTimeoutMinutes?: number;
  defaultProfileId?: string;
  defaultEnableRecording?: boolean;
}

export interface BrowserUseCreateBrowserInput {
  profileId?: string | null;
  proxyCountryCode?: string | null;
  timeout?: number;
  browserScreenWidth?: number;
  browserScreenHeight?: number;
  allowResizing?: boolean;
  enableRecording?: boolean;
}

export interface BrowserUseBrowserSession {
  id: string;
  status?: string;
  timeoutAt?: string;
  startedAt?: string;
  liveUrl?: string | null;
  cdpUrl?: string | null;
  finishedAt?: string | null;
  proxyUsedMb?: string;
  proxyCost?: string;
  browserCost?: string;
  recordingUrl?: string | null;
}

export class BrowserUseApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "BrowserUseApiError";
  }
}

export class BrowserUseCloudClient {
  constructor(
    private readonly apiKey: string,
    private readonly options: BrowserUseCloudClientOptions = {},
  ) {}

  static loadSettings(): BrowserUseCloudSettings {
    if (!SecureSettingsRepository.isInitialized()) return {};
    try {
      const repository = SecureSettingsRepository.getInstance();
      return repository.load<BrowserUseCloudSettings>("browser-use") || {};
    } catch {
      return {};
    }
  }

  static resolveApiKey(settings: BrowserUseCloudSettings = BrowserUseCloudClient.loadSettings()): string {
    const envApiKey = normalizeString(process.env.BROWSER_USE_API_KEY);
    if (envApiKey) return envApiKey;
    if (settings.enabled === false) return "";
    return normalizeString(settings.apiKey);
  }

  static fromEnvironmentOrSettings(): BrowserUseCloudClient | null {
    const apiKey = BrowserUseCloudClient.resolveApiKey();
    return apiKey ? new BrowserUseCloudClient(apiKey) : null;
  }

  async createBrowserSession(input: BrowserUseCreateBrowserInput): Promise<BrowserUseBrowserSession> {
    const session = await this.request<BrowserUseBrowserSession>("/browsers", {
      method: "POST",
      body: JSON.stringify(stripUndefined(input)),
    });
    if (!session.id) {
      throw new Error("Browser Use did not return a browser session id");
    }
    return session;
  }

  async stopBrowserSession(sessionId: string): Promise<BrowserUseBrowserSession> {
    const normalized = normalizeString(sessionId);
    if (!normalized) throw new Error("Browser Use session id is required");
    return await this.request<BrowserUseBrowserSession>(`/browsers/${encodeURIComponent(normalized)}`, {
      method: "PATCH",
      body: JSON.stringify({ action: "stop" }),
    });
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const fetchImpl = this.options.fetchImpl || fetch;
    const baseUrl = (this.options.baseUrl || "https://api.browser-use.com/api/v4").replace(/\/$/, "");
    const maxAttempts = Math.max(1, Math.min(5, Math.round(this.options.maxRetries ?? 3)));
    const sleep =
      this.options.sleep || ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          "X-Browser-Use-API-Key": this.apiKey,
          ...(init.headers || {}),
        },
      });
      if (response.ok) return (await response.json()) as T;

      const retryable = isRetryableBrowserUseStatus(response.status);
      const retryAfterMs = parseRetryAfterMs(response.headers);
      const requestMethod = (init.method || "GET").toUpperCase();
      const safeToReplay = requestMethod !== "POST" || response.status === 429;
      if (!retryable || !safeToReplay || attempt >= maxAttempts - 1) {
        let details = "";
        try {
          details = await response.text();
        } catch {
          details = "";
        }
        const redactedDetails = redactBrowserUseErrorText(details);
        throw new BrowserUseApiError(
          `Browser Use API request failed with HTTP ${response.status}${redactedDetails ? `: ${redactedDetails.slice(0, 500)}` : ""}`,
          response.status,
          retryable,
          retryAfterMs,
        );
      }

      const exponentialBackoffMs = 250 * 2 ** attempt;
      const delayMs = Math.min(60_000, Math.max(retryAfterMs || 0, exponentialBackoffMs));
      await sleep(delayMs);
    }

    throw new Error("Browser Use API request exhausted its retry budget");
  }
}

export function isRetryableBrowserUseStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function parseRetryAfterMs(headers: Pick<Headers, "get">, now = Date.now()): number | undefined {
  const retryAfter = headers.get("retry-after")?.trim();
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(60_000, Math.ceil(seconds * 1000));
    const timestamp = Date.parse(retryAfter);
    if (Number.isFinite(timestamp)) return Math.min(60_000, Math.max(0, timestamp - now));
  }

  const reset = headers.get("x-ratelimit-reset")?.trim();
  const resetSeconds = reset ? Number(reset) : NaN;
  if (Number.isFinite(resetSeconds) && resetSeconds >= 0) {
    const resetAtMs =
      resetSeconds >= 100_000_000_000
        ? resetSeconds
        : resetSeconds > now / 1000
          ? resetSeconds * 1000
          : now + resetSeconds * 1000;
    return Math.min(60_000, Math.max(0, Math.ceil(resetAtMs - now)));
  }
  return undefined;
}

export function normalizeBrowserUseProxyCountryCode(value: unknown): string | null | undefined {
  if (value === null) return null;
  const normalized = normalizeString(value).toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "none" || normalized === "off" || normalized === "disabled") return null;
  if (!/^[a-z]{2}$/.test(normalized)) {
    throw new Error("proxy_country_code must be a two-letter country code, or 'none' to disable proxy");
  }
  return normalized;
}

export function normalizeBrowserUseTimeoutMinutes(value: unknown, fallback?: number): number | undefined {
  const raw = typeof value === "number" ? value : fallback;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  return Math.max(1, Math.min(240, Math.round(raw)));
}

export function isPrivateOrLocalBrowserTarget(rawUrl: unknown): boolean {
  const value = normalizeString(rawUrl);
  if (!value) return false;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return true;
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (host === "localhost" || host.endsWith(".localhost")) return true;
    if (host.endsWith(".local") || host.endsWith(".internal")) return true;
    if (!host.includes(".") && !host.includes(":")) return true;
    if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
    if (host.includes(":")) {
      if (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:")) return true;
      if (host.startsWith("::ffff:127.") || host.startsWith("::ffff:10.")) return true;
      if (host.startsWith("::ffff:192.168.")) return true;
      const mapped172 = host.match(/^::ffff:172\.(\d+)\./);
      if (mapped172 && Number(mapped172[1]) >= 16 && Number(mapped172[1]) <= 31) return true;
    }
    if (/^127\./.test(host) || /^10\./.test(host) || /^0\./.test(host)) return true;
    if (/^192\.168\./.test(host)) return true;
    const parts = host.split(".").map((part) => Number(part));
    if (parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
      if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
      if (parts[0] === 169 && parts[1] === 254) return true;
    }
  } catch {
    return false;
  }
  return false;
}

export function redactBrowserUseUrl(value: unknown): string {
  const text = normalizeString(value);
  if (!text) return "";
  return text.replace(/([?&](?:apiKey|key|token|wss)=)[^&#\s]+/gi, "$1[REDACTED]");
}

export function redactBrowserUseErrorText(value: unknown): string {
  const text = redactBrowserUseUrl(value);
  if (!text) return "";
  return text
    .replace(/\bbearer\s+[a-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(
      /("(?:api[_-]?key|apikey|token|authorization|x-browser-use-api-key)"\s*:\s*")([^"]+)(")/gi,
      "$1[REDACTED]$3",
    )
    .replace(
      /\b(api[_-]?key|apikey|token|authorization|x-browser-use-api-key)\s*[=:]\s*([^\s"';&]+)/gi,
      "$1=[REDACTED]",
    );
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stripUndefined<T extends object>(input: T): Partial<T> {
  const output: Partial<T> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) output[key as keyof T] = value as T[keyof T];
  }
  return output;
}
