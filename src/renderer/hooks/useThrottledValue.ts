import { useEffect, useRef, useState } from "react";

/** How long to hold a new value: none once `intervalMs` has passed since the last update. */
export function throttleWaitMs(lastUpdateAt: number, intervalMs: number, now: number): number {
  return Math.max(0, lastUpdateAt + intervalMs - now);
}

/**
 * `value`, updated at most once per `intervalMs` while it keeps changing and
 * always to its latest value once it settles.
 */
export function useThrottledValue<T>(value: T, intervalMs: number): T {
  const [throttled, setThrottled] = useState(value);
  const lastUpdateAtRef = useRef(0);
  useEffect(() => {
    if (Object.is(value, throttled)) return;
    const apply = () => {
      lastUpdateAtRef.current = Date.now();
      setThrottled(value);
    };
    const wait = throttleWaitMs(lastUpdateAtRef.current, intervalMs, Date.now());
    if (wait === 0) {
      apply();
      return;
    }
    const timer = setTimeout(apply, wait);
    return () => clearTimeout(timer);
  }, [value, throttled, intervalMs]);
  return throttled;
}
