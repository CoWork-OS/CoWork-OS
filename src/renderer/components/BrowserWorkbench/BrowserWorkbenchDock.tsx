import { useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

type DockRect = { left: number; top: number; width: number; height: number };

/**
 * Keeps the browser workbench mounted in one place while it moves between the
 * sidebar and full view.
 *
 * A <webview> reloads its page whenever its element is moved in the DOM, so
 * the workbench is never reparented. In full view the dock fills the layout
 * like any panel; in sidebar mode it stays where it is and is positioned over
 * the sidebar's slot element, following the slot as it moves or resizes.
 */
export function BrowserWorkbenchDock({
  mode,
  slot,
  children,
}: {
  mode: "sidebar" | "fullscreen";
  slot: HTMLElement | null;
  children: ReactNode;
}) {
  const dockRef = useRef<HTMLDivElement | null>(null);
  const [rect, setRect] = useState<DockRect | null>(null);

  useLayoutEffect(() => {
    const dock = dockRef.current;
    if (mode !== "sidebar" || !slot || !dock) {
      setRect(null);
      return;
    }
    let frame = 0;
    const apply = () => {
      const slotRect = slot.getBoundingClientRect();
      const parent = dock.offsetParent as HTMLElement | null;
      // Absolute offsets are relative to the containing block's padding box.
      const baseLeft = parent
        ? parent.getBoundingClientRect().left + parent.clientLeft - parent.scrollLeft
        : -window.scrollX;
      const baseTop = parent
        ? parent.getBoundingClientRect().top + parent.clientTop - parent.scrollTop
        : -window.scrollY;
      const next = {
        left: Math.round(slotRect.left - baseLeft),
        top: Math.round(slotRect.top - baseTop),
        width: Math.round(slotRect.width),
        height: Math.round(slotRect.height),
      };
      setRect((current) =>
        current &&
        current.left === next.left &&
        current.top === next.top &&
        current.width === next.width &&
        current.height === next.height
          ? current
          : next,
      );
    };
    const measure = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(apply);
    };
    apply();
    const observer = new ResizeObserver(measure);
    observer.observe(slot);
    if (slot.parentElement) observer.observe(slot.parentElement);
    if (dock.offsetParent) observer.observe(dock.offsetParent);
    observer.observe(document.documentElement);
    window.addEventListener("resize", measure);
    // Panels that slide open (left sidebar, right panel) move the slot without resizing it.
    document.addEventListener("transitionend", measure, true);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", measure);
      document.removeEventListener("transitionend", measure, true);
    };
  }, [mode, slot]);

  const docked = mode === "sidebar";
  return (
    <div
      ref={dockRef}
      className={`browser-workbench-dock ${docked ? "is-docked" : "is-fullscreen"} ${
        docked && !rect ? "is-unplaced" : ""
      }`}
      style={
        docked && rect
          ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
          : undefined
      }
    >
      {children}
    </div>
  );
}
