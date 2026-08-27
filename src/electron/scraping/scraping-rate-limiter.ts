export interface ScrapingRateLimitSettings {
  enabled?: boolean;
  requestsPerMinute?: number;
}

const nextAllowedAtByHost = new Map<string, number>();
const queueByHost = new Map<string, Promise<void>>();

export function getScrapingRequestDelayMs(requestsPerMinute: unknown): number {
  const numeric = typeof requestsPerMinute === "number" ? requestsPerMinute : Number(requestsPerMinute);
  if (!Number.isFinite(numeric)) return 0;
  const bounded = Math.max(1, Math.min(120, numeric));
  return Math.ceil(60_000 / bounded);
}

/**
 * Wait for a host-scoped scraping slot. The queue is process-wide so separate
 * agent tasks cannot accidentally create a burst against the same host.
 */
export function waitForScrapingSlot(
  url: string,
  settings: ScrapingRateLimitSettings | undefined,
  sleep: (delayMs: number) => Promise<void> = (delayMs) =>
    new Promise((resolve) => setTimeout(resolve, delayMs)),
): Promise<void> {
  if (!settings?.enabled) return Promise.resolve();

  const host = new URL(url).host.toLowerCase();
  const intervalMs = getScrapingRequestDelayMs(settings.requestsPerMinute);
  if (!intervalMs) return Promise.resolve();

  const previous = queueByHost.get(host) || Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const delayMs = Math.max(0, (nextAllowedAtByHost.get(host) || 0) - Date.now());
    if (delayMs > 0) await sleep(delayMs);
    nextAllowedAtByHost.set(host, Date.now() + intervalMs);
  });

  let queued: Promise<void>;
  queued = next.finally(() => {
    if (queueByHost.get(host) === queued) queueByHost.delete(host);
  });
  queueByHost.set(host, queued);
  return next;
}

export function resetScrapingRateLimiterForTests(): void {
  nextAllowedAtByHost.clear();
  queueByHost.clear();
}
