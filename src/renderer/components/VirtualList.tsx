/**
 * VirtualList
 *
 * Generic virtual-scrolling list component.  Uses `useVirtualList` internally
 * to render only the visible window of items plus an overscan buffer.
 *
 * The component renders a scrollable outer container with an inner spacer
 * sized to the total content height.  Visible items are absolutely positioned
 * at their computed offsets so the browser scrollbar stays proportional.
 */

import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { useVirtualList, type VirtualItem } from "../hooks/useVirtualList";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VirtualListProps<T> {
  /** Full list of items. */
  items: T[];
  /** Unique key extractor. */
  getItemKey: (item: T, index: number) => string | number;
  /** Pixel height for a given item (backed by pretext measurement). */
  getItemHeight: (item: T, index: number) => number;
  /** Render callback for a single item. */
  renderItem: (item: T, index: number, meta: VirtualItem<T>) => ReactNode;
  /** Fallback height when measurement is unavailable. */
  estimatedItemHeight?: number;
  /** Extra items rendered above/below the viewport. */
  overscan?: number;
  /** Master switch — when disabled, renders all items normally without virtualization. */
  enabled?: boolean;
  /** CSS class applied to the outer scrollable container. */
  className?: string;
  /** Inline styles applied to the outer container. */
  style?: CSSProperties;
  /** ARIA role for the list container (default "list"). */
  role?: string;
  /** Callback fired when the user scrolls near the bottom (infinite scroll). */
  onScrollNearEnd?: () => void;
  /** Allow near-end callbacks before the user has scrolled, for explicit auto-fill use cases. */
  triggerNearEndOnMount?: boolean;
  /** Keep the current scroll position when items are appended or prepended. */
  suppressAutoScrollOnItemsChange?: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function VirtualList<T>({
  items,
  getItemKey,
  getItemHeight,
  renderItem,
  estimatedItemHeight = 40,
  overscan = 5,
  enabled = true,
  className,
  style,
  role = "list",
  onScrollNearEnd,
  triggerNearEndOnMount = false,
  suppressAutoScrollOnItemsChange = false,
}: VirtualListProps<T>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const nearEndTriggeredRef = useRef(false);
  const lastItemCountRef = useRef(items.length);
  const hasUserScrolledRef = useRef(false);

  const { virtualItems, totalHeight, isAtBottom } = useVirtualList({
    items,
    containerRef,
    getItemHeight,
    estimatedItemHeight,
    overscan,
    enabled,
    suppressAutoScrollOnItemsChange,
  });

  useEffect(() => {
    if (lastItemCountRef.current !== items.length) {
      lastItemCountRef.current = items.length;
      nearEndTriggeredRef.current = false;
    }
  }, [items.length]);

  useEffect(() => {
    if (!enabled || !onScrollNearEnd) return;
    if (!triggerNearEndOnMount && !hasUserScrolledRef.current) return;
    if (!isAtBottom) {
      nearEndTriggeredRef.current = false;
      return;
    }
    if (nearEndTriggeredRef.current) return;
    nearEndTriggeredRef.current = true;
    onScrollNearEnd();
  }, [enabled, isAtBottom, onScrollNearEnd, triggerNearEndOnMount]);

  // ---- Non-virtual fallback -----------------------------------------------

  if (!enabled) {
    return (
      <div ref={containerRef} className={className} style={style} role={role}>
        {items.map((item, index) => (
          <div key={getItemKey(item, index)} role="listitem">
            {renderItem(item, index, {
              item,
              index,
              offsetTop: 0,
              height: estimatedItemHeight,
            })}
          </div>
        ))}
      </div>
    );
  }

  // ---- Virtual rendering --------------------------------------------------

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ overflow: "auto", position: "relative", ...style }}
      role={role}
      onScroll={() => {
        hasUserScrolledRef.current = true;
      }}
    >
      {/* Spacer — keeps the scrollbar proportional to the full content. */}
      <div style={{ height: totalHeight, position: "relative" }}>
        {virtualItems.map((vi) => (
          <div
            key={getItemKey(vi.item, vi.index)}
            role="listitem"
            style={{
              position: "absolute",
              top: vi.offsetTop,
              left: 0,
              right: 0,
              height: vi.height,
            }}
          >
            {renderItem(vi.item, vi.index, vi)}
          </div>
        ))}
      </div>
    </div>
  );
}
