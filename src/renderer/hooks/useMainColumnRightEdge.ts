import { useLayoutEffect, useState } from "react";

const MAIN_ROW_SELECTOR = ".selected-workspace-main-row";
const MAIN_COLUMN_SELECTOR = ":scope > .main-content";
const RESIZE_HANDLE_CLASS = "app-resizable-divider";

/**
 * Left edge (in px from the window's left) of a docked panel beside the session's
 * main column, or null when nothing docked is open to its right. The title bar
 * draws its divider there so the navbar lines up with the browser, artifact
 * viewers, side chat, or Calm's right panel, including resizable ones.
 * `refreshKey` should change when the column may have been re-rendered (a
 * different view or session).
 */
export function useMainColumnRightEdge(active: boolean, refreshKey: string): number | null {
  const [edge, setEdge] = useState<number | null>(null);

  useLayoutEffect(() => {
    if (!active || typeof ResizeObserver === "undefined") {
      setEdge(null);
      return;
    }

    let row: HTMLElement | null = null;
    let main: HTMLElement | null = null;

    const measure = () => {
      // The column and panels mount and remount under us (lazy views, a different
      // MainContent root), so look them up on every pass and follow new nodes.
      const nextRow = document.querySelector<HTMLElement>(MAIN_ROW_SELECTOR);
      const nextMain = nextRow?.querySelector<HTMLElement>(MAIN_COLUMN_SELECTOR) ?? null;
      if (nextRow !== row || nextMain !== main) {
        row = nextRow;
        main = nextMain;
        resizeObserver.disconnect();
        mutationObserver.disconnect();
        if (row) {
          resizeObserver.observe(row);
          mutationObserver.observe(row, { childList: true });
        }
        if (main) resizeObserver.observe(main);
      }
      if (!row || !main) {
        setEdge(null);
        return;
      }

      // Resizable panels sit behind a drag handle; line up with the panel itself.
      let panel = main.nextElementSibling;
      while (panel?.classList.contains(RESIZE_HANDLE_CLASS)) panel = panel.nextElementSibling;
      const rect = panel?.getBoundingClientRect();
      // Only docked panels, whose edge runs up to the navbar, get a divider there;
      // floating cards (the modern inspector, bot details) sit below it.
      const docked = rect && rect.width > 0 && rect.top - row.getBoundingClientRect().top <= 1;
      setEdge(docked ? Math.round(rect.left) : null);
    };

    // A panel opening, closing, or resizing changes the column's width; the
    // window and the left panel change the row's; a panel mounting or the
    // column remounting changes the row's children.
    const resizeObserver = new ResizeObserver(measure);
    const mutationObserver = new MutationObserver(measure);
    measure();
    window.addEventListener("resize", measure);
    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [active, refreshKey]);

  return edge;
}
