import { useEffect, useState } from "react";
import type { RefObject } from "react";

/**
 * App UI that can float over the page: menus, list popups (address bar
 * suggestions), dialogs and toasts. A native tab view draws above all of it,
 * so while one of these overlaps the page the view is swapped for a still image.
 */
export const OCCLUDING_OVERLAY_SELECTOR = [
  '[role="menu"]',
  '[role="listbox"]',
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[aria-modal="true"]',
  ".toast",
].join(", ");

type Rect = { left: number; top: number; right: number; bottom: number };

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom;
}

/**
 * Whether any floating app UI outside the page surface overlaps it. Overlays
 * inside the surface (notices, page dialogs, annotation) are covered explicitly
 * by the workbench, so they are not counted here.
 */
export function useSurfaceOcclusion(
  surfaceRef: RefObject<HTMLElement | null>,
  enabled: boolean,
): boolean {
  const [occluded, setOccluded] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setOccluded(false);
      return;
    }
    let frame = 0;
    const check = () => {
      frame = 0;
      const surface = surfaceRef.current;
      if (!surface) return;
      const surfaceRect = surface.getBoundingClientRect();
      let hit = false;
      for (const element of document.querySelectorAll(OCCLUDING_OVERLAY_SELECTOR)) {
        if (surface.contains(element)) continue;
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        if (rectsOverlap(rect, surfaceRect)) {
          hit = true;
          break;
        }
      }
      setOccluded(hit);
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(check);
    };
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden", "open", "aria-expanded"],
    });
    window.addEventListener("resize", schedule);
    check();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [enabled, surfaceRef]);

  return occluded;
}
