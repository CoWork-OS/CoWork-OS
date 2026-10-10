import { useCallback, useEffect, useId, useState } from "react";
import { liveFrameSlots, type LiveFrameSlots } from "../utils/live-frame-slots";

/** Frames this close to the visible area count as on screen, so scrolling doesn't thrash. */
const NEAR_SCREEN_MARGIN = "600px 0px";

function scrollParent(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") return node;
  }
  return null;
}

/**
 * Whether the frame inside `element` may be loaded now (see LiveFrameSlots), and an
 * `activate` to call when the user uses the frame or asks for a parked one. Without
 * IntersectionObserver (tests, old hosts) every frame is treated as on screen.
 */
export function useLiveFrameSlot(
  element: HTMLElement | null,
  slots: LiveFrameSlots = liveFrameSlots,
): { live: boolean; activate: () => void } {
  const id = useId();
  const [live, setLive] = useState(false);

  useEffect(() => {
    if (!element) return;
    slots.register(id, setLive);
    const release = () => {
      slots.unregister(id);
      setLive(false);
    };
    if (typeof IntersectionObserver === "undefined") {
      slots.setVisible(id, true);
      return release;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (entry) slots.setVisible(id, entry.isIntersecting);
      },
      { root: scrollParent(element), rootMargin: NEAR_SCREEN_MARGIN },
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
      release();
    };
  }, [element, id, slots]);

  const activate = useCallback(() => slots.touch(id), [id, slots]);
  return { live, activate };
}
