import { useLayoutEffect, useRef, type RefObject } from "react";

/** Measure once per frame while open; track scrolling and anchor/panel size changes. */
export function usePositionUpdates(
  active: boolean,
  update: () => void,
  anchor?: RefObject<HTMLElement | null>,
  panel?: RefObject<HTMLElement | null>,
) {
  const latest = useRef(update);
  latest.current = update;
  useLayoutEffect(() => {
    if (!active) return;
    let frame: number | null = null;
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => schedule());
    const schedule = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        latest.current();
        if (panel?.current) observer?.observe(panel.current);
      });
    };
    latest.current();
    schedule();
    if (anchor?.current) observer?.observe(anchor.current);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
    };
  }, [active, anchor, panel]);
}
