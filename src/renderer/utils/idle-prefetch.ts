type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

/**
 * Runs `loaders` one at a time while the renderer is idle, starting after `delayMs`.
 * Used to fetch and compile lazily loaded screens ahead of their first open, so the
 * first click costs what a repeat visit does. Failures are ignored: the screen's own
 * lazy import retries when it is opened. Returns a function that stops the remaining work.
 */
export function prefetchWhenIdle(
  loaders: Array<() => Promise<unknown>>,
  options: { delayMs?: number; idleTimeoutMs?: number } = {},
): () => void {
  const idleWindow: IdleWindow | undefined = typeof window === "undefined" ? undefined : window;
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let idleHandle: number | null = null;

  const whenIdle = (run: () => void) => {
    if (idleWindow?.requestIdleCallback) {
      idleHandle = idleWindow.requestIdleCallback(run, { timeout: options.idleTimeoutMs ?? 5_000 });
    } else {
      timer = setTimeout(run, 0);
    }
  };
  const runFrom = (index: number) => {
    if (cancelled || index >= loaders.length) return;
    whenIdle(() => {
      idleHandle = null;
      if (cancelled) return;
      let pending: Promise<unknown>;
      try {
        pending = loaders[index]();
      } catch {
        pending = Promise.resolve();
      }
      void pending.catch(() => undefined).finally(() => runFrom(index + 1));
    });
  };

  timer = setTimeout(() => {
    timer = null;
    runFrom(0);
  }, options.delayMs ?? 0);

  return () => {
    cancelled = true;
    if (timer !== null) clearTimeout(timer);
    if (idleHandle !== null) idleWindow?.cancelIdleCallback?.(idleHandle);
  };
}
