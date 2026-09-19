import type { DecisionProvider } from "./decision-provider";
import {
  digestDecisionState,
  DecisionTelemetry,
  type DecisionTelemetryEvent,
} from "./decision-telemetry";
import { recordJevCall, type JevDecisionTelemetryContext } from "./decision-usage-telemetry";
import type { DecisionRequestOptions, JevRequest, JevResponse } from "./types";

export type DecisionServiceStatus =
  | "success"
  | "unavailable"
  | "cancelled"
  | "budget_exhausted"
  | "circuit_open";

export interface DecisionServiceResult {
  status: DecisionServiceStatus;
  response?: JevResponse;
  latencyMs: number;
  stateDigest: string;
  model?: string;
  requestId?: string;
  reason?: string;
  fromCache?: boolean;
}

export interface DecisionServiceOptions {
  provider: DecisionProvider;
  model?: string;
  providerType?: string;
  telemetryContext?: JevDecisionTelemetryContext;
  timeoutMs?: number;
  maxRetries?: number;
  maxConcurrent?: number;
  maxCalls?: number;
  circuitFailureThreshold?: number;
  circuitResetMs?: number;
  cache?: {
    enabled?: boolean;
    ttlMs?: number;
    maxEntries?: number;
  };
  telemetry?: DecisionTelemetry;
  now?: () => number;
}

export interface DecisionServiceCallOptions extends Pick<
  DecisionRequestOptions,
  "signal" | "timeoutMs" | "maxRetries" | "retryDelayMs"
> {
  purpose?: string;
  cacheKey?: string;
  sourceId?: string;
}

interface CacheEntry {
  expiresAt: number;
  result: DecisionServiceResult;
}

const DEFAULT_TIMEOUT_MS = 1_500;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_CIRCUIT_THRESHOLD = 3;
const DEFAULT_CIRCUIT_RESET_MS = 30_000;
const DEFAULT_CACHE_TTL_MS = 5_000;
const DEFAULT_MAX_CACHE_ENTRIES = 100;

function clampPositive(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value) || (value as number) <= 0) return fallback;
  return Math.min(max, Math.round(value as number));
}

function clampNonNegative(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value) || (value as number) < 0) return fallback;
  return Math.min(max, Math.floor(value as number));
}

function questionCount(request: JevRequest): number {
  return Object.keys(request.questions || {}).length;
}

function stateBytes(request: JevRequest): number {
  try {
    return Buffer.byteLength(JSON.stringify(request.state) || "", "utf8");
  } catch {
    return 0;
  }
}

function responseMetadata(result: DecisionServiceResult): Partial<DecisionTelemetryEvent> {
  const response = result.response;
  return {
    ...(response?.model ? { model: response.model } : {}),
    ...(response?.id ? { requestId: response.id } : {}),
    ...(response?.usage ? { usage: response.usage } : {}),
    ...(result.fromCache ? { fromCache: true } : {}),
  };
}

/**
 * Bounded runtime around a typed decision provider. It owns operational
 * concerns only; callers still validate the meaning of each answer.
 */
export class DecisionService {
  private readonly provider: DecisionProvider;
  private readonly defaultModel?: string;
  private readonly providerType?: string;
  private readonly telemetryContext?: JevDecisionTelemetryContext;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly maxConcurrent: number;
  private readonly maxCalls?: number;
  private readonly circuitFailureThreshold: number;
  private readonly circuitResetMs: number;
  private readonly cacheEnabled: boolean;
  private readonly cacheTtlMs: number;
  private readonly maxCacheEntries: number;
  private readonly telemetry: DecisionTelemetry;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();
  private activeCalls = 0;
  private calls = 0;
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;

  constructor(options: DecisionServiceOptions) {
    this.provider = options.provider;
    this.defaultModel = options.model;
    this.providerType = options.providerType;
    this.telemetryContext = options.telemetryContext;
    this.timeoutMs = clampPositive(options.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    this.maxRetries = clampNonNegative(options.maxRetries, 0, 5);
    this.maxConcurrent = clampPositive(options.maxConcurrent, 2, 32);
    this.maxCalls =
      options.maxCalls === undefined ? undefined : clampNonNegative(options.maxCalls, 0, 10_000);
    this.circuitFailureThreshold = clampPositive(
      options.circuitFailureThreshold,
      DEFAULT_CIRCUIT_THRESHOLD,
      100,
    );
    this.circuitResetMs = clampPositive(
      options.circuitResetMs,
      DEFAULT_CIRCUIT_RESET_MS,
      10 * 60_000,
    );
    this.cacheEnabled = options.cache?.enabled === true;
    this.cacheTtlMs = clampPositive(options.cache?.ttlMs, DEFAULT_CACHE_TTL_MS, 10 * 60_000);
    this.maxCacheEntries = clampPositive(
      options.cache?.maxEntries,
      DEFAULT_MAX_CACHE_ENTRIES,
      1_000,
    );
    this.telemetry = options.telemetry || new DecisionTelemetry();
    this.now = options.now || Date.now;
  }

  getTelemetry(): DecisionTelemetry {
    return this.telemetry;
  }

  /** Expose the underlying typed transport for adapters that share this budget. */
  getProvider(): DecisionProvider {
    return this.provider;
  }

  getModel(): string | undefined {
    return this.defaultModel;
  }

  getUsage(): { calls: number; activeCalls: number; circuitOpen: boolean } {
    return {
      calls: this.calls,
      activeCalls: this.activeCalls,
      circuitOpen: this.circuitOpenUntil > this.now(),
    };
  }

  reset(): void {
    this.calls = 0;
    this.activeCalls = 0;
    this.consecutiveFailures = 0;
    this.circuitOpenUntil = 0;
    this.cache.clear();
  }

  async decide(
    request: JevRequest,
    options: DecisionServiceCallOptions = {},
  ): Promise<DecisionServiceResult> {
    const startedAt = this.now();
    const purpose = String(options.purpose || "decision").slice(0, 80);
    const stateDigest = digestDecisionState(request.state);
    const requestDigest = digestDecisionState({
      model: request.model || this.defaultModel || "",
      state: request.state,
      questions: request.questions,
    });
    const key = options.cacheKey?.trim()
      ? `${purpose}:${options.cacheKey.trim()}:${requestDigest}`
      : undefined;
    const baseTelemetry = {
      purpose,
      stateDigest,
      stateBytes: stateBytes(request),
      questionCount: questionCount(request),
      sourceId: options.sourceId || options.cacheKey,
    };

    const cached = key ? this.cache.get(key) : undefined;
    if (cached && cached.expiresAt > this.now()) {
      const result = { ...cached.result, latencyMs: 0, fromCache: true };
      this.telemetry.record({
        ...baseTelemetry,
        ...responseMetadata(result),
        status: result.status,
        latencyMs: 0,
        reason: "cache_hit",
        fromCache: true,
        at: this.now(),
      });
      this.recordPersistentTelemetry(result, purpose, baseTelemetry.sourceId);
      return result;
    }
    if (cached) this.cache.delete(key!);

    if (options.signal?.aborted) {
      return this.finish(baseTelemetry, startedAt, {
        status: "cancelled",
        latencyMs: 0,
        stateDigest,
        reason: "cancelled",
      });
    }
    if (this.circuitOpenUntil > this.now()) {
      return this.finish(baseTelemetry, startedAt, {
        status: "circuit_open",
        latencyMs: 0,
        stateDigest,
        reason: "circuit_open",
      });
    }
    if (this.maxCalls !== undefined && this.calls >= this.maxCalls) {
      return this.finish(baseTelemetry, startedAt, {
        status: "budget_exhausted",
        latencyMs: 0,
        stateDigest,
        reason: "call_budget_exhausted",
      });
    }
    if (this.activeCalls >= this.maxConcurrent) {
      return this.finish(baseTelemetry, startedAt, {
        status: "budget_exhausted",
        latencyMs: 0,
        stateDigest,
        reason: "concurrency_budget_exhausted",
      });
    }

    this.calls += 1;
    this.activeCalls += 1;
    const controller = new AbortController();
    const timeoutMs = clampPositive(options.timeoutMs, this.timeoutMs, MAX_TIMEOUT_MS);
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    let timeoutRaceTimer: ReturnType<typeof setTimeout> | undefined;
    const timeoutRace = new Promise<never>((_, reject) => {
      timeoutRaceTimer = setTimeout(() => reject(new Error("decision_timeout")), timeoutMs);
    });
    let externallyCancelled = false;
    let cancellationReject: ((reason?: unknown) => void) | undefined;
    const cancellationRace = options.signal
      ? new Promise<never>((_, reject) => {
          cancellationReject = reject;
        })
      : undefined;
    const abortForwarder = (): void => {
      externallyCancelled = true;
      controller.abort();
      cancellationReject?.(new Error("decision_cancelled"));
    };
    options.signal?.addEventListener("abort", abortForwarder, { once: true });
    try {
      const races: Array<Promise<JevResponse> | Promise<never>> = [
        this.provider.decide(
          {
            ...request,
            ...(request.model || this.defaultModel
              ? { model: request.model || this.defaultModel }
              : {}),
          },
          {
            signal: controller.signal,
            timeoutMs,
            maxRetries: clampNonNegative(options.maxRetries, this.maxRetries, 5),
            retryDelayMs: options.retryDelayMs,
          },
        ),
        timeoutRace,
      ];
      if (cancellationRace) races.push(cancellationRace);
      const response = await Promise.race(races);
      const result: DecisionServiceResult = {
        status: "success",
        response,
        latencyMs: Math.max(0, this.now() - startedAt),
        stateDigest,
        model: response.model,
        ...(response.id ? { requestId: response.id } : {}),
      };
      this.consecutiveFailures = 0;
      if (key && this.cacheEnabled) {
        this.cache.set(key, { expiresAt: this.now() + this.cacheTtlMs, result });
        while (this.cache.size > this.maxCacheEntries) {
          const first = this.cache.keys().next().value as string | undefined;
          if (first) this.cache.delete(first);
          else break;
        }
      }
      return this.finish(baseTelemetry, startedAt, result);
    } catch {
      const cancelled =
        externallyCancelled || options.signal?.aborted || (!timedOut && controller.signal.aborted);
      if (!cancelled) {
        this.consecutiveFailures += 1;
        if (this.consecutiveFailures >= this.circuitFailureThreshold) {
          this.circuitOpenUntil = this.now() + this.circuitResetMs;
        }
      }
      return this.finish(baseTelemetry, startedAt, {
        status: cancelled ? "cancelled" : "unavailable",
        latencyMs: Math.max(0, this.now() - startedAt),
        stateDigest,
        reason: cancelled ? "cancelled" : timedOut ? "timeout" : "provider_error",
      });
    } finally {
      clearTimeout(timeout);
      if (timeoutRaceTimer) clearTimeout(timeoutRaceTimer);
      options.signal?.removeEventListener("abort", abortForwarder);
      this.activeCalls = Math.max(0, this.activeCalls - 1);
    }
  }

  private finish(
    base: {
      purpose: string;
      stateDigest: string;
      stateBytes: number;
      questionCount: number;
      sourceId?: string;
    },
    startedAt: number,
    result: DecisionServiceResult,
  ): DecisionServiceResult {
    const finalized = {
      ...result,
      latencyMs: Math.max(0, result.latencyMs || this.now() - startedAt),
      stateDigest: base.stateDigest,
    };
    this.telemetry.record({
      ...base,
      ...responseMetadata(finalized),
      status: finalized.status,
      latencyMs: finalized.latencyMs,
      reason: finalized.reason,
      at: this.now(),
    });
    this.recordPersistentTelemetry(finalized, base.purpose, base.sourceId);
    return finalized;
  }

  private recordPersistentTelemetry(
    result: DecisionServiceResult,
    purpose: string,
    sourceId?: string,
  ): void {
    recordJevCall({
      ...this.telemetryContext,
      sourceId: sourceId || null,
      providerType: this.providerType,
      modelId: result.response?.model || result.model,
      purpose,
      status: result.status,
      latencyMs: result.latencyMs,
      fromCache: result.fromCache,
      requestId: result.response?.id || result.requestId,
      usage: result.response?.usage,
      errorCode: result.status === "success" ? null : result.status,
      errorMessage: result.reason,
      timestamp: this.now(),
    });
  }
}

export function createDecisionService(
  provider: DecisionProvider,
  options: Omit<DecisionServiceOptions, "provider"> = {},
): DecisionService {
  return new DecisionService({ ...options, provider });
}
