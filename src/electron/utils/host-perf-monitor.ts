import { monitorEventLoopDelay, performance, type EventLoopUtilization } from "perf_hooks";
import {
  getSqliteInstrumentationSnapshot,
  type SqliteInstrumentationSnapshot,
} from "../database/sqlite-instrumentation";
import { createLogger } from "./logger";

/**
 * Periodic host event-loop and SQLite summary for the async SQLite migration
 * baseline (DB0 in docs/async-sqlite-migration-plan-2026-09-27.md).
 *
 * Each interval produces one `[HostPerf] {json}` line. It is logged at info
 * when summaries are enabled (dev log capture or `COWORK_HOST_PERF=1`), and at
 * warn whenever event-loop p99 crosses the warning threshold, so real stalls
 * surface in ordinary logs too. Lines carry durations, counts, and SQL
 * fingerprints only.
 */

const logger = createLogger("HostPerf");

const DEFAULT_INTERVAL_MS = 60_000;
const MIN_INTERVAL_MS = 5_000;
const DEFAULT_WARN_EVENT_LOOP_P99_MS = 250;
const EVENT_LOOP_RESOLUTION_MS = 20;
const TOP_SQLITE_LABELS = 5;

export type HostPerfRuntime = "desktop" | "daemon" | "cli";

export interface HostPerfMonitorOptions {
  runtime: HostPerfRuntime;
  intervalMs?: number;
  isSummaryEnabled?: () => boolean;
  warnEventLoopP99Ms?: number;
}

export interface HostPerfSample {
  runtime: HostPerfRuntime;
  windowMs: number;
  eventLoop: {
    p50Ms: number;
    p90Ms: number;
    p99Ms: number;
    maxMs: number;
    meanMs: number;
    utilization: number;
  };
  sqlite: {
    hostMs: number;
    /** Share of the window spent inside top-level SQLite calls on this thread. */
    hostShare: number;
    topLevelOperations: number;
    slowOperations: number;
    errors: number;
    busyErrors: number;
    byKind: SqliteInstrumentationSnapshot["byKind"];
    hostOperations: SqliteInstrumentationSnapshot["hostOperations"];
    top: Array<{ label: string; kind: string; count: number; totalMs: number; maxMs: number }>;
  };
}

export interface HostPerfMonitorHandle {
  /** Stop sampling. With `flush`, emit a final sample if summaries are enabled. */
  stop(options?: { flush?: boolean }): void;
}

let activeMonitor: HostPerfMonitorHandle | null = null;

const nsToMs = (value: number): number => Math.round((value / 1e6) * 1000) / 1000;

function readPositiveNumberEnv(name: string): number | undefined {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function envSummaryEnabled(): boolean {
  const raw = (process.env.COWORK_HOST_PERF || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on";
}

export function buildHostPerfSample(
  runtime: HostPerfRuntime,
  histogram: Pick<
    ReturnType<typeof monitorEventLoopDelay>,
    "count" | "percentile" | "max" | "mean"
  >,
  utilization: EventLoopUtilization,
  sqlite: SqliteInstrumentationSnapshot,
): HostPerfSample {
  const hasSamples = histogram.count > 0;
  const windowMs = sqlite.windowMs;
  return {
    runtime,
    windowMs,
    eventLoop: {
      p50Ms: hasSamples ? nsToMs(histogram.percentile(50)) : 0,
      p90Ms: hasSamples ? nsToMs(histogram.percentile(90)) : 0,
      p99Ms: hasSamples ? nsToMs(histogram.percentile(99)) : 0,
      maxMs: hasSamples ? nsToMs(histogram.max) : 0,
      meanMs: hasSamples ? nsToMs(histogram.mean) : 0,
      utilization: Math.round(utilization.utilization * 1000) / 1000,
    },
    sqlite: {
      hostMs: sqlite.hostMs,
      hostShare: windowMs > 0 ? Math.round((sqlite.hostMs / windowMs) * 1000) / 1000 : 0,
      topLevelOperations: sqlite.topLevelOperations,
      slowOperations: sqlite.slowOperations,
      errors: sqlite.errors,
      busyErrors: sqlite.busyErrors,
      byKind: sqlite.byKind,
      hostOperations: sqlite.hostOperations,
      top: sqlite.labels.slice(0, TOP_SQLITE_LABELS).map((entry) => ({
        label: entry.label,
        kind: entry.kind,
        count: entry.count,
        totalMs: entry.totalMs,
        maxMs: entry.maxMs,
      })),
    },
  };
}

/**
 * Start the process-wide monitor. A second call returns the running monitor.
 * The timer is unref'd so it never keeps a process alive.
 */
export function startHostPerfMonitor(options: HostPerfMonitorOptions): HostPerfMonitorHandle {
  if (activeMonitor) return activeMonitor;

  const intervalMs = Math.max(
    MIN_INTERVAL_MS,
    options.intervalMs ??
      readPositiveNumberEnv("COWORK_HOST_PERF_INTERVAL_MS") ??
      DEFAULT_INTERVAL_MS,
  );
  const warnP99Ms =
    options.warnEventLoopP99Ms ??
    readPositiveNumberEnv("COWORK_HOST_PERF_WARN_P99_MS") ??
    DEFAULT_WARN_EVENT_LOOP_P99_MS;
  const isSummaryEnabled = (): boolean => {
    if (envSummaryEnabled()) return true;
    try {
      return options.isSummaryEnabled?.() ?? false;
    } catch {
      return false;
    }
  };

  const histogram = monitorEventLoopDelay({ resolution: EVENT_LOOP_RESOLUTION_MS });
  histogram.enable();
  let lastUtilization = performance.eventLoopUtilization();
  // Start the SQLite window with the event-loop window.
  getSqliteInstrumentationSnapshot({ reset: true, topLabels: 0 });

  const emitSample = (force: boolean): void => {
    try {
      const utilization = performance.eventLoopUtilization(lastUtilization);
      lastUtilization = performance.eventLoopUtilization();
      const sample = buildHostPerfSample(
        options.runtime,
        histogram,
        utilization,
        getSqliteInstrumentationSnapshot({ reset: true, topLabels: TOP_SQLITE_LABELS }),
      );
      histogram.reset();
      if (sample.eventLoop.p99Ms >= warnP99Ms) {
        logger.warn(`[HostPerf] ${JSON.stringify(sample)}`);
      } else if (force || isSummaryEnabled()) {
        logger.info(`[HostPerf] ${JSON.stringify(sample)}`);
      }
    } catch (error) {
      logger.debug("Host perf sample failed:", error);
    }
  };

  const timer = setInterval(() => emitSample(false), intervalMs);
  timer.unref?.();

  const handle: HostPerfMonitorHandle = {
    stop: (stopOptions = {}) => {
      if (activeMonitor !== handle) return;
      activeMonitor = null;
      clearInterval(timer);
      if (stopOptions.flush && isSummaryEnabled()) emitSample(true);
      histogram.disable();
    },
  };
  activeMonitor = handle;
  return handle;
}
