/** True when the user asked the OS for less motion. */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** `behavior` for scrollIntoView/scrollTo: smooth, unless reduced motion is on. */
export function scrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? "auto" : "smooth";
}

const INSTANT_CLASS = "motion-instant";
let instantTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Keyboard-initiated changes should not animate: people repeat them all day and motion
 * makes them feel slow. Flags the document so entrances and transitions finish at once
 * for the next second, long enough for the new view's staggered entrances to pass.
 */
export function suppressMotionBriefly(durationMs = 1000): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.add(INSTANT_CLASS);
  if (instantTimer) clearTimeout(instantTimer);
  instantTimer = setTimeout(() => {
    document.documentElement.classList.remove(INSTANT_CLASS);
    instantTimer = null;
  }, durationMs);
}
