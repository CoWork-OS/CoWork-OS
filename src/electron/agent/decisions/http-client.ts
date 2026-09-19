import type { DecisionRequestOptions } from "./types";

export type DecisionErrorCode =
  | "configuration"
  | "validation"
  | "authentication"
  | "request"
  | "response"
  | "aborted"
  | "timeout"
  | "transport";

export class DecisionClientError extends Error {
  readonly code: DecisionErrorCode;
  readonly provider: string;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(
    code: DecisionErrorCode,
    message: string,
    options: {
      provider: string;
      status?: number;
      retryable?: boolean;
    },
  ) {
    super(message);
    this.name = "DecisionClientError";
    this.code = code;
    this.provider = options.provider;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
  }
}

// Keep the fetch contract usable by the Node-only CLI build, which does not
// include the DOM lib's RequestInfo alias even though Node exposes fetch.
export type DecisionFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type DecisionSleep = (delayMs: number, signal?: AbortSignal) => Promise<void>;

export interface DecisionHttpClientOptions {
  apiKey: string;
  endpoint: string;
  providerName: string;
  fetch?: DecisionFetch;
  fetchImpl?: DecisionFetch;
  timeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
  sleep?: DecisionSleep;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 250;
const DEFAULT_MAX_RETRY_DELAY_MS = 5_000;
const MAX_RESPONSE_BYTES = 1_048_576;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function statusFor(response: Response): number {
  return typeof response.status === "number" ? response.status : 0;
}

function isSuccessful(response: Response): boolean {
  if (typeof response.ok === "boolean") return response.ok;
  const status = statusFor(response);
  return status >= 200 && status < 300;
}

function validatePositiveNumber(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number.`);
  }
}

function validateNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
}

/** Normalize the common forms users paste into provider settings. */
export function normalizeDecisionApiKey(value: string): string {
  let normalized = value.trim();
  normalized = normalized.replace(/^['"]|['"]$/g, "").trim();
  normalized = normalized
    .replace(/^(?:export\s+)?(?:OPENROUTER|TYPESAFE|JEV)_API_KEY\s*[:=]\s*/i, "")
    .trim();
  normalized = normalized.replace(/^['"]|['"]$/g, "").trim();
  normalized = normalized.replace(/^Bearer\s+/i, "").trim();
  normalized = normalized.replace(/^['"]|['"]$/g, "").trim();
  return normalized;
}

function redactDetail(value: string, secret?: string): string {
  const redacted = value
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(
      /((?:api[_ -]?key|token|secret|authorization)\s*[:=]\s*)["']?[^"'\s,;]+/gi,
      "$1[redacted]",
    )
    .replace(/\bsk(?:-or-v1)?-[a-z0-9_-]{8,}\b/gi, "[redacted]");
  return (secret ? redacted.split(secret).join("[redacted]") : redacted).trim().slice(0, 240);
}

function errorDetail(body: unknown, secret?: string): string | undefined {
  if (!isRecord(body)) return undefined;

  const error = body.error;
  if (typeof error === "string") return redactDetail(error, secret);
  if (isRecord(error) && typeof error.message === "string") {
    return redactDetail(error.message, secret);
  }
  if (typeof body.message === "string") return redactDetail(body.message, secret);
  if (typeof body.detail === "string") return redactDetail(body.detail, secret);
  return undefined;
}

function sleepWithAbort(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs <= 0) {
    if (signal?.aborted) return Promise.reject(new Error("aborted"));
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function isRetryableDecisionStatus(status: number): boolean {
  return status === 429 || status === 529 || (status >= 500 && status <= 599);
}

/** Small fetch-based transport with bounded transient retries and no request logging. */
export class DecisionHttpClient {
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly providerName: string;
  private readonly fetchImpl: DecisionFetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly sleep: DecisionSleep;

  constructor(options: DecisionHttpClientOptions) {
    const apiKey = normalizeDecisionApiKey(options.apiKey);
    const endpoint = options.endpoint.trim();
    const providerName = options.providerName.trim();
    if (!apiKey) {
      throw new DecisionClientError(
        "configuration",
        `${providerName || "Decision"} API key is required. Configure an API key before making a decision request.`,
        { provider: providerName || "Decision" },
      );
    }
    if (!endpoint) {
      throw new DecisionClientError(
        "configuration",
        `${providerName || "Decision"} endpoint is required.`,
        { provider: providerName || "Decision" },
      );
    }
    try {
      const parsedEndpoint = new URL(endpoint);
      if (parsedEndpoint.protocol !== "https:") {
        throw new Error("endpoint must use HTTPS");
      }
    } catch (error) {
      if (error instanceof DecisionClientError) throw error;
      throw new DecisionClientError(
        "configuration",
        `${providerName || "Decision"} endpoint must be a valid HTTPS URL.`,
        { provider: providerName || "Decision" },
      );
    }
    if (!providerName) {
      throw new DecisionClientError("configuration", "Decision provider name is required.", {
        provider: "Decision",
      });
    }

    this.apiKey = apiKey;
    this.endpoint = endpoint;
    this.providerName = providerName;
    this.fetchImpl = options.fetchImpl ?? options.fetch ?? globalThis.fetch;
    if (typeof this.fetchImpl !== "function") {
      throw new DecisionClientError(
        "configuration",
        `${providerName} requires a fetch implementation in this runtime.`,
        { provider: providerName },
      );
    }

    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
    validatePositiveNumber("timeoutMs", this.timeoutMs);
    validateNonNegativeInteger("maxRetries", this.maxRetries);
    validateNonNegativeInteger("retryDelayMs", this.retryDelayMs);
    validatePositiveNumber("maxRetryDelayMs", this.maxRetryDelayMs);
    this.sleep = options.sleep ?? sleepWithAbort;
  }

  async post<T>(body: unknown, options: DecisionRequestOptions = {}): Promise<T> {
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const maxRetries = options.maxRetries ?? this.maxRetries;
    const retryDelayMs = options.retryDelayMs ?? this.retryDelayMs;
    validatePositiveNumber("timeoutMs", timeoutMs);
    validateNonNegativeInteger("maxRetries", maxRetries);
    validateNonNegativeInteger("retryDelayMs", retryDelayMs);
    if (options.signal?.aborted) throw this.abortedError();

    let serializedBody: string;
    try {
      serializedBody = JSON.stringify(body);
    } catch {
      throw new DecisionClientError(
        "validation",
        `${this.providerName} request contains unsupported non-JSON content. Use text or JSON-compatible state and questions.`,
        { provider: this.providerName },
      );
    }

    for (let attempt = 0; ; attempt += 1) {
      const attemptResult = await this.fetchAttempt(serializedBody, timeoutMs, options.signal);
      const { response, body: bodyData } = attemptResult;
      const status = statusFor(response);
      const ok = isSuccessful(response);

      if (ok) {
        if (bodyData === undefined) {
          throw new DecisionClientError(
            "response",
            `${this.providerName} returned an empty or malformed JSON response. Retry the request; if it persists, contact the provider.`,
            { provider: this.providerName },
          );
        }
        return bodyData as T;
      }

      const retryable = isRetryableDecisionStatus(status);
      if (retryable && attempt < maxRetries) {
        const delayMs = Math.min(retryDelayMs * 2 ** attempt, this.maxRetryDelayMs);
        try {
          await this.sleep(delayMs, options.signal);
        } catch (error) {
          if (options.signal?.aborted || (error instanceof Error && error.message === "aborted")) {
            throw this.abortedError();
          }
          throw error;
        }
        continue;
      }

      throw this.httpError(status, bodyData, retryable);
    }
  }

  private async fetchAttempt(
    serializedBody: string,
    timeoutMs: number,
    callerSignal?: AbortSignal,
  ): Promise<{ response: Response; body: unknown }> {
    const controller = new AbortController();
    let callerAborted = callerSignal?.aborted ?? false;
    let timedOut = false;
    let rejectAbort: ((reason?: unknown) => void) | undefined;
    let responseForAbort: Response | undefined;
    const abortPromise = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });

    const cancelResponseBody = (): void => {
      const body = responseForAbort?.body;
      if (body && typeof body.cancel === "function") {
        try {
          void body.cancel().catch(() => undefined);
        } catch {
          // The body may already be locked by readJson; the abort race below
          // still releases the request without waiting for it.
        }
      }
    };

    const abortFromCaller = (): void => {
      callerAborted = true;
      controller.abort(callerSignal?.reason);
      cancelResponseBody();
      rejectAbort?.(this.abortedError());
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
      cancelResponseBody();
      rejectAbort?.(this.timeoutError(timeoutMs));
    }, timeoutMs);

    if (callerSignal?.aborted) {
      abortFromCaller();
    } else {
      callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
    }

    try {
      const fetchPromise = Promise.resolve().then(() =>
        this.fetchImpl(this.endpoint, {
          method: "POST",
          redirect: "error",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: serializedBody,
          signal: controller.signal,
        }),
      );
      responseForAbort = await Promise.race([fetchPromise, abortPromise]);
      const ok = isSuccessful(responseForAbort);
      const body = await Promise.race([this.readJson(responseForAbort, !ok), abortPromise]);
      return { response: responseForAbort, body };
    } catch (error) {
      if (callerAborted || callerSignal?.aborted) throw this.abortedError();
      if (timedOut) throw this.timeoutError(timeoutMs);
      if (error instanceof DecisionClientError) throw error;
      const detail = error instanceof Error ? redactDetail(error.message, this.apiKey) : undefined;
      throw new DecisionClientError(
        "transport",
        `${this.providerName} request could not be completed. Check connectivity and try again${detail ? `: ${detail}` : "."}`,
        { provider: this.providerName },
      );
    } finally {
      clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", abortFromCaller);
    }
  }

  private async readJson(response: Response, allowMalformed: boolean): Promise<unknown> {
    const responseWithBody = response as Response & {
      text?: () => Promise<string>;
      json?: () => Promise<unknown>;
    };

    try {
      const contentLength = response.headers?.get("content-length");
      if (contentLength) {
        const declaredLength = Number.parseInt(contentLength, 10);
        if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
          throw new DecisionClientError(
            "response",
            `${this.providerName} returned an oversized response.`,
            { provider: this.providerName },
          );
        }
      }

      if (response.body && typeof response.body.getReader === "function") {
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let totalBytes = 0;
        try {
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            if (!next.value) continue;
            totalBytes += next.value.byteLength;
            if (totalBytes > MAX_RESPONSE_BYTES) {
              await reader.cancel();
              throw new DecisionClientError(
                "response",
                `${this.providerName} returned an oversized response.`,
                { provider: this.providerName },
              );
            }
            chunks.push(next.value);
          }
        } finally {
          reader.releaseLock();
        }

        const bytes = new Uint8Array(totalBytes);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        const text = new TextDecoder().decode(bytes);
        if (!text.trim()) return undefined;
        try {
          return JSON.parse(text) as unknown;
        } catch {
          if (allowMalformed) return undefined;
          throw new DecisionClientError(
            "response",
            `${this.providerName} returned malformed JSON. Retry the request; if it persists, contact the provider.`,
            { provider: this.providerName },
          );
        }
      }

      if (typeof responseWithBody.text === "function") {
        const text = await responseWithBody.text();
        if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
          throw new DecisionClientError(
            "response",
            `${this.providerName} returned an oversized response.`,
            { provider: this.providerName },
          );
        }
        if (!text.trim()) return undefined;
        try {
          return JSON.parse(text) as unknown;
        } catch {
          if (allowMalformed) return undefined;
          throw new DecisionClientError(
            "response",
            `${this.providerName} returned malformed JSON. Retry the request; if it persists, contact the provider.`,
            { provider: this.providerName },
          );
        }
      }

      if (typeof responseWithBody.json === "function") {
        return await responseWithBody.json();
      }
    } catch (error) {
      if (error instanceof DecisionClientError) throw error;
      if (!allowMalformed) {
        throw new DecisionClientError(
          "response",
          `${this.providerName} returned an unreadable response. Retry the request; if it persists, contact the provider.`,
          { provider: this.providerName },
        );
      }
    }
    return undefined;
  }

  private httpError(status: number, body: unknown, retryable: boolean): DecisionClientError {
    const detail = errorDetail(body, this.apiKey);
    if (status === 401 || status === 403) {
      return new DecisionClientError(
        "authentication",
        `${this.providerName} rejected the API key (HTTP ${status}). Check the configured key and its access to the Jev decision endpoint.`,
        { provider: this.providerName, status, retryable },
      );
    }
    if (status === 400 || status === 422) {
      return new DecisionClientError(
        "request",
        `${this.providerName} rejected the Jev request (HTTP ${status}). Check the state, question types, and criteria${detail ? `: ${detail}` : "."}`,
        { provider: this.providerName, status, retryable },
      );
    }
    if (status === 429 || retryable) {
      return new DecisionClientError(
        "request",
        `${this.providerName} is temporarily unavailable (HTTP ${status}). Try again shortly${detail ? `: ${detail}` : "."}`,
        { provider: this.providerName, status, retryable },
      );
    }
    return new DecisionClientError(
      "request",
      `${this.providerName} request failed with HTTP ${status || "unknown"}${detail ? `: ${detail}` : "."}`,
      { provider: this.providerName, status, retryable },
    );
  }

  private abortedError(): DecisionClientError {
    return new DecisionClientError(
      "aborted",
      `${this.providerName} decision request was aborted.`,
      { provider: this.providerName },
    );
  }

  private timeoutError(timeoutMs: number): DecisionClientError {
    return new DecisionClientError(
      "timeout",
      `${this.providerName} decision request timed out after ${timeoutMs} ms.`,
      { provider: this.providerName },
    );
  }
}

export { DEFAULT_MAX_RETRIES, DEFAULT_TIMEOUT_MS };
