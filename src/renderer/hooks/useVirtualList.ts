/**
 * useVirtualList
 *
 * React hook that manages a virtual scroll window.  Only the visible items
 * (plus an overscan buffer) are rendered to the DOM.  Item heights come from
 * a caller-supplied function — typically backed by PretextMeasurer — with a
 * fixed `estimatedItemHeight` fallback.
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VirtualItem<T> {
  item: T;
  index: number;
  offsetTop: number;
  height: number;
}

export interface UseVirtualListOptions<T> {
  /** The full list of items. */
  items: T[];
  /** Ref to the scrollable outer container. */
  containerRef: RefObject<HTMLElement | null>;
  /** Return the pixel height for an item.  Should be cheap (pretext‑backed). */
  getItemHeight: (item: T, index: number) => number;
  /** Fallback height when getItemHeight is not available. */
  estimatedItemHeight?: number;
  /** Extra items rendered above/below the viewport. */
  overscan?: number;
  /** Master switch — when false the hook returns all items unstyled. */
  enabled?: boolean;
}

export interface UseVirtualListResult<T> {
  /** Items visible in (or near) the viewport, with layout metadata. */
  virtualItems: VirtualItem<T>[];
  /** Total content height in pixels. */
  totalHeight: number;
  /** Scroll the container so that `index` is visible. */
  scrollToIndex: (index: number) => void;
  /** Scroll the container to the very bottom. */
  scrollToBottom: () => void;
  /** Whether the user's scroll position is pinned to the bottom. */
  isAtBottom: boolean;
}

// ---------------------------------------------------------------------------
// Height accumulator (pure function, testable)
// ---------------------------------------------------------------------------

export function computeOffsets(
  count: number,
  getHeight: (index: number) => number,
): { offsets: number[]; totalHeight: number } {
  const offsets = Array.from<number>({ length: count });
  let cumulative = 0;
  for (let i = 0; i < count; i++) {
    offsets[i] = cumulative;
    cumulative += getHeight(i);
  }
  return { offsets, totalHeight: cumulative };
}

/**
 * Binary-search the first item whose top offset is >= scrollTop.
 * Returns the index of the first visible item (may need -1 for partial).
 */
export function findStartIndex(offsets: number[], scrollTop: number): number {
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (offsets[mid] < scrollTop) lo = mid + 1;
    else hi = mid;
  }
  // The item at `lo` starts at or after scrollTop, so the first partially
  // visible item is max(lo - 1, 0).
  return Math.max(lo - 1, 0);
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useVirtualList<T>(options: UseVirtualListOptions<T>): UseVirtualListResult<T> {
  const {
    items,
    containerRef,
    getItemHeight,
    estimatedItemHeight = 40,
    overscan = 5,
    enabled = true,
  } = options;

  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const rafRef = useRef(0);
  const isAtBottomRef = useRef(true);
  const [isAtBottom, setIsAtBottom] = useState(true);

  // ---- Compute item offsets ------------------------------------------------

  const heightFn = useCallback(
    (index: number) => {
      try {
        return getItemHeight(items[index], index);
      } catch {
        return estimatedItemHeight;
      }
    },
    [items, getItemHeight, estimatedItemHeight],
  );

  const { offsets, totalHeight } = computeOffsets(items.length, heightFn);

  // ---- Scroll handler (rAF‑throttled) -------------------------------------

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !enabled) return;

    const onScroll = () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        const st = container.scrollTop;
        setScrollTop(st);
        const atBottom = st + container.clientHeight >= container.scrollHeight - 30;
        isAtBottomRef.current = atBottom;
        setIsAtBottom(atBottom);
      });
    };

    container.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      container.removeEventListener("scroll", onScroll);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [containerRef, enabled]);

  // ---- ResizeObserver for viewport height ---------------------------------

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !enabled) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setViewportHeight(entry.contentRect.height);
      }
    });
    observer.observe(container);
    setViewportHeight(container.clientHeight);

    return () => observer.disconnect();
  }, [containerRef, enabled]);

  // ---- Auto-scroll to bottom when new items arrive if pinned --------------

  useEffect(() => {
    if (!enabled || !isAtBottomRef.current) return;
    const container = containerRef.current;
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }, [items.length, enabled, containerRef]);

  // ---- Compute visible window ---------------------------------------------

  let virtualItems: VirtualItem<T>[];

  if (!enabled || items.length === 0) {
    // Fallback: return every item with stacked offsets
    virtualItems = items.map((item, index) => ({
      item,
      index,
      offsetTop: index * estimatedItemHeight,
      height: estimatedItemHeight,
    }));
  } else {
    const startIndex = Math.max(findStartIndex(offsets, scrollTop) - overscan, 0);
    const endBound = scrollTop + viewportHeight;

    let endIndex = startIndex;
    while (endIndex < items.length && offsets[endIndex] < endBound) {
      endIndex++;
    }
    endIndex = Math.min(endIndex + overscan, items.length);

    virtualItems = [];
    for (let i = startIndex; i < endIndex; i++) {
      virtualItems.push({
        item: items[i],
        index: i,
        offsetTop: offsets[i],
        height: heightFn(i),
      });
    }
  }

  // ---- Imperative scroll helpers ------------------------------------------

  const scrollToIndex = useCallback(
    (index: number) => {
      const container = containerRef.current;
      if (!container || index < 0 || index >= offsets.length) return;
      container.scrollTop = offsets[index];
    },
    [containerRef, offsets],
  );

  const scrollToBottom = useCallback(() => {
    const container = containerRef.current;
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }, [containerRef]);

  return { virtualItems, totalHeight, scrollToIndex, scrollToBottom, isAtBottom };
}
