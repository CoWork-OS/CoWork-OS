import { useLayoutEffect, useState } from "react";

/** Title-bar element that hosts the open view's header (the session title and its menu). */
export const TITLE_BAR_CONTEXT_SLOT_ID = "title-bar-context-slot";

/**
 * The title-bar slot when `enabled`, so a view can portal its header into the
 * navbar. Header controls must live in the title bar's DOM to stay clickable
 * inside its window-drag region.
 */
export function useTitleBarContextSlot(enabled: boolean): HTMLElement | null {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    setSlot(enabled ? document.getElementById(TITLE_BAR_CONTEXT_SLOT_ID) : null);
  }, [enabled]);
  return slot;
}
