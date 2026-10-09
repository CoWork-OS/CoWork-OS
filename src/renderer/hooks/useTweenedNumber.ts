import { useEffect, useRef, useState } from "react";

const DURATION_MS = 420;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Follows `target`, easing from the previous value over a short animation whenever it
 * changes. The first value is shown as-is, so a remounted surface does not replay a count.
 */
export function useTweenedNumber(target: number): number {
  const [shown, setShown] = useState(target);
  const shownRef = useRef(target);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    const from = shownRef.current;
    if (from === target) return;
    if (prefersReducedMotion() || typeof requestAnimationFrame !== "function") {
      shownRef.current = target;
      setShown(target);
      return;
    }
    const start = performance.now();
    const step = (now: number) => {
      const progress = Math.min(1, (now - start) / DURATION_MS);
      const eased = 1 - Math.pow(1 - progress, 3);
      const next = progress >= 1 ? target : from + (target - from) * eased;
      shownRef.current = next;
      setShown(next);
      if (progress < 1) frame.current = requestAnimationFrame(step);
    };
    frame.current = requestAnimationFrame(step);
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, [target]);

  return shown;
}
