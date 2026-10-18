/**
 * Runs `fn` over `items` with at most `limit` calls in flight and returns the
 * results in input order.
 *
 * Per-workspace reads use this instead of Promise.all: each read is one request
 * to the database worker, whose queue rejects requests past its cap (256), so an
 * unbounded fan-out over every workspace can fail its own reads and anything
 * else issued at the same moment.
 */
export async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, Math.floor(limit)), items.length) }, worker),
  );
  return results;
}

/** Like mapBounded, but one failure does not stop the others (Promise.allSettled order). */
export function mapBoundedSettled<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  return mapBounded(items, limit, async (item, index) => {
    try {
      return { status: "fulfilled", value: await fn(item, index) } as const;
    } catch (reason) {
      return { status: "rejected", reason } as const;
    }
  });
}

/** Concurrent per-workspace database reads; well under the worker's 256-request queue. */
export const WORKSPACE_READ_CONCURRENCY = 8;
